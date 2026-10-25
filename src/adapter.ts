/**
 * Parent-side project adapter contract. A trusted, locally authored module owns business
 * semantics: fixtures, the job payload, independent observations and invariants. The kit
 * owns infrastructure, queue, workers, the fault and evidence.
 */
import type { JsonObject } from './core/events.js';
import type { InvariantVerdict } from './core/outcomes.js';
import type { ScenarioKind } from './core/scenario.js';
import type { PostgresSettings } from './control/ipc.js';

export type { InvariantVerdict };

export const ADAPTER_SCHEMA_VERSION = 1;

export interface AdapterContext {
  runId: string;
  scenario: ScenarioKind;
  /** Run-scoped namespace, validated as a safe SQL identifier (`^[a-z_][a-z0-9_]{0,62}$`). */
  namespace: string;
  /** Selected processor implementation name. */
  processor: string;
  postgres: PostgresSettings;
}

export interface Payload {
  /** Stable logical business operation id, distinct from the BullMQ job id. */
  operationId: string;
  /** Job data. Must contain the operation id where the processor's `operationIdOf` can find it. */
  data: JsonObject;
}

export interface CommitCheck {
  committed: boolean;
  detail: string;
}

export interface EvaluationContext {
  scenario: ScenarioKind;
  payload: Payload;
  initial: JsonObject;
  final: JsonObject;
}

export interface AdapterSession {
  /** Create and seed run-scoped fixtures. */
  setup(): Promise<void>;
  makePayload(): Promise<Payload>;
  /** Read durable state on a connection independent of every worker process. Allowlisted fields only. */
  observe(): Promise<JsonObject>;
  /** At the checkpoint: is the expected first effect durably visible in this snapshot? */
  confirmCommitted(snapshot: JsonObject, payload: Payload): CommitCheck;
  /** Business invariants (category "business"). Returning none can never produce PASS. */
  evaluate(ctx: EvaluationContext): InvariantVerdict[];
  /** Remove only resources this session created. */
  teardown(): Promise<void>;
}

export interface ProjectAdapter {
  id: string;
  schemaVersion: typeof ADAPTER_SCHEMA_VERSION;
  /** Implementation name -> absolute path of a compiled JavaScript processor module. */
  processors: Record<string, string>;
  defaultProcessor?: string;
  /** Checkpoint name armed in worker A. Defaults to "effect-committed". */
  checkpoint?: string;
  open(ctx: AdapterContext): Promise<AdapterSession>;
}

export function defineAdapter(adapter: ProjectAdapter): ProjectAdapter {
  return adapter;
}
