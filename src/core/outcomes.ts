import type { JsonValue } from './events.js';
import type { ScenarioKind } from './scenario.js';

export type Outcome = 'PASS' | 'VIOLATION' | 'INCONCLUSIVE' | 'ERROR';

export interface InvariantVerdict {
  id: string;
  description: string;
  /** `business` verdicts come from the application adapter; `kit` verdicts from the runner. */
  category: 'business' | 'kit';
  expected: JsonValue;
  observed: JsonValue;
  verdict: 'pass' | 'fail' | 'not-evaluated';
}

export interface EvidenceCheck {
  id: string;
  satisfied: boolean;
  detail: string;
}

export interface Halt {
  kind: 'error' | 'inconclusive' | 'interrupted';
  reason: string;
}

export interface EvaluationInput {
  scenario: ScenarioKind;
  halt: Halt | null;
  evidence: EvidenceCheck[];
  invariants: InvariantVerdict[];
  /** A valid fault was delivered, observers stayed healthy, and the recovery deadline passed. */
  livenessTimeout: boolean;
}

export interface Evaluation {
  outcome: Outcome;
  valid: boolean;
  missingEvidence: string[];
  reasons: string[];
}

/** Evidence that may legitimately be absent when the outcome is a bounded liveness violation. */
const LIVENESS_DEPENDENT = new Set(['broker-stalled-recovery', 'redelivered-to-worker-b', 'job-terminal']);

export function requiredEvidence(scenario: ScenarioKind): string[] {
  const common = ['worker-a-ready', 'job-submitted-once', 'single-job-in-queue', 'job-terminal', 'final-observation'];
  if (scenario === 'baseline') return [...common, 'single-processing-attempt', 'no-stall-recovery'];
  return [
    ...common,
    'checkpoint-reached',
    'commit-independently-confirmed',
    'fault-delivered',
    'worker-a-exit-confirmed',
    'job-active-after-kill',
    'broker-stalled-recovery',
    'redelivered-to-worker-b',
  ];
}

/**
 * Two separate questions: did the requested experiment really happen (validity), and did
 * the application keep its declared invariants (correctness). Only a valid experiment with
 * at least one evaluated business invariant can PASS.
 */
export function evaluate(input: EvaluationInput): Evaluation {
  const reasons: string[] = [];
  const byId = new Map(input.evidence.map((check) => [check.id, check]));
  const missingEvidence = requiredEvidence(input.scenario).filter((id) => !byId.get(id)?.satisfied);

  if (input.halt?.kind === 'error') {
    return { outcome: 'ERROR', valid: false, missingEvidence, reasons: [input.halt.reason] };
  }
  if (input.halt) {
    return { outcome: 'INCONCLUSIVE', valid: false, missingEvidence, reasons: [input.halt.reason] };
  }

  const blocking = input.livenessTimeout ? missingEvidence.filter((id) => !LIVENESS_DEPENDENT.has(id)) : missingEvidence;
  if (blocking.length > 0) {
    reasons.push(`required scenario evidence missing: ${blocking.join(', ')}`);
    return { outcome: 'INCONCLUSIVE', valid: false, missingEvidence, reasons };
  }

  const business = input.invariants.filter((inv) => inv.category === 'business');
  if (business.length === 0) {
    reasons.push('no business invariants were declared; skipping all assertions cannot pass');
    return { outcome: 'INCONCLUSIVE', valid: true, missingEvidence, reasons };
  }
  const unevaluated = input.invariants.filter((inv) => inv.verdict === 'not-evaluated');
  if (unevaluated.length > 0) {
    reasons.push(`invariants not evaluated: ${unevaluated.map((inv) => inv.id).join(', ')}`);
    return { outcome: 'INCONCLUSIVE', valid: true, missingEvidence, reasons };
  }

  const failed = input.invariants.filter((inv) => inv.verdict === 'fail');
  if (input.livenessTimeout) reasons.push('bounded liveness violation: job did not reach a terminal state within the recovery deadline');
  if (failed.length > 0 || input.livenessTimeout) {
    for (const inv of failed) reasons.push(`invariant failed: ${inv.id}`);
    return { outcome: 'VIOLATION', valid: true, missingEvidence, reasons };
  }
  return { outcome: 'PASS', valid: true, missingEvidence, reasons };
}

/** A cleanup failure prevents an unqualified result; the evaluated outcome is kept separately. */
export function finalizeOutcome(evaluated: Outcome, cleanupOk: boolean): Outcome {
  return cleanupOk ? evaluated : 'ERROR';
}

export function exitCodeFor(outcome: Outcome): 0 | 1 | 2 {
  if (outcome === 'PASS') return 0;
  if (outcome === 'VIOLATION') return 1;
  return 2;
}

/** Any inconclusive/error case dominates; otherwise any violation gives 1. */
export function batchExitCode(outcomes: readonly Outcome[]): 0 | 1 | 2 {
  if (outcomes.length === 0) return 2;
  if (outcomes.some((o) => o === 'INCONCLUSIVE' || o === 'ERROR')) return 2;
  if (outcomes.some((o) => o === 'VIOLATION')) return 1;
  return 0;
}

export interface ComparisonCase {
  name: string;
  expected: Outcome;
  observed: Outcome;
}

/**
 * Demo comparison: expects baseline PASS, unsafe S1 VIOLATION, idempotent S1 PASS.
 * Exit 0 only when every expectation holds; 2 if any case was inconclusive/error; else 1.
 */
export function compareExpectations(cases: readonly ComparisonCase[]): { ok: boolean; exitCode: 0 | 1 | 2; mismatches: string[] } {
  const mismatches = cases
    .filter((c) => c.expected !== c.observed)
    .map((c) => `${c.name}: expected ${c.expected}, observed ${c.observed}`);
  if (cases.length === 0) return { ok: false, exitCode: 2, mismatches: ['no cases ran'] };
  if (cases.some((c) => c.observed === 'INCONCLUSIVE' || c.observed === 'ERROR')) return { ok: false, exitCode: 2, mismatches };
  if (mismatches.length > 0) return { ok: false, exitCode: 1, mismatches };
  return { ok: true, exitCode: 0, mismatches };
}
