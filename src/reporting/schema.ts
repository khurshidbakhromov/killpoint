import { Ajv } from 'ajv';
import type { JsonObject } from '../core/events.js';
import type { EvidenceCheck, Halt, InvariantVerdict, Outcome } from '../core/outcomes.js';
import type { ScenarioKind } from '../core/scenario.js';
import type { JobSnapshot } from '../adapters/bullmq.js';

export const REPORT_SCHEMA_VERSION = 1;

export interface CleanupReport {
  status: 'ok' | 'failed' | 'pending';
  steps: Array<{ name: string; ok: boolean; detail: string }>;
}

export interface RunReport {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  tool: { name: string; version: string };
  /** False for the provisional report written before cleanup. */
  final: boolean;
  runId: string;
  scenario: ScenarioKind;
  processor: string;
  adapterId: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  outcome: Outcome;
  /** Outcome from validity + invariants alone, before cleanup qualification. */
  evaluatedOutcome: Outcome;
  validity: { valid: boolean; evidence: EvidenceCheck[]; missing: string[] };
  reasons: string[];
  fault: null | {
    requested: { kind: 'SIGKILL'; target: string; checkpoint: string };
    delivered: boolean;
    confirmed: boolean;
    exit: { code: number | null; signal: string | null } | null;
  };
  operationId: string | null;
  payloadSha256: string | null;
  observations: { initial: JsonObject | null; atCheckpoint: JsonObject | null; final: JsonObject | null };
  invariants: InvariantVerdict[];
  job: JobSnapshot | null;
  processingStarts: Array<{ generation: string; jobId: string; operationId: string | null; attemptsStarted: number | null }>;
  livenessTimeout: boolean;
  halt: Halt | null;
  states: string[];
  timing: JsonObject;
  deadlines: JsonObject;
  diagnostics: string[];
  cleanup: CleanupReport;
  artifacts: { dir: string; manifest: string; events: string; report: string };
  rerun: { command: string; of: string | null; inputsChanged: boolean };
}

const str = { type: 'string' } as const;
const nullableStr = { type: ['string', 'null'] } as const;
const outcome = { enum: ['PASS', 'VIOLATION', 'INCONCLUSIVE', 'ERROR'] } as const;

export const reportSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion', 'tool', 'final', 'runId', 'scenario', 'processor', 'adapterId', 'startedAt', 'finishedAt', 'durationMs',
    'outcome', 'evaluatedOutcome', 'validity', 'reasons', 'fault', 'operationId', 'payloadSha256', 'observations', 'invariants',
    'job', 'processingStarts', 'livenessTimeout', 'halt', 'states', 'timing', 'deadlines', 'diagnostics', 'cleanup', 'artifacts', 'rerun',
  ],
  properties: {
    schemaVersion: { const: REPORT_SCHEMA_VERSION },
    tool: { type: 'object', required: ['name', 'version'], properties: { name: str, version: str } },
    final: { type: 'boolean' },
    runId: str,
    scenario: { enum: ['post-commit-crash', 'baseline'] },
    processor: str,
    adapterId: str,
    startedAt: str,
    finishedAt: nullableStr,
    durationMs: { type: ['integer', 'null'] },
    outcome,
    evaluatedOutcome: outcome,
    validity: {
      type: 'object',
      required: ['valid', 'evidence', 'missing'],
      properties: {
        valid: { type: 'boolean' },
        evidence: {
          type: 'array',
          items: { type: 'object', required: ['id', 'satisfied', 'detail'], properties: { id: str, satisfied: { type: 'boolean' }, detail: str } },
        },
        missing: { type: 'array', items: str },
      },
    },
    reasons: { type: 'array', items: str },
    fault: {
      type: ['object', 'null'],
      required: ['requested', 'delivered', 'confirmed', 'exit'],
      properties: { delivered: { type: 'boolean' }, confirmed: { type: 'boolean' } },
    },
    operationId: nullableStr,
    payloadSha256: nullableStr,
    observations: {
      type: 'object',
      required: ['initial', 'atCheckpoint', 'final'],
      properties: { initial: { type: ['object', 'null'] }, atCheckpoint: { type: ['object', 'null'] }, final: { type: ['object', 'null'] } },
    },
    invariants: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'description', 'category', 'expected', 'observed', 'verdict'],
        properties: { id: str, description: str, category: { enum: ['business', 'kit'] }, verdict: { enum: ['pass', 'fail', 'not-evaluated'] } },
      },
    },
    job: { type: ['object', 'null'] },
    processingStarts: { type: 'array' },
    livenessTimeout: { type: 'boolean' },
    halt: { type: ['object', 'null'], required: ['kind', 'reason'], properties: { kind: { enum: ['error', 'inconclusive', 'interrupted'] }, reason: str } },
    states: { type: 'array', items: str },
    timing: { type: 'object' },
    deadlines: { type: 'object' },
    diagnostics: { type: 'array', items: str },
    cleanup: {
      type: 'object',
      required: ['status', 'steps'],
      properties: { status: { enum: ['ok', 'failed', 'pending'] }, steps: { type: 'array' } },
    },
    artifacts: { type: 'object', required: ['dir', 'manifest', 'events', 'report'] },
    rerun: { type: 'object', required: ['command', 'of', 'inputsChanged'] },
  },
} as const;

const validate = new Ajv({ allErrors: true, strict: false }).compile(reportSchema);

export function validateReport(report: unknown): string[] {
  if (validate(report)) return [];
  return (validate.errors ?? []).map((err) => `${err.instancePath || '(root)'} ${err.message ?? 'is invalid'}`);
}
