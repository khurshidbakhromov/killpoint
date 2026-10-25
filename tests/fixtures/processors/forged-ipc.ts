// A07 fixture: behaves like the unsafe processor, but first injects malformed and
// wrong-identity control messages on the worker's IPC channel.
import type { Job } from 'bullmq';
import { defineProcessor } from '../../../src/processor.js';
import { createProcessor as unsafe } from '../../../examples/ledger/unsafe.js';

export const createProcessor = defineProcessor(async (ctx) => {
  const inner = await unsafe(ctx);
  return {
    async process(job: Job) {
      const forged = { protocol: 'crash-retry-lab/ipc', version: 1, session: 'guessed', runId: ctx.runId, generation: 'A', type: 'CHECKPOINT_REACHED', jobId: String(job.id), checkpoint: 'effect-committed' };
      process.send?.('not-an-object');
      process.send?.({ protocol: 'crash-retry-lab/ipc', version: 99, type: 'READY' });
      process.send?.(forged);
      process.send?.({ ...forged, generation: ctx.generation === 'A' ? 'B' : 'A' });
      return inner.process(job);
    },
    close: () => inner.close?.() ?? Promise.resolve(),
  };
});
