/**
 * Versioned runner <-> worker control protocol over Node's child-process IPC channel.
 * Every message carries the per-launch session nonce plus run and generation identity;
 * the runner validates all of it before any scenario state changes.
 */
export const IPC_PROTOCOL = 'crash-retry-lab/ipc';
export const IPC_VERSION = 1;

export type WorkerMessageType =
  | 'READY'
  | 'PROCESSING_STARTED'
  | 'CHECKPOINT_REACHED'
  | 'CHECKPOINT_PASSED'
  | 'PROCESSOR_RETURNED'
  | 'PROCESSOR_ERROR'
  | 'WORKER_STOPPED';

export type RunnerMessageType = 'INIT' | 'RELEASE_CHECKPOINT' | 'STOP';

const WORKER_TYPES: ReadonlySet<string> = new Set<WorkerMessageType>([
  'READY',
  'PROCESSING_STARTED',
  'CHECKPOINT_REACHED',
  'CHECKPOINT_PASSED',
  'PROCESSOR_RETURNED',
  'PROCESSOR_ERROR',
  'WORKER_STOPPED',
]);

export interface Envelope {
  protocol: typeof IPC_PROTOCOL;
  version: typeof IPC_VERSION;
  session: string;
  runId: string;
  generation: string;
}

export interface WorkerMessage extends Envelope {
  type: WorkerMessageType;
  pid?: number;
  jobId?: string;
  operationId?: string;
  checkpoint?: string;
  attemptsStarted?: number;
  stalledCounter?: number;
  error?: { name: string; message: string };
}

export interface PostgresSettings {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface RedisSettings {
  host: string;
  port: number;
}

export interface WorkerTiming {
  lockDurationMs: number;
  stalledIntervalMs: number;
  maxStalledCount: number;
}

export interface InitMessage extends Envelope {
  type: 'INIT';
  processorModule: string;
  queue: { name: string; prefix: string };
  connections: { redis: RedisSettings; postgres: PostgresSettings };
  namespace: string;
  timing: WorkerTiming;
  /** Only the named checkpoint in this generation blocks, and only once. Null = no fault armed. */
  armed: { checkpoint: string } | null;
}

export interface ReleaseMessage extends Envelope {
  type: 'RELEASE_CHECKPOINT';
}

export interface StopMessage extends Envelope {
  type: 'STOP';
}

export type RunnerMessage = InitMessage | ReleaseMessage | StopMessage;

export interface ExpectedIdentity {
  session: string;
  runId: string;
  generation: string;
}

export type ParseResult = { ok: true; message: WorkerMessage } | { ok: false; reason: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const optionalString = (value: unknown, max = 512): boolean =>
  value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= max);

const optionalCount = (value: unknown): boolean =>
  value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 0);

export function envelope(identity: ExpectedIdentity): Envelope {
  return { protocol: IPC_PROTOCOL, version: IPC_VERSION, ...identity };
}

/** Validate shape and identity of a message received from a worker. */
export function parseWorkerMessage(raw: unknown, expected: ExpectedIdentity): ParseResult {
  if (!isObject(raw)) return { ok: false, reason: 'message is not an object' };
  if (raw.protocol !== IPC_PROTOCOL) return { ok: false, reason: 'unknown protocol' };
  if (raw.version !== IPC_VERSION) return { ok: false, reason: `unsupported protocol version ${String(raw.version)}` };
  if (typeof raw.type !== 'string' || !WORKER_TYPES.has(raw.type)) return { ok: false, reason: `unknown message type ${String(raw.type)}` };
  if (raw.session !== expected.session) return { ok: false, reason: 'session nonce mismatch' };
  if (raw.runId !== expected.runId) return { ok: false, reason: 'run id mismatch' };
  if (raw.generation !== expected.generation) return { ok: false, reason: `generation mismatch (got ${String(raw.generation)})` };
  if (!optionalString(raw.jobId) || !optionalString(raw.operationId) || !optionalString(raw.checkpoint, 128)) {
    return { ok: false, reason: 'malformed identity field' };
  }
  if (!optionalCount(raw.attemptsStarted) || !optionalCount(raw.stalledCounter) || !optionalCount(raw.pid)) {
    return { ok: false, reason: 'malformed counter field' };
  }
  const needsJob: ReadonlySet<string> = new Set(['PROCESSING_STARTED', 'CHECKPOINT_REACHED', 'CHECKPOINT_PASSED', 'PROCESSOR_RETURNED', 'PROCESSOR_ERROR']);
  if (needsJob.has(raw.type) && raw.jobId === undefined) return { ok: false, reason: `${raw.type} without jobId` };
  if ((raw.type === 'CHECKPOINT_REACHED' || raw.type === 'CHECKPOINT_PASSED') && raw.checkpoint === undefined) {
    return { ok: false, reason: `${raw.type} without checkpoint name` };
  }
  let error: WorkerMessage['error'];
  if (raw.error !== undefined) {
    if (!isObject(raw.error) || typeof raw.error.message !== 'string') return { ok: false, reason: 'malformed error field' };
    error = { name: String(raw.error.name ?? 'Error').slice(0, 200), message: raw.error.message.slice(0, 2000) };
  }
  const message: WorkerMessage = {
    protocol: IPC_PROTOCOL,
    version: IPC_VERSION,
    session: expected.session,
    runId: expected.runId,
    generation: expected.generation,
    type: raw.type as WorkerMessageType,
  };
  for (const key of ['jobId', 'operationId', 'checkpoint'] as const) {
    if (typeof raw[key] === 'string') message[key] = raw[key];
  }
  for (const key of ['pid', 'attemptsStarted', 'stalledCounter'] as const) {
    if (typeof raw[key] === 'number') message[key] = raw[key];
  }
  if (error) message.error = error;
  return { ok: true, message };
}

/** Child-side validation of runner messages. */
export function parseRunnerMessage(raw: unknown, session: string | null): RunnerMessage | null {
  if (!isObject(raw) || raw.protocol !== IPC_PROTOCOL || raw.version !== IPC_VERSION) return null;
  if (typeof raw.session !== 'string' || (session !== null && raw.session !== session)) return null;
  if (raw.type === 'INIT') {
    if (typeof raw.processorModule !== 'string' || !isObject(raw.queue) || !isObject(raw.connections) || !isObject(raw.timing)) return null;
    return raw as unknown as InitMessage;
  }
  if (raw.type === 'RELEASE_CHECKPOINT' || raw.type === 'STOP') return raw as unknown as RunnerMessage;
  return null;
}
