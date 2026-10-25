/**
 * Reference ledger fixture adapter. Synthetic credits: balance starts at 0, the job credits
 * 100 integer units once. An unrelated control tenant detects collateral changes.
 */
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { ADAPTER_SCHEMA_VERSION, defineAdapter, type AdapterSession, type InvariantVerdict, type ProjectAdapter } from '../../src/adapter.js';
import type { JsonObject } from '../../src/core/events.js';
import { CONTROL_TENANT, CREDIT_AMOUNT, OPERATION_ID, TARGET_TENANT, fingerprint, pool, schemaIdent } from './shared.js';

const here = (file: string): string => fileURLToPath(new URL(file, import.meta.url));

export const LEDGER_PROCESSORS = {
  unsafe: here('./unsafe.js'),
  idempotent: here('./idempotent.js'),
};

const CONTROL_OPERATION = 'control-op-0001';

async function createSchema(db: pg.Pool, s: string): Promise<void> {
  await db.query(`CREATE SCHEMA ${s}`);
  await db.query(`
    CREATE TABLE ${s}.account_balance (tenant_id text PRIMARY KEY, balance bigint NOT NULL);
    CREATE TABLE ${s}.operations (
      tenant_id text NOT NULL, operation_id text NOT NULL, request_fingerprint text NOT NULL, amount bigint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, operation_id));
    CREATE TABLE ${s}.effect_ledger (
      effect_id bigserial PRIMARY KEY, tenant_id text NOT NULL, operation_id text NOT NULL, amount bigint NOT NULL,
      job_id text, worker_generation text, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE ${s}.processing_attempts (
      attempt_id bigserial PRIMARY KEY, run_id text NOT NULL, worker_generation text NOT NULL, job_id text NOT NULL,
      operation_id text NOT NULL, status text NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz);
  `);
  await db.query(`INSERT INTO ${s}.account_balance (tenant_id, balance) VALUES ($1, 0), ($2, 500)`, [TARGET_TENANT, CONTROL_TENANT]);
  const control = { tenantId: CONTROL_TENANT, operationId: CONTROL_OPERATION, amount: 500 };
  await db.query(`INSERT INTO ${s}.operations (tenant_id, operation_id, request_fingerprint, amount) VALUES ($1, $2, $3, $4)`, [
    control.tenantId,
    control.operationId,
    fingerprint(control),
    control.amount,
  ]);
  await db.query(`INSERT INTO ${s}.effect_ledger (tenant_id, operation_id, amount) VALUES ($1, $2, $3)`, [control.tenantId, control.operationId, control.amount]);
}

async function snapshot(db: pg.Pool, s: string): Promise<JsonObject> {
  const tenant = async (tenantId: string): Promise<JsonObject> => {
    const bal = await db.query<{ balance: string }>(`SELECT balance FROM ${s}.account_balance WHERE tenant_id = $1`, [tenantId]);
    const eff = await db.query<{ n: string; total: string | null }>(`SELECT count(*) AS n, sum(amount) AS total FROM ${s}.effect_ledger WHERE tenant_id = $1`, [tenantId]);
    const rec = await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${s}.operations WHERE tenant_id = $1`, [tenantId]);
    return {
      balance: bal.rows[0] ? Number(bal.rows[0].balance) : null,
      acceptedEffects: Number(eff.rows[0]!.n),
      effectTotal: Number(eff.rows[0]!.total ?? 0),
      operationReceipts: Number(rec.rows[0]!.n),
    };
  };
  const opEffects = await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${s}.effect_ledger WHERE tenant_id = $1 AND operation_id = $2`, [TARGET_TENANT, OPERATION_ID]);
  const attempts = await db.query<{ worker_generation: string; status: string }>(
    `SELECT worker_generation, status FROM ${s}.processing_attempts ORDER BY attempt_id`,
  );
  return {
    target: { tenantId: TARGET_TENANT, operationId: OPERATION_ID, operationEffects: Number(opEffects.rows[0]!.n), ...(await tenant(TARGET_TENANT)) },
    control: { tenantId: CONTROL_TENANT, ...(await tenant(CONTROL_TENANT)) },
    attempts: attempts.rows.map((r) => ({ generation: r.worker_generation, status: r.status })),
  };
}

const num = (obj: JsonObject | null | undefined, group: string, key: string): number | null => {
  const g = obj?.[group];
  const v = g && typeof g === 'object' && !Array.isArray(g) ? g[key] : undefined;
  return typeof v === 'number' ? v : null;
};

export function evaluateLedger(initial: JsonObject, final: JsonObject): InvariantVerdict[] {
  const effects = num(final, 'target', 'operationEffects');
  const delta = num(final, 'target', 'balance') !== null && num(initial, 'target', 'balance') !== null ? num(final, 'target', 'balance')! - num(initial, 'target', 'balance')! : null;
  const verdict = (ok: boolean | null): InvariantVerdict['verdict'] => (ok === null ? 'not-evaluated' : ok ? 'pass' : 'fail');
  const controlBefore = { balance: num(initial, 'control', 'balance'), effects: num(initial, 'control', 'acceptedEffects'), receipts: num(initial, 'control', 'operationReceipts') };
  const controlAfter = { balance: num(final, 'control', 'balance'), effects: num(final, 'control', 'acceptedEffects'), receipts: num(final, 'control', 'operationReceipts') };
  const targetOther = num(final, 'target', 'acceptedEffects') !== null && effects !== null ? num(final, 'target', 'acceptedEffects')! - effects : null;
  return [
    { id: 'at-most-one-effect', description: 'Accepted effects (at most one)', category: 'business', expected: '<= 1', observed: effects, verdict: verdict(effects === null ? null : effects <= 1) },
    { id: 'at-least-one-effect', description: 'Accepted effects (at least one)', category: 'business', expected: '>= 1', observed: effects, verdict: verdict(effects === null ? null : effects >= 1) },
    { id: 'exact-account-delta', description: 'Account delta', category: 'business', expected: CREDIT_AMOUNT, observed: delta, verdict: verdict(delta === null ? null : delta === CREDIT_AMOUNT) },
    {
      id: 'no-unrelated-changes',
      description: 'Unrelated tenant/operation state unchanged',
      category: 'business',
      expected: { control: controlBefore, otherTargetEffects: 0 },
      observed: { control: controlAfter, otherTargetEffects: targetOther },
      verdict: verdict(
        controlAfter.balance === null || targetOther === null
          ? null
          : JSON.stringify(controlBefore) === JSON.stringify(controlAfter) && targetOther === 0,
      ),
    },
  ];
}

/** Build a ledger adapter; extra processors let tests register deliberately broken fixtures. */
export function createLedgerAdapter(extraProcessors: Record<string, string> = {}): ProjectAdapter {
  return defineAdapter({
    id: 'ledger-reference',
    schemaVersion: ADAPTER_SCHEMA_VERSION,
    processors: { ...LEDGER_PROCESSORS, ...extraProcessors },
    defaultProcessor: 'idempotent',
    checkpoint: 'effect-committed',
    async open(ctx): Promise<AdapterSession> {
      const db = pool(ctx.postgres);
      const s = schemaIdent(ctx.namespace);
      let created = false;
      return {
        async setup() {
          await createSchema(db, s);
          created = true;
        },
        async makePayload() {
          const data = { tenantId: TARGET_TENANT, operationId: OPERATION_ID, amount: CREDIT_AMOUNT };
          return { operationId: OPERATION_ID, data };
        },
        observe: () => snapshot(db, s),
        confirmCommitted(snap) {
          const effects = num(snap, 'target', 'operationEffects');
          const balance = num(snap, 'target', 'balance');
          return {
            committed: effects === 1 && balance === CREDIT_AMOUNT,
            detail: `independent read at checkpoint: ${effects} accepted effect(s), balance ${balance}`,
          };
        },
        evaluate: ({ initial, final }) => evaluateLedger(initial, final),
        async teardown() {
          try {
            if (created) await db.query(`DROP SCHEMA ${s} CASCADE`);
          } finally {
            await db.end();
          }
        },
      };
    },
  });
}

export const ledgerAdapter = createLedgerAdapter();
export default ledgerAdapter;
