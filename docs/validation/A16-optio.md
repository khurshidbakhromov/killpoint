# A16: killpoint on a real application (Optio)

**Date:** 2026-10-26.
**Application:** [Optio](https://github.com/jonwiggins/optio), MIT, about 1.1k stars, commit `e1ff7fa` (2026-10-25). It uses BullMQ 5, drizzle-orm and postgres-js.
**Status:** one real open-source application was integrated locally and the results are recorded below. Nobody from Optio was involved and nothing was sent upstream.

> **What this is, and what it is not.** It shows that killpoint can test unmodified code from a real, independently written application and tell a crash-safe design from a broken one. It does **not** show that teams will adopt killpoint, and the effort numbers come from killpoint's own author, not from a new user.

## Why Optio

Candidates were screened for: a permissive license; an active repository; a BullMQ processor that commits PostgreSQL effects; and code that can run in isolation. Infisical, Langfuse and Activepieces were also considered. Infisical's notification queue is a near-trivial insert; Langfuse needs ClickHouse; Activepieces' path looked upsert-shaped and its stack is heavy. Optio was chosen because its schedule-trigger sweep has real, deliberately designed crash-safety logic worth confirming.

## What was tested

`checkDueScheduleTriggers()` in `apps/api/src/workers/workflow-trigger-worker.ts` is Optio's BullMQ processor body. For each due schedule it runs **one transaction** containing two steps:
1. `advanceScheduleCas(...)`: a compare-and-set move of `workflow_triggers.next_fire_at` past the tick it saw;
2. `enqueueOccurrence(..., "schedule:<trigger>:<tick>", tx)`: an outbox row in `trigger_occurrences` with `ON CONFLICT DO NOTHING`.

After that it dispatches pending occurrences. The question killpoint asks: if the worker is SIGKILLed after that transaction commits and before BullMQ marks the job done, and BullMQ redelivers it, is the occurrence lost, duplicated or kept exactly once?

## Results (real Redis 8.10.2, PostgreSQL 18.6, owned workers, SIGKILL, BullMQ stalled redelivery)

| Case | Runs | Outcome | Durable result |
|---|---|---|---|
| baseline, Optio code, no fault | 5 | **PASS** ×5 | 1 occurrence, schedule advanced, control trigger unchanged |
| post-commit-crash, **Optio's real code** | 5 | **PASS** ×5 | A committed, A was killed, B got the redelivered sweep: still exactly **1** occurrence; schedule advanced once; control trigger unchanged |
| post-commit-crash, **split-transaction mutation** (negative control) | 5 | **VIOLATION** ×5 | the occurrence was **lost** (0): the advance committed, A was killed, and B found nothing due |

All 15 runs were valid experiments, with commit, kill and redelivery each confirmed independently. Durations were 11.0–15.6 s, median 14.6 s; most of that is Optio's 135 migrations applied on every run. Evidence: [`docs/evidence/a16-optio/`](../evidence/a16-optio/), containing one report per case plus `repeat.json` with all 15 rows.

**Node 26 (2026-10-27).** The same 15 runs were repeated on Node 26.12.1, which Optio requires, with killpoint `bd95f6d` installed from its packed tarball and Optio rebuilt at `e1ff7fa` on Node 26: baseline PASS ×5, real code PASS ×5, mutation VIOLATION ×5, all valid, with the same failed invariants as on Node 24 (`at-least-one-occurrence`, `no-other-occurrences`). Durations were 10.8–17.0 s, median 14.3 s. Rows: `repeat-node26.json`.

**Finding:** Optio's sweep is crash-safe at this boundary, as its comments claim ("transient dispatch failures never consume the schedule without durable work"). killpoint confirmed it and also caught the bug that design avoids. The mutation (`processor-split-mutation.mjs`) is clearly labelled and exists only in this harness. It calls Optio's own `advanceScheduleCas` and `enqueueOccurrence` in two separate commits. **Optio's source was not modified.**

## Integration effort and friction

| Item | Measurement |
|---|---|
| Lines of Optio changed | **0** |
| Harness written | 129 lines: `processor.mjs` 23, `adapter.mjs` 74, mutation 26, config 4 + 2 |
| Wall-clock, from harness creation to the first valid crash PASS | about 8 minutes; about 14 minutes including the mutation and the repeats. Measured from the harness timestamps; reading Optio's code and building it came before and was not timed. Written by killpoint's author. **Not representative of a new user.** |
| killpoint changes needed | **1**: the new `workerExecArgv` option (DECISIONS #17) |

Friction found, in the order it was hit:
1. **TypeScript-source workspace packages.** `@optio/shared` exports `./src/index.ts`, and Optio's production image runs via `tsx`. killpoint's workers ran plain `node` with no way to add flags, so worker startup failed. killpoint correctly reported ERROR, not a verdict. **Fixed in killpoint** with `workerExecArgv: ['--import', 'tsx']`.
2. **Node version.** Optio declares Node `>=26.12.1 <27`, while killpoint supports only Node 24. This code path worked on Node 24.22.1, but that is not a supported combination for either project. killpoint added Node 26 support on 2026-10-26 (DECISIONS #18), and the Optio runs were repeated on Node 26.12.1 with the same results (above). **Resolved.**
3. **Clients bound at import time.** Optio's `db` and Redis clients read `DATABASE_URL` and `REDIS_URL` when the module loads. The processor module sets them from `ctx.connections` before a dynamic import. This works and is now documented in INTEGRATION.md.
4. **No after-commit hook.** The commit sits inside a loop in Optio's code. The seam was placed by wrapping `db.transaction` in the processor module (checkpoint after the first commit). That is correct here only because the first transaction of the sweep is the effect under test, and the adapter's independent `confirmCommitted` check guards against a misplaced seam. It is fragile for other applications.
5. **Schema setup.** `tsc` does not copy Optio's SQL migrations into `dist/`. The adapter runs Optio's own `migrateSafe` against `src/db/migrations` in the run's private database. That costs about 7 s per run, and Optio's migrations print PostgreSQL NOTICEs to the runner's console.
6. **Worker environment.** killpoint workers start with only `PATH` and `NODE_ENV`, so the processor module cannot read `OPTIO_API` from the environment. The harness as first committed did exactly that, and its reproduce steps failed with a worker startup ERROR (found on 2026-10-27 when re-running on Node 26; how the original runs supplied the path was not recorded). `optio-path.mjs` now records the path in `.optio-api` when the parent loads the config, and workers read it from there. A `workerEnv` option in killpoint would remove this workaround; it has not been added.
7. **Isolation scope.** The harness calls `checkDueScheduleTriggers()` directly. It bypasses Optio's `underPollerLease` wrapper (a multi-instance guard) and its BullMQ repeat scheduling. Occurrence dispatch runs but cannot start real workflow runs without Optio's wider stack, so occurrences stay `pending`, which in Optio's design still counts as durable work.

**Compared with the closest alternative:** per the M0 source review, Faultline has no bring-your-own-processor path, so testing this code with it would mean forking and rewriting its demo worker and SQL. That was not attempted, so this is not a measured comparison.

## Reproduce

```bash
git clone https://github.com/jonwiggins/optio && cd optio && git checkout e1ff7fa
corepack pnpm install --frozen-lockfile --ignore-scripts --filter @optio/api...
for p in @optio/shared @optio/agent-adapters @optio/container-runtime @optio/ticket-providers @optio/api; do corepack pnpm --filter $p build; done

cd <killpoint>/docs/validation/a16-optio
npm install <killpoint tarball from npm pack> pg@8.23.1 tsx@4.23.15
export OPTIO_API=<optio checkout>/apps/api
npx killpoint run --config ./lab.config.mjs --scenario baseline --implementation optio
npx killpoint run --config ./lab.config.mjs --scenario post-commit-crash --implementation optio            # PASS
npx killpoint run --config ./lab.config.mjs --scenario post-commit-crash --implementation split-mutation   # VIOLATION
```

The evidence reports contain absolute paths from the machine they were recorded on, and no credentials.

## What A16 still lacks

- An integration by someone **other than** killpoint's author, with their own setup time.
- A **team** using killpoint on their own application: use in a CI suite, bugs found, whether they kept it.
- A real application that **does** have the duplicate-effect bug. Infisical's notification queue looks like one (an insert with no idempotency key) but was not run.
