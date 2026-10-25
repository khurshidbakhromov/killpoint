import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { resolveConfig, type LabConfig, type ResolvedConfig } from '../../src/config.js';
import { fixtureAdapter } from '../fixtures/adapter.js';
import type { RunResult } from '../../src/core/runner.js';

let cached: boolean | null = null;

/** Integration tests need a real Docker Engine; they skip loudly (never pass) without one. */
export function dockerAvailable(): boolean {
  if (cached === null) {
    try {
      execFileSync('docker', ['compose', 'version'], { stdio: 'ignore', timeout: 15_000 });
      execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore', timeout: 15_000 });
      cached = true;
    } catch {
      cached = false;
    }
  }
  return cached;
}

export function requireDocker(t: TestContext): boolean {
  if (dockerAvailable()) return true;
  t.skip('Docker Engine/Compose unavailable: integration behaviour NOT verified');
  return false;
}

export function config(overrides: Partial<LabConfig> = {}): ResolvedConfig {
  return resolveConfig({ adapter: fixtureAdapter, outputDir: mkdtempSync(join(tmpdir(), 'kp-it-')), ...overrides });
}

export function evidence(result: RunResult, id: string): boolean | undefined {
  return result.report.validity.evidence.find((e) => e.id === id)?.satisfied;
}

export function verdict(result: RunResult, id: string): string | undefined {
  return result.report.invariants.find((i) => i.id === id)?.verdict;
}

export function observed(result: RunResult, id: string): unknown {
  return result.report.invariants.find((i) => i.id === id)?.observed;
}

export function events(result: RunResult): Array<{ kind: string; generation?: string; jobId?: string; data?: Record<string, unknown> }> {
  return readFileSync(result.report.artifacts.events, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

export function artifactTexts(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), 'utf8')]));
}

export function ownedContainers(runId: string): string[] {
  return execFileSync('docker', ['ps', '-a', '-q', '--filter', `label=io.killpoint.run-id=${runId}`], { encoding: 'utf8' }).split('\n').filter(Boolean);
}
