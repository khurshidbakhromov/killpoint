import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Redactor } from '../../src/reporting/redact.js';
import { ConfigError, minimumRecoveryMs, resolveConfig } from '../../src/config.js';
import { createLedgerAdapter } from '../../examples/ledger/adapter.js';
import { validateReport } from '../../src/reporting/schema.js';

const SENTINEL = 'SENTINEL-s3cr3t-7f9a';

test('redacts known secrets and credential shapes recursively', () => {
  const r = new Redactor([SENTINEL]);
  const out = r.redact({
    a: `failed with ${SENTINEL}`,
    nested: [{ url: 'postgres://crl:hunter22@127.0.0.1:5432/crl' }, 'password=abc123', 'token: "xyz987"'],
    n: 5,
  });
  const text = JSON.stringify(out);
  assert.ok(!text.includes(SENTINEL));
  assert.ok(!text.includes('hunter22'));
  assert.ok(!text.includes('abc123'));
  assert.ok(!text.includes('xyz987'));
  assert.equal(out.n, 5);
});

test('ignores trivially short secrets that would redact normal words', () => {
  const r = new Redactor(['a']);
  assert.equal(r.redactString('banana'), 'banana');
});

test('config: defaults are valid and labelled test-only', () => {
  const c = resolveConfig({ adapter: createLedgerAdapter() });
  assert.equal(c.timing.maxStalledCount, 1);
  assert.match(c.timing.label, /test-only/);
  assert.ok(c.deadlines.recoveryMs >= minimumRecoveryMs(c.timing));
});

test('config: rejects a recovery deadline shorter than lock expiry + stalled scans', () => {
  assert.throws(() => resolveConfig({ adapter: createLedgerAdapter(), timing: { lockDurationMs: 5000 }, deadlines: { recoveryMs: 6000 } }), ConfigError);
});

test('config: rejects unknown keys, bad types and non-compiled processors', () => {
  assert.throws(() => resolveConfig({ adapter: createLedgerAdapter(), bogus: 1 } as never), ConfigError);
  assert.throws(() => resolveConfig({ adapter: createLedgerAdapter(), timing: { lockDurationMs: 'x' } } as never), ConfigError);
  assert.throws(() => resolveConfig({ adapter: createLedgerAdapter({ ts: '/tmp/processor.ts' }) }), /compiled JavaScript/);
  assert.throws(() => resolveConfig({ adapter: createLedgerAdapter({ rel: './processor.js' }) }), /absolute path/);
  assert.throws(() => resolveConfig({ adapter: { id: 'x' } } as never), ConfigError);
});

test('report schema rejects an incomplete report', () => {
  assert.ok(validateReport({ schemaVersion: 1 }).length > 0);
});
