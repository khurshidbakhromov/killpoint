# Limitations (v0.1, experimental)

- **One failure class.** v0.1 covers only a worker SIGKILL after a committed effect and before acknowledgement, followed by BullMQ stalled redelivery. It does not cover a lost reply from a remote effect (v0.2), stale-owner resumption or fencing (v0.3), network partitions, or Redis or PostgreSQL crashes.
- **Only the worker process crashes.** PostgreSQL runs on tmpfs and is never restarted. "Durable" means committed and visible to an independent connection, not fsync-survives-power-loss.
- **One stack.** BullMQ 6.4.2 with ioredis 5, PostgreSQL 18.6 and Redis 8.10.2, on Node 24, Linux, Docker Engine and Compose v2+ (tested 5.5.1). Other versions are untested; the manifest records what actually ran.
- **Platforms.** Verified on WSL2 (Ubuntu, Docker Desktop 29.8.1) locally and on GitHub Actions `ubuntu-24.04` (Docker 28.0.4, Compose 2.38.2). macOS and native Windows fail preflight.
- **One job, one concurrency, two worker generations.** A run uses exactly one logical job, worker concurrency 1, worker A (faulted) and worker B (recovery). Extra recoveries are recorded, not prevented.
- **Short, test-only lock timings.** The defaults are lock 3000 ms and stalled interval 1000 ms so recovery takes seconds. These are labelled in every manifest and are **not** production guidance.
- **Instrumentation is required.** You must add `await ctx.checkpoint("effect-committed")` after your commit resolves, and expose the processor through `createProcessor(ctx)`. If your processor builds its own database connection from the environment, you will need to inject the test connection settings. See `INTEGRATION.md`. "Zero instrumentation" is not claimed.
- **Invariants are yours.** The kit checks only experiment validity and job completion. Business correctness comes entirely from your adapter's `evaluate()`. A wrong invariant gives a wrong verdict, and counting rows is not sufficient for every application.
- **Not deterministic replay.** "Rerun" re-executes the same failure boundary against inputs whose fingerprints and versions match. It does not replay OS scheduling, and no seed is involved.
- **Trusted code only.** Config, adapter and processor modules execute with your privileges. Configuration is not a sandbox.
- **No process-tree cleanup.** Processor fixtures must not spawn unmanaged grandchildren.
- **Runner SIGKILL.** If the runner itself is killed, owned workers exit when their IPC channel closes, but containers remain until you run `killpoint cleanup --manifest <run>/manifest.json`.
- **Not validated on a real application (A16 pending).** There is no evidence yet that existing teams can adopt this more easily than the alternatives.
