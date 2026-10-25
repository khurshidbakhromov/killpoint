// killpoint adapter for Optio's schedule-trigger sweep (A16 validation harness).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ADAPTER_SCHEMA_VERSION, defineAdapter } from 'killpoint';
import { OPTIO_API } from './optio-path.mjs';

const CRON = '*/5 * * * *';

export default defineAdapter({
  id: 'optio-schedule-trigger',
  schemaVersion: ADAPTER_SCHEMA_VERSION,
  processors: {
    optio: fileURLToPath(new URL('./processor.mjs', import.meta.url)),
    'split-mutation': fileURLToPath(new URL('./processor-split-mutation.mjs', import.meta.url)),
  },
  checkpoint: 'effect-committed',
  async open(ctx) {
    const db = new pg.Pool({ ...ctx.postgres, max: 2 });
    const triggerId = randomUUID();
    const controlId = randomUUID();
    const seen = new Date(Math.floor(Date.now() / 60000) * 60000 - 60000); // due one minute ago
    const key = `schedule:${triggerId}:${seen.toISOString()}`;
    return {
      async setup() {
        // Optio's own migration runner against this run's private database.
        const p = ctx.postgres;
        process.env.DATABASE_URL = `postgres://${p.user}:${encodeURIComponent(p.password)}@${p.host}:${p.port}/${p.database}`;
        const { db: optioDb } = await import(`${OPTIO_API}/dist/db/client.js`);
        const { migrateSafe } = await import(`${OPTIO_API}/dist/db/migrate-safe.js`);
        await migrateSafe(optioDb, `${OPTIO_API}/src/db/migrations`);
        await db.query(
          `INSERT INTO workflow_triggers (id, target_type, target_id, type, config, enabled, next_fire_at)
           VALUES ($1, 'job', $2, 'schedule', $3, true, $4), ($5, 'job', $6, 'schedule', $3, true, now() + interval '1 day')`,
          [triggerId, randomUUID(), JSON.stringify({ cronExpression: CRON }), seen, controlId, randomUUID()],
        );
      },
      async makePayload() {
        return { operationId: key, data: { operationId: key } };
      },
      async observe() {
        const t = await db.query('SELECT id, next_fire_at, updated_at FROM workflow_triggers WHERE id = ANY($1)', [[triggerId, controlId]]);
        const occ = await db.query('SELECT occurrence_key, trigger_id, state, attempts FROM trigger_occurrences ORDER BY received_at');
        const row = (id) => t.rows.find((r) => r.id === id);
        return {
          trigger: { nextFireAt: row(triggerId)?.next_fire_at?.toISOString() ?? null },
          control: { nextFireAt: row(controlId)?.next_fire_at?.toISOString() ?? null, updatedAt: row(controlId)?.updated_at?.toISOString() ?? null },
          occurrencesForKey: occ.rows.filter((o) => o.occurrence_key === key).length,
          occurrencesTotal: occ.rows.length,
          occurrenceStates: occ.rows.filter((o) => o.occurrence_key === key).map((o) => o.state),
        };
      },
      // The sweep's first durable effect is the schedule advance; the checkpoint claims it committed.
      confirmCommitted(s) {
        const advanced = s.trigger.nextFireAt !== null && new Date(s.trigger.nextFireAt) > seen;
        return { committed: advanced, detail: `schedule nextFireAt ${s.trigger.nextFireAt}; occurrences for key ${s.occurrencesForKey}` };
      },
      evaluate({ initial, final }) {
        const v = (ok) => (ok ? 'pass' : 'fail');
        const n = final.occurrencesForKey;
        return [
          { id: 'at-most-one-occurrence', description: 'Occurrences for this schedule tick (at most one)', category: 'business', expected: '<= 1', observed: n, verdict: v(n <= 1) },
          { id: 'at-least-one-occurrence', description: 'Occurrences for this schedule tick (at least one, not lost)', category: 'business', expected: '>= 1', observed: n, verdict: v(n >= 1) },
          { id: 'schedule-advanced', description: 'Schedule moved past the fired tick', category: 'business', expected: `> ${seen.toISOString()}`, observed: final.trigger.nextFireAt, verdict: v(final.trigger.nextFireAt !== null && new Date(final.trigger.nextFireAt) > seen) },
          { id: 'no-other-occurrences', description: 'No occurrences for other triggers or ticks', category: 'business', expected: 1, observed: final.occurrencesTotal, verdict: v(final.occurrencesTotal === 1) },
          { id: 'control-trigger-unchanged', description: 'Unrelated schedule trigger unchanged', category: 'business', expected: initial.control, observed: final.control, verdict: v(JSON.stringify(initial.control) === JSON.stringify(final.control)) },
        ];
      },
      async teardown() {
        await db.end();
      },
    };
  },
});
