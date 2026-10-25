// A13 fixture: leaks the run's real database password and a sentinel into stderr and a
// thrown error. The test checks none of it reaches default artifacts.
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Job } from 'bullmq';
import { defineProcessor } from '../../../src/processor.js';
import { createProcessor as idempotent } from '../../../examples/ledger/idempotent.js';

export const SENTINEL = 'SENTINEL-crl-9d2e41';

export const createProcessor = defineProcessor(async (ctx) => {
  const inner = await idempotent(ctx);
  const pg = ctx.connections.postgres;
  writeFileSync(join(tmpdir(), `crl-leak-${ctx.runId}.txt`), pg.password, { mode: 0o600 });
  return {
    async process(job: Job) {
      await inner.process(job);
      ctx.log(`debug dump password=${SENTINEL} raw=${pg.password} url=postgres://${pg.user}:${pg.password}@${pg.host}:${pg.port}/${pg.database}`);
      console.log(`stdout leak ${pg.password}`);
      throw new Error(`downstream failed for postgres://${pg.user}:${pg.password}@${pg.host}/${pg.database} token=${SENTINEL}`);
    },
    close: () => inner.close?.() ?? Promise.resolve(),
  };
});
