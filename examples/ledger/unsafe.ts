/**
 * UNSAFE reference processor: appends an effect and increments the balance in one
 * transaction, with no logical-operation deduplication. Redelivery after a post-commit
 * crash applies the credit twice.
 */
import type { Job } from 'bullmq';
import { defineProcessor } from '../../src/processor.js';
import { inTransaction, parsePayload, pool, recordAttemptFinish, recordAttemptStart, schemaIdent } from './shared.js';

export const createProcessor = defineProcessor((ctx) => {
  const db = pool(ctx.connections.postgres);
  const s = schemaIdent(ctx.namespace);
  return {
    async process(job: Job) {
      const credit = parsePayload(job.data);
      const attempt = await recordAttemptStart(db, s, ctx.runId, ctx.generation, String(job.id), credit.operationId);
      const effectId = await inTransaction(db, async (tx) => {
        const res = await tx.query<{ effect_id: string }>(
          `INSERT INTO ${s}.effect_ledger (tenant_id, operation_id, amount, job_id, worker_generation) VALUES ($1, $2, $3, $4, $5) RETURNING effect_id`,
          [credit.tenantId, credit.operationId, credit.amount, String(job.id), ctx.generation],
        );
        await tx.query(`UPDATE ${s}.account_balance SET balance = balance + $2 WHERE tenant_id = $1`, [credit.tenantId, credit.amount]);
        return Number(res.rows[0]!.effect_id);
      });
      // Commit has resolved; we are outside the transaction and have not returned to BullMQ.
      await ctx.checkpoint('effect-committed');
      await recordAttemptFinish(db, s, attempt, 'finished');
      return { effectId };
    },
    async close() {
      await db.end();
    },
  };
});
