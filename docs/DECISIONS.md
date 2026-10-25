# Decisions

This file records decisions made while implementing v0.1 from `AI-HANDOFF.md`, and every place the implementation departs from the handoff. Dates are 2026-10-25 unless noted.

## M0: prior art and overlap (checked 2026-10-25)

The repositories were shallow-cloned and their source was read. Statements marked **README** are claims I did not verify in code.

| Project | What it actually is | Overlap | Gap relative to this tool |
|---|---|---|---|
| [Faultline](https://github.com/kritibehl/faultline) (MIT, last push 2026-10-16, v0.1.0, not on PyPI) | Python CLI that drives its **own** demo BullMQ 6.3.4 worker and Celery stack under Docker Compose. It waits for a `READY_AFTER_COMMIT` line in `docker logs` (the worker sleeps 15 s on attempt 1), then runs `docker kill --signal=SIGKILL`, starts worker-b and waits for `JOB_STALLED`. | **Very high on the scenario**: post-commit SIGKILL, real BullMQ stalled recovery, Postgres effect counting. | No way to bring your own processor; you would have to fork and rewrite `worker.js`, the schema and the Python SQL. The barrier is log scraping plus a sleep. Invariants are integer predicates over its fixed tables. Results are PASS/FAIL only, with no experiment-validity layer (it never checks, for example, that the second delivery ran the processor). |
| [Déjà](https://github.com/sagarrsharmaa/deja) (`deja-dst` 0.1.0, MIT, pre-alpha) | In-process deterministic simulation: virtual clock, seeded scheduler, PGlite, simulated Redis subset, seed search and shrinking. | Same bug class (simulated `crash-after-effect`). | No real processes, no SIGKILL and no BullMQ (its simulated Redis cannot run BullMQ's Lua scripts). Workers must take injected `ctx.sql/redis/net` handles; the README says "not drop-in". |
| [Chronos](https://github.com/sx4im/chronos) (`@sx4im/chronos-vitest` 0.3.0, MIT) | FoundationDB-style deterministic simulation for TypeScript, with Vitest integration (`simTest`, `expectInvariant`). | Conceptual only: invariants, simulated crash and restart. | No BullMQ, no Postgres and no child processes in the packages or examples. |
| [payfuzz](https://github.com/Subhooo5/payfuzz) (0.1.1, MIT) | Replays signed Stripe webhook fixtures with duplicate, concurrent and reorder faults, then checks ledger state through `/__payfuzz/state`. | Same idea of checking business invariants after at-least-once delivery. | HTTP layer only; no process kills and no queue. |

**Remaining integration friction this tool addresses.** The hypothesis is not proven:
- you can bring an existing processor module, with one `checkpoint()` call after commit;
- the barrier is an authenticated IPC handshake, not a sleep plus log scraping;
- business invariants are declared by the application's adapter against its own schema;
- an explicit validity layer (INCONCLUSIVE) is kept separate from correctness;
- everything is TypeScript and npm, and it runs against your installed BullMQ version.

**Extend Faultline instead?** No. Extending it would mean replacing its orchestrator, trigger, schema, invariant model and result model, and its adapter interface (`run_race(mode, fault, window)`) has no slot for a user's processor. Faultline is cited as prior art in the README. A possible later upstream contribution would be a Faultline adapter that shells out to this CLI. Nothing has been forked or contacted.

## M0: real application

No authorized real application was supplied, so the **reference ledger fixture** is used. A16 (real-world validation) is **pending**. No second toy fixture is presented as evidence of demand.

## Stack (all versions verified on npm and Docker Hub on 2026-10-25)

| Choice | Pinned | Reason |
|---|---|---|
| Node.js | 24.x (tested 24.21.0) | Handoff default. `engines` is `>=24 <25`; other majors produce a preflight warning, and below 24 is an error. |
| TypeScript | **7.0.2** (was 6.0.3 until 2026-10-26) | Moved after the full unit, integration and consumer suite passed on 7.0.2 with `@types/node` 24. |
| BullMQ | 6.4.2 (exact) | Current release. Its stalled-recovery semantics were verified in source and by experiment (below). |
| ioredis | 5.11.1 | BullMQ 6 makes the Redis client a peer dependency (`ioredis >=5` or `redis >=5`). 5.x is the established line; ioredis 6.0.0 was only 13 days old. |
| pg | 8.23.1 | The handoff names the `pg` driver for the reference fixture. |
| ajv | 8.20.0 | Validates config and report schemas at runtime. |
| Redis image | `redis:8.10.2-alpine` (digest `sha256:0bf6577d…`), up from 7.4.7 on 2026-10-26 | BullMQ requires ≥5.0.0 and recommends ≥6.2.0. Pinned tag; the digest is recorded in every manifest. The Redis 8 server is licensed RSALv2/SSPLv1/AGPLv3; killpoint only runs the official image as a disposable local test service and does not distribute it. |
| PostgreSQL image | `postgres:18.6-alpine` (digest `sha256:898c60cb…`), up from 17.7 on 2026-10-26 | Pinned tag; the digest is recorded in every manifest. The 18 image stores data under `/var/lib/postgresql/18/docker` and refuses to start if anything is mounted at the legacy `/var/lib/postgresql/data`, so the tmpfs now covers `/var/lib/postgresql` (Dependabot PR #2 failed CI for exactly this reason). |
| Docker Compose | v2+ CLI plugin (tested **5.5.1**) | The handoff says "v2". Compose 5.x is the same v2 plugin lineage with the same CLI. |
| Test runner | `node:test` | Handoff default; the repository had no existing convention. |
| License | MIT, "Copyright (c) 2026 Khurshid" | The owner confirmed MIT and delegated the choice of copyright name. |

## M0: BullMQ 6.4.2 stalled recovery, verified

Source read: `dist/esm/commands/moveStalledJobsToWait-9.lua` and `classes/worker.js`.
- Every worker runs a stalled checker unless `skipStalledCheck` is set. The first check runs at worker start, then every `stalledInterval`. A global `stalled-check` key with `PX = stalledInterval` stops workers from scanning concurrently.
- A scan (1) moves members of the `stalled` set **whose `:lock` key is missing** back to `wait` and increments `stc` (`stalledCounter`), then (2) adds every active job to the `stalled` set for the next scan. So recovery after the lock expires needs up to two scans.
- If `stalledCount > maxStalledCount`, the job is marked with a deferred failure ("job stalled more than allowable limit"). `maxStalledCount` defaults to 1.
- There is no `QueueScheduler`; the legacy assumption does not apply.

Experiment (`experiments/stalled-recovery.mjs`, real Redis 7.4.7, child processes, SIGKILL):

| lockDuration / stalledInterval | Lock TTL while A is blocked | SIGKILL to B processing | Final counters |
|---|---|---|---|
| 2000 / 1000 ms | 1986 ms after 4 s blocked (A keeps renewing) | 3.1 s | `attemptsStarted 2, attemptsMade 1, stalledCounter 1` |
| 5000 / 1000 ms | n/a | 6.1 s | same |

Consequences:
- Lock expiry starts at A's death, not at the checkpoint.
- **`attemptsMade` does not count the stall**, so redelivery evidence uses the `stalled` queue event, worker B's `PROCESSING_STARTED` and `stalledCounter`, never `attemptsMade`.
- The recovery deadline is validated to be at least `lockDuration + 2×stalledInterval + 5000 ms` margin.

## Design decisions and deviations

1. **Adapter shape: `open(ctx)` returns a session.** The handoff lists `setup/makePayload/observe/teardown` on the adapter. They live on a per-run session object instead, so two concurrent runs in one process (A10) cannot share state. The session also has `confirmCommitted()` (the independent commit check at the checkpoint) and `evaluate()` (business invariants). The responsibilities are the same as in the handoff.
2. **Processors are selected by name.** The adapter maps implementation names to absolute compiled-JS module paths (`processors: { unsafe, idempotent }`), and `--implementation` chooses one.
3. **Processor module contract: `createProcessor(ctx)` returns `{ process(job), close?, operationIdOf? }`.** This gives per-worker resources such as connection pools a lifecycle. The operation ID is read by the kit's bootstrap (default `job.data.operationId`), so redelivery of the same operation is observed rather than assumed.
4. **Extra IPC messages.** `CHECKPOINT_PASSED` and `PROCESSOR_RETURNED` (worker to runner) are informational evidence. `INIT` and `STOP` (runner to worker) carry configuration and graceful stop. The session nonce is **per worker launch**, not per run, so a message from B can never authenticate as A. Configuration and test-only credentials travel over IPC, never in argv or the environment.
5. **`STOP` never opens a gated barrier.** A gated worker is cleaned up with SIGKILL after the stop deadline.
6. **Infrastructure is per run.** Each run gets its own Compose project (`kp-<run-id>`) with its own Redis and PostgreSQL, on loopback-only ephemeral ports, labelled `io.killpoint.run-id`. On top of that, the queue name, schema name and job ID are run-scoped. This costs about 2.5 s per run and gives isolation that is easy to explain.
7. **PostgreSQL data is on tmpfs.** v0.1 only crashes worker processes, never the database. The boundary tested is "committed and visible to an independent connection". This is documented in LIMITATIONS.
8. **A cleanup failure turns the outcome into ERROR.** The pre-cleanup verdict is kept as `evaluatedOutcome`. This implements "a cleanup failure prevents an unqualified successful run; preserve correctness findings separately".
9. **Bounded liveness vs. observer gap.** At the recovery deadline the runner checks the broker's own job record. A genuinely non-terminal, non-stalled job with healthy observers gives a liveness VIOLATION. A job that Redis says is terminal or stalled, but whose events were not observed, gives INCONCLUSIVE. (The A07 missing-observer test caught the earlier version, which reported a false liveness VIOLATION.)
10. **`report.provisional.json`.** The handoff says to write a provisional report before cleanup and then atomically finalize it. The provisional copy is kept next to `report.json` as evidence of the pre-cleanup state. Only `report.json` (`final: true`) is the run outcome.
11. **`cleanup --manifest` subcommand.** Added for scoped recovery after the runner itself is SIGKILLed. It removes only a Compose project whose containers all carry the recorded run label.
12. **Platform support.** Linux only. macOS fails preflight until its signal and process behaviour has been exercised; native Windows fails preflight. **WSL2 is the verified local environment** (Docker Desktop integration). The CI target is `ubuntu-24.04`.
13. **Test seams (`testHooks`).** These are programmatic only and not exposed by the CLI. They suppress the fault signal (A05), add an extra job after the fault (A06), drop queue events (A07) and observe states to interrupt (A11). They exist so that negative controls run against real infrastructure rather than mocks.
14. **The split-transaction regression fixture was not built.** The handoff makes it optional. The before-commit fixture (A04) already demonstrates that a misplaced seam is detected.
15. **Name: `killpoint`** (renamed from the provisional "Crash Retry Lab"). It names the mechanism, a checkpoint where the worker is killed, and stays accurate for the later lost-reply and stale-owner scenarios. The npm name was free on 2026-10-25; GitHub, domain and trademark availability were not checked. The rename covers the package, the CLI binary, the IPC protocol string (`killpoint/ipc`), container labels (`io.killpoint.*`), the `kp` prefixes for Compose project, queue, schema and env vars (`KP_RUN_ID`, `KP_PG_PASSWORD`), and the output directory `.killpoint/`. Recorded artifacts in `docs/examples/` and `docs/evidence/` predate the rename and keep the old names unchanged.
16. **Dependency updates go through real-infrastructure CI.** Dependabot proposes npm, Actions and Compose-image bumps weekly. `@types/node` is held to the major that matches the supported Node runtime (24), because newer typings describe APIs that the tested runtime lacks. Any stack change updates this table and the validation record.
