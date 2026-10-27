import { accessSync, constants, mkdirSync, readFileSync } from 'node:fs';
import { run } from './exec.js';

export const SUPPORTED_NODE_MAJORS = [24, 26];

export interface PreflightCheck {
  id: string;
  ok: boolean;
  detail: string;
  /** Warnings are reported but do not block a run. */
  severity: 'error' | 'warning';
}

export interface PreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
  environment: {
    platform: string;
    arch: string;
    wsl: boolean;
    node: string;
    docker?: string;
    compose?: string;
  };
}

export interface PreflightOptions {
  outputDir: string;
  dockerCommand?: string;
  /** Test seam for unsupported-platform behaviour. */
  platform?: NodeJS.Platform;
}

function detectWsl(): boolean {
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

/** Read-only environment checks. Never installs or modifies anything outside outputDir. */
export async function preflight(opts: PreflightOptions): Promise<PreflightResult> {
  const platform = opts.platform ?? process.platform;
  const docker = opts.dockerCommand ?? 'docker';
  const checks: PreflightCheck[] = [];
  const wsl = platform === 'linux' && detectWsl();
  const environment: PreflightResult['environment'] = { platform, arch: process.arch, wsl, node: process.versions.node };

  checks.push({
    id: 'platform',
    severity: 'error',
    ok: platform === 'linux',
    detail:
      platform === 'linux'
        ? `linux${wsl ? ' (WSL2)' : ''} supported`
        : `platform "${platform}" is not supported in v0.1 (Linux only; macOS signal/process behaviour has not been exercised, native Windows is unsupported)`,
  });

  const major = Number(process.versions.node.split('.')[0]);
  checks.push({
    id: 'node',
    severity: major < 24 ? 'error' : 'warning',
    ok: SUPPORTED_NODE_MAJORS.includes(major),
    detail: SUPPORTED_NODE_MAJORS.includes(major)
      ? `Node ${process.versions.node} (tested major)`
      : `Node ${process.versions.node} is not a tested major (tested: ${SUPPORTED_NODE_MAJORS.join(', ')})`,
  });

  if (platform === 'linux') {
    const version = await run(docker, ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 15_000 });
    environment.docker = version.ok ? version.stdout.trim() : undefined;
    checks.push({
      id: 'docker',
      severity: 'error',
      ok: version.ok,
      detail: version.ok ? `Docker Engine ${version.stdout.trim()}` : `Docker Engine unavailable via "${docker}": ${(version.stderr || version.error || '').trim().slice(0, 300)}`,
    });
    const compose = await run(docker, ['compose', 'version', '--short'], { timeoutMs: 15_000 });
    environment.compose = compose.ok ? compose.stdout.trim() : undefined;
    checks.push({
      id: 'compose',
      severity: 'error',
      ok: compose.ok,
      detail: compose.ok ? `Docker Compose ${compose.stdout.trim()}` : 'Docker Compose plugin unavailable',
    });
  }

  try {
    mkdirSync(opts.outputDir, { recursive: true });
    accessSync(opts.outputDir, constants.W_OK);
    checks.push({ id: 'output-dir', severity: 'error', ok: true, detail: `${opts.outputDir} is writable` });
  } catch (error) {
    checks.push({ id: 'output-dir', severity: 'error', ok: false, detail: `${opts.outputDir} is not writable: ${(error as Error).message}` });
  }

  return { ok: checks.every((c) => c.ok || c.severity === 'warning'), checks, environment };
}
