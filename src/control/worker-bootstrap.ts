/**
 * Compiled child entry for an owned worker process. Launched by the runner with
 * child_process.fork (no shell); receives INIT over IPC, imports the trusted processor
 * module, runs a single-concurrency BullMQ Worker and implements the checkpoint barrier.
 */
import { pathToFileURL } from 'node:url';
import { Worker, type Job } from 'bullmq';
import {
  envelope,
  parseRunnerMessage,
  type ExpectedIdentity,
  type InitMessage,
  type WorkerMessage,
  type WorkerMessageType,
} from './ipc.js';
import type { ProcessorInstance, WorkerContext } from '../processor.js';

const INIT_DEADLINE_MS = 10_000;
/** Exit codes for controlled failures (sysexits-style). */
const EXIT_CHANNEL_LOST_AT_BARRIER = 70;
const EXIT_CHANNEL_LOST = 69;
const EXIT_NO_INIT = 64;
const EXIT_STARTUP_FAILED = 65;

let identity: ExpectedIdentity | null = null;
let worker: Worker | null = null;
let processor: ProcessorInstance | null = null;
let current: { jobId: string; operationId?: string } | null = null;
let armed: { checkpoint: string } | null = null;
let barrierFired = false;
let waitingAtBarrier = false;
let releaseBarrier: (() => void) | null = null;
let stopping = false;

function stderr(line: string): void {
  process.stderr.write(`[worker ${identity?.generation ?? '?'}] ${line}\n`);
}

function channelLost(): never {
  // Never continue through a gated barrier without the controller.
  stderr(waitingAtBarrier ? 'control channel lost while gated; exiting' : 'control channel lost; exiting');
  process.exit(waitingAtBarrier ? EXIT_CHANNEL_LOST_AT_BARRIER : EXIT_CHANNEL_LOST);
}

function send(type: WorkerMessageType, fields: Partial<WorkerMessage> = {}): Promise<void> {
  if (!identity) throw new Error('send before INIT');
  if (!process.connected || !process.send) channelLost();
  const message: WorkerMessage = { ...envelope(identity), type, ...fields };
  return new Promise((resolve) => {
    process.send!(message, undefined, {}, (error) => {
      if (error) channelLost();
      resolve();
    });
  });
}

function safeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message.slice(0, 2000) };
  return { name: 'NonError', message: String(error).slice(0, 2000) };
}

async function checkpoint(name: string): Promise<void> {
  if (typeof name !== 'string' || name.length === 0 || name.length > 128) throw new TypeError('checkpoint name must be a non-empty string');
  if (!current) throw new Error(`checkpoint("${name}") called outside a job`);
  const job = current;
  if (armed && name === armed.checkpoint && !barrierFired) {
    barrierFired = true; // arm exactly once per worker generation
    waitingAtBarrier = true;
    const released = new Promise<void>((resolve) => (releaseBarrier = resolve));
    await send('CHECKPOINT_REACHED', { checkpoint: name, jobId: job.jobId, ...(job.operationId ? { operationId: job.operationId } : {}) });
    await released;
    waitingAtBarrier = false;
    return;
  }
  await send('CHECKPOINT_PASSED', { checkpoint: name, jobId: job.jobId });
}

async function start(init: InitMessage): Promise<void> {
  identity = { session: init.session, runId: init.runId, generation: init.generation };
  armed = init.armed;
  const ctx: WorkerContext = {
    runId: init.runId,
    generation: init.generation,
    namespace: init.namespace,
    connections: init.connections,
    checkpoint,
    log: stderr,
  };
  const mod = (await import(pathToFileURL(init.processorModule).href)) as { createProcessor?: unknown; default?: { createProcessor?: unknown } };
  const create = mod.createProcessor ?? mod.default?.createProcessor;
  if (typeof create !== 'function') throw new Error('processor module must export createProcessor(ctx)');
  processor = (await create(ctx)) as ProcessorInstance;
  if (!processor || typeof processor.process !== 'function') throw new Error('createProcessor must return { process(job) }');
  const proc = processor;

  worker = new Worker(
    init.queue.name,
    async (job: Job) => {
      const operationId = proc.operationIdOf ? proc.operationIdOf(job) : (job.data as { operationId?: unknown } | undefined)?.operationId;
      current = { jobId: String(job.id), ...(typeof operationId === 'string' ? { operationId } : {}) };
      await send('PROCESSING_STARTED', {
        jobId: current.jobId,
        ...(current.operationId ? { operationId: current.operationId } : {}),
        attemptsStarted: job.attemptsStarted,
        stalledCounter: job.stalledCounter,
      });
      try {
        const result = await proc.process(job);
        await send('PROCESSOR_RETURNED', { jobId: current.jobId });
        return result;
      } catch (error) {
        await send('PROCESSOR_ERROR', { jobId: current.jobId, error: safeError(error) });
        throw error;
      } finally {
        current = null;
      }
    },
    {
      connection: { host: init.connections.redis.host, port: init.connections.redis.port, maxRetriesPerRequest: null },
      prefix: init.queue.prefix,
      concurrency: 1,
      lockDuration: init.timing.lockDurationMs,
      stalledInterval: init.timing.stalledIntervalMs,
      maxStalledCount: init.timing.maxStalledCount,
      autorun: true,
      name: `kp-${init.generation}`,
    },
  );
  worker.on('error', (error) => stderr(`bullmq worker error: ${safeError(error).message}`));
  await worker.waitUntilReady();
  await send('READY', { pid: process.pid });
}

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    await worker?.close();
    await processor?.close?.();
  } catch (error) {
    stderr(`error while stopping: ${safeError(error).message}`);
  }
  await send('WORKER_STOPPED', {});
  process.disconnect?.();
}

if (!process.send) {
  process.stderr.write('worker-bootstrap must be launched by killpoint with an IPC channel\n');
  process.exit(EXIT_NO_INIT);
}

const initTimer = setTimeout(() => {
  process.stderr.write('no INIT received from runner\n');
  process.exit(EXIT_NO_INIT);
}, INIT_DEADLINE_MS);

process.on('disconnect', () => {
  if (!stopping) channelLost();
});

process.on('message', (raw) => {
  const message = parseRunnerMessage(raw, identity?.session ?? null);
  if (!message) {
    stderr('ignored unrecognized control message');
    return;
  }
  if (message.type === 'INIT') {
    if (identity) return stderr('ignored duplicate INIT');
    clearTimeout(initTimer);
    start(message).catch((error: unknown) => {
      stderr(`startup failed: ${safeError(error).message}`);
      process.exit(EXIT_STARTUP_FAILED);
    });
  } else if (message.type === 'RELEASE_CHECKPOINT') {
    releaseBarrier?.();
    releaseBarrier = null;
  } else if (message.type === 'STOP') {
    // STOP never opens a gated barrier; a gated worker is stopped by the runner's kill instead.
    void stop();
  }
});
