// A10, A11, A13: isolation, interruption and redaction/cleanup scope.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScenario } from '../../src/core/runner.js';
import { artifactTexts, config, observed, ownedContainers, requireDocker } from './helpers.js';
import { SENTINEL } from '../fixtures/processors/leaky.js';

test('A10: two concurrent runs with the same business operation id do not cross-contaminate', async (t) => {
  if (!requireDocker(t)) return;
  const cfg = config();
  const [a, b] = await Promise.all([
    runScenario({ config: cfg, scenario: 'post-commit-crash', processor: 'unsafe' }),
    runScenario({ config: cfg, scenario: 'post-commit-crash', processor: 'idempotent' }),
  ]);
  assert.notEqual(a.runId, b.runId);
  assert.notEqual(a.report.artifacts.dir, b.report.artifacts.dir);
  assert.equal(a.report.operationId, b.report.operationId);
  assert.equal(a.outcome, 'VIOLATION', a.report.reasons.join('; '));
  assert.equal(b.outcome, 'PASS', b.report.reasons.join('; '));
  assert.equal(observed(a, 'exact-account-delta'), 200);
  assert.equal(observed(b, 'exact-account-delta'), 100);
  assert.ok(a.report.processingStarts.every((s) => s.jobId === `job-${a.runId}`));
  assert.ok(b.report.processingStarts.every((s) => s.jobId === `job-${b.runId}`));
});

test('A11: interrupt while waiting for recovery leaves a partial report and no owned workers', async (t) => {
  if (!requireDocker(t)) return;
  const controller = new AbortController();
  const r = await runScenario({
    config: config(),
    scenario: 'post-commit-crash',
    processor: 'unsafe',
    signal: controller.signal,
    testHooks: { onState: (s) => s === 'B_READY' && controller.abort() },
  });
  assert.equal(r.outcome, 'INCONCLUSIVE');
  assert.equal(r.report.halt?.kind, 'interrupted');
  assert.equal(r.report.final, true);
  assert.equal(r.report.fault?.confirmed, true, 'evidence gathered before the interrupt is preserved');
  assert.equal(r.cleanup.steps.find((s) => s.name === 'verify-no-owned-workers')?.ok, true);
  assert.equal(r.cleanup.status, 'ok');
  assert.deepEqual(ownedContainers(r.runId), []);
});

test('A13: secrets never reach default artifacts; unrelated Docker resources survive', async (t) => {
  if (!requireDocker(t)) return;
  const unrelated = `kp-unrelated-${process.pid}-${Date.now()}`;
  execFileSync('docker', ['network', 'create', '--label', 'io.killpoint.run-id=unrelated', unrelated], { stdio: 'ignore' });
  try {
    const r = await runScenario({ config: config(), scenario: 'baseline', processor: 'leaky' });
    const leakFile = join(tmpdir(), `kp-leak-${r.runId}.txt`);
    const password = readFileSync(leakFile, 'utf8');
    rmSync(leakFile);
    assert.ok(password.length >= 16);
    const texts = artifactTexts(r.report.artifacts.dir);
    assert.ok(Object.keys(texts).includes('stderr.log'), 'worker diagnostics were captured');
    for (const [name, text] of Object.entries(texts)) {
      assert.ok(!text.includes(password), `${name} contains the database password`);
      assert.ok(!text.includes(SENTINEL), `${name} contains the sentinel secret`);
    }
    assert.ok(texts['stderr.log']!.includes('[REDACTED]'));
    assert.equal(r.report.job?.state, 'failed');
    assert.equal(r.cleanup.status, 'ok');
    const still = execFileSync('docker', ['network', 'ls', '-q', '--filter', `name=${unrelated}`], { encoding: 'utf8' }).trim();
    assert.ok(still.length > 0, 'unrelated network was removed');
  } finally {
    execFileSync('docker', ['network', 'rm', unrelated], { stdio: 'ignore' });
  }
});

test('workerExecArgv reaches both worker generations and is recorded in the manifest', async (t) => {
  if (!requireDocker(t)) return;
  const { REQUIRED_FLAG } = await import('../fixtures/processors/execargv-check.js');
  const r = await runScenario({ config: config({ workerExecArgv: [REQUIRED_FLAG] }), scenario: 'post-commit-crash', processor: 'execargv-check' });
  assert.equal(r.outcome, 'PASS', r.report.reasons.join('; '));
  assert.deepEqual(r.report.processingStarts.map((s) => s.generation), ['A', 'B']);
  const manifest = JSON.parse(readFileSync(r.report.artifacts.manifest, 'utf8'));
  assert.deepEqual(manifest.workerExecArgv, [REQUIRED_FLAG]);
  // Without the flag the fixture refuses to start, so the run cannot pass.
  const without = await runScenario({ config: config(), scenario: 'baseline', processor: 'execargv-check' });
  assert.equal(without.outcome, 'ERROR');
});
