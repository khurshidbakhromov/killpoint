# Validation record

Date: 2026-10-25. Everything below was actually executed. Anything not executed is listed under **Not verified**.

## Environment

| Item | Value |
|---|---|
| OS | Linux 6.18.54.1-microsoft-standard-WSL2 (WSL2, x64) |
| Node / npm | 24.21.0 / 11.19.0 |
| Docker Engine / Compose | 29.8.1 / 5.5.1 (Docker Desktop WSL integration) |
| BullMQ / ioredis / pg / ajv / TypeScript | 6.4.2 / 5.11.1 / 8.23.1 / 8.20.0 / 6.0.3 |
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
| A15 repeatability | **Verified** (local) | 30 runs, 30 matched, 0 inconclusive, 0 reruns. Duration min 3441 / median 6664 / max 8571 ms. `docs/evidence/repeatability.json` |
| A16 real application | **Pending** | no authorized real application was available. Real-world usefulness is **not** claimed |

## Not verified

- **The GitHub Actions workflow (`.github/workflows/ci.yml`) has never run.** The repository has no remote and nothing has been pushed. Linux CI on `ubuntu-24.04` is therefore unverified.
- Native (non-WSL) Linux, macOS, other Node majors, other BullMQ/Redis/PostgreSQL versions.
- BullMQ default (30 s) lock timings: only the short test timings were exercised.
- The optional split-transaction regression fixture was not built.
- All recorded runs predate the initial commit, so their `manifest.source.gitCommit` is `null`; new runs record the commit and dirty flag.
- Nothing has been published, and no maintainers have been contacted.

## Open items and blockers

1. A16: integrate with one authorized real BullMQ application and measure setup time and lines changed against Faultline.
2. Push to a remote and confirm the CI workflow goes green.
3. Decide whether to keep TypeScript 6.0.3 or move to 7.x.
