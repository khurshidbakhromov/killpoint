# Quickstart

Requirements: Linux (or WSL2), Node.js 24, Docker Engine with the Compose plugin. The first run pulls `redis:8.10.2-alpine` and `postgres:18.6-alpine`.

```bash
git clone <this repository> killpoint && cd killpoint
npm ci
npm run build
node dist/src/cli.js doctor
```

## The reference comparison

```bash
node dist/src/cli.js demo --compare
```

This makes three runs. Each one starts and removes its own disposable Redis and PostgreSQL:

| Case | Expected |
|---|---|
| baseline, unsafe processor, no fault | PASS: one attempt, one effect, balance 100 |
| post-commit-crash, unsafe processor | VIOLATION: A committed, A was SIGKILLed, B got the redelivered job, two effects, balance 200 |
| post-commit-crash, idempotent processor | PASS: A and B both executed, one effect, balance 100 |

The command exits 0 only if all three outcomes are observed. Each run takes about 4–7 s on the development machine.

## One scenario

```bash
node dist/src/cli.js run --scenario post-commit-crash --implementation unsafe
echo $?   # 1 = VIOLATION
```

Real output from this repository (paths shortened). It was captured before the rename to `killpoint`, and only the tool name in the paths has been updated:

```text
Scenario:  post-commit-crash    Experiment: VALID
Processor: unsafe               Outcome:    VIOLATION
Fault:     SIGKILL worker A at "effect-committed" -> confirmed (exit signal SIGKILL)
Job:       completed, attemptsStarted 2, stalledCounter 1
  ok   Job completed within deadline: expected completed, observed completed
  FAIL Accepted effects (at most one): expected <= 1, observed 2
  ok   Accepted effects (at least one): expected >= 1, observed 2
  FAIL Account delta: expected 100, observed 200
  ok   Unrelated tenant/operation state unchanged: ...
Reason:    invariant failed: at-most-one-effect
Reason:    invariant failed: exact-account-delta
Evidence:  .killpoint/runs/20261025t145737-81b7ee/report.json
Rerun:     killpoint rerun --manifest .killpoint/runs/20261025t145737-81b7ee/manifest.json
```

Exit codes: `0` PASS, `1` VIOLATION, `2` INCONCLUSIVE or ERROR.

## Evidence

Every run writes `.killpoint/runs/<run-id>/`:
- `manifest.json`: versions, image digests, fingerprints, timing, owned resources and the cleanup command;
- `events.jsonl`: the ordered evidence;
- `report.json`: the final verdict, the evidence checklist, observations and invariants.

Complete reports from real runs are in [`docs/examples/`](examples/).

## Rerun and recovery

```bash
killpoint rerun --manifest .killpoint/runs/<id>/manifest.json
killpoint cleanup --manifest .killpoint/runs/<id>/manifest.json   # only after a runner crash
```

`rerun` refuses to run if the config, processor module, compose file, lockfile, Node, BullMQ, pg or tool version has changed. Pass `--allow-changed-inputs` to run it anyway as a new experiment, which is labelled as such.

## Your own processor

See [INTEGRATION.md](INTEGRATION.md).
