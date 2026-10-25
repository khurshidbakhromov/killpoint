import { execFile } from 'node:child_process';

export interface ExecResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Run a binary without a shell. Never rejects; inspect `ok`. */
export function run(
  file: string,
  args: readonly string[],
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv; cwd?: string; signal?: AbortSignal } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        timeout: opts.timeoutMs ?? 30_000,
        env: opts.env ?? process.env,
        cwd: opts.cwd,
        signal: opts.signal,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : error ? null : 0;
        resolve({ ok: !error, code, stdout: String(stdout), stderr: String(stderr), ...(error ? { error: error.message } : {}) });
      },
    );
  });
}
