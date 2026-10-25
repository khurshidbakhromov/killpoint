import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../infra/exec.js';
import { COMPOSE_FILE, type ContainerIdentity } from '../infra/compose.js';
import { bullmqVersion } from '../adapters/bullmq.js';
import { sha256File } from '../config.js';
import type { JsonObject } from './events.js';
import type { ScenarioKind } from './scenario.js';

const require = createRequire(import.meta.url);
const PACKAGE_JSON = fileURLToPath(new URL('../../../package.json', import.meta.url));

export const MANIFEST_SCHEMA_VERSION = 1;

export function toolInfo(): { name: string; version: string } {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { name: string; version: string };
  return { name: pkg.name, version: pkg.version };
}

export interface Fingerprints {
  configPath: string | null;
  config: string | null;
  processorModule: string;
  composeFile: string;
  lockfile: string | null;
}

export interface Manifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  runId: string;
  scenario: ScenarioKind;
  processor: string;
  adapterId: string;
  createdAt: string;
  tool: { name: string; version: string };
  source: { cwd: string; gitCommit: string | null; gitDirty: boolean | null };
  fingerprints: Fingerprints;
  versions: { node: string; bullmq: string; pg: string; redisServer: string | null; postgresServer: string | null };
  images: ContainerIdentity[];
  environment: JsonObject;
  timing: JsonObject;
  deadlines: JsonObject;
  ownedResources: { composeProject: string; queuePrefix: string; queueName: string; namespace: string; jobId: string; workers: Array<{ generation: string; pid: number | null }> };
  cleanup: { command: string; manual: string };
  rerunOf: string | null;
  inputsChanged: boolean;
}

export async function gitState(cwd: string): Promise<{ gitCommit: string | null; gitDirty: boolean | null }> {
  const head = await run('git', ['rev-parse', 'HEAD'], { cwd, timeoutMs: 5000 });
  if (!head.ok) return { gitCommit: null, gitDirty: null };
  const status = await run('git', ['status', '--porcelain'], { cwd, timeoutMs: 5000 });
  return { gitCommit: head.stdout.trim(), gitDirty: status.ok ? status.stdout.trim().length > 0 : null };
}

export function fingerprints(configPath: string | null, configSha: string | null, processorModule: string, cwd: string): Fingerprints {
  const lock = join(cwd, 'package-lock.json');
  return {
    configPath,
    config: configSha,
    processorModule: sha256File(processorModule),
    composeFile: sha256File(COMPOSE_FILE),
    lockfile: existsSync(lock) ? sha256File(lock) : null,
  };
}

export function libraryVersions(): { node: string; bullmq: string; pg: string } {
  return {
    node: process.versions.node,
    bullmq: bullmqVersion(),
    pg: (require('pg/package.json') as { version: string }).version,
  };
}

/** Differences that make a recorded case incompatible with a bounded rerun. */
export function rerunDifferences(recorded: Manifest, current: { fingerprints: Fingerprints; versions: { node: string; bullmq: string; pg: string }; tool: { version: string } }): string[] {
  const diffs: string[] = [];
  const keys: Array<keyof Fingerprints> = ['config', 'processorModule', 'composeFile', 'lockfile'];
  for (const key of keys) {
    if (recorded.fingerprints[key] !== current.fingerprints[key]) diffs.push(`fingerprint ${key} changed`);
  }
  for (const key of ['node', 'bullmq', 'pg'] as const) {
    if (recorded.versions[key] !== current.versions[key]) diffs.push(`${key} ${recorded.versions[key]} -> ${current.versions[key]}`);
  }
  if (recorded.tool.version !== current.tool.version) diffs.push(`crash-retry-lab ${recorded.tool.version} -> ${current.tool.version}`);
  return diffs;
}
