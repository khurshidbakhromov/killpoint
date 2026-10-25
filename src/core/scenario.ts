export type ScenarioKind = 'post-commit-crash' | 'baseline';

export const SCENARIOS: readonly ScenarioKind[] = ['post-commit-crash', 'baseline'];

export type ScenarioState =
  | 'CREATED'
  | 'PREFLIGHT_OK'
  | 'INFRA_READY'
  | 'A_READY'
  | 'JOB_SUBMITTED'
  | 'COMMIT_CONFIRMED'
  | 'A_EXIT_CONFIRMED'
  | 'B_READY'
  | 'REDELIVERY_CONFIRMED'
  | 'JOB_TERMINAL'
  | 'OBSERVED'
  | 'HALTED'
  | 'REPORTED'
  | 'CLEANED';

const S1_PATH: Record<ScenarioState, readonly ScenarioState[]> = {
  CREATED: ['PREFLIGHT_OK'],
  PREFLIGHT_OK: ['INFRA_READY'],
  INFRA_READY: ['A_READY'],
  A_READY: ['JOB_SUBMITTED'],
  JOB_SUBMITTED: ['COMMIT_CONFIRMED'],
  COMMIT_CONFIRMED: ['A_EXIT_CONFIRMED'],
  A_EXIT_CONFIRMED: ['B_READY'],
  B_READY: ['REDELIVERY_CONFIRMED', 'OBSERVED'], // OBSERVED directly only on a bounded liveness timeout
  REDELIVERY_CONFIRMED: ['JOB_TERMINAL', 'OBSERVED'],
  JOB_TERMINAL: ['OBSERVED'],
  OBSERVED: ['REPORTED'],
  HALTED: ['REPORTED'],
  REPORTED: ['CLEANED'],
  CLEANED: [],
};

const BASELINE_PATH: Record<ScenarioState, readonly ScenarioState[]> = {
  ...S1_PATH,
  JOB_SUBMITTED: ['JOB_TERMINAL', 'OBSERVED'],
  COMMIT_CONFIRMED: [],
  A_EXIT_CONFIRMED: [],
  B_READY: [],
  REDELIVERY_CONFIRMED: [],
};

export class IllegalTransitionError extends Error {
  constructor(readonly from: ScenarioState, readonly to: ScenarioState, readonly scenario: ScenarioKind) {
    super(`illegal ${scenario} transition ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

/**
 * Explicit scenario lifecycle. Any non-terminal state may move to HALTED; everything
 * else must follow the scenario's path, so a duplicate checkpoint can never cause a
 * second fault and the baseline can never claim S1 coverage.
 */
export class ScenarioStateMachine {
  private current: ScenarioState = 'CREATED';
  readonly history: Array<{ state: ScenarioState; at: number }> = [{ state: 'CREATED', at: Date.now() }];

  constructor(readonly scenario: ScenarioKind, private readonly onChange?: (state: ScenarioState) => void) {}

  get state(): ScenarioState {
    return this.current;
  }

  reached(state: ScenarioState): boolean {
    return this.history.some((entry) => entry.state === state);
  }

  canTransition(to: ScenarioState): boolean {
    if (to === 'HALTED') return !['HALTED', 'REPORTED', 'CLEANED', 'OBSERVED'].includes(this.current);
    const table = this.scenario === 'baseline' ? BASELINE_PATH : S1_PATH;
    return table[this.current].includes(to);
  }

  transition(to: ScenarioState): void {
    if (!this.canTransition(to)) throw new IllegalTransitionError(this.current, to, this.scenario);
    this.current = to;
    this.history.push({ state: to, at: Date.now() });
    this.onChange?.(to);
  }
}
