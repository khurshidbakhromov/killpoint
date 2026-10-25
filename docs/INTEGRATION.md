# Plugging in your own processor

You provide two trusted, locally authored modules, both compiled to JavaScript:

1. A **processor module**, loaded inside each owned worker process. It exports `createProcessor(ctx)`.
2. An **adapter**, loaded by the runner. It seeds fixtures, builds the payload, reads durable state independently, and declares your invariants.

Then point a config file at the adapter and run it. The kit owns Redis, PostgreSQL, the queue, the single job, the worker processes, the SIGKILL and the evidence.

## 1. Processor module (child side)

Wrap your real processor. The changes you actually need are:
- (a) take database settings from `ctx.connections.postgres` instead of production configuration;
- (b) add one awaited checkpoint **after your transaction's commit has resolved, outside the transaction, and before returning**.

```ts
// src/test-support/crash-processor.ts → compile to dist/test-support/crash-processor.js
import { defineProcessor } from 'crash-retry-lab/processor';
import pg from 'pg';
import { handleInvoicePaid } from '../jobs/invoice-paid.js'; // your real handler

export const createProcessor = defineProcessor((ctx) => {
  const db = new pg.Pool(ctx.connections.postgres);
  return {
    async process(job) {
      // Your handler must let you run code after commit. A small seam such as an
      // `afterCommit` hook is usually the only refactor needed.
      return handleInvoicePaid(job.data, {
        db,
        schema: ctx.namespace,
        afterCommit: () => ctx.checkpoint('effect-committed'),
      });
    },
    operationIdOf: (job) => job.data.invoiceId, // your stable business operation id
    close: () => db.end(),
  };
});
```

Rules:
- Put the checkpoint **after** `COMMIT` resolves. A seam inside the transaction tests rollback, not this hazard. The runner detects that case: its independent read at the checkpoint finds no effect, and the run is INCONCLUSIVE.
- When not armed, `checkpoint()` resolves immediately. Only worker A is armed, and only once.
- Do not spawn child processes the kit doesn't know about.

## 2. Adapter (runner side)

```ts
import { defineAdapter, ADAPTER_SCHEMA_VERSION } from 'crash-retry-lab';
import { fileURLToPath } from 'node:url';

export default defineAdapter({
  id: 'billing-invoice-paid',
  schemaVersion: ADAPTER_SCHEMA_VERSION,
  processors: {
    current: fileURLToPath(new URL('./crash-processor.js', import.meta.url)),
  },
  checkpoint: 'effect-committed',
  async open(ctx) {
    // ctx: runId, scenario, namespace (safe SQL identifier), processor, postgres settings
    const db = new pg.Pool(ctx.postgres);
    return {
      async setup() { /* create schema ctx.namespace, run your migrations, seed fixtures */ },
      async makePayload() { return { operationId: 'inv-42', data: { invoiceId: 'inv-42', amountCents: 1999 } }; },
      async observe() { /* SELECT allowlisted counts and balances; return plain JSON, no secrets */ },
      confirmCommitted(snapshot) { return { committed: snapshot.ledgerRows === 1, detail: `ledger rows ${snapshot.ledgerRows}` }; },
      evaluate({ initial, final }) {
        return [
          { id: 'one-ledger-entry', description: 'Ledger entries for invoice', category: 'business', expected: 1, observed: final.ledgerRows, verdict: final.ledgerRows === 1 ? 'pass' : 'fail' },
          // add at-least-one, exact amount, no collateral changes, …
        ];
      },
      async teardown() { /* drop only ctx.namespace */ await db.end(); },
    };
  },
});
```

`evaluate()` must return at least one business invariant. A run with none can never PASS. Declare both "at most one" and "at least one": an implementation that loses the effect would otherwise look safe. A verdict of `not-evaluated` (for example because an observation is missing) makes the run INCONCLUSIVE.

## 3. Config and run

```js
// lab.config.mjs (trusted local code)
import adapter from './dist/test-support/adapter.js';
export default { adapter, timing: { lockDurationMs: 3000, stalledIntervalMs: 1000, maxStalledCount: 1 } };
```

```bash
npx crash-retry-lab run --config ./lab.config.mjs --scenario baseline --implementation current
npx crash-retry-lab run --config ./lab.config.mjs --scenario post-commit-crash --implementation current
```

Run the baseline first. If the baseline doesn't PASS, the crash result means nothing.

## Programmatic use

```ts
import { loadConfigFile, runScenario, exitCodeFor } from 'crash-retry-lab';
const config = await loadConfigFile('./lab.config.mjs');
const result = await runScenario({ config, scenario: 'post-commit-crash', processor: 'current' });
// result.outcome, result.valid, result.invariants, result.reportPath, result.cleanup
```

The library never calls `process.exit`.

## What A16 still needs

This guide has only been exercised with the reference ledger. Integration with a real application, including measured setup time and lines changed, is **pending**. See `VALIDATION.md`.
