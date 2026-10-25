// workerExecArgv fixture: behaves like the idempotent processor, but only when the worker
// process was started with the flag the test configured.
import type { Job } from 'bullmq';
import { defineProcessor } from '../../../src/processor.js';
import { createProcessor as idempotent } from '../../../examples/ledger/idempotent.js';

export const REQUIRED_FLAG = '--max-old-space-size=384';

export const createProcessor = defineProcessor(async (ctx) => {
  if (!process.execArgv.includes(REQUIRED_FLAG)) throw new Error(`worker started without ${REQUIRED_FLAG}: ${JSON.stringify(process.execArgv)}`);
  const inner = await idempotent(ctx);
  return {
    process: (job: Job) => inner.process(job),
    close: () => inner.close?.() ?? Promise.resolve(),
  };
});
