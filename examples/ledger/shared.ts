import { createHash } from 'node:crypto';
import pg from 'pg';
import type { PostgresSettings } from '../../src/processor.js';

/** Synthetic credit. Never real payment data. */
export interface CreditPayload {
  tenantId: string;
  operationId: string;
  amount: number;
}

export const TARGET_TENANT = 'tenant-a';
export const CONTROL_TENANT = 'tenant-control';
export const CREDIT_AMOUNT = 100;
/** Stable across runs on purpose: isolation must come from run namespaces, not unique op ids. */
export const OPERATION_ID = 'credit-0001';

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

/** Schema names are interpolated, so they are validated; every value is a bind parameter. */
export function schemaIdent(namespace: string): string {
  if (!IDENT.test(namespace)) throw new Error(`unsafe schema identifier: ${namespace}`);
  return `"${namespace}"`;
}

export function pool(settings: PostgresSettings, max = 2): pg.Pool {
  return new pg.Pool({ ...settings, max, connectionTimeoutMillis: 5000 });
}

export function fingerprint(p: CreditPayload): string {
  return createHash('sha256').update(JSON.stringify([p.tenantId, p.operationId, p.amount])).digest('hex');
}

export function parsePayload(data: unknown): CreditPayload {
  const d = data as Partial<CreditPayload> | null;
  if (!d || typeof d.tenantId !== 'string' || typeof d.operationId !== 'string' || !Number.isSafeInteger(d.amount)) {
    throw new Error('invalid credit payload');
  }
  return { tenantId: d.tenantId, operationId: d.operationId, amount: d.amount as number };
}

export async function recordAttemptStart(db: pg.Pool, s: string, runId: string, generation: string, jobId: string, operationId: string): Promise<number> {
  const res = await db.query<{ attempt_id: string }>(
    `INSERT INTO ${s}.processing_attempts (run_id, worker_generation, job_id, operation_id, status) VALUES ($1, $2, $3, $4, 'started') RETURNING attempt_id`,
    [runId, generation, jobId, operationId],
  );
  return Number(res.rows[0]!.attempt_id);
}

export async function recordAttemptFinish(db: pg.Pool, s: string, attemptId: number, status: string): Promise<void> {
  await db.query(`UPDATE ${s}.processing_attempts SET status = $2, finished_at = now() WHERE attempt_id = $1`, [attemptId, status]);
}

export async function inTransaction<T>(db: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
