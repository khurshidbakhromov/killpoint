// A08 fixture: reaches the seam but never applies any effect.
import type { Job } from 'bullmq';
import { defineProcessor } from '../../../src/processor.js';

export const createProcessor = defineProcessor((ctx) => ({
  async process(_job: Job) {
    await ctx.checkpoint('effect-committed');
    return 'nothing';
  },
}));
