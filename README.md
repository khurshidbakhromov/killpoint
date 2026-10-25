# killpoint

**Experimental (v0.1).** Kill a BullMQ worker right after it commits a PostgreSQL effect, let BullMQ redeliver the job, and check what is durably true afterwards.

> Trigger a specific failure boundary in your worker, observe the durable outcome after recovery, and keep a repeatable regression case.

A unique BullMQ job ID does not make an already-started processor's effects idempotent, and a job that eventually completes is no evidence that the effect happened only once. This tool runs that scenario against **real** infrastructure:
- disposable Redis and PostgreSQL containers;
- separate worker processes owned by the tool;
- an IPC barrier placed after your commit;
- a targeted `SIGKILL`;
- BullMQ's **own** stalled-job recovery.

It then reports whether the experiment actually happened, and whether your invariants held, as two separate answers.

```text
Scenario:  post-commit-crash    Experiment: VALID
Processor: unsafe               Outcome:    VIOLATION
Fault:     SIGKILL worker A at "effect-committed" -> confirmed (exit signal SIGKILL)
Job:       completed, attemptsStarted 2, stalledCounter 1
  FAIL Accepted effects (at most one): expected <= 1, observed 2
  FAIL Account delta: expected 100, observed 200
```
<sub>Real output from `node dist/src/cli.js run --implementation unsafe` (abridged).</sub>

## Quick start

```bash
npm ci && npm run build
node dist/src/cli.js doctor
node dist/src/cli.js demo --compare     # baseline PASS, unsafe VIOLATION, idempotent PASS
```

Requirements: Linux or WSL2, Node 24, Docker Engine with Compose v2+. Full guide: [docs/QUICKSTART.md](docs/QUICKSTART.md).

## Outcomes

| Outcome | Meaning | Exit |
|---|---|---|
| PASS | Every piece of scenario evidence is present and every declared invariant holds | 0 |
| VIOLATION | The experiment was valid and at least one invariant failed (or a bounded liveness deadline passed after a confirmed fault) | 1 |
| INCONCLUSIVE | Evidence is incomplete: no confirmed commit, kill or redelivery; an extra job; a lost observer; an interrupt; no invariants declared | 2 |
| ERROR | A config, preflight, infrastructure, harness or cleanup failure | 2 |

A run is valid only when **all** of these are observed independently:
1. the effect was committed, confirmed by the runner reading PostgreSQL on its own connection at the checkpoint;
2. worker A died, confirmed by the exit event with `SIGKILL`, and the job was still `active`;
3. the broker redelivered the job, confirmed by the BullMQ `stalled` event and worker B starting the **same** job ID and operation ID, with no other job in the queue.

## Using it on your code

You add one line after your commit, `await ctx.checkpoint("effect-committed")`, expose your processor through `createProcessor(ctx)`, and write an adapter that seeds fixtures, reads durable state and declares your invariants. See [docs/INTEGRATION.md](docs/INTEGRATION.md). This is **not** zero-instrumentation.

## Documentation

- [QUICKSTART](docs/QUICKSTART.md)
- [INTEGRATION](docs/INTEGRATION.md): plug in your own processor
- [DESIGN](docs/DESIGN.md): architecture, IPC protocol, state machine, evidence
- [LIMITATIONS](docs/LIMITATIONS.md)
- [DECISIONS](docs/DECISIONS.md): stack choices, the verified BullMQ semantics, deviations, prior art
- [VALIDATION](docs/VALIDATION.md): what was actually run, with results and open items
- [Example reports](docs/examples/) from real runs

## Prior art

Crash testing, deterministic simulation and the "payment then crash" scenario are not new:
- **[Faultline](https://github.com/kritibehl/faultline)** runs the same post-commit SIGKILL and BullMQ stalled-recovery scenario against its own fixed demo worker.
- **[Déjà](https://github.com/sagarrsharmaa/deja)** and **[Chronos](https://github.com/sx4im/chronos)** do deterministic simulation in TypeScript.
- **[payfuzz](https://github.com/Subhooo5/payfuzz)** fuzzes duplicate webhook deliveries.

This project's hypothesis, which is not yet proven, is that a small TypeScript library that brings **your existing processor** into a real-process failure test, with an explicit experiment-validity layer, is easier to adopt. See [DECISIONS.md](docs/DECISIONS.md#m0-prior-art-and-overlap-checked-2026-10-25).

## Status

Experimental and unpublished. Validated only against the reference ledger fixture on Linux (WSL2). Real-application validation (A16) is pending. MIT licensed.
