/**
 * Transactionally idempotent reference processor. The operation receipt, the effect and
 * the balance change commit together, keyed by (tenant_id, operation_id):
 *  - new key            -> insert receipt + effect + balance increment
 *  - same key, same fingerprint -> no-op (the effect already happened)
 *  - same key, different payload -> conflict error, never silent success
 * Execution may still happen more than once; the property is one durable effect.
 */
import type { Job } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import type pg from 'pg';
import { defineProcessor } from '../../src/processor.js';
import { fingerprint, inTransaction, parsePayload, pool, recordAttemptFinish, recordAttemptStart, schemaIdent, type CreditPayload } from './shared.js';

export class OperationConflictError extends UnrecoverableError {
  constructor(operationId: string) {
    super(`operation ${operationId} was already accepted with a different payload`);
    this.name = 'OperationConflictError';
  }
}

/** The idempotent effect itself, exported so A09 can exercise it directly. */
export async function applyCreditOnce(
  db: pg.Pool,
  s: string,
  credit: CreditPayload,
  meta: { jobId: string; generation: string },
): Promise<{ applied: boolean }> {
  return inTransaction(db, async (tx) => {
    const fp = fingerprint(credit);
    const claim = await tx.query(
      `INSERT INTO ${s}.operations (tenant_id, operation_id, request_fingerprint, amount) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, operation_id) DO NOTHING RETURNING operation_id`,
      [credit.tenantId, credit.operationId, fp, credit.amount],
    );
    if (claim.rowCount === 0) {
      const existing = await tx.query<{ request_fingerprint: string }>(
        `SELECT request_fingerprint FROM ${s}.operations WHERE tenant_id = $1 AND operation_id = $2`,
        [credit.tenantId, credit.operationId],
      );
      if (existing.rows[0]?.request_fingerprint !== fp) throw new OperationConflictError(credit.operationId);
      return { applied: false };
    }
    await tx.query(
      `INSERT INTO ${s}.effect_ledger (tenant_id, operation_id, amount, job_id, worker_generation) VALUES ($1, $2, $3, $4, $5)`,
      [credit.tenantId, credit.operationId, credit.amount, meta.jobId, meta.generation],
    );
    await tx.query(`UPDATE ${s}.account_balance SET balance = balance + $2 WHERE tenant_id = $1`, [credit.tenantId, credit.amount]);
    return { applied: true };
  });
}

export const createProcessor = defineProcessor((ctx) => {
  const db = pool(ctx.connections.postgres);
  const s = schemaIdent(ctx.namespace);
  return {
    async process(job: Job) {
      const credit = parsePayload(job.data);
      const attempt = await recordAttemptStart(db, s, ctx.runId, ctx.generation, String(job.id), credit.operationId);
      try {
        const result = await applyCreditOnce(db, s, credit, { jobId: String(job.id), generation: ctx.generation });
        await ctx.checkpoint('effect-committed');
        await recordAttemptFinish(db, s, attempt, result.applied ? 'finished' : 'finished-deduplicated');
        return result;
      } catch (error) {
        await recordAttemptFinish(db, s, attempt, 'error').catch(() => {});
        throw error;
      }
    },
    async close() {
      await db.end();
    },
  };
});
