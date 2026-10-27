# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning](https://semver.org/); while the version is `0.x`, minor versions may break compatibility.

## [Unreleased]

### Added
- Node 26 support: `engines` is `>=24 <27`, preflight treats Node 26 as a tested major, and CI runs on Node 24 and 26.
- A16 partial validation against Optio (MIT), using a harness in `docs/validation/a16-optio/` with evidence in `docs/evidence/a16-optio/`.
- `workerExecArgv` config option: Node flags for worker processes, for example `['--import', 'tsx']` for monorepos that export TypeScript source. Recorded in the manifest.
- A15 repeatability record on the current stack: 30/30 (`docs/evidence/repeatability-2026-10-26.json`).
- Repository community files: contributing guide, Code of Conduct (Contributor Covenant 2.1), security policy, support guide, issue and PR templates, CODEOWNERS and Dependabot configuration.

### Fixed
- The A16 Optio harness passed `OPTIO_API` to workers through the environment, which killpoint does not forward, so its documented reproduce steps failed. The path now reaches workers through a file.

### Changed
- Test services: Redis 7.4.7 → 8.10.2 and PostgreSQL 17.7 → 18.6. The PostgreSQL tmpfs moved to `/var/lib/postgresql`, which the 18 image requires.
- ioredis 5.11.1 → 6.0.0 (BullMQ's Redis client peer dependency).
- TypeScript 6.0.3 → 7.0.2. Dependabot no longer proposes `@types/node` majors beyond the supported Node 24 (`@types/node` 26 failed typecheck in #3).
- CI uses `actions/checkout`, `actions/setup-node` and `actions/upload-artifact` v7 (the v4 releases ran on the deprecated Node 20 runtime).

## [0.1.0-experimental.0] - 2026-10-25

Not published to npm.

### Added
- `post-commit-crash` scenario: a real SIGKILL of BullMQ worker A at a post-commit checkpoint, BullMQ stalled-job redelivery to worker B, and an independent durable-state check.
- `baseline` scenario (no fault).
- Outcomes PASS / VIOLATION / INCONCLUSIVE / ERROR, with experiment validity tracked separately from invariant correctness. Exit codes 0 / 1 / 2.
- Per-run disposable Redis 7.4.7 and PostgreSQL 17.7 through Docker Compose, with ownership labels and scoped cleanup.
- Versioned IPC protocol with per-launch session nonces.
- JSONL evidence log, atomic schema-validated reports, manifests with version and image-digest fingerprints, bounded `rerun`, and `cleanup --manifest`.
- Reference ledger fixture with unsafe and idempotent processors.
- CLI commands `doctor`, `run`, `demo --compare`, `rerun` and `cleanup`; a programmatic API.
- Unit, integration (A01–A13) and packed-consumer (A14) tests, plus the A15 repeatability record.

[Unreleased]: https://github.com/khurshidbakhromov/killpoint/compare/27d881d...HEAD
[0.1.0-experimental.0]: https://github.com/khurshidbakhromov/killpoint/commit/c7be636
