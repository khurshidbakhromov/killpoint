// A04-A08: invalid experiments must never PASS or be miscounted as crash coverage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from '../../src/core/runner.js';
import { config, events, evidence, requireDocker, verdict } from './helpers.js';

test('A04: checkpoint before the actual commit fails independent observation', async (t) => {
  if (!requireDocker(t)) return;
  const r = await runScenario({ config: config(), scenario: 'post-commit-crash', processor: 'before-commit' });
  assert.equal(r.outcome, 'INCONCLUSIVE');
  assert.equal(evidence(r, 'checkpoint-reached'), true);
  assert.equal(evidence(r, 'commit-independently-confirmed'), false);
  assert.equal(r.report.fault, null, 'no fault may be sent after a failed commit check');
  assert.equal(r.cleanup.status, 'ok');
});

test('A04: absent checkpoint is inconclusive, never PASS', async (t) => {
  if (!requireDocker(t)) return;
  const r = await runScenario({ config: config(), scenario: 'post-commit-crash', processor: 'no-checkpoint' });
  assert.equal(r.outcome, 'INCONCLUSIVE');
  assert.match(r.report.halt?.reason ?? '', /before the armed checkpoint/);
});

test('A05: unconfirmed kill claims no crash coverage', async (t) => {
  if (!requireDocker(t)) return;
  const r = await runScenario({ config: config(), scenario: 'post-commit-crash', processor: 'unsafe', testHooks: { suppressFaultSignal: true } });
  assert.equal(r.outcome, 'INCONCLUSIVE');
  assert.equal(r.report.fault?.delivered, false);
  assert.equal(r.report.fault?.confirmed, false);
  assert.match(r.report.halt?.reason ?? '', /exit not confirmed/);
  assert.equal(r.cleanup.status, 'ok');
});

test('A06: a manually added second job is rejected as redelivery evidence', async (t) => {
  if (!requireDocker(t)) return;
  const r = await runScenario({
    config: config(),
    scenario: 'post-commit-crash',
    processor: 'unsafe',
    testHooks: { afterFault: async (h) => void (await h.addExtraJob({ tenantId: 'tenant-a', operationId: 'credit-0001', amount: 100 })) },
  });
  assert.notEqual(r.outcome, 'PASS');
  assert.notEqual(r.outcome, 'VIOLATION');
  assert.equal(evidence(r, 'single-job-in-queue'), false);
});

test('A07: malformed and wrong-generation IPC is ignored and preserved as diagnostics', async (t) => {
  if (!requireDocker(t)) return;
  const r = await runScenario({ config: config(), scenario: 'post-commit-crash', processor: 'forged-ipc' });
  const rejected = events(r).filter((e) => e.kind === 'ipc.rejected');
  assert.ok(rejected.length >= 4, `expected rejected messages, got ${rejected.length}`);
  assert.ok(r.report.diagnostics.some((d) => /session nonce mismatch/.test(d)));
  // The real (authenticated) checkpoint still drives exactly one fault and a valid unsafe VIOLATION.
  assert.equal(r.outcome, 'VIOLATION', r.report.reasons.join('; '));
  assert.equal(events(r).filter((e) => e.kind === 'fault.sent').length, 1);
});

test('A07: a missing queue observer makes the run inconclusive', async (t) => {
  if (!requireDocker(t)) return;
  const r = await runScenario({ config: config(), scenario: 'post-commit-crash', processor: 'idempotent', testHooks: { dropQueueEvents: ['stalled'] } });
  assert.equal(r.outcome, 'INCONCLUSIVE');
  assert.equal(evidence(r, 'broker-stalled-recovery'), false);
});

test('A08: zero accepted effects is not PASS', async (t) => {
  if (!requireDocker(t)) return;
  const r = await runScenario({ config: config(), scenario: 'baseline', processor: 'noop' });
  assert.equal(r.outcome, 'VIOLATION');
  assert.equal(verdict(r, 'at-most-one-effect'), 'pass');
  assert.equal(verdict(r, 'at-least-one-effect'), 'fail');
});
