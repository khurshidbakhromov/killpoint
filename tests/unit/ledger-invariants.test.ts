import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLedger } from '../../examples/ledger/adapter.js';

const snap = (balance: number, effects: number, control = { balance: 500, acceptedEffects: 1, operationReceipts: 1 }) => ({
  target: { balance, operationEffects: effects, acceptedEffects: effects },
  control,
});

const verdicts = (initial: ReturnType<typeof snap>, final: ReturnType<typeof snap>) =>
  Object.fromEntries(evaluateLedger(initial, final).map((v) => [v.id, v.verdict]));

test('single effect passes all ledger invariants', () => {
  assert.deepEqual(verdicts(snap(0, 0), snap(100, 1)), {
    'at-most-one-effect': 'pass',
    'at-least-one-effect': 'pass',
    'exact-account-delta': 'pass',
    'no-unrelated-changes': 'pass',
  });
});

test('duplicate effect violates at-most-one and delta', () => {
  const v = verdicts(snap(0, 0), snap(200, 2));
  assert.equal(v['at-most-one-effect'], 'fail');
  assert.equal(v['exact-account-delta'], 'fail');
});

test('zero effects is not success (A08)', () => {
  const v = verdicts(snap(0, 0), snap(0, 0));
  assert.equal(v['at-most-one-effect'], 'pass');
  assert.equal(v['at-least-one-effect'], 'fail');
  assert.equal(v['exact-account-delta'], 'fail');
});

test('collateral change to the control tenant is detected', () => {
  const v = verdicts(snap(0, 0), snap(100, 1, { balance: 600, acceptedEffects: 2, operationReceipts: 1 }));
  assert.equal(v['no-unrelated-changes'], 'fail');
});

test('missing observations are not-evaluated, never pass', () => {
  const v = Object.fromEntries(evaluateLedger({}, {}).map((x) => [x.id, x.verdict]));
  assert.ok(Object.values(v).every((x) => x === 'not-evaluated'));
});
