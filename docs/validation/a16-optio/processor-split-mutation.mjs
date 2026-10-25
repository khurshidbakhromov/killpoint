// DELIBERATE MUTATION for a negative control. Not Optio's code path.
// Uses Optio's real service functions, but commits the schedule advance and the
// occurrence in two separate transactions: the classic split-transaction bug.
import { OPTIO_API } from './optio-path.mjs';

export async function createProcessor(ctx) {
  const pg = ctx.connections.postgres;
  process.env.DATABASE_URL = `postgres://${pg.user}:${encodeURIComponent(pg.password)}@${pg.host}:${pg.port}/${pg.database}`;
  process.env.REDIS_URL = `redis://${ctx.connections.redis.host}:${ctx.connections.redis.port}`;
  const { advanceScheduleCas, listDueScheduleTriggers } = await import(`${OPTIO_API}/dist/services/trigger-service.js`);
  const { enqueueOccurrence } = await import(`${OPTIO_API}/dist/services/trigger-delivery.js`);
  return {
    async process() {
      let fired = 0;
      for (const trigger of await listDueScheduleTriggers()) {
        const cron = trigger.config?.cronExpression;
        if (!cron || !(await advanceScheduleCas(trigger.id, cron, trigger.nextFireAt))) continue; // commit 1
        await ctx.checkpoint('effect-committed');
        await enqueueOccurrence(trigger, { source: 'schedule' }, `schedule:${trigger.id}:${trigger.nextFireAt.toISOString()}`); // commit 2
        fired++;
      }
      return { fired };
    },
    operationIdOf: (job) => job.data.operationId,
  };
}
