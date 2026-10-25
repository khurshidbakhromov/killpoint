import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envelope, parseRunnerMessage, parseWorkerMessage } from '../../src/control/ipc.js';

const identity = { session: 'nonce-a', runId: 'run-1', generation: 'A' };
const good = { ...envelope(identity), type: 'CHECKPOINT_REACHED', jobId: 'job-1', checkpoint: 'effect-committed', operationId: 'op' };

test('accepts a well-formed message with matching identity', () => {
  const r = parseWorkerMessage(good, identity);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.message.checkpoint, 'effect-committed');
});

test('rejects wrong generation: a B checkpoint can never satisfy A', () => {
  const r = parseWorkerMessage({ ...good, generation: 'B' }, identity);
  assert.deepEqual(r, { ok: false, reason: 'generation mismatch (got B)' });
});

test('rejects wrong session, run, protocol and version', () => {
  assert.equal(parseWorkerMessage({ ...good, session: 'other' }, identity).ok, false);
  assert.equal(parseWorkerMessage({ ...good, runId: 'run-2' }, identity).ok, false);
  assert.equal(parseWorkerMessage({ ...good, protocol: 'x' }, identity).ok, false);
  assert.equal(parseWorkerMessage({ ...good, version: 2 }, identity).ok, false);
});

test('rejects malformed messages (A07)', () => {
  for (const raw of [null, 'CHECKPOINT_REACHED', 42, [], { ...good, type: 'KILL' }, { ...good, jobId: 7 }, { ...good, jobId: undefined }, { ...good, checkpoint: '' }, { ...good, attemptsStarted: -1 }, { ...good, error: 'boom' }]) {
    assert.equal(parseWorkerMessage(raw, identity).ok, false, JSON.stringify(raw));
  }
});

test('drops unknown extra fields', () => {
  const r = parseWorkerMessage({ ...good, injected: { evil: true } }, identity);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal('injected' in r.message, false);
});

test('child side ignores messages from another session', () => {
  assert.equal(parseRunnerMessage({ ...envelope(identity), type: 'RELEASE_CHECKPOINT' }, 'nonce-a')?.type, 'RELEASE_CHECKPOINT');
  assert.equal(parseRunnerMessage({ ...envelope(identity), type: 'RELEASE_CHECKPOINT' }, 'nonce-b'), null);
  assert.equal(parseRunnerMessage({ ...envelope(identity), type: 'EVAL' }, 'nonce-a'), null);
});
