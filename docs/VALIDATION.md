# Validation record

Date: 2026-10-25. Everything below was actually executed. Anything not executed is listed under **Not verified**.

## Environment

| Item | Value |
|---|---|
| OS | Linux 6.18.54.1-microsoft-standard-WSL2 (WSL2, x64) |
| Node / npm | 24.21.0 / 11.19.0 |
| Docker Engine / Compose | 29.8.1 / 5.5.1 (Docker Desktop WSL integration) |
| BullMQ / ioredis / pg / ajv / TypeScript | 6.4.2 / 5.11.1 / 8.23.1 / 8.20.0 / 6.0.3 (on 2026-10-26: ioredis 6.0.0 and TypeScript 7.0.2; see below) |
| Redis image | `redis:7.4.7-alpine` `sha256:02f2cc4882f8bf87c79a220ac958f58c700bdec0dfb9b9ea61b62fb0e8f1bfcf`, server 7.4.7 |
| PostgreSQL image | `postgres:17.7-alpine` `sha256:bb377b7239d2774ac8cc76f481596ce96c5a6b5e9d141f6d0a0ee371a6e7c0f2`, server 17.7 |
| Timing | lock 3000 ms, stalled interval 1000 ms, maxStalledCount 1 (test-only) |

Note: Docker Desktop's WSL integration dropped out partway through the session. The CLI shim reported "could not be found in this WSL 2 distro". During that window a real run correctly failed preflight with ERROR and exit code 2. All integration results below were obtained after Docker was restored.

## Commands and results

| Command | Result |
|---|---|
| `node experiments/stalled-recovery.mjs <port> 2000 1000` and `5000 1000` | BullMQ redelivered the same job ID after SIGKILL. Recovery took 3.1 s and 6.1 s. `attemptsStarted 2, attemptsMade 1, stalledCounter 1`. See DECISIONS.md. |
| `npm run typecheck` | clean |
| `npm run test:unit` | **45/45 pass** |
| `node --test --test-concurrency=2 "dist/tests/integration/**/*.test.js"` | **14/14 pass** (about 67 s) |
| `npm test` (unit + integration, final build) | exit 0 |
| `npm run test:consumer` (A14) | packed tarball installed in a temp project; idempotent S1 **PASS**, exit 0 |
| `node dist/src/cli.js demo --compare` | baseline PASS, unsafe VIOLATION, idempotent PASS; exit 0 |
| `node dist/scripts/repeatability.js 10` (A15) | **30/30 matched expectations**; see below |
| `node dist/src/cli.js doctor` | all checks ok on WSL2; exit 0 |
| `run --scenario baseline --implementation unsafe` | exit 0 |
| `run --implementation unsafe` | exit 1 |
| `rerun --manifest <unsafe run>` | VIOLATION again, exit 1 |
| `rerun` with a manifest whose BullMQ version and processor fingerprint were edited | rejected with both differences listed; exit 2 |
| `run --scenario nope` / `--implementation nope` | config error; exit 2 |
| SIGINT to the CLI 4 s into an unsafe S1 run | INCONCLUSIVE (`interrupted while waiting for BullMQ stalled event`), final report, cleanup ok, 0 containers left; exit 2 |
| SIGKILL to the CLI mid-run | gated worker exited on channel loss (0 worker processes 1 s later); 2 containers remained; `cleanup --manifest` verified ownership, removed them, and verified nothing remained; exit 0 |
| CLI run of the `before-commit` fixture through a config file | INCONCLUSIVE; CLI exited after 9.5 s (includes the 5 s stop deadline for the gated worker) |

## After the rename to `killpoint` (2026-10-25)

The results above were recorded under the provisional name "crash-retry-lab" (the `crl` prefixes in recorded artifacts). After the rename (DECISIONS #15), the following were re-run on the renamed code:

| Command | Result |
|---|---|
| `npm test` (unit + integration) | 45/45 unit and 14/14 integration pass; exit 0 |
| `npm run test:consumer` | `killpoint-0.1.0-experimental.0.tgz` installed; `npx killpoint run … idempotent` gives PASS, exit 0 |
| `node dist/src/cli.js demo --compare` | PASS / VIOLATION / PASS; exit 0; compose project `kp-<run-id>`; 0 owned containers left |

A15 (30 runs) was not repeated immediately after the rename. It was repeated on 2026-10-26 on the current stack (see below).

## GitHub Actions CI (2026-10-25)

Run [40214085573](https://github.com/khurshidbakhromov/killpoint/actions/runs/40214085573) on `ubuntu-24.04` (native Linux, Docker Engine 28.0.4, Compose 2.38.2), commit `c7be636`, took 1m52s:
- unit tests 45/45;
- integration tests 14/14, none skipped;
- `demo --compare` observed every expected outcome;
- packed-consumer test exited 0.

The only warning was the deprecated Node 20 runtime in `actions/*@v4`. The actions were then updated to v7.

## Image upgrade: Redis 8.10.2 and PostgreSQL 18.6 (2026-10-26)

The environment table and the A15 record above are from Redis 7.4.7 and PostgreSQL 17.7. After moving to `redis:8.10.2-alpine` (`sha256:0bf6577d7774e592b29d093e3ac9390eb91e13d72c21e506afce736de5e0eeb0`) and `postgres:18.6-alpine` (`sha256:898c60cb390d1085bc97bdd6a1ae968757421df394b071848b52b1c09c89d6a5`), the following were run locally on WSL2:
- `npm test`: 45/45 unit and 14/14 integration pass;
- `demo --compare`: PASS / VIOLATION / PASS, with the manifest recording `redisServer 8.10.2` and `postgresServer 18.6`.

A15 was later repeated on the new images (see below).

## TypeScript 7.0.2 and ioredis 6.0.0 (2026-10-26)

ioredis 6.0.0 was merged from Dependabot #4 after its CI passed: unit and integration tests plus the demo, against real Redis with BullMQ redelivery.

On the combined stack (`typescript` 7.0.2, `@types/node` 24.19.2, ioredis 6.0.0, Redis 8.10.2, PostgreSQL 18.6), locally on WSL2:
- `npm run typecheck`: clean;
- `npm test`: 45/45 unit and 14/14 integration pass;
- `npm run test:consumer`: PASS, exit 0.

Dependabot PR #3 had also moved `@types/node` to 26.6.5. That failed typecheck (TS2722: `process.disconnect` became optional), so `@types/node` majors are now held to 24.x, and the call was made defensive (`process.disconnect?.()`).

## A15 repeated on the current stack (2026-10-26)

`node dist/scripts/repeatability.js 10 docs/evidence/repeatability-2026-10-26.json`, run on commit `1aa17b6` (clean tree, recorded in every run manifest). Stack: Node 24.22.1, TypeScript 7.0.2, BullMQ 6.4.2, ioredis 6.0.0, pg 8.23.1, Redis 8.10.2, PostgreSQL 18.6, on WSL2.
- **30 runs, 30 matched expectations:** baseline PASS ×10, unsafe VIOLATION ×10, idempotent PASS ×10.
- 0 inconclusive, 0 reruns, 0 owned containers left afterwards.
- Durations: min 3440, median 6651, max 7711 ms.

## Node 26 (2026-10-26)

Node 26.12.1 with npm 11.20.0, locally on WSL2 (Docker Engine 29.8.1, Compose 5.5.1), on the otherwise unchanged current stack. The tree contained the uncommitted Node 26 changes, so the run manifests record `gitDirty: true`.
- `npm ci`: exit 0. npm 11.20 did not run the optional `msgpackr-extract` install script, which is not approved by default; msgpackr falls back to its pure-JS path;
- `npm run typecheck`: clean (with `@types/node` 24.19.2);
- `npm test`: 46/46 unit and 15/15 integration pass;
- `demo --compare`: PASS / VIOLATION / PASS, exit 0;
- `npm run test:consumer`: idempotent S1 PASS, exit 0;
- `doctor`: all checks ok, `Node 26.12.1 (tested major)`;
- A15, `node dist/scripts/repeatability.js 10 docs/evidence/repeatability-2026-10-26-node26.json`: **30/30 matched expectations**, 0 inconclusive, 0 reruns, 0 owned containers left. Durations: min 3362, median 7456, max 9025 ms.

CI now runs the same sequence on Node 24 and 26.

## Acceptance matrix

| ID | Status | Evidence |
|---|---|---|
| A01 no-fault baseline | **Verified** | `reference.test.ts`; A15 10/10 PASS |
| A02 unsafe S1 | **Verified** | valid VIOLATION; commit confirmed before the fault event; `exit signal SIGKILL`; job active after kill; stalled event; B started the same job and operation; 2 effects, balance 200; A15 10/10 |
| A03 idempotent S1 | **Verified** | PASS; attempts A `started` (killed) and B `finished-deduplicated`; 1 effect, balance 100; A15 10/10 |
| A04 checkpoint before commit / absent | **Verified** | before-commit: the independent read shows 0 effects, INCONCLUSIVE, no fault sent. Absent: job completes before the barrier, INCONCLUSIVE |
| A05 kill unconfirmed | **Verified** | signal suppressed: `delivered false`, exit not confirmed in 5 s, INCONCLUSIVE |
| A06 manual second job | **Verified** | `single-job-in-queue` false; the outcome is neither PASS nor VIOLATION |
| A07 malformed / wrong-generation IPC; missing observer | **Verified** | ≥4 messages rejected and kept as diagnostics; exactly one fault; still a valid VIOLATION. Dropped `stalled` observer gives INCONCLUSIVE. This test found and fixed a false liveness VIOLATION (DECISIONS #9) |
| A08 zero effects | **Verified** | no-op processor baseline gives VIOLATION (`at-least-one-effect` fail) |
| A09 same key, different payload | **Verified** | `OperationConflictError`; effects stay 1, balance 100 |
| A10 isolation, same operation ID | **Verified** | concurrent unsafe and idempotent runs: 200 vs 100, separate jobs and artifacts |
| A11 interrupt in waiting phase | **Verified** | programmatic abort at `B_READY`, plus a real SIGINT through the CLI |
| A12 missing Docker / unsupported OS | **Verified** | `win32` and `darwin` preflight fail; missing docker binary gives ERROR, exit 2; plus the real Docker outage noted above |
| A13 redaction and cleanup scope | **Verified** | the run's real PostgreSQL password and a sentinel are absent from every default artifact while `stderr.log` shows `[REDACTED]`; an unrelated labelled Docker network survived |
| A14 packed consumer | **Verified** (local) | `tests/consumer/smoke.sh` |
| A15 repeatability | **Verified** (local) | Original stack: 30/30, min 3441 / median 6664 / max 8571 ms (`docs/evidence/repeatability.json`). Current stack (2026-10-26): 30/30, min 3440 / median 6651 / max 7711 ms (`docs/evidence/repeatability-2026-10-26.json`). Node 26.12.1: 30/30, min 3362 / median 7456 / max 9025 ms (`docs/evidence/repeatability-2026-10-26-node26.json`). No inconclusive runs, no reruns |
| A16 real application | **Partially verified** | Integrated locally with one open-source application, Optio (MIT, commit `e1ff7fa`), with 0 lines of Optio changed. Its real schedule-trigger sweep gives PASS ×5 under the crash; a split-transaction mutation of its functions gives VIOLATION ×5 (lost occurrence). One killpoint change was needed (`workerExecArgv`). See [validation/A16-optio.md](validation/A16-optio.md). Adoption by an independent user or team is still **not** shown |

## Not verified

- macOS, Node majors other than 24 and 26, other BullMQ/Redis/PostgreSQL versions.
- BullMQ default (30 s) lock timings: only the short test timings were exercised.
- The optional split-transaction regression fixture was not built.
- All recorded runs predate the initial commit, so their `manifest.source.gitCommit` is `null`; new runs record the commit and dirty flag.
- Nothing has been published, and no maintainers have been contacted.

## Open items and blockers

1. A16 remainder: an integration by someone other than killpoint's author; a real application that has the duplicate bug; re-running the Optio harness on Node 26, which Optio requires (killpoint itself now supports Node 26, but the Optio runs were recorded on Node 24.22.1).
