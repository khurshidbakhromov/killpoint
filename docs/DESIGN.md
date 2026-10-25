# Design

## What is tested

A BullMQ processor commits a durable PostgreSQL effect. Its worker process is then SIGKILLed before it returns, so BullMQ never marks the job completed. BullMQ's own stalled-job recovery later redelivers the same job to another worker. The question is whether the application applies the effect twice.

## Components

```text
CLI (src/cli.ts) ──► runScenario (src/core/runner.ts) ──► events.jsonl (fsync before the fault)
                          │  ScenarioStateMachine            report.provisional.json → report.json (atomic)
                          │  outcomes.evaluate                manifest.json
                          │
       ┌──────────────────┼──────────────────────────┬──────────────────────────┐
       ▼                  ▼                          ▼                          ▼
 compose.yaml       BullmqRunQueue             OwnedWorker A / B          AdapterSession
 (per-run Redis +   (queue, one job,           (fork of compiled          (fixtures, payload,
  PostgreSQL)        QueueEvents observer)      worker-bootstrap.js)       independent observe,
                                                    │ IPC                  invariants)
                                                    ▼
                                             your processor module
                                             createProcessor(ctx) → process(job)
                                             … commit … await ctx.checkpoint("effect-committed")
```

The runner owns orchestration: infrastructure, the queue, the single logical job, the worker processes, the fault and the evidence. The adapter owns business meaning: what to seed, what the payload is, what the durable state looks like, and which invariants must hold. The runner never infers correctness from queue completion.

## Scenario S1 (post-commit-crash)

| Step | Evidence required |
|---|---|
| Preflight: Linux, Node, Docker, Compose, writable output | `preflight` event |
| Start Compose project `crl-<run>`, wait for health, connect to PostgreSQL | `infra.ready`, server versions, image digests |
| Open the queue and QueueEvents observer **before** any job exists | |
| Adapter setup, then the initial observation | `observe.initial` |
| Fork worker A (armed at `effect-committed`) and wait for authenticated `READY` | `worker-a-ready` |
| Add exactly one job (`job-<run>`, `attempts: 1`, records retained) | `job-submitted-once` |
| A commits, then sends `CHECKPOINT_REACHED` and blocks (still renewing its lock) | `checkpoint-reached` |
| Runner reads PostgreSQL on its own connection; the first effect must be visible | `commit-independently-confirmed` |
| fsync the event log, then SIGKILL the owned child handle | `fault-delivered` |
| Await the exit event with `signal === "SIGKILL"` | `worker-a-exit-confirmed` |
| Job is still `active` in Redis (A never acknowledged it) | `job-active-after-kill` |
| Fork worker B (unarmed). BullMQ's stalled checker moves the job back to wait | `broker-stalled-recovery` (QueueEvents `stalled`) |
| B starts the **same job ID and operation ID** | `redelivered-to-worker-b` |
| Job reaches completed/failed within the recovery deadline | `job-terminal` |
| Final durable observation; the queue contains only this job | `final-observation`, `single-job-in-queue` |

The baseline scenario has its own path (A unarmed, no kill). It requires exactly one processing start and no stall.

Queue events and IPC messages may arrive in either order. Waiters match recorded evidence by identity (kind, job, generation), not by position, and the controller sequence number in `events.jsonl` is receive order only.

## State machine

```text
CREATED → PREFLIGHT_OK → INFRA_READY → A_READY → JOB_SUBMITTED → COMMIT_CONFIRMED
→ A_EXIT_CONFIRMED → B_READY → REDELIVERY_CONFIRMED → JOB_TERMINAL → OBSERVED → REPORTED → CLEANED
baseline: … JOB_SUBMITTED → JOB_TERMINAL → OBSERVED → …
any active state → HALTED → REPORTED → CLEANED
```

Illegal transitions throw. A duplicate checkpoint cannot cause a second fault, because `COMMIT_CONFIRMED` is reachable only once.

## Outcomes

`evaluate()` in `src/core/outcomes.ts` is a pure function of the halt reason, the evidence checks, the invariant verdicts and the liveness flag:

- **ERROR**: a harness, config or infrastructure failure, or a failed cleanup (the pre-cleanup verdict is kept as `evaluatedOutcome`).
- **INCONCLUSIVE**: an interrupt; any required evidence missing; no business invariants declared; an invariant that could not be evaluated; or an observer gap at the deadline.
- **VIOLATION**: a valid experiment with at least one failing invariant, or a bounded liveness timeout after a confirmed fault while observers stayed healthy.
- **PASS**: everything else. That requires complete evidence and every invariant evaluated and passing.

## IPC protocol (version 1)

Envelope: `{ protocol: "crash-retry-lab/ipc", version: 1, session, runId, generation, type }`. `session` is a 128-bit nonce generated for each worker launch.

| Direction | Type | Purpose |
|---|---|---|
| runner → worker | `INIT` | processor path, queue, test-only connections, namespace, timing, armed checkpoint (or null) |
| worker → runner | `READY` | the BullMQ Worker is connected (stalled checker running) |
| worker → runner | `PROCESSING_STARTED` | job ID, operation ID, `attemptsStarted`, `stalledCounter` |
| worker → runner | `CHECKPOINT_REACHED` | the armed checkpoint was hit for the first time in this generation; the worker blocks |
| worker → runner | `CHECKPOINT_PASSED` | an unarmed checkpoint (informational) |
| worker → runner | `PROCESSOR_RETURNED` / `PROCESSOR_ERROR` | processor finished (the error message is redacted by the runner) |
| runner → worker | `RELEASE_CHECKPOINT` | controlled release (not used by S1) |
| runner → worker | `STOP` → `WORKER_STOPPED` | graceful stop; never opens a gated barrier |

A message with the wrong session, run, generation, version or shape is rejected and recorded as `ipc.rejected` plus a diagnostic. If a worker loses its channel it exits immediately (code 70 if it was gated, otherwise 69). It never continues through the barrier.

## Resource ownership

- The only process that can be signalled is the `ChildProcess` handle the runner forked. There is no PID input and no name-based killing. Children are forked without a shell, with `execArgv: []` and a minimal environment.
- Compose project, container labels, queue name, schema and job ID are all derived from the run ID. Schema identifiers are validated before interpolation; all values are bind parameters.
- Cleanup checks that every container in the project carries this run's label before running `compose down --volumes --remove-orphans`, then checks that nothing labelled for the run remains. There is no `prune`, no `FLUSHALL` and no global cleanup.

## Artifacts

```text
.crash-retry-lab/runs/<run-id>/
  manifest.json            versions, image digests, fingerprints, effective timing, owned resources, cleanup command
  events.jsonl             controller-ordered evidence (seq, wall time, monotonic elapsed)
  report.provisional.json  written before cleanup
  report.json              final, schema-validated, atomically written
  stdout.log / stderr.log  worker output, redacted line by line (only if the worker printed anything)
  raw-*.log                only with captureRawOutput: true (local-only, unredacted)
```

Every string goes through the redactor, which knows the run's generated PostgreSQL password and common credential shapes. Payloads are recorded as a SHA-256 plus the operation ID, never in full.
