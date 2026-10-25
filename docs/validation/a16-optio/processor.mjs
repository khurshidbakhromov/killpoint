// killpoint processor module wrapping Optio's real workflow-trigger sweep.
import { OPTIO_API } from './optio-path.mjs';

export async function createProcessor(ctx) {
  const pg = ctx.connections.postgres;
  // Optio binds its db/Redis clients at import time from env, so point them at the test services first.
  process.env.DATABASE_URL = `postgres://${pg.user}:${encodeURIComponent(pg.password)}@${pg.host}:${pg.port}/${pg.database}`;
  process.env.REDIS_URL = `redis://${ctx.connections.redis.host}:${ctx.connections.redis.port}`;
  const { db } = await import(`${OPTIO_API}/dist/db/client.js`);
  // Seam: the first transaction of a sweep is "advance schedule + save occurrence".
  // Checkpoint once it has committed, before the sweep continues to dispatch.
  const transaction = db.transaction.bind(db);
  db.transaction = async (...args) => {
    const result = await transaction(...args);
    await ctx.checkpoint('effect-committed');
    return result;
  };
  const { checkDueScheduleTriggers } = await import(`${OPTIO_API}/dist/workers/workflow-trigger-worker.js`);
  return {
    process: async () => ({ fired: await checkDueScheduleTriggers() }),
    operationIdOf: (job) => job.data.operationId,
  };
}
