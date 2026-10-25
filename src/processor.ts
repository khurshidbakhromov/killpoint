/**
 * Child-side contract: a compiled JavaScript module that the worker bootstrap imports
 * inside each owned worker process. It must export `createProcessor`.
 */
import type { Job } from 'bullmq';
import type { PostgresSettings, RedisSettings } from './control/ipc.js';

export type { PostgresSettings, RedisSettings };

export interface WorkerContext {
  runId: string;
  /** "A" for the faulted worker, "B" for the recovery worker, "A" alone in the baseline. */
  generation: string;
  /** Run-scoped resource namespace (the reference fixture uses it as a PostgreSQL schema name). */
  namespace: string;
  /** Test-only connection settings for the disposable services of this run. */
  connections: { postgres: PostgresSettings; redis: RedisSettings };
  /**
   * Awaitable test seam. Resolves immediately unless this worker generation is armed for
   * `name`, in which case it reports arrival to the runner and blocks until the runner acts.
   * Place it after your business transaction's commit has resolved, outside the transaction,
   * and before returning to BullMQ.
   */
  checkpoint(name: string): Promise<void>;
  /** Diagnostic line to the worker's stderr log (redacted by the runner). */
  log(message: string): void;
}

export interface ProcessorInstance {
  process(job: Job): Promise<unknown>;
  /** Extract the logical business operation id. Defaults to `job.data.operationId`. */
  operationIdOf?(job: Job): string | undefined;
  close?(): Promise<void>;
}

export type CreateProcessor = (ctx: WorkerContext) => ProcessorInstance | Promise<ProcessorInstance>;

/** Identity helper that gives processor modules type checking. */
export function defineProcessor(create: CreateProcessor): CreateProcessor {
  return create;
}
