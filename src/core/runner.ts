import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterSession, Payload } from '../adapter.js';
import { BullmqRunQueue, type JobSnapshot } from '../adapters/bullmq.js';
import type { ResolvedConfig } from '../config.js';
import { OwnedWorker, type ExitInfo } from '../control/child.js';
import type { WorkerMessage } from '../control/ipc.js';
import { startInfrastructure, stopInfrastructure, projectName, waitForPostgres, type Infrastructure } from '../infra/compose.js';
import { preflight, type PreflightResult } from '../infra/preflight.js';
import { writeJsonAtomic } from '../reporting/json.js';
import { Redactor, describeError } from '../reporting/redact.js';
import { validateReport, REPORT_SCHEMA_VERSION, type CleanupReport, type RunReport } from '../reporting/schema.js';
import { AbortedError, DeadlineError, EventLog, type JsonObject, type RecordedEvent } from './events.js';
import { fingerprints, gitState, libraryVersions, toolInfo, MANIFEST_SCHEMA_VERSION, type Manifest } from './manifest.js';
import { evaluate, finalizeOutcome, requiredEvidence, type EvidenceCheck, type Halt, type InvariantVerdict } from './outcomes.js';
import { ScenarioStateMachine, type ScenarioKind, type ScenarioState } from './scenario.js';

/** Internal seams for negative-control tests. Not exposed by the CLI. */
export interface TestHooks {
  /** A05: skip sending the fault signal so death is never confirmed. */
  suppressFaultSignal?: boolean;
  /** A06: called after worker A exit is confirmed, before worker B starts. */
  afterFault?: (h: { addExtraJob(data: JsonObject): Promise<string> }) => Promise<void>;
  /** A07: QueueEvents names the observer silently drops. */
  dropQueueEvents?: string[];
  /** A11: observe state transitions (e.g. to abort during a waiting phase). */
  onState?: (state: ScenarioState) => void;
  /** A12: pretend to run on another platform. */
  platform?: NodeJS.Platform;
}

export interface RunOptions {
  config: ResolvedConfig;
  scenario: ScenarioKind;
  /** Implementation name from adapter.processors. Defaults to adapter.defaultProcessor or the first entry. */
  processor?: string;
  signal?: AbortSignal;
  rerunOf?: { runId: string; inputsChanged: boolean };
  testHooks?: TestHooks;
  /** Called with each progress line (CLI prints them). */
  onProgress?: (line: string) => void;
}

export interface RunResult {
  runId: string;
  outcome: RunReport['outcome'];
  evaluatedOutcome: RunReport['outcome'];
  valid: boolean;
  invariants: InvariantVerdict[];
  observations: RunReport['observations'];
  report: RunReport;
  reportPath: string;
  cleanup: CleanupReport;
  preflight: PreflightResult | null;
}

class HaltError extends Error {
  constructor(readonly halt: Halt) {
    super(halt.reason);
  }
}

const halt = (kind: Halt['kind'], reason: string): HaltError => new HaltError({ kind, reason });

function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').toLowerCase();
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

function namespaceFor(runId: string): string {
  const ns = `kp_${runId.replace(/[^a-z0-9]/g, '_')}`;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(ns)) throw new Error(`generated namespace is not a safe identifier: ${ns}`);
  return ns;
}

const TERMINAL = new Set(['completed', 'failed']);

/**
 * Execute one scenario end to end against real disposable infrastructure. Never calls
 * process.exit; always returns a result whose report reflects what was actually observed.
 */
export async function runScenario(opts: RunOptions): Promise<RunResult> {
  const { config, scenario } = opts;
  const adapter = config.adapter;
  const processor = opts.processor ?? adapter.defaultProcessor ?? Object.keys(adapter.processors)[0]!;
  const processorModule = adapter.processors[processor];
  if (!processorModule) throw new Error(`unknown processor implementation "${processor}" (available: ${Object.keys(adapter.processors).join(', ')})`);
  const checkpointName = adapter.checkpoint ?? 'effect-committed';
  const progress = opts.onProgress ?? (() => {});
  const hooks = opts.testHooks ?? {};

  const runId = newRunId();
  const dir = join(config.outputDir, runId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const paths = { dir, manifest: join(dir, 'manifest.json'), events: join(dir, 'events.jsonl'), report: join(dir, 'report.json') };
  const pgPassword = randomBytes(18).toString('base64url');
  const redactor = new Redactor([pgPassword]);
  const log = new EventLog(paths.events, redactor);
  const startedAt = new Date();
  const diagnostics: string[] = [];
  const diag = (line: string): void => {
    const safe = redactor.redactString(line).slice(0, 2000);
    diagnostics.push(safe);
    log.record({ kind: 'runner.diagnostic', source: 'runner', data: { message: safe } });
  };
  const machine = new ScenarioStateMachine(scenario, (state) => {
    log.record({ kind: 'state', source: 'runner', data: { state } });
    hooks.onState?.(state);
  });
  const signal = opts.signal;
  const throwIfAborted = (): void => {
    if (signal?.aborted) throw halt('interrupted', 'run interrupted by signal');
  };

  const namespace = namespaceFor(runId);
  const jobId = `job-${runId}`;
  const tool = toolInfo();
  const cwd = process.cwd();
  const manifest: Manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    runId,
    scenario,
    processor,
    adapterId: adapter.id,
    createdAt: startedAt.toISOString(),
    tool,
    source: { cwd, ...(await gitState(cwd)) },
    fingerprints: fingerprints(config.source.path, config.source.sha256, processorModule, cwd),
    versions: { ...libraryVersions(), redisServer: null, postgresServer: null },
    images: [],
    environment: {},
    timing: { ...config.timing },
    deadlines: { ...config.deadlines },
    ownedResources: { composeProject: projectName(runId), queuePrefix: 'kp', queueName: `q-${runId}`, namespace, jobId, workers: [] },
    cleanup: {
      command: `killpoint cleanup --manifest ${paths.manifest}`,
      manual: `KP_RUN_ID=${runId} KP_PG_PASSWORD=x docker compose -p ${projectName(runId)} -f <killpoint>/compose.yaml down --volumes --remove-orphans`,
    },
    rerunOf: opts.rerunOf?.runId ?? null,
    inputsChanged: opts.rerunOf?.inputsChanged ?? false,
  };
  const writeManifest = (): void => writeJsonAtomic(paths.manifest, redactor.redact(manifest));
  writeManifest();
  log.record({ kind: 'run.created', source: 'runner', data: { runId, scenario, processor, adapterId: adapter.id } });
  progress(`run ${runId}: ${scenario} / ${processor}`);

  // Mutable evidence gathered during the run.
  let preflightResult: PreflightResult | null = null;
  let infra: Infrastructure | null = null;
  let queue: BullmqRunQueue | null = null;
  let session: AdapterSession | null = null;
  let payload: Payload | null = null;
  const workers: OwnedWorker[] = [];
  const observations: RunReport['observations'] = { initial: null, atCheckpoint: null, final: null };
  const evidence = new Map<string, EvidenceCheck>();
  const setEvidence = (id: string, satisfied: boolean, detail: string): void => {
    evidence.set(id, { id, satisfied, detail: redactor.redactString(detail) });
  };
  let haltInfo: Halt | null = null;
  let livenessTimeout = false;
  let jobSnapshot: JobSnapshot | null = null;
  let faultInfo: RunReport['fault'] = null;
  let invariants: InvariantVerdict[] = [];

  const rawOutput = config.captureRawOutput;
  const launch = (generation: string, armed: boolean): OwnedWorker => {
    if (!infra || !queue) throw new Error('launch before infrastructure');
    const worker = new OwnedWorker(
      generation,
      runId,
      {
        processorModule,
        queue: { name: queue.name, prefix: queue.prefix },
        connections: { redis: infra.redis, postgres: infra.postgres },
        namespace,
        timing: config.timing,
        armed: armed ? { checkpoint: checkpointName } : null,
      },
      {
        onMessage: (msg: WorkerMessage) => {
          const data: JsonObject = {};
          for (const key of ['pid', 'operationId', 'checkpoint', 'attemptsStarted', 'stalledCounter'] as const) {
            if (msg[key] !== undefined) data[key] = msg[key];
          }
          if (msg.error) data.error = msg.error;
          log.record({ kind: `ipc.${msg.type}`, source: 'worker', generation, ...(msg.jobId ? { jobId: msg.jobId } : {}), data });
        },
        onRejected: (reason) => {
          log.record({ kind: 'ipc.rejected', source: 'worker', generation, data: { reason } });
          diag(`ignored IPC message from worker ${generation}: ${reason}`);
        },
        onOutput: (stream, line) => {
          appendFileSync(join(dir, `${stream}.log`), `[${generation}] ${redactor.redactString(line)}\n`, { mode: 0o600 });
          if (rawOutput) appendFileSync(join(dir, `raw-${stream}.log`), `[${generation}] ${line}\n`, { mode: 0o600 });
        },
        onExit: (info: ExitInfo) => {
          log.record({ kind: 'worker.exit', source: 'runner', generation, data: { code: info.code, signal: info.signal } });
        },
      },
    );
    workers.push(worker);
    manifest.ownedResources.workers.push({ generation, pid: worker.pid ?? null });
    writeManifest();
    log.record({ kind: 'worker.spawned', source: 'runner', generation, data: { pid: worker.pid ?? null, armed: armed ? checkpointName : null } });
    return worker;
  };

  /** Wait for an event, translating deadlines/aborts into halts unless the caller handles them. */
  const waitFor = async (pred: (e: RecordedEvent) => boolean, label: string, deadlineMs: number, kind: Halt['kind'] = 'inconclusive'): Promise<RecordedEvent> => {
    try {
      return await log.waitFor(pred, { label, deadlineMs, ...(signal ? { signal } : {}) });
    } catch (error) {
      if (error instanceof AbortedError) throw halt('interrupted', error.message);
      if (error instanceof DeadlineError) throw halt(kind, error.message);
      throw error;
    }
  };

  const workerReady = async (worker: OwnedWorker): Promise<void> => {
    const ready = waitFor((e) => e.kind === 'ipc.READY' && e.generation === worker.generation, `worker ${worker.generation} READY`, config.deadlines.workerReadyMs, 'error');
    const died = worker.exited.then((info) => {
      throw halt('error', `worker ${worker.generation} exited during startup (code ${info.code}, signal ${info.signal}); see stderr.log`);
    });
    await Promise.race([ready, died]);
  };

  const isJobEvent = (e: RecordedEvent, ...kinds: string[]): boolean => kinds.includes(e.kind) && e.jobId === jobId;

  /**
   * At a deadline, compare the broker's own job record with what the observers reported.
   * Only a job that is genuinely not terminal (and not secretly stalled) counts as a liveness
   * failure; anything else is a gap in observation and makes the run inconclusive.
   */
  const observerGap = async (): Promise<string | null> => {
    const snap = await queue!.snapshot(jobId);
    if (!snap) return 'job record missing at deadline';
    const sawStall = log.find((e) => isJobEvent(e, 'queue.stalled'));
    if (snap.stalledCounter > 0 && !sawStall) return `job stalledCounter is ${snap.stalledCounter} in Redis but no stalled queue event was observed`;
    if (TERMINAL.has(snap.state)) return `job is ${snap.state} in Redis but the required evidence was not observed before the deadline`;
    return null;
  };

  try {
    // 1. Preflight.
    preflightResult = await preflight({ outputDir: config.outputDir, dockerCommand: config.dockerCommand, ...(hooks.platform ? { platform: hooks.platform } : {}) });
    manifest.environment = preflightResult.environment as unknown as JsonObject;
    writeManifest();
    log.record({ kind: 'preflight', source: 'runner', data: { ok: preflightResult.ok, checks: preflightResult.checks as unknown as JsonObject[] } });
    for (const check of preflightResult.checks.filter((c) => !c.ok)) diag(`preflight ${check.severity}: ${check.detail}`);
    if (!preflightResult.ok) throw halt('error', `preflight failed: ${preflightResult.checks.filter((c) => !c.ok && c.severity === 'error').map((c) => c.detail).join('; ')}`);
    machine.transition('PREFLIGHT_OK');
    throwIfAborted();

    // 2-3. Disposable infrastructure.
    progress('starting disposable Redis + PostgreSQL');
    try {
      infra = await startInfrastructure({ runId, pgPassword, deadlineMs: config.deadlines.infraStartMs, docker: config.dockerCommand, ...(signal ? { signal } : {}) });
    } catch (error) {
      throwIfAborted();
      throw halt('error', `infrastructure failed to start: ${describeError(error, redactor).message}`);
    }
    manifest.images = infra.containers;
    log.record({ kind: 'infra.ready', source: 'infra', data: { project: infra.project, redisPort: infra.redis.port, postgresPort: infra.postgres.port, images: infra.containers as unknown as JsonObject[] } });

    manifest.versions.postgresServer = await waitForPostgres(infra.postgres, config.deadlines.infraStartMs);
    queue = new BullmqRunQueue(runId, infra.redis, config.timing, log, new Set(hooks.dropQueueEvents ?? []));
    await queue.open(); // 5. observers registered before any work exists
    manifest.versions.redisServer = await queue.serverVersion();

    // 4. Application fixtures.
    session = await adapter.open({ runId, scenario, namespace, processor, postgres: infra.postgres });
    await session.setup();
    observations.initial = await session.observe();
    writeManifest();
    log.record({ kind: 'observe.initial', source: 'observer', data: observations.initial });
    machine.transition('INFRA_READY');
    throwIfAborted();

    // 6. Worker A.
    const armed = scenario === 'post-commit-crash';
    const workerA = launch('A', armed);
    await workerReady(workerA);
    setEvidence('worker-a-ready', true, `worker A pid ${workerA.pid} READY${armed ? `, armed at "${checkpointName}"` : ', unarmed'}`);
    machine.transition('A_READY');
    throwIfAborted();

    // 7. Exactly one logical job.
    payload = await session.makePayload();
    const submittedId = await queue.addJob(jobId, payload.data);
    log.record({ kind: 'job.submitted', source: 'runner', jobId: submittedId, data: { operationId: payload.operationId } });
    setEvidence('job-submitted-once', submittedId === jobId, `job ${submittedId} for operation ${payload.operationId}`);
    machine.transition('JOB_SUBMITTED');

    if (scenario === 'baseline') {
      progress('baseline: waiting for completion without a fault');
      try {
        await waitFor((e) => isJobEvent(e, 'queue.completed', 'queue.failed'), 'baseline job terminal state', config.deadlines.completionMs);
        setEvidence('job-terminal', true, 'terminal queue event observed');
        machine.transition('JOB_TERMINAL');
      } catch (error) {
        if (!(error instanceof HaltError) || error.halt.kind !== 'inconclusive') throw error;
        const gap = workerA.alive && (await queue.healthy()) ? await observerGap() : 'worker A or Redis unhealthy';
        if (gap) throw halt('inconclusive', `${error.message}; ${gap}`);
        livenessTimeout = true;
        setEvidence('job-terminal', false, error.message);
      }
    } else {
      // 8-9. Barrier after commit, then independent confirmation.
      progress(`waiting for worker A to reach "${checkpointName}"`);
      const reached = waitFor(
        (e) => e.kind === 'ipc.CHECKPOINT_REACHED' && e.generation === 'A' && e.jobId === jobId && e.data?.checkpoint === checkpointName,
        `worker A checkpoint "${checkpointName}"`,
        config.deadlines.checkpointMs,
      );
      const finishedEarly = waitFor((e) => isJobEvent(e, 'queue.completed', 'queue.failed'), 'n/a', config.deadlines.checkpointMs + 60_000).then((e) => {
        throw halt('inconclusive', `job reached ${e.kind.replace('queue.', '')} before the armed checkpoint; the fault boundary was never reached (checkpoint absent or misplaced)`);
      });
      const diedEarly = workerA.exited.then((info) => {
        throw halt('inconclusive', `worker A exited before reaching the checkpoint (code ${info.code}, signal ${info.signal})`);
      });
      const checkpointEvent = await Promise.race([reached, finishedEarly, diedEarly]);
      finishedEarly.catch(() => {});
      diedEarly.catch(() => {});
      setEvidence('checkpoint-reached', true, `CHECKPOINT_REACHED seq ${checkpointEvent.seq} from worker A for ${jobId}`);
      if (checkpointEvent.data?.operationId !== payload.operationId) diag(`checkpoint operationId ${String(checkpointEvent.data?.operationId)} differs from payload ${payload.operationId}`);

      observations.atCheckpoint = await session.observe();
      log.record({ kind: 'observe.at-checkpoint', source: 'observer', jobId, data: observations.atCheckpoint });
      const commit = session.confirmCommitted(observations.atCheckpoint, payload);
      setEvidence('commit-independently-confirmed', commit.committed, commit.detail);
      if (!commit.committed) {
        throw halt('inconclusive', `checkpoint reached but the effect is not independently visible (${commit.detail}); the barrier is not after a committed effect`);
      }
      machine.transition('COMMIT_CONFIRMED');
      throwIfAborted();

      // 10. The fault. Persist pre-kill evidence first.
      log.record({ kind: 'fault.planned', source: 'runner', generation: 'A', jobId, data: { signal: 'SIGKILL', pid: workerA.pid ?? null } });
      log.sync();
      faultInfo = { requested: { kind: 'SIGKILL', target: 'worker A', checkpoint: checkpointName }, delivered: false, confirmed: false, exit: null };
      const delivered = hooks.suppressFaultSignal ? false : workerA.sigkill();
      faultInfo.delivered = delivered;
      log.record({ kind: 'fault.sent', source: 'runner', generation: 'A', data: { delivered } });
      setEvidence('fault-delivered', delivered, delivered ? `SIGKILL delivered to owned worker A pid ${workerA.pid}` : 'fault signal was not delivered');
      const exit = await Promise.race([workerA.exited, new Promise<null>((r) => setTimeout(() => r(null), config.deadlines.killConfirmMs).unref())]);
      if (!exit) throw halt('inconclusive', `worker A exit not confirmed within ${config.deadlines.killConfirmMs} ms; no crash coverage is claimed`);
      faultInfo.exit = { code: exit.code, signal: exit.signal };
      faultInfo.confirmed = delivered && exit.signal === 'SIGKILL';
      setEvidence('worker-a-exit-confirmed', faultInfo.confirmed, `worker A exit code ${exit.code} signal ${exit.signal}`);
      if (!faultInfo.confirmed) throw halt('inconclusive', `worker A did not die from the injected SIGKILL (code ${exit.code}, signal ${exit.signal})`);
      const afterKill = await queue.snapshot(jobId);
      setEvidence('job-active-after-kill', afterKill?.state === 'active', `job state after worker A death: ${afterKill?.state ?? 'missing'}`);
      if (afterKill?.state !== 'active') throw halt('inconclusive', `job was ${afterKill?.state ?? 'missing'} after worker A died; A was not interrupted before acknowledgement`);
      machine.transition('A_EXIT_CONFIRMED');
      progress('worker A killed after commit; starting worker B');
      throwIfAborted();

      if (hooks.afterFault) await hooks.afterFault({ addExtraJob: (data) => queue!.addUnrelatedJob(data) });

      // 11. Worker B, unarmed. BullMQ's own stalled recovery must redeliver.
      const workerB = launch('B', false);
      await workerReady(workerB);
      machine.transition('B_READY');
      const recoveryStart = Date.now();
      const remaining = (): number => Math.max(1, config.deadlines.recoveryMs - (Date.now() - recoveryStart));

      try {
        // 12. Independent redelivery evidence: broker stall event and worker B starting the same job/operation.
        const stalled = waitFor((e) => isJobEvent(e, 'queue.stalled'), 'BullMQ stalled event', remaining());
        const bStarted = waitFor((e) => e.kind === 'ipc.PROCESSING_STARTED' && e.generation === 'B' && e.jobId === jobId, 'worker B processing the same job', remaining());
        const [stallEvent, bEvent] = await Promise.all([stalled, bStarted]);
        stalled.catch(() => {});
        bStarted.catch(() => {});
        setEvidence('broker-stalled-recovery', true, `queue stalled event seq ${stallEvent.seq}`);
        const sameOp = bEvent.data?.operationId === payload.operationId;
        setEvidence('redelivered-to-worker-b', sameOp, `worker B started ${jobId} with operation ${String(bEvent.data?.operationId)}`);
        machine.transition('REDELIVERY_CONFIRMED');
        // 13. Terminal state.
        await waitFor((e) => isJobEvent(e, 'queue.completed', 'queue.failed'), 'job terminal state after recovery', remaining());
        setEvidence('job-terminal', true, 'terminal queue event observed');
        machine.transition('JOB_TERMINAL');
      } catch (error) {
        if (!(error instanceof HaltError) || error.halt.kind !== 'inconclusive') throw error;
        // Deadline after a confirmed valid fault: liveness violation only if observers are healthy.
        const healthy = workerB.alive && (await queue.healthy()) && !log.find((e) => e.kind === 'queue.observer-error');
        if (!healthy) throw halt('inconclusive', `${error.message}; observers or worker B unhealthy, liveness cannot be judged`);
        const gap = await observerGap();
        if (gap) throw halt('inconclusive', `${error.message}; ${gap} (observer gap, not a liveness failure)`);
        livenessTimeout = true;
        diag(`bounded liveness deadline reached: ${error.message}`);
        if (!evidence.has('broker-stalled-recovery')) setEvidence('broker-stalled-recovery', Boolean(log.find((e) => isJobEvent(e, 'queue.stalled'))), 'checked at deadline');
        if (!evidence.has('redelivered-to-worker-b')) setEvidence('redelivered-to-worker-b', false, 'worker B did not start the job before the deadline');
        setEvidence('job-terminal', false, error.message);
      }
    }

    // 14. Final durable state and job record.
    jobSnapshot = await queue.snapshot(jobId);
    observations.final = await session.observe();
    log.record({ kind: 'observe.final', source: 'observer', jobId, data: observations.final });
    setEvidence('final-observation', true, 'final durable state read on an independent connection');

    const ids = await queue.allJobIds();
    const foreignStarts = log.filter((e) => e.kind === 'ipc.PROCESSING_STARTED' && e.jobId !== jobId);
    setEvidence(
      'single-job-in-queue',
      ids.length === 1 && ids[0] === jobId && foreignStarts.length === 0,
      `queue job ids: [${ids.join(', ')}]; processing of other jobs: ${foreignStarts.length}`,
    );
    const starts = log.filter((e) => e.kind === 'ipc.PROCESSING_STARTED' && e.jobId === jobId);
    if (scenario === 'baseline') {
      setEvidence('single-processing-attempt', starts.length === 1, `${starts.length} processing start(s)`);
      const stalls = log.filter((e) => isJobEvent(e, 'queue.stalled'));
      setEvidence('no-stall-recovery', stalls.length === 0, `${stalls.length} stalled event(s)`);
    } else if (starts.length > 2) {
      diag(`unexpected additional processing generations: ${starts.length} starts for ${jobId}`);
    }

    invariants = [
      {
        id: 'job-completed-within-deadline',
        description: 'Job completed within deadline',
        category: 'kit',
        expected: 'completed',
        observed: jobSnapshot ? (livenessTimeout && !TERMINAL.has(jobSnapshot.state) ? `${jobSnapshot.state} (deadline)` : jobSnapshot.state) : 'missing',
        verdict: jobSnapshot?.state === 'completed' && !livenessTimeout ? 'pass' : 'fail',
      },
      ...session.evaluate({ scenario, payload, initial: observations.initial, final: observations.final }).map((v) => ({ ...v, category: 'business' as const })),
    ];
    machine.transition('OBSERVED');
  } catch (error) {
    if (error instanceof HaltError) haltInfo = error.halt;
    else haltInfo = { kind: signal?.aborted ? 'interrupted' : 'error', reason: `harness error: ${describeError(error, redactor).message}` };
    if (machine.canTransition('HALTED')) machine.transition('HALTED');
    diag(`halted (${haltInfo.kind}): ${haltInfo.reason}`);
    // Preserve whatever final evidence is still readable.
    if (queue && !jobSnapshot) jobSnapshot = await queue.snapshot(jobId).catch(() => null);
    if (session && !observations.final && !signal?.aborted) {
      observations.final = await session.observe().catch(() => null);
    }
  }

  // Evaluation and provisional report (before cleanup). Every required item appears in the report.
  for (const id of requiredEvidence(scenario)) {
    if (!evidence.has(id)) setEvidence(id, false, 'not observed');
  }
  const evaluation = evaluate({ scenario, halt: haltInfo, evidence: [...evidence.values()], invariants, livenessTimeout });
  const processingStarts = log
    .filter((e) => e.kind === 'ipc.PROCESSING_STARTED')
    .map((e) => ({
      generation: e.generation ?? '?',
      jobId: e.jobId ?? '?',
      operationId: typeof e.data?.operationId === 'string' ? e.data.operationId : null,
      attemptsStarted: typeof e.data?.attemptsStarted === 'number' ? e.data.attemptsStarted : null,
    }));
  const rerunCommand = `killpoint rerun --manifest ${paths.manifest}`;
  const buildReport = (cleanup: CleanupReport, final: boolean): RunReport => {
    const finishedAt = final ? new Date() : null;
    return redactor.redact({
      schemaVersion: REPORT_SCHEMA_VERSION,
      tool,
      final,
      runId,
      scenario,
      processor,
      adapterId: adapter.id,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt?.toISOString() ?? null,
      durationMs: finishedAt ? finishedAt.getTime() - startedAt.getTime() : null,
      outcome: final ? finalizeOutcome(evaluation.outcome, cleanup.status === 'ok') : evaluation.outcome,
      evaluatedOutcome: evaluation.outcome,
      validity: { valid: evaluation.valid, evidence: [...evidence.values()], missing: evaluation.missingEvidence },
      reasons: [...evaluation.reasons, ...(final && cleanup.status !== 'ok' ? ['cleanup failed; result is not an unqualified success'] : [])],
      fault: faultInfo,
      operationId: payload?.operationId ?? null,
      payloadSha256: payload ? createHash('sha256').update(JSON.stringify(payload.data)).digest('hex') : null,
      observations,
      invariants,
      job: jobSnapshot,
      processingStarts,
      livenessTimeout,
      halt: haltInfo,
      states: machine.history.map((h) => h.state),
      timing: { ...config.timing },
      deadlines: { ...config.deadlines },
      diagnostics,
      cleanup,
      artifacts: paths,
      rerun: { command: rerunCommand, of: opts.rerunOf?.runId ?? null, inputsChanged: opts.rerunOf?.inputsChanged ?? false },
    } satisfies RunReport);
  };
  const writeReport = (report: RunReport): void => {
    const problems = validateReport(report);
    if (problems.length > 0) {
      diag(`report failed schema validation: ${problems.join('; ')}`);
      report.outcome = 'ERROR';
      report.reasons.push('report failed schema validation');
    }
    writeJsonAtomic(report.final ? paths.report : join(dir, 'report.provisional.json'), report);
  };
  writeReport(buildReport({ status: 'pending', steps: [] }, false));
  if (machine.canTransition('REPORTED')) machine.transition('REPORTED');

  // Cleanup: only resources this run owns.
  progress('cleaning up owned resources');
  const steps: CleanupReport['steps'] = [];
  const step = async (name: string, fn: () => Promise<string>): Promise<void> => {
    try {
      steps.push({ name, ok: true, detail: redactor.redactString(await fn()) });
    } catch (error) {
      steps.push({ name, ok: false, detail: describeError(error, redactor).message });
    }
  };
  for (const worker of workers) {
    await step(`stop-worker-${worker.generation}`, async () => {
      if (!worker.alive) return `already exited (${worker.exit?.signal ?? worker.exit?.code})`;
      const result = await worker.stop(config.deadlines.stopMs);
      return result.graceful ? 'stopped gracefully' : 'force-killed after stop deadline';
    });
  }
  if (queue) await step('close-queue-observers', async () => (await queue!.close(), 'closed'));
  if (session) await step('adapter-teardown', async () => (await session!.teardown(), 'adapter resources removed'));
  if (infra || machine.reached('PREFLIGHT_OK')) {
    const infraSteps = await stopInfrastructure({ runId, docker: config.dockerCommand, timeoutMs: config.deadlines.cleanupMs });
    steps.push(...infraSteps);
  }
  const survivors = workers.filter((w) => w.alive);
  steps.push({ name: 'verify-no-owned-workers', ok: survivors.length === 0, detail: survivors.length === 0 ? 'no owned worker processes remain' : `${survivors.length} owned worker(s) still alive` });
  const cleanup: CleanupReport = { status: steps.every((s) => s.ok) ? 'ok' : 'failed', steps };
  log.record({ kind: 'cleanup', source: 'runner', data: { status: cleanup.status } });
  if (machine.canTransition('CLEANED')) machine.transition('CLEANED');

  const report = buildReport(cleanup, true);
  writeReport(report);
  log.close();
  progress(`outcome ${report.outcome}`);

  return {
    runId,
    outcome: report.outcome,
    evaluatedOutcome: report.evaluatedOutcome,
    valid: report.validity.valid,
    invariants: report.invariants,
    observations: report.observations,
    report,
    reportPath: paths.report,
    cleanup,
    preflight: preflightResult,
  };
}
