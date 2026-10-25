import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  batchExitCode,
  compareExpectations,
  evaluate,
  exitCodeFor,
  finalizeOutcome,
  requiredEvidence,
  type EvidenceCheck,
  type InvariantVerdict,
} from '../../src/core/outcomes.js';

const allEvidence = (scenario: 'post-commit-crash' | 'baseline', except: string[] = []): EvidenceCheck[] =>
  requiredEvidence(scenario).map((id) => ({ id, satisfied: !except.includes(id), detail: 'test' }));

const inv = (id: string, verdict: InvariantVerdict['verdict'], category: InvariantVerdict['category'] = 'business'): InvariantVerdict => ({
  id,
  description: id,
  category,
  expected: 1,
  observed: 1,
  verdict,
});

test('valid S1 with all invariants passing is PASS', () => {
  const r = evaluate({ scenario: 'post-commit-crash', halt: null, evidence: allEvidence('post-commit-crash'), invariants: [inv('job', 'pass', 'kit'), inv('one', 'pass')], livenessTimeout: false });
  assert.equal(r.outcome, 'PASS');
  assert.equal(r.valid, true);
});

test('valid S1 with a failing business invariant is VIOLATION', () => {
  const r = evaluate({ scenario: 'post-commit-crash', halt: null, evidence: allEvidence('post-commit-crash'), invariants: [inv('job', 'pass', 'kit'), inv('at-most-one', 'fail')], livenessTimeout: false });
  assert.equal(r.outcome, 'VIOLATION');
  assert.equal(r.valid, true);
});

for (const missing of ['commit-independently-confirmed', 'worker-a-exit-confirmed', 'broker-stalled-recovery', 'redelivered-to-worker-b', 'single-job-in-queue', 'checkpoint-reached']) {
  test(`missing evidence ${missing} can never PASS (A04-A07)`, () => {
    const r = evaluate({ scenario: 'post-commit-crash', halt: null, evidence: allEvidence('post-commit-crash', [missing]), invariants: [inv('one', 'pass')], livenessTimeout: false });
    assert.equal(r.outcome, 'INCONCLUSIVE');
    assert.deepEqual(r.missingEvidence, [missing]);
  });
}

test('missing evidence plus a failing invariant is INCONCLUSIVE, not VIOLATION', () => {
  const r = evaluate({ scenario: 'post-commit-crash', halt: null, evidence: allEvidence('post-commit-crash', ['worker-a-exit-confirmed']), invariants: [inv('one', 'fail')], livenessTimeout: false });
  assert.equal(r.outcome, 'INCONCLUSIVE');
});

test('skipping all assertions cannot produce PASS', () => {
  const none = evaluate({ scenario: 'post-commit-crash', halt: null, evidence: allEvidence('post-commit-crash'), invariants: [], livenessTimeout: false });
  assert.equal(none.outcome, 'INCONCLUSIVE');
  const kitOnly = evaluate({ scenario: 'post-commit-crash', halt: null, evidence: allEvidence('post-commit-crash'), invariants: [inv('job', 'pass', 'kit')], livenessTimeout: false });
  assert.equal(kitOnly.outcome, 'INCONCLUSIVE');
});

test('not-evaluated invariant is INCONCLUSIVE', () => {
  const r = evaluate({ scenario: 'baseline', halt: null, evidence: allEvidence('baseline'), invariants: [inv('one', 'pass'), inv('delta', 'not-evaluated')], livenessTimeout: false });
  assert.equal(r.outcome, 'INCONCLUSIVE');
});

test('halts map to ERROR or INCONCLUSIVE regardless of invariants', () => {
  const base = { scenario: 'post-commit-crash' as const, evidence: allEvidence('post-commit-crash'), invariants: [inv('one', 'pass')], livenessTimeout: false };
  assert.equal(evaluate({ ...base, halt: { kind: 'error', reason: 'x' } }).outcome, 'ERROR');
  assert.equal(evaluate({ ...base, halt: { kind: 'inconclusive', reason: 'x' } }).outcome, 'INCONCLUSIVE');
  assert.equal(evaluate({ ...base, halt: { kind: 'interrupted', reason: 'x' } }).outcome, 'INCONCLUSIVE');
});

test('bounded liveness timeout after a valid fault is VIOLATION', () => {
  const r = evaluate({
    scenario: 'post-commit-crash',
    halt: null,
    evidence: allEvidence('post-commit-crash', ['redelivered-to-worker-b', 'job-terminal']),
    invariants: [inv('job', 'fail', 'kit'), inv('one', 'pass')],
    livenessTimeout: true,
  });
  assert.equal(r.outcome, 'VIOLATION');
});

test('liveness timeout without a confirmed fault stays INCONCLUSIVE', () => {
  const r = evaluate({
    scenario: 'post-commit-crash',
    halt: null,
    evidence: allEvidence('post-commit-crash', ['worker-a-exit-confirmed', 'job-terminal']),
    invariants: [inv('one', 'pass')],
    livenessTimeout: true,
  });
  assert.equal(r.outcome, 'INCONCLUSIVE');
});

test('baseline does not require kill or redelivery evidence', () => {
  const ids = requiredEvidence('baseline');
  assert.ok(!ids.includes('fault-delivered'));
  assert.ok(!ids.includes('redelivered-to-worker-b'));
  const r = evaluate({ scenario: 'baseline', halt: null, evidence: allEvidence('baseline'), invariants: [inv('one', 'pass')], livenessTimeout: false });
  assert.equal(r.outcome, 'PASS');
});

test('cleanup failure turns any outcome into ERROR', () => {
  assert.equal(finalizeOutcome('PASS', false), 'ERROR');
  assert.equal(finalizeOutcome('VIOLATION', false), 'ERROR');
  assert.equal(finalizeOutcome('PASS', true), 'PASS');
});

test('exit codes', () => {
  assert.equal(exitCodeFor('PASS'), 0);
  assert.equal(exitCodeFor('VIOLATION'), 1);
  assert.equal(exitCodeFor('INCONCLUSIVE'), 2);
  assert.equal(exitCodeFor('ERROR'), 2);
});

test('batch exit: inconclusive/error dominates violation', () => {
  assert.equal(batchExitCode(['PASS', 'PASS']), 0);
  assert.equal(batchExitCode(['PASS', 'VIOLATION']), 1);
  assert.equal(batchExitCode(['VIOLATION', 'INCONCLUSIVE']), 2);
  assert.equal(batchExitCode(['ERROR', 'PASS']), 2);
  assert.equal(batchExitCode([]), 2);
});

test('demo comparison semantics and negative controls', () => {
  const expected = (observed: ['PASS' | 'VIOLATION' | 'INCONCLUSIVE' | 'ERROR', 'PASS' | 'VIOLATION' | 'INCONCLUSIVE' | 'ERROR', 'PASS' | 'VIOLATION' | 'INCONCLUSIVE' | 'ERROR']) =>
    compareExpectations([
      { name: 'baseline', expected: 'PASS', observed: observed[0] },
      { name: 'unsafe', expected: 'VIOLATION', observed: observed[1] },
      { name: 'safe', expected: 'PASS', observed: observed[2] },
    ]);
  assert.equal(expected(['PASS', 'VIOLATION', 'PASS']).exitCode, 0);
  assert.equal(expected(['PASS', 'PASS', 'PASS']).exitCode, 1, 'unsafe S1 PASS fails the comparison');
  assert.equal(expected(['PASS', 'VIOLATION', 'VIOLATION']).exitCode, 1, 'safe S1 VIOLATION fails the comparison');
  assert.equal(expected(['PASS', 'INCONCLUSIVE', 'PASS']).exitCode, 2, 'any inconclusive fails the comparison');
  assert.equal(compareExpectations([]).ok, false);
});
