import { readFileSync } from 'node:fs';
import type { ResolvedConfig } from '../config.js';
import { stopInfrastructure, type CleanupStep } from '../infra/compose.js';
import { compareExpectations, type ComparisonCase } from './outcomes.js';
import { fingerprints, libraryVersions, rerunDifferences, toolInfo, type Manifest } from './manifest.js';
import { runScenario, type RunOptions, type RunResult } from './runner.js';

export interface ComparisonResult {
  ok: boolean;
  exitCode: 0 | 1 | 2;
  cases: ComparisonCase[];
  mismatches: string[];
  runs: RunResult[];
}

/**
 * Baseline (unsafe, no fault) must PASS, unsafe S1 must be a valid VIOLATION and
 * idempotent S1 must PASS. Individual reports keep their own outcomes.
 */
export async function runDemoComparison(
  config: ResolvedConfig,
  opts: Pick<RunOptions, 'signal' | 'onProgress'> & { unsafe?: string; safe?: string } = {},
): Promise<ComparisonResult> {
  const unsafe = opts.unsafe ?? 'unsafe';
  const safe = opts.safe ?? 'idempotent';
  const plan: Array<{ name: string; scenario: RunOptions['scenario']; processor: string; expected: ComparisonCase['expected'] }> = [
    { name: `baseline / ${unsafe}`, scenario: 'baseline', processor: unsafe, expected: 'PASS' },
    { name: `post-commit-crash / ${unsafe}`, scenario: 'post-commit-crash', processor: unsafe, expected: 'VIOLATION' },
    { name: `post-commit-crash / ${safe}`, scenario: 'post-commit-crash', processor: safe, expected: 'PASS' },
  ];
  const runs: RunResult[] = [];
  const cases: ComparisonCase[] = [];
  for (const item of plan) {
    if (opts.signal?.aborted) break;
    const result = await runScenario({ config, scenario: item.scenario, processor: item.processor, ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.onProgress ? { onProgress: opts.onProgress } : {}) });
    runs.push(result);
    cases.push({ name: item.name, expected: item.expected, observed: result.outcome });
  }
  const verdict = compareExpectations(cases);
  if (cases.length < plan.length) {
    return { ok: false, exitCode: 2, cases, mismatches: [...verdict.mismatches, 'comparison interrupted before all cases ran'], runs };
  }
  return { ...verdict, cases, runs };
}

export function readManifest(path: string): Manifest {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
  if (manifest.schemaVersion !== 1 || typeof manifest.runId !== 'string') throw new Error(`${path} is not a crash-retry-lab manifest`);
  return manifest;
}

export interface RerunCheck {
  compatible: boolean;
  differences: string[];
}

/** Compare recorded inputs against the current environment before a bounded rerun. */
export function checkRerun(manifest: Manifest, config: ResolvedConfig): RerunCheck {
  const processorModule = config.adapter.processors[manifest.processor];
  if (!processorModule) return { compatible: false, differences: [`processor "${manifest.processor}" no longer exists in the adapter`] };
  if (config.adapter.id !== manifest.adapterId) return { compatible: false, differences: [`adapter ${manifest.adapterId} -> ${config.adapter.id}`] };
  const differences = rerunDifferences(manifest, {
    fingerprints: fingerprints(config.source.path, config.source.sha256, processorModule, manifest.source.cwd),
    versions: libraryVersions(),
    tool: toolInfo(),
  });
  return { compatible: differences.length === 0, differences };
}

/** Scoped recovery after a runner crash: remove only the compose project recorded in the manifest. */
export async function cleanupFromManifest(manifest: Manifest, docker = 'docker'): Promise<CleanupStep[]> {
  return stopInfrastructure({ runId: manifest.runId, docker });
}
