import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { run, type ExecResult } from './exec.js';
import type { PostgresSettings, RedisSettings } from '../control/ipc.js';

export const COMPOSE_FILE = fileURLToPath(new URL('../../../compose.yaml', import.meta.url));
export const RUN_LABEL = 'io.killpoint.run-id';
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{5,62}$/;
const PLACEHOLDER_PASSWORD = 'cleanup-placeholder';

export interface ContainerIdentity {
  service: string;
  containerId: string;
  imageRef: string;
  imageId: string;
  repoDigests: string[];
}

export interface Infrastructure {
  project: string;
  redis: RedisSettings;
  postgres: PostgresSettings;
  containers: ContainerIdentity[];
}

export interface ComposeOptions {
  runId: string;
  docker?: string;
  composeFile?: string;
}

export function projectName(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error(`invalid run id for compose project: ${runId}`);
  return `kp-${runId}`;
}

function composeArgs(opts: ComposeOptions, ...rest: string[]): string[] {
  return ['compose', '-p', projectName(opts.runId), '-f', opts.composeFile ?? COMPOSE_FILE, ...rest];
}

function composeEnv(runId: string, pgPassword: string): NodeJS.ProcessEnv {
  return { ...process.env, KP_RUN_ID: runId, KP_PG_PASSWORD: pgPassword };
}

function failure(step: string, result: ExecResult): Error {
  return new Error(`${step} failed: ${(result.stderr || result.error || '').trim().slice(0, 1500)}`);
}

async function discoverPort(opts: ComposeOptions, env: NodeJS.ProcessEnv, service: string, port: number): Promise<number> {
  const result = await run(opts.docker ?? 'docker', composeArgs(opts, 'port', service, String(port)), { env });
  if (!result.ok) throw failure(`port discovery for ${service}`, result);
  const match = /:(\d+)\s*$/.exec(result.stdout.trim().split('\n')[0] ?? '');
  if (!match) throw new Error(`could not parse published port for ${service}: ${result.stdout.trim()}`);
  return Number(match[1]);
}

async function inspectContainers(opts: ComposeOptions, env: NodeJS.ProcessEnv): Promise<ContainerIdentity[]> {
  const docker = opts.docker ?? 'docker';
  const ids = await run(docker, composeArgs(opts, 'ps', '-q'), { env });
  if (!ids.ok) throw failure('compose ps', ids);
  const out: ContainerIdentity[] = [];
  for (const containerId of ids.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
    const info = await run(docker, ['inspect', '--format', '{{index .Config.Labels "com.docker.compose.service"}}|{{.Config.Image}}|{{.Image}}', containerId]);
    if (!info.ok) throw failure('docker inspect', info);
    const [service = '', imageRef = '', imageId = ''] = info.stdout.trim().split('|');
    const digests = await run(docker, ['image', 'inspect', '--format', '{{json .RepoDigests}}', imageId]);
    out.push({ service, containerId: containerId.slice(0, 12), imageRef, imageId, repoDigests: digests.ok ? (JSON.parse(digests.stdout) as string[]) : [] });
  }
  return out.sort((a, b) => a.service.localeCompare(b.service));
}

/** Start the run's disposable Redis + PostgreSQL and wait for container health. */
export async function startInfrastructure(
  opts: ComposeOptions & { pgPassword: string; deadlineMs: number; signal?: AbortSignal },
): Promise<Infrastructure> {
  const env = composeEnv(opts.runId, opts.pgPassword);
  const up = await run(opts.docker ?? 'docker', composeArgs(opts, 'up', '-d', '--wait', '--wait-timeout', String(Math.ceil(opts.deadlineMs / 1000))), {
    env,
    timeoutMs: opts.deadlineMs + 15_000,
    signal: opts.signal,
  });
  if (!up.ok) throw failure('docker compose up', up);
  const [redisPort, pgPort] = await Promise.all([discoverPort(opts, env, 'redis', 6379), discoverPort(opts, env, 'postgres', 5432)]);
  return {
    project: projectName(opts.runId),
    redis: { host: '127.0.0.1', port: redisPort },
    postgres: { host: '127.0.0.1', port: pgPort, user: 'kp', password: opts.pgPassword, database: 'kp' },
    containers: await inspectContainers(opts, env),
  };
}

export interface CleanupStep {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Remove only this run's compose project, after verifying every container in it carries
 * this run's ownership label. Never prunes or touches anything else.
 */
export async function stopInfrastructure(opts: ComposeOptions & { timeoutMs?: number }): Promise<CleanupStep[]> {
  const docker = opts.docker ?? 'docker';
  const project = projectName(opts.runId);
  const env = composeEnv(opts.runId, PLACEHOLDER_PASSWORD);
  const steps: CleanupStep[] = [];

  const listing = await run(docker, ['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', `{{.ID}} {{.Label "${RUN_LABEL}"}}`]);
  if (!listing.ok) {
    steps.push({ name: 'verify-ownership', ok: false, detail: `could not list containers: ${listing.stderr.trim()}` });
    return steps;
  }
  const rows = listing.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const foreign = rows.filter((row) => row.split(' ')[1] !== opts.runId);
  if (foreign.length > 0) {
    steps.push({ name: 'verify-ownership', ok: false, detail: `refusing cleanup: ${foreign.length} container(s) in ${project} lack this run's ownership label` });
    return steps;
  }
  steps.push({ name: 'verify-ownership', ok: true, detail: `${rows.length} owned container(s) in ${project}` });

  const down = await run(docker, composeArgs(opts, 'down', '--volumes', '--remove-orphans', '--timeout', '2'), { env, timeoutMs: opts.timeoutMs ?? 60_000 });
  steps.push({ name: 'compose-down', ok: down.ok, detail: down.ok ? `removed project ${project}` : (down.stderr || down.error || '').trim().slice(0, 500) });

  const remaining = await run(docker, ['ps', '-a', '-q', '--filter', `label=${RUN_LABEL}=${opts.runId}`]);
  const networks = await run(docker, ['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]);
  const leftover = remaining.stdout.trim().split('\n').filter(Boolean).length + networks.stdout.trim().split('\n').filter(Boolean).length;
  steps.push({
    name: 'verify-removed',
    ok: remaining.ok && networks.ok && leftover === 0,
    detail: leftover === 0 ? 'no owned containers or networks remain' : `${leftover} owned resource(s) remain`,
  });
  return steps;
}

/** Real readiness from the runner's side: connect and read the server version, retrying until the deadline. */
export async function waitForPostgres(settings: PostgresSettings, deadlineMs: number): Promise<string> {
  const until = Date.now() + deadlineMs;
  let last: unknown;
  while (Date.now() < until) {
    const client = new pg.Client({ ...settings, connectionTimeoutMillis: 2000 });
    try {
      await client.connect();
      const res = await client.query<{ server_version: string }>('SHOW server_version');
      return res.rows[0]?.server_version ?? 'unknown';
    } catch (error) {
      last = error;
      await new Promise((r) => setTimeout(r, 250));
    } finally {
      await client.end().catch(() => {});
    }
  }
  throw new Error(`PostgreSQL not ready within ${deadlineMs} ms: ${(last as Error)?.message ?? 'unknown'}`);
}
