// A09: same idempotency key with a different payload is an explicit conflict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startInfrastructure, stopInfrastructure, waitForPostgres } from '../../src/infra/compose.js';
import { applyCreditOnce, OperationConflictError } from '../../examples/ledger/idempotent.js';
import { ledgerAdapter } from '../../examples/ledger/adapter.js';
import { pool, schemaIdent } from '../../examples/ledger/shared.js';
import { requireDocker } from './helpers.js';

test('A09: same key, different amount -> conflict, no second effect', async (t) => {
  if (!requireDocker(t)) return;
  const runId = `a09-${randomBytes(4).toString('hex')}`;
  const pgPassword = randomBytes(18).toString('base64url');
  try {
    const infra = await startInfrastructure({ runId, pgPassword, deadlineMs: 120_000 });
    await waitForPostgres(infra.postgres, 60_000);
    const namespace = 'crl_a09';
    const session = await ledgerAdapter.open({ runId, scenario: 'baseline', namespace, processor: 'idempotent', postgres: infra.postgres });
    await session.setup();
    const db = pool(infra.postgres);
    const s = schemaIdent(namespace);
    const meta = { jobId: 'j', generation: 'A' };
    try {
      assert.deepEqual(await applyCreditOnce(db, s, { tenantId: 'tenant-a', operationId: 'credit-0001', amount: 100 }, meta), { applied: true });
      assert.deepEqual(await applyCreditOnce(db, s, { tenantId: 'tenant-a', operationId: 'credit-0001', amount: 100 }, meta), { applied: false });
      await assert.rejects(applyCreditOnce(db, s, { tenantId: 'tenant-a', operationId: 'credit-0001', amount: 999 }, meta), OperationConflictError);
      const snap = (await session.observe()) as { target: { operationEffects: number; balance: number } };
      assert.equal(snap.target.operationEffects, 1);
      assert.equal(snap.target.balance, 100);
    } finally {
      await db.end();
      await session.teardown();
    }
  } finally {
    const steps = await stopInfrastructure({ runId });
    assert.ok(steps.every((s) => s.ok), JSON.stringify(steps));
  }
});
