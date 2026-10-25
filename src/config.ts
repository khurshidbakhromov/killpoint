import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Ajv } from 'ajv';
import { ADAPTER_SCHEMA_VERSION, type ProjectAdapter } from './adapter.js';

export interface Timing {
  lockDurationMs: number;
  stalledIntervalMs: number;
  maxStalledCount: number;
}

export interface Deadlines {
  infraStartMs: number;
  workerReadyMs: number;
  checkpointMs: number;
  killConfirmMs: number;
  /** From confirmed worker-A exit to a terminal job state. Must cover lock expiry + 2 stalled scans. */
  recoveryMs: number;
  /** Baseline: from submission to a terminal job state. */
  completionMs: number;
  stopMs: number;
  cleanupMs: number;
}

export interface LabConfig {
  adapter: ProjectAdapter;
  outputDir?: string;
  timing?: Partial<Timing>;
  deadlines?: Partial<Deadlines>;
  /** Keep unredacted worker stdout/stderr in local-only raw-*.log files. Off by default. */
  captureRawOutput?: boolean;
  dockerCommand?: string;
}

export interface ResolvedConfig {
  adapter: ProjectAdapter;
  outputDir: string;
  timing: Timing & { label: string };
  deadlines: Deadlines;
  captureRawOutput: boolean;
  dockerCommand: string;
  source: { path: string | null; sha256: string | null };
}

export const DEFAULT_TIMING: Timing = { lockDurationMs: 3000, stalledIntervalMs: 1000, maxStalledCount: 1 };
const TIMING_LABEL = 'test-only short lock timings; not production guidance';

/** Recovery margin on top of lock expiry and two stalled-check intervals (worker B start + scheduling). */
export const RECOVERY_MARGIN_MS = 5000;

export function minimumRecoveryMs(timing: Timing): number {
  return timing.lockDurationMs + 2 * timing.stalledIntervalMs + RECOVERY_MARGIN_MS;
}

const timingSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    lockDurationMs: { type: 'integer', minimum: 1000, maximum: 600000 },
    stalledIntervalMs: { type: 'integer', minimum: 250, maximum: 600000 },
    maxStalledCount: { type: 'integer', minimum: 1, maximum: 3 },
  },
} as const;

const deadlineProps = Object.fromEntries(
  ['infraStartMs', 'workerReadyMs', 'checkpointMs', 'killConfirmMs', 'recoveryMs', 'completionMs', 'stopMs', 'cleanupMs'].map((key) => [
    key,
    { type: 'integer', minimum: 100, maximum: 3_600_000 },
  ]),
);

const configSchema = {
  type: 'object',
  required: ['adapter'],
  additionalProperties: false,
  properties: {
    adapter: { type: 'object' },
    outputDir: { type: 'string', minLength: 1 },
    timing: timingSchema,
    deadlines: { type: 'object', additionalProperties: false, properties: deadlineProps },
    captureRawOutput: { type: 'boolean' },
    dockerCommand: { type: 'string', minLength: 1 },
  },
} as const;

const ajv = new Ajv({ allErrors: true });
const validateConfigShape = ajv.compile(configSchema);

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid configuration: ${problems.join('; ')}`);
    this.name = 'ConfigError';
  }
}

export function validateAdapter(adapter: unknown): string[] {
  const problems: string[] = [];
  const a = adapter as Partial<ProjectAdapter> | null;
  if (!a || typeof a !== 'object') return ['adapter must be an object'];
  if (typeof a.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(a.id)) problems.push('adapter.id must be a short identifier');
  if (a.schemaVersion !== ADAPTER_SCHEMA_VERSION) problems.push(`adapter.schemaVersion must be ${ADAPTER_SCHEMA_VERSION}`);
  if (typeof a.open !== 'function') problems.push('adapter.open(ctx) must be a function');
  if (a.checkpoint !== undefined && (typeof a.checkpoint !== 'string' || a.checkpoint.length === 0)) problems.push('adapter.checkpoint must be a non-empty string');
  if (!a.processors || typeof a.processors !== 'object' || Object.keys(a.processors).length === 0) {
    problems.push('adapter.processors must map at least one implementation name to a module path');
  } else {
    for (const [name, path] of Object.entries(a.processors)) {
      if (typeof path !== 'string' || !isAbsolute(path)) problems.push(`processor "${name}" must be an absolute path`);
      else if (!/\.(c|m)?js$/.test(path)) problems.push(`processor "${name}" must be compiled JavaScript (.js/.mjs/.cjs): ${path}`);
      else if (!existsSync(path) || !statSync(path).isFile()) problems.push(`processor "${name}" module not found: ${path}`);
    }
    if (a.defaultProcessor !== undefined && !(a.defaultProcessor in a.processors)) problems.push(`defaultProcessor "${a.defaultProcessor}" is not in processors`);
  }
  return problems;
}

/** Validate configuration and apply defaults. Throws ConfigError with every problem found. */
export function resolveConfig(input: LabConfig, source: ResolvedConfig['source'] = { path: null, sha256: null }): ResolvedConfig {
  const problems: string[] = [];
  if (!validateConfigShape(input)) {
    for (const err of validateConfigShape.errors ?? []) problems.push(`${err.instancePath || '(root)'} ${err.message ?? 'is invalid'}`);
  }
  problems.push(...validateAdapter(input?.adapter));
  if (problems.length > 0) throw new ConfigError(problems);

  const timing = { ...DEFAULT_TIMING, ...input.timing };
  if (timing.stalledIntervalMs > timing.lockDurationMs) problems.push('timing.stalledIntervalMs should not exceed timing.lockDurationMs');
  const deadlines: Deadlines = {
    infraStartMs: 120_000,
    workerReadyMs: 20_000,
    checkpointMs: 20_000,
    killConfirmMs: 5_000,
    recoveryMs: minimumRecoveryMs(timing) + 5_000,
    completionMs: 20_000,
    stopMs: 5_000,
    cleanupMs: 60_000,
    ...input.deadlines,
  };
  if (deadlines.recoveryMs < minimumRecoveryMs(timing)) {
    problems.push(`deadlines.recoveryMs (${deadlines.recoveryMs}) must be >= lockDurationMs + 2*stalledIntervalMs + ${RECOVERY_MARGIN_MS} = ${minimumRecoveryMs(timing)}`);
  }
  if (problems.length > 0) throw new ConfigError(problems);

  return {
    adapter: input.adapter,
    outputDir: resolve(input.outputDir ?? '.killpoint/runs'),
    timing: {
      ...timing,
      label: timing.lockDurationMs < 30_000 || timing.stalledIntervalMs < 30_000 ? TIMING_LABEL : 'BullMQ default-scale timings',
    },
    deadlines,
    captureRawOutput: input.captureRawOutput ?? false,
    dockerCommand: input.dockerCommand ?? 'docker',
    source,
  };
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Load a trusted local config module (default export: LabConfig). This executes local code;
 * configuration is not a sandbox for untrusted modules.
 */
export async function loadConfigFile(path: string): Promise<ResolvedConfig> {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new ConfigError([`config file not found: ${absolute}`]);
  const mod = (await import(pathToFileURL(absolute).href)) as { default?: LabConfig };
  if (!mod.default) throw new ConfigError([`${absolute} must have a default export`]);
  return resolveConfig(mod.default, { path: absolute, sha256: sha256File(absolute) });
}
