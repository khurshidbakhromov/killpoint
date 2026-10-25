import { createRequire } from 'node:module';
import { Queue, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import type { EventLog, JsonObject } from '../core/events.js';
import type { RedisSettings, WorkerTiming } from '../control/ipc.js';

const require = createRequire(import.meta.url);

export const QUEUE_PREFIX = 'crl';
const OBSERVED_QUEUE_EVENTS = ['added', 'waiting', 'active', 'stalled', 'completed', 'failed', 'retries-exhausted'] as const;
const ALL_STATES = ['wait', 'active', 'delayed', 'completed', 'failed', 'prioritized', 'waiting-children'] as const;

export function bullmqVersion(): string {
  return (require('bullmq/package.json') as { version: string }).version;
}

export interface JobSnapshot {
  jobId: string;
  state: string;
  attemptsStarted: number;
  attemptsMade: number;
  stalledCounter: number;
  finishedOn: number | null;
  failedReason: string | null;
}

/**
 * Kit-owned queue lifecycle for one run: a generated queue name, the single logical job,
 * and an independent QueueEvents observer feeding the evidence log.
 */
export class BullmqRunQueue {
  readonly name: string;
  readonly prefix = QUEUE_PREFIX;
  private queue: Queue | null = null;
  private events: QueueEvents | null = null;
  private probe: Redis | null = null;

  constructor(
    runId: string,
    private readonly redis: RedisSettings,
    readonly timing: WorkerTiming,
    private readonly log: EventLog,
    private readonly dropEvents: ReadonlySet<string> = new Set(),
  ) {
    this.name = `q-${runId}`;
  }

  /** Register observers before any work is submitted. */
  async open(): Promise<void> {
    const connection = { host: this.redis.host, port: this.redis.port, maxRetriesPerRequest: null };
    this.queue = new Queue(this.name, { connection, prefix: this.prefix });
    this.events = new QueueEvents(this.name, { connection, prefix: this.prefix });
    this.probe = new Redis({ ...connection, lazyConnect: true });
    for (const name of OBSERVED_QUEUE_EVENTS) {
      if (this.dropEvents.has(name)) continue; // test seam for a missing observer
      this.events.on(name, (args: { jobId: string; [key: string]: unknown }) => {
        const data: JsonObject = {};
        for (const [key, value] of Object.entries(args)) {
          if (key !== 'jobId' && key !== 'returnvalue' && (typeof value === 'string' || typeof value === 'number')) data[key] = value;
        }
        this.log.record({ kind: `queue.${name}`, source: 'queue', jobId: String(args.jobId), data });
      });
    }
    this.events.on('error', (error: Error) => this.log.record({ kind: 'queue.observer-error', source: 'queue', data: { message: error.message } }));
    await Promise.all([this.queue.waitUntilReady(), this.events.waitUntilReady(), this.probe.connect()]);
  }

  private get q(): Queue {
    if (!this.queue) throw new Error('queue not opened');
    return this.queue;
  }

  async addJob(jobId: string, data: JsonObject): Promise<string> {
    const job = await this.q.add('crash-retry-lab', data, { jobId, attempts: 1, removeOnComplete: false, removeOnFail: false });
    return String(job.id);
  }

  /** Test seam only (A06): enqueue an extra job that must never count as broker redelivery. */
  async addUnrelatedJob(data: JsonObject): Promise<string> {
    const job = await this.q.add('manual-extra', data, { attempts: 1, removeOnComplete: false, removeOnFail: false });
    return String(job.id);
  }

  async snapshot(jobId: string): Promise<JobSnapshot | null> {
    const job = await this.q.getJob(jobId);
    if (!job) return null;
    return {
      jobId,
      state: await job.getState(),
      attemptsStarted: job.attemptsStarted,
      attemptsMade: job.attemptsMade,
      stalledCounter: job.stalledCounter,
      finishedOn: job.finishedOn ?? null,
      failedReason: job.failedReason ? String(job.failedReason).slice(0, 2000) : null,
    };
  }

  async allJobIds(): Promise<string[]> {
    const jobs = await this.q.getJobs([...ALL_STATES], 0, 100);
    return [...new Set(jobs.filter(Boolean).map((job) => String(job.id)))].sort();
  }

  async healthy(): Promise<boolean> {
    try {
      return (await this.probe?.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async serverVersion(): Promise<string | null> {
    const info = await this.probe?.info('server');
    return /redis_version:(\S+)/.exec(info ?? '')?.[1] ?? null;
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.events?.close(), this.queue?.close()]);
    this.probe?.disconnect();
  }
}
