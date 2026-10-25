// A04 fixture: the seam is (wrongly) inside the uncommitted transaction.
import type { Job } from 'bullmq';
import { defineProcessor } from '../../../src/processor.js';
import { inTransaction, parsePayload, pool, schemaIdent } from '../../../examples/ledger/shared.js';

export const createProcessor = defineProcessor((ctx) => {
  const db = pool(ctx.connections.postgres);
  const s = schemaIdent(ctx.namespace);
  return {
    async process(job: Job) {
      const credit = parsePayload(job.data);
      await inTransaction(db, async (tx) => {
        await tx.query(`INSERT INTO ${s}.effect_ledger (tenant_id, operation_id, amount) VALUES ($1, $2, $3)`, [credit.tenantId, credit.operationId, credit.amount]);
        await tx.query(`UPDATE ${s}.account_balance SET balance = balance + $2 WHERE tenant_id = $1`, [credit.tenantId, credit.amount]);
        await ctx.checkpoint('effect-committed'); // not yet committed
      });
      return 'ok';
    },
    close: () => db.end(),
  };
});
