export { runScenario, type RunOptions, type RunResult, type TestHooks } from './core/runner.js';
export { runDemoComparison, checkRerun, readManifest, cleanupFromManifest, type ComparisonResult, type RerunCheck } from './core/demo.js';
export {
  evaluate,
  exitCodeFor,
  batchExitCode,
  compareExpectations,
  finalizeOutcome,
  requiredEvidence,
  type Outcome,
  type InvariantVerdict,
  type EvidenceCheck,
  type ComparisonCase,
} from './core/outcomes.js';
export { SCENARIOS, type ScenarioKind } from './core/scenario.js';
export { loadConfigFile, resolveConfig, ConfigError, DEFAULT_TIMING, minimumRecoveryMs, type LabConfig, type ResolvedConfig, type Timing, type Deadlines } from './config.js';
export { defineAdapter, ADAPTER_SCHEMA_VERSION, type ProjectAdapter, type AdapterSession, type AdapterContext, type Payload, type CommitCheck, type EvaluationContext } from './adapter.js';
export { defineProcessor, type WorkerContext, type ProcessorInstance, type CreateProcessor } from './processor.js';
export { preflight, type PreflightResult } from './infra/preflight.js';
export { formatSummary, formatComparison } from './reporting/terminal.js';
export { reportSchema, validateReport, type RunReport } from './reporting/schema.js';
export type { Manifest } from './core/manifest.js';
export type { JsonObject, JsonValue } from './core/events.js';
