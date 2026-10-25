import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IllegalTransitionError, ScenarioStateMachine } from '../../src/core/scenario.js';

const S1 = ['PREFLIGHT_OK', 'INFRA_READY', 'A_READY', 'JOB_SUBMITTED', 'COMMIT_CONFIRMED', 'A_EXIT_CONFIRMED', 'B_READY', 'REDELIVERY_CONFIRMED', 'JOB_TERMINAL', 'OBSERVED', 'REPORTED', 'CLEANED'] as const;

test('S1 happy path is legal', () => {
  const m = new ScenarioStateMachine('post-commit-crash');
  for (const s of S1) m.transition(s);
  assert.equal(m.state, 'CLEANED');
});

test('S1 cannot skip the commit confirmation or the kill', () => {
  const m = new ScenarioStateMachine('post-commit-crash');
  for (const s of ['PREFLIGHT_OK', 'INFRA_READY', 'A_READY', 'JOB_SUBMITTED'] as const) m.transition(s);
  assert.throws(() => m.transition('A_EXIT_CONFIRMED'), IllegalTransitionError);
  assert.throws(() => m.transition('B_READY'), IllegalTransitionError);
  assert.throws(() => m.transition('OBSERVED'), IllegalTransitionError);
});

test('a duplicate checkpoint cannot re-trigger the fault transition', () => {
  const m = new ScenarioStateMachine('post-commit-crash');
  for (const s of ['PREFLIGHT_OK', 'INFRA_READY', 'A_READY', 'JOB_SUBMITTED', 'COMMIT_CONFIRMED'] as const) m.transition(s);
  assert.equal(m.canTransition('COMMIT_CONFIRMED'), false);
});

test('baseline has its own path and cannot claim S1 states', () => {
  const m = new ScenarioStateMachine('baseline');
  for (const s of ['PREFLIGHT_OK', 'INFRA_READY', 'A_READY', 'JOB_SUBMITTED'] as const) m.transition(s);
  assert.throws(() => m.transition('COMMIT_CONFIRMED'), IllegalTransitionError);
  m.transition('JOB_TERMINAL');
  m.transition('OBSERVED');
  m.transition('REPORTED');
  m.transition('CLEANED');
});

test('any active state may halt, then report and clean', () => {
  const m = new ScenarioStateMachine('post-commit-crash');
  m.transition('PREFLIGHT_OK');
  m.transition('HALTED');
  assert.equal(m.canTransition('HALTED'), false);
  assert.throws(() => m.transition('INFRA_READY'), IllegalTransitionError);
  m.transition('REPORTED');
  m.transition('CLEANED');
});
