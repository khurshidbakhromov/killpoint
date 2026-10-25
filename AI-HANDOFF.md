# Crash/retry testing library — AI implementation handoff

**Prepared:** 2026-10-25  
**Owner:** Khurshid  
**Status:** Specification only. No implementation, executed tests, validated compatibility matrix, or proven user adoption yet.  
**Working title:** Crash Retry Lab. Repository/package/binary names are provisional; availability and trademarks have not been checked.  
**Transfer:** This file is self-contained. Give it to an AI coding CLI in a new or explicitly selected project repository. It does not require access to the original conversation.

## 1. Instructions for the implementing agent

Build the smallest credible open-source developer tool described here. Read the target repository's instructions first, inspect existing files, and preserve unrelated work. Do not replace an existing application or assume that the directory containing this document is the implementation repository.

Start with milestone M0, then build through M4 in order. A short plan is useful, but the deliverable is working code and evidence, not a plan alone. Make routine reversible implementation decisions without repeatedly asking the user. Record material deviations and their reasons in docs/DECISIONS.md.

The product direction is selected. The technology choices below are recommended defaults, not user-confirmed language preferences. Change a default only for a concrete compatibility or repository constraint, and document it. Do not expand the initial scope to match every competitor.

Use real Redis, PostgreSQL and separate worker processes for the integration scenario. If Docker or another required capability is unavailable, continue independent unit/schema/documentation work, report the missing prerequisite, and leave integration verification explicitly incomplete. Never silently substitute in-memory mocks and claim the crash scenario passed.

This brief authorizes local implementation when the user supplies it as a task. It does not independently authorize publishing a package, opening public issues, contacting maintainers, using production data, or deploying. A later explicit user instruction controls those actions.

No need to build a web app, employ an LLM at runtime, or require an API key.

## 2. Purpose and intended user

Help backend developers test whether application-level side effects remain correct when an at-least-once background job is interrupted and redelivered.

**Product promise:** “Trigger a specific failure boundary in your worker, observe the durable outcome after recovery, and retain a repeatable regression case.”

**Career goal:** demonstrate credible distributed-systems engineering and create something other developers use. Immediate monetization is optional. Do not optimize for fabricated novelty, star counts, or a SaaS dashboard.

**First user:** a developer with a Node/TypeScript BullMQ processor and PostgreSQL-backed effects who can run a disposable local test environment.

**First use case:** a worker commits a durable effect, then dies before BullMQ marks the job completed. BullMQ later redelivers the same job. Does the application duplicate that effect?

A queue's unique job ID does not by itself make an already-started processor's effects idempotent. Likewise, a successful eventual retry is not evidence that only one effect occurred.

## 3. Existing work and positioning

Do not describe crash testing, deterministic simulation, idempotency testing or the payment-then-crash scenario as new inventions.

| Existing work | Overlap | Implication |
|---|---|---|
| Faultline | Real Celery/BullMQ process faults, PostgreSQL invariants, remote-outcome scenarios | Closest direct alternative; inspect before reproducing its features |
| Déjà | Node/TypeScript simulation, replay seeds, invariants, failure minimization | Useful alternative; documented I/O-injection and transaction-model limitations |
| Chronos / chronos-vitest | Search surfaced TypeScript simulation and test-runner integration | Verify the actual current project before claiming an integration gap |
| payfuzz | Duplicate/concurrent webhook delivery and business-state checking | Do not pivot into another generic webhook replay tool |

**Differentiation hypothesis, not a proven gap:** a small, well-documented way to bring an existing application processor into a real-process failure test, with minimal instrumentation, honest outcomes and useful evidence.

M0 should examine one candidate application or the reference processor against current alternatives and record the remaining integration friction. If no real application is supplied, proceed with an explicitly labeled reference fixture; real-world validation remains pending. Do not pretend a second toy fixture proves demand.

If the same useful deliverable is better implemented as an extension to an existing project, record a concrete recommendation and reusable adapter design. Do not automatically fork, change the selected repository, abandon implementation, or publish upstream without user direction.

## 4. Scope and version boundaries

### v0.1: one failure class, deeply verified

Deliver:
- A programmatic runner and a thin local CLI.
- One BullMQ adapter and one supported stack.
- Real disposable Redis and PostgreSQL.
- Separate owned Node worker processes.
- A named post-commit barrier and targeted SIGKILL.
- Actual broker redelivery, not manually inserting a replacement job.
- An unsafe reference processor and a transactionally idempotent reference processor.
- A no-fault baseline, unsafe fault run, and safe fault run.
- Durable-state assertions, JSON/JSONL evidence and a concise terminal summary.
- A documented way to plug in another compatible application processor.
- A packaged-consumer smoke check and a Linux CI job.

v0.1 does NOT need a general scheduler, broker emulator, browser UI, account system, cloud service, broad plugin marketplace, AI summaries, automatic ORM instrumentation, or production traffic recording.

### Later milestones, not v0.1 requirements

**v0.2: remote effect committed but response lost.** Use a local fake HTTP service with its own durable effect store; observe service commit independently, suppress the reply, then exercise client recovery. Show why a local database receipt or fencing token is not a universal substitute for provider-side idempotency.

**v0.3: stale owner resumes.** Pause Worker A before an effect, allow lease expiry and Worker B ownership, then resume A. Test application-level transactional fencing against stale commits. A BullMQ lock token is not automatically a fencing mechanism for an external database.

Additional brokers, simulated scheduling, failure reduction, runner-specific plugins, Windows support and a visual timeline can follow actual user need.

## 5. Recommended stack and compatibility policy

- TypeScript, strict settings, ESM.
- Node.js 24 as the initial target; verify current maintained releases and dependencies at implementation time. Do not advertise support for untested Node majors.
- npm with a checked-in package-lock.json; one package first, not a monorepo.
- BullMQ and a compatible Redis version.
- PostgreSQL with the pg driver for the reference fixture.
- Docker Compose v2 for test dependencies; workers initially run as owned host Node child processes.
- Node's built-in test runner unless the target repository has an established equivalent.
- JSON Schema or an equivalent runtime validator for configuration/reports.
- Standard Node child-process IPC for test barriers.
- Suggested license: MIT, subject to the user's project choice. Confirm copyright details rather than inventing them.

Pin exact tested library versions in the lockfile and explicit container image versions; never use floating latest tags. Record resolved image IDs/digests in reports. The research mentions BullMQ 6.3.7 as a resolved historical issue version; that is NOT a recommendation to pin it.

Choose an initial Linux CI environment. macOS may be supported only after exercising its signal/process behavior. Native Windows should fail preflight with a clear unsupported-platform result in v0.1; WSL2 requires its own verified environment entry.

Compile worker entry modules to JavaScript. A successful development run using an ad-hoc TS loader does not prove that an installed package can launch its workers.

Before coding recovery logic, verify the chosen BullMQ version's lock duration, renewal, stalled-check and max-stall semantics from primary docs and a small experiment. Do not copy legacy QueueScheduler assumptions without checking the selected version.

## 6. Architecture

The runner owns orchestration; application adapters own business semantics.

```text
CLI / programmatic caller
          |
          v
Runner + scenario state machine ----> JSONL event log + final JSON report
    |             |                                ^
    |             +---- independent observer ------|
    |                            |
    v                            v
Owned worker A/B <----------> PostgreSQL
    |
    v
BullMQ / Redis

Worker -> IPC checkpoint -> runner verifies committed state
Runner -> kill owned A -> start B -> broker redelivery -> final observation
```

Suggested source layout:

```text
src/
  index.ts                 public runner exports
  cli.ts                   thin argument parsing and exit codes
  config.ts                runtime validation and trusted module loading
  core/
    runner.ts              lifecycle and cleanup
    scenario.ts            explicit state transitions
    events.ts              event contracts
    outcomes.ts            validity and invariant evaluation
  control/
    worker-bootstrap.ts    compiled child entry
    ipc.ts                 checkpoint/ready/error protocol
    child.ts               owned-process lifecycle
  adapters/
    bullmq.ts              queue lifecycle + recovery observations
  reporting/
    schema.ts
    json.ts
    terminal.ts
examples/
  ledger/                  unsafe + safe processors, fixture adapter, SQL
tests/
  unit/
  integration/
  consumer/
docs/
  QUICKSTART.md
  DESIGN.md
  LIMITATIONS.md
  DECISIONS.md
  VALIDATION.md
compose.yaml
package.json
package-lock.json
```

Keep orchestration independent of the example's SQL. Business observations come from the application adapter, not a hard-coded generic inference that a queue completion means correctness.

## 7. API and adapter contract

This is a design contract, not existing executable API. Implementers may adjust naming while preserving responsibilities.

### Parent-side project adapter

A trusted, locally authored compiled JavaScript module exports:
- An adapter ID and schema version.
- An absolute/resolved worker processor module path.
- setup(context): create/seed run-scoped application fixtures.
- makePayload(context): return the test job payload.
- observe(context): return an independently read durable-state snapshot.
- teardown(context): remove only the application resources owned by this run.

The kit owns queue creation and adding the single logical job. The payload contains a stable business operation ID distinct from its job ID.

For v0.1, adapters run against kit-created disposable services. Attaching to arbitrary existing worker deployments or production services is out of scope.

### Child-side processor module

Export an async processor that receives the job and a serializable test context:
- run ID, generation ID, operation ID and resource namespace;
- test-only connection settings;
- checkpoint(name), an awaitable test seam.

Wrap or import the real application's processor where practical. If refactoring to inject dependencies or place the seam is required, document the actual changes; do not promise zero instrumentation.

Place:

```text
await businessTransactionCommit()
await testContext.checkpoint("effect-committed")
return processorResult
```

The barrier must be after the commit promise succeeds, outside the transaction, and before the processor returns to BullMQ. A seam inside an uncommitted transaction tests rollback instead of the intended post-commit hazard.

With no armed fault, checkpoint resolves immediately. When armed for a specific run/job/worker generation, it reports arrival and waits. It must not accidentally arm again for Worker B.

If a gated worker loses its control channel, terminate with a controlled error; do not quietly continue through the barrier. The runner classifies an unexpected channel loss as an invalid experiment.

### Public runner result

Return:
- scenario validity;
- observation snapshots;
- individual invariant verdicts;
- overall outcome;
- evidence/report paths;
- cleanup status.

Do not call process.exit from the library. The CLI maps results to exit codes.

## 8. Scenario S1: post-commit crash and broker redelivery

The controller is event-driven with bounded deadlines, not a chain of sleep calls.

1. Validate OS, Node, Docker/Compose, config and writable output path.
2. Create a fresh run ID and isolated infrastructure/project namespace.
3. Start test Redis and PostgreSQL; wait for real readiness.
4. Set up fixture tables and initial balance.
5. Register queue/worker observers before submitting work.
6. Start Worker A in its own child process and wait for explicit READY.
7. Add exactly one job with a stable logical operation ID; retain completed/failed job records.
8. Worker A records an application attempt, commits the business effect, reaches the armed checkpoint, and blocks before returning.
9. Runner receives the checkpoint with matching run/job/generation, then reads the database on an independent connection. Confirm the expected first effect is durably visible. Persist this observation and the planned fault event.
10. Send SIGKILL to the exact owned Worker A child. Await confirmed exit. Do not use graceful Worker.close as the fault; that changes acknowledgment/recovery behavior.
11. Start Worker B with no armed barrier. Allow BullMQ's documented stalled-job recovery to redeliver the same job after A's lock expires.
12. Independently observe Worker B starting processing of the same job and operation. Do not infer retry solely from BullMQ attemptsMade; stalls may have different accounting.
13. Wait for job completion or an explicit terminal error within the recovery deadline.
14. Read final durable state after completion. Stop B, preserve final observations and a provisional report, then clean owned resources. Atomically finalize the report with cleanup results; a report emitted before cleanup is not the final run outcome.

Checkpoint messages alone are not proof of commit. A call to kill alone is not proof of death. A second manually queued job is not proof of broker recovery. Require all three boundaries in evidence.

Worker A can keep renewing its queue lock while awaiting the barrier. Lock expiry starts after it dies, not when the checkpoint arrives. Start B so the chosen BullMQ version's stalled detection is active. Set a bounded recovery deadline that includes lock expiry, stalled scanning and a documented scheduling margin.

Use one worker concurrency and one job in v0.1. No unrelated consumers may access the generated queue.

### Baseline variant

Run the same application/queue/infrastructure without an armed fault. Require one processing attempt, completed job and one durable effect. The missing kill/redelivery is intentional for this variant and must not be misclassified as failed S1 coverage.

## 9. Reference ledger and correctness oracle

Use synthetic credits, not real payment credentials. Each run starts with balance 0 and an intended credit amount of 100 integer units.

Suggested run-scoped tables:
- operations: tenant ID, logical operation ID, request fingerprint, amount.
- effect_ledger: durable accepted business effects.
- account_balance: integer balance.
- processing_attempts: run ID, worker generation, job ID, operation ID, start/finish status.

processing_attempts is observational and may have an unfinished A attempt after SIGKILL. It must not be confused with accepted effects.

### Unsafe processor

In one database transaction:
- append a new effect with a fresh effect-row identity;
- atomically increment the account balance by 100;
- commit.

Then await the checkpoint and return. It has no logical-operation deduplication. Under a valid S1 run, two processing attempts should produce two accepted effects and balance 200.

### Safe processor

In one database transaction:
- atomically claim a unique (tenant ID, operation ID) with a stable request fingerprint;
- if new, insert the accepted effect and increment balance;
- if already claimed with the same fingerprint, leave effect/balance unchanged;
- if the same key has different payload/amount, fail with a conflict, not silent success;
- commit the operation receipt and effect together.

After the first effect commit, reach the checkpoint. On recovery, the same operation is deduplicated and the job can complete. Final accepted effects = 1, balance = 100, and processing attempts demonstrate A and B.

Never claim “exactly-once execution”: execution happened more than once. The property is a single durable effect for the tested operation and scenario.

A receipt written before a separately committed effect can lose work; one written after a separately committed effect can duplicate it. Include a deliberately incorrect split-transaction implementation as an optional focused regression test if needed to verify this distinction, not an extra product feature.

### Required invariant set

- At most one accepted effect for the logical operation.
- At least one accepted effect after recovery/completion; zero effects is not success.
- Exact intended account delta: 100.
- Job reaches completed state within the supported recovery deadline.
- No unrelated operation/tenant state changes.

Applications outside the reference fixture must declare equivalent business observations. Do not automatically assume that counting rows is sufficient for every application.

## 10. Experiment validity and outcome semantics

Separate these two questions:
1. Did the requested fault and recovery scenario actually occur?
2. Did the application preserve its declared invariants?

Outcomes:
- PASS: required scenario evidence is complete and all invariants pass.
- VIOLATION: the intended experiment is valid and at least one declared invariant fails.
- INCONCLUSIVE: evidence/preconditions are incomplete, so the claim cannot be evaluated.
- ERROR: config, harness, infrastructure or report-generation failure prevented trustworthy evaluation.

A liveness deadline reached after a confirmed valid fault, while infrastructure and observers remain healthy, can be a bounded liveness VIOLATION. A deadline caused by lost observers, unavailable services or unconfirmed fault delivery is INCONCLUSIVE/ERROR. Report the distinction and deadline; do not claim a universal nontermination proof.

CLI exit codes:
- 0: PASS.
- 1: VIOLATION.
- 2: INCONCLUSIVE or ERROR.

Batch results retain every case. If any case is inconclusive/error, batch exit is 2 even if another case violated an invariant. Otherwise any violation produces 1. Never hide observed violations behind only a batch summary.

A separate demo-comparison command expects a passing baseline, a valid unsafe VIOLATION, and a safe PASS. It exits 0 only when all expected outcomes are observed. Individual unsafe reports remain VIOLATION and an individual unsafe run still exits 1.

Required negative-control behavior:
- An unsafe S1 PASS fails the comparison; it may mean the test missed its intended boundary.
- A safe S1 VIOLATION fails the comparison.
- Any inconclusive case fails the comparison.
- Skipping all assertions cannot produce PASS.

## 11. IPC protocol and lifecycle requirements

Use versioned messages with a run-local session nonce:
- READY
- PROCESSING_STARTED
- CHECKPOINT_REACHED
- RELEASE_CHECKPOINT (for controlled cancellation/no-fault behavior only)
- PROCESSOR_ERROR
- WORKER_STOPPED

Validate type/version/run/job/generation/checkpoint identity before changing scenario state. Ignore or flag unrelated messages; duplicate matching events must not trigger multiple kills. A checkpoint for B must never satisfy A's armed barrier.

The runner's state machine should make illegal transitions explicit, e.g.:

CREATED -> INFRA_READY -> A_READY -> JOB_SUBMITTED -> COMMIT_CONFIRMED
-> A_EXIT_CONFIRMED -> B_READY -> REDELIVERY_CONFIRMED
-> OBSERVED -> REPORTED -> CLEANED

Some queue events can arrive before corresponding IPC events. Store evidence by identity and permit documented event-order variation; do not force a fabricated global order. The no-fault baseline has a separate valid path.

Every blocking wait has a deadline and cancellation path. On SIGINT/SIGTERM, preserve partial evidence, clean only owned resources, and return a non-success result. On runner SIGKILL cleanup cannot be guaranteed; provide documented scoped recovery using the run manifest.

During normal runs, do not enable extra processor-error retries merely to make the scenario finish. Configure the supported version to permit the intended stalled recovery, record the effective settings, and bound the number of processing generations. Unexpected additional recoveries remain visible; they are not discarded from the outcome. Startup, checkpoint, recovery and cleanup deadlines are separate validated configuration fields. Test-only short lock timings must be labeled as such, not recommended for production.

## 12. Artifacts and honest reproduction

Proposed output layout:

```text
.crash-retry-lab/runs/<run-id>/
  manifest.json
  events.jsonl
  report.json
  stdout.log               optional sanitized diagnostics
  stderr.log               optional sanitized diagnostics
```

Manifest:
- schema version, run/scenario/adapter IDs;
- source commit when available and dirty-tree indicator;
- application/config/lockfile content fingerprints;
- Node/package/database/Redis versions and container image identities;
- effective queue timing and deadline configuration;
- owned-resource IDs/names and cleanup instructions without secrets.

Events:
- controller sequence number, wall timestamp and monotonic elapsed time;
- event kind and relevant run/job/generation IDs;
- named boundary and allowlisted observations.

Controller receive order is not globally synchronized distributed event order. Record worker-local data only when useful, and explain its limits.

Report:
- validity result and missing evidence;
- fault requested versus confirmed;
- first/final observations;
- per-invariant expected/observed/verdict;
- PASS/VIOLATION/INCONCLUSIVE/ERROR outcome;
- cleanup status, diagnostics and a rerun recipe.

Persist critical pre-kill evidence before sending the signal. Write final JSON atomically; leave partial artifacts usable on failure. Never fabricate absent observations.

“Rerun” means executing the same configured failure boundary against the recorded compatible inputs. It is NOT deterministic replay of the OS scheduler or a promise that a seed recreates an arbitrary concurrency bug. Before rerun, compare fingerprints and versions; reject incompatible inputs unless the user explicitly opts into a new experiment, clearly labeled as such.

Do not store connection strings, raw environment dumps, credentials, or entire job payloads by default. Use allowlisted metadata. Sanitize diagnostic logs; make raw output capture an explicit local-only option. Test redaction with synthetic sentinel secrets. This requirement applies to emitted errors as well as reports.

## 13. Resource isolation and failure injection boundaries

These are implementation constraints for a tool that deliberately kills processes, not a request for a separate approval ceremony.

- v0.1 provisions only dedicated disposable local test services.
- Bind exposed ports to loopback; discover allocated ports instead of assuming 5432/6379 are free.
- Generate per-run Compose project/container labels, database/schema identifiers and queue prefixes.
- Use parameterized SQL for values; validate generated identifiers before interpolating schema names.
- Never issue FLUSHALL or broad cleanup commands.
- Do not accept an arbitrary PID to kill. Signal only the owned child handle after verifying its lifecycle.
- Launch child modules without shell evaluation. Do not search for and kill processes by name.
- v0.1 processor fixtures must not spawn unmanaged grandchildren; arbitrary process-tree cleanup is not supported.
- Keep the fault target and infrastructure lifecycle separate: killing A must not kill Redis, PostgreSQL, the runner or B.
- A cleanup failure is visible and prevents an unqualified successful run; preserve correctness findings separately.
- Only remove resources whose ownership metadata matches the run. Never prune global Docker resources or delete unrelated volumes.
- Use fake external services for later remote-effect scenarios. No real payment/network side effects.
- Trusted adapter/config modules execute local code. Document that configuration is not a sandbox for untrusted code.

## 14. Proposed CLI experience

Names below are design examples, not commands that already exist:

```text
crash-retry-lab doctor
crash-retry-lab run --config ./lab.config.mjs --scenario post-commit-crash --implementation unsafe
crash-retry-lab run --config ./lab.config.mjs --scenario post-commit-crash --implementation idempotent
crash-retry-lab demo --compare
crash-retry-lab rerun --manifest ./.crash-retry-lab/runs/<id>/manifest.json
```

doctor should report supported environment, missing prerequisites and version information without modifying unrelated system state. Do not automatically install Docker or upgrade system packages.

The primary summary should answer: What failed? Was the scenario valid? What state was expected and observed? Where is the evidence? How can this case be rerun?

Illustrative summary only:

```text
Scenario: post-commit-crash     Experiment: VALID
Processor: unsafe             Outcome: VIOLATION
Accepted effects: expected 1, observed 2
Account delta: expected 100, observed 200
Evidence: <run>/report.json
```

Do not bury the result in installation details or marketing copy.

## 15. Acceptance matrix

| ID | Case | Required outcome/evidence |
|---|---|---|
| A01 | No-fault unsafe baseline | PASS; completed job, one attempt, one effect, balance 100 |
| A02 | Unsafe S1 | Valid VIOLATION; A committed, A killed, B broker-redelivered, two effects, balance 200 |
| A03 | Idempotent S1 | PASS; A and B attempts, completed job, one effect, balance 100 |
| A04 | Checkpoint absent or before actual commit | INCONCLUSIVE/ERROR; no PASS; before-commit case must fail independent observation |
| A05 | Kill fails or exit unconfirmed | INCONCLUSIVE/ERROR; do not claim crash coverage |
| A06 | Manually added second job | Rejected as S1 evidence; no valid broker-redelivery claim |
| A07 | Missing observer, malformed IPC, wrong generation | No false PASS or wrong-target signal; diagnostic preserved |
| A08 | Zero accepted effects | Not PASS, even if at-most-one is technically true |
| A09 | Same idempotency key, different payload | Explicit conflict, no second effect or silent acceptance |
| A10 | Two isolated runs, same business operation ID | No queue/database/artifact cross-contamination |
| A11 | Interrupt during a waiting phase | Partial report and scoped cleanup; no surviving owned worker |
| A12 | Missing Docker/unsupported OS | Clear preflight error and exit 2; no fallback success |
| A13 | Redaction and cleanup | Sentinel secrets absent from default artifacts; unrelated resources unchanged |
| A14 | Packed consumer | Installed tarball can launch compiled child and complete safe reference scenario |
| A15 | Repeatability check | 10 full baseline/unsafe/safe cycles; report actual 30 outcomes and durations, no hidden reruns |
| A16 | External processor integration | Document actual setup changes on one authorized application, or label real-world validation pending |

A15 is a local release-readiness experiment for v0.1, not a mathematical proof. If one of the 30 cases is inconclusive, preserve it and investigate; do not rerun until green and omit failures. A small per-PR suite may use fewer runs, with the release experiment recorded separately.

Unit tests should target meaningful state transitions, invalid evidence, outcome logic, redaction and configuration validation. Real integration tests must exercise commit, SIGKILL, redelivery and durable observations. A mocked worker test cannot replace A02/A03.

A16 is a separate adoption gate. The prototype may be released as experimental with this pending, but cannot claim proven usefulness for existing teams.

## 16. Build milestones

### M0 — resolve assumptions and overlap
- Inspect current Faultline and TypeScript alternatives; record scope overlap with URLs and dates.
- Select and pin a compatible stack; verify BullMQ stalled recovery experimentally.
- Record defaults and an initial threat/resource model.
- Identify an authorized real processor, or explicitly choose the reference fixture.
- Output: docs/DECISIONS.md and docs/VALIDATION.md with unknowns.

### M1 — working reference baseline
- Package structure, compiled worker bootstrap, disposable infrastructure.
- Unsafe and idempotent processors with independent observer.
- CLI/programmatic execution of no-fault baseline.
- Output: working baseline, not only types and mock tests.

### M2 — one real post-commit crash
- Versioned checkpoint protocol, named barrier and independent commit check.
- Owned A SIGKILL, confirmed exit, B startup and actual broker redelivery.
- Unsafe must violate; idempotent must pass.
- Output: raw evidence for both, plus explicit validity checks.

### M3 — trustworthy tool behavior
- Final outcomes, schema validation, atomic reports, secret redaction.
- Deadlines, cancellation, ownership-scoped cleanup and partial evidence.
- Implement negative cases A04–A13 and demo-comparison semantics.
- Output: reliable failures as well as successful runs.

### M4 — usable experimental release
- README quickstart, architecture, limitations and reference application guide.
- Package exports, clean-install tarball consumer test, Linux CI.
- Run and record A15; document A16 honestly.
- Include an example failing report and a passing report produced by actual execution, clearly distinguished from illustrative snippets.
- Output: locally reviewable experimental package. Publishing remains a separate user action.

### M5+ — validate before expanding
- Test integration on an authorized real application.
- Compare required setup/code changes against the closest existing tool.
- Only then add remote lost-reply and stale-owner scenarios or another adapter.

Do not implement M5 while M2 remains a simulated demonstration or M3 can silently pass invalid experiments.

## 17. Definition of done for the implementing agent

A first implementation is complete when:
1. The reference comparison demonstrates the requested crash boundary against real dependencies.
2. Safe/unsafe results match the acceptance matrix, and invalid experiments cannot pass.
3. The package works outside the development source tree.
4. Evidence is replayable as a bounded rerun recipe and never overstated as deterministic scheduling.
5. Docs explain setup, test seams, cleanup, limitations, alternatives and version support.
6. VALIDATION.md names commands run, versions, results, skipped checks and unresolved blockers.
7. A final handoff summarizes files changed, verified behavior and remaining adoption assumptions.

If real infrastructure is unavailable, the correct result is a partially implemented package with explicit blockers—not “done” or “all tests pass.”

## 18. Success and stop criteria

Engineering success:
- A reproducible reference defect is detected.
- Correct handling survives the same valid fault.
- A second developer can understand and integrate the seam and business observer.

User-value hypothesis:
- Existing applications can adopt this with meaningfully less effort or better evidence than alternatives.
- Measure actual setup time, lines of application adaptation, supported failure cases and bugs found. Do not invent target adoption numbers or benchmark wins.

Reconsider a standalone product if:
- it only adds a wrapper around an alternative with no measurable integration benefit;
- every application needs a bespoke rewrite;
- results mostly test mocks instead of real durability;
- a clear upstream extension offers the same outcome with less maintenance.

A useful upstream contribution remains aligned with Khurshid's career objective.

## 19. Sources and research caveats

Primary research date: 2026-10-25. Recheck versions and capabilities during implementation.

- BullMQ idempotent jobs: https://docs.bullmq.io/patterns/idempotent-jobs
- BullMQ retry behavior: https://docs.bullmq.io/guide/retrying-failing-jobs
- BullMQ issue 4311: https://github.com/taskforcesh/bullmq/issues/4311
  - Historical production failure report; closed, release bot reports resolution in 6.3.7. Not an outstanding defect to fix.
- Faultline: https://github.com/kritibehl/faultline
- Déjà: https://github.com/sagarrsharmaa/deja
- Chronos search lead: https://libraries.io/npm/@sx4im%2Fchronos-vitest
  - Search discovery only; actual implementation/capabilities were not audited.
- payfuzz: https://github.com/Subhooo5/payfuzz

Prior research inspected repository documentation and issue states, not competitor runtime behavior. Reliable direct Reddit evidence was unavailable. Do not cite Reddit consensus, prove novelty from search absence, or inherit competitor README performance claims as verified facts.

## 20. Copy-paste starter prompt

> Read AI-HANDOFF.md completely and inspect this repository's instructions and current files. Implement the v0.1 crash/retry testing library described there, starting with M0 and progressing through M4. Use the proposed TypeScript/BullMQ/PostgreSQL stack unless an actual compatibility constraint requires a documented change. Keep the initial scope to one real post-commit-crash scenario, an unsafe reference processor, an idempotent processor, and a no-fault baseline. Use real disposable Redis/PostgreSQL and separate owned worker processes; do not substitute mocks for the crash/recovery proof. Track experiment validity separately from application correctness. Record decisions, exact checks and blockers. Do not implement the deferred scenarios, publish, or access production systems. If infrastructure is missing, complete independent work and explicitly report unverified integration checks. Deliver working code, truthful evidence and user documentation—not just a plan.
