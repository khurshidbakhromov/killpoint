# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning](https://semver.org/); while the version is `0.x`, minor versions may break compatibility.

## [Unreleased]

### Added
- Repository community files: contributing guide, Code of Conduct (Contributor Covenant 2.1), security policy, support guide, issue and PR templates, CODEOWNERS and Dependabot configuration.

### Changed
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
