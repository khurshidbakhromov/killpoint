import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { envelope, parseWorkerMessage, type ExpectedIdentity, type InitMessage, type WorkerMessage } from './ipc.js';

export const BOOTSTRAP_PATH = fileURLToPath(new URL('./worker-bootstrap.js', import.meta.url));

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface OwnedWorkerHooks {
  onMessage(message: WorkerMessage): void;
  onRejected(reason: string, raw: unknown): void;
  onOutput(stream: 'stdout' | 'stderr', line: string): void;
  onExit(info: ExitInfo): void;
}

/**
 * Handle to one worker process this runner launched. The only process the fault can
 * target is the one behind this handle; there is no PID- or name-based killing.
 */
export class OwnedWorker {
  readonly identity: ExpectedIdentity;
  readonly exited: Promise<ExitInfo>;
  private readonly child: ChildProcess;
  private exitInfo: ExitInfo | null = null;

  constructor(
    readonly generation: string,
    runId: string,
    init: Omit<InitMessage, 'protocol' | 'version' | 'session' | 'runId' | 'generation' | 'type'>,
    private readonly hooks: OwnedWorkerHooks,
    opts: { execArgv?: readonly string[]; bootstrapPath?: string } = {},
  ) {
    this.identity = { session: randomBytes(16).toString('hex'), runId, generation };
    this.child = fork(opts.bootstrapPath ?? BOOTSTRAP_PATH, [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
      // Only flags the trusted config asked for (e.g. a TypeScript loader); never the runner's own.
      execArgv: [...(opts.execArgv ?? [])],
      // Minimal environment: connection settings arrive over IPC, never via env or argv.
      env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' },
    });
    this.exited = new Promise((resolve) => {
      this.child.once('exit', (code, signal) => {
        this.exitInfo = { code, signal };
        hooks.onExit(this.exitInfo);
        resolve(this.exitInfo);
      });
    });
    this.child.on('error', (error) => hooks.onOutput('stderr', `spawn error: ${error.message}`));
    this.child.on('message', (raw) => {
      const parsed = parseWorkerMessage(raw, this.identity);
      if (parsed.ok) hooks.onMessage(parsed.message);
      else hooks.onRejected(parsed.reason, raw);
    });
    for (const stream of ['stdout', 'stderr'] as const) {
      let buffer = '';
      this.child[stream]?.setEncoding('utf8');
      this.child[stream]?.on('data', (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) hooks.onOutput(stream, line);
      });
      this.child[stream]?.on('end', () => buffer && hooks.onOutput(stream, buffer));
    }
    this.child.send({ ...envelope(this.identity), type: 'INIT', ...init } satisfies InitMessage);
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get alive(): boolean {
    return this.exitInfo === null && this.child.exitCode === null && this.child.signalCode === null;
  }

  get exit(): ExitInfo | null {
    return this.exitInfo;
  }

  /** The fault: SIGKILL this exact owned child. Returns whether a signal was delivered. */
  sigkill(): boolean {
    if (!this.alive || this.child.pid === undefined) return false;
    return this.child.kill('SIGKILL');
  }

  send(type: 'RELEASE_CHECKPOINT' | 'STOP'): boolean {
    if (!this.alive || !this.child.connected) return false;
    this.child.send({ ...envelope(this.identity), type });
    return true;
  }

  /** Graceful stop with a deadline, then SIGKILL. Used for cleanup, never as the fault. */
  async stop(deadlineMs: number): Promise<{ graceful: boolean; exit: ExitInfo }> {
    if (!this.alive) return { graceful: true, exit: this.exitInfo ?? (await this.exited) };
    this.send('STOP');
    const timer = new Promise<null>((resolve) => setTimeout(() => resolve(null), deadlineMs).unref());
    const exit = await Promise.race([this.exited, timer]);
    if (exit) return { graceful: true, exit };
    this.sigkill();
    return { graceful: false, exit: await this.exited };
  }
}
