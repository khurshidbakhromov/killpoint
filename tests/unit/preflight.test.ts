import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preflight } from '../../src/infra/preflight.js';
import { runScenario } from '../../src/core/runner.js';
import { resolveConfig } from '../../src/config.js';
import { exitCodeFor } from '../../src/core/outcomes.js';
import { createLedgerAdapter } from '../../examples/ledger/adapter.js';

const out = (): string => mkdtempSync(join(tmpdir(), 'crl-unit-'));

test('A12: native Windows and macOS fail preflight with a clear message', async () => {
  for (const platform of ['win32', 'darwin'] as const) {
    const r = await preflight({ outputDir: out(), platform });
    assert.equal(r.ok, false);
    assert.match(r.checks.find((c) => c.id === 'platform')!.detail, /not supported in v0\.1/);
  }
});

test('A12: missing Docker binary fails preflight', async () => {
  const r = await preflight({ outputDir: out(), dockerCommand: '/nonexistent/docker-crl-test' });
  assert.equal(r.ok, false);
  assert.equal(r.checks.find((c) => c.id === 'docker')!.ok, false);
});

test('A12: a run on an unsupported platform is ERROR, exit 2, with a final report and no fallback', async () => {
  const config = resolveConfig({ adapter: createLedgerAdapter(), outputDir: out() });
  const result = await runScenario({ config, scenario: 'post-commit-crash', processor: 'unsafe', testHooks: { platform: 'win32' } });
  assert.equal(result.outcome, 'ERROR');
  assert.equal(exitCodeFor(result.outcome), 2);
  assert.ok(existsSync(result.reportPath));
  const report = JSON.parse(readFileSync(result.reportPath, 'utf8'));
  assert.equal(report.final, true);
  assert.equal(report.halt.kind, 'error');
  assert.match(report.halt.reason, /preflight failed/);
  assert.equal(report.invariants.length, 0);
});

test('A12: a run with a missing docker binary is ERROR', async () => {
  const config = resolveConfig({ adapter: createLedgerAdapter(), outputDir: out(), dockerCommand: '/nonexistent/docker-crl-test' });
  const result = await runScenario({ config, scenario: 'baseline', processor: 'unsafe' });
  assert.equal(result.outcome, 'ERROR');
});
