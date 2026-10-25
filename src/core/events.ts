import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import type { Redactor } from '../reporting/redact.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** One line of events.jsonl. `seq` is controller receive order, not global distributed order. */
export interface RecordedEvent {
  seq: number;
  wallTime: string;
  elapsedMs: number;
  kind: string;
  source: 'runner' | 'worker' | 'queue' | 'observer' | 'infra';
  generation?: string;
  jobId?: string;
  data?: JsonObject;
}

export type EventInput = Omit<RecordedEvent, 'seq' | 'wallTime' | 'elapsedMs'>;

export class DeadlineError extends Error {
  constructor(readonly label: string, readonly deadlineMs: number) {
    super(`deadline exceeded after ${deadlineMs} ms while waiting for ${label}`);
    this.name = 'DeadlineError';
  }
}

export class AbortedError extends Error {
  constructor(readonly label: string) {
    super(`interrupted while waiting for ${label}`);
    this.name = 'AbortedError';
  }
}

interface Waiter {
  predicate: (event: RecordedEvent) => boolean;
  resolve: (event: RecordedEvent) => void;
}

/**
 * Append-only evidence log. Every event is redacted, written to events.jsonl and kept
 * in memory so waiters can match by identity regardless of arrival order.
 */
export class EventLog {
  private readonly events: RecordedEvent[] = [];
  private readonly waiters = new Set<Waiter>();
  private readonly started = performance.now();
  private fd: number | null;
  private seq = 0;

  constructor(path: string, private readonly redactor: Redactor) {
    this.fd = openSync(path, 'a', 0o600);
  }

  record(input: EventInput): RecordedEvent {
    const event = this.redactor.redact({
      seq: ++this.seq,
      wallTime: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - this.started),
      ...input,
    }) as RecordedEvent;
    this.events.push(event);
    if (this.fd !== null) writeSync(this.fd, `${JSON.stringify(event)}\n`);
    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(event)) {
        this.waiters.delete(waiter);
        waiter.resolve(event);
      }
    }
    return event;
  }

  /** Flush to disk. Called before irreversible actions such as the fault signal. */
  sync(): void {
    if (this.fd !== null) fsyncSync(this.fd);
  }

  close(): void {
    if (this.fd === null) return;
    fsyncSync(this.fd);
    closeSync(this.fd);
    this.fd = null;
  }

  all(): readonly RecordedEvent[] {
    return this.events;
  }

  find(predicate: (event: RecordedEvent) => boolean): RecordedEvent | undefined {
    return this.events.find(predicate);
  }

  filter(predicate: (event: RecordedEvent) => boolean): RecordedEvent[] {
    return this.events.filter(predicate);
  }

  /** Resolve with the first matching event, already recorded or future. */
  waitFor(
    predicate: (event: RecordedEvent) => boolean,
    opts: { label: string; deadlineMs: number; signal?: AbortSignal },
  ): Promise<RecordedEvent> {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { predicate, resolve: (event) => finish(() => resolve(event)) };
      const timer = setTimeout(() => finish(() => reject(new DeadlineError(opts.label, opts.deadlineMs))), opts.deadlineMs);
      timer.unref(); // an abandoned guard waiter must not keep the CLI process alive
      const onAbort = (): void => finish(() => reject(new AbortedError(opts.label)));
      const finish = (settle: () => void): void => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
        opts.signal?.removeEventListener('abort', onAbort);
        settle();
      };
      if (opts.signal?.aborted) return onAbort();
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.add(waiter);
    });
  }
}
