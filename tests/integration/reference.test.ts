// A01-A03: the reference comparison against real Redis, PostgreSQL and owned worker processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from '../../src/core/runner.js';
import { config, events, evidence, observed, ownedContainers, requireDocker, verdict } from './helpers.js';

test('A01: no-fault unsafe baseline passes with one attempt and one effect', async (t) => {
  if (!requireDocker(t)) return;
  const r = await runScenario({ config: config(), scenario: 'baseline', processor: 'unsafe' });
  assert.equal(r.outcome, 'PASS', r.report.reasons.join('; '));
  assert.equal(r.report.job?.state, 'completed');
  assert.equal(r.report.processingStarts.length, 1);
  assert.equal(observed(r, 'at-most-one-effect'), 1);
  assert.equal(observed(r, 'exact-account-delta'), 100);
  assert.equal(r.report.fault, null);
  assert.equal(r.cleanup.status, 'ok');
  assert.deepEqual(ownedContainers(r.runId), []);
});

test('A02: unsafe processor under post-commit SIGKILL is a valid VIOLATION', async (t) => {
  if (!requireDocker(t)) return;
  const r = await runScenario({ config: config(), scenario: 'post-commit-crash', processor: 'unsafe' });
  assert.equal(r.outcome, 'VIOLATION', r.report.reasons.join('; '));
  assert.equal(r.valid, true);
  for (const id of ['commit-independently-confirmed', 'fault-delivered', 'worker-a-exit-confirmed', 'job-active-after-kill', 'broker-stalled-recovery', 'redelivered-to-worker-b', 'single-job-in-queue']) {
    assert.equal(evidence(r, id), true, id);
  }
  assert.equal(r.report.fault?.exit?.signal, 'SIGKILL');
  assert.equal(verdict(r, 'at-most-one-effect'), 'fail');
  assert.equal(observed(r, 'at-most-one-effect'), 2);
  assert.equal(observed(r, 'exact-account-delta'), 200);
  assert.deepEqual(r.report.processingStarts.map((s) => s.generation), ['A', 'B']);
  assert.equal(r.report.job?.state, 'completed');
  assert.equal(r.report.job?.stalledCounter, 1);
  // Commit was confirmed independently before the fault was sent.
  const kinds = events(r).map((e) => e.kind);
  assert.ok(kinds.indexOf('observe.at-checkpoint') < kinds.indexOf('fault.sent'));
  assert.equal(r.cleanup.status, 'ok');
});

test('A03: idempotent processor under the same fault passes', async (t) => {
  if (!requireDocker(t)) return;
  const r = await runScenario({ config: config(), scenario: 'post-commit-crash', processor: 'idempotent' });
  assert.equal(r.outcome, 'PASS', r.report.reasons.join('; '));
  assert.equal(r.valid, true);
  assert.equal(observed(r, 'at-most-one-effect'), 1);
  assert.equal(observed(r, 'exact-account-delta'), 100);
  assert.deepEqual(r.report.processingStarts.map((s) => s.generation), ['A', 'B']);
  const attempts = (r.observations.final as { attempts: Array<{ generation: string; status: string }> }).attempts;
  assert.deepEqual(attempts.map((a) => a.generation), ['A', 'B']);
  assert.equal(attempts[0]!.status, 'started', 'A never finished: it was killed');
  assert.equal(attempts[1]!.status, 'finished-deduplicated');
  assert.equal(r.report.job?.state, 'completed');
});
