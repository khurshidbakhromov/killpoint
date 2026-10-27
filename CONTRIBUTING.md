# Contributing to killpoint

Thanks for your interest. killpoint is a small, experimental tool. Its value depends on one thing: **a verdict must never claim more than the evidence shows.** Please read this guide before opening a pull request.

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). To report a vulnerability, follow [SECURITY.md](SECURITY.md) and do **not** open a public issue.

## Ways to help

- **Try it on a real BullMQ application.** This is the most valuable contribution right now (acceptance item A16 in [docs/VALIDATION.md](docs/VALIDATION.md)). Open an issue describing the setup changes you needed, how long they took, and what killpoint found. Leave out anything confidential.
- Report bugs, especially any run that reached **PASS** or **VIOLATION** when the evidence was incomplete. That is the most serious class of bug.
- Improve the docs where they were unclear when you integrated.
- Fix issues labelled `good first issue` or `help wanted`.

## Scope

v0.1 deliberately covers **one** failure class: a worker SIGKILL after commit and before acknowledgement, followed by BullMQ stalled redelivery. See [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

Please **open an issue to discuss before writing code** for:
- new scenarios, such as a lost remote reply or a stale owner (planned as v0.2 and v0.3, gated on real-user validation);
- new brokers, databases or platforms;
- changes to the outcome semantics (PASS / VIOLATION / INCONCLUSIVE / ERROR), the IPC protocol, or the report and manifest schemas.

Out of scope for now: a web UI, hosted services, AI-generated summaries, automatic ORM instrumentation, and recording production traffic.

## Development setup

Requirements: Linux or WSL2, Node.js 24 or 26, and Docker Engine with the Compose plugin.

```bash
npm ci
npm run build
node dist/src/cli.js doctor
```

| Command | What it runs | Needs Docker |
|---|---|---|
| `npm run typecheck` | `tsc --noEmit` (strict) | no |
| `npm run test:unit` | build + unit tests | no |
| `npm run test:integration` | build + real Redis/PostgreSQL/SIGKILL scenarios (about 70 s) | **yes** |
| `npm run test:consumer` | `npm pack`, install the tarball in a temp project, run a scenario | **yes** |
| `npm run demo` | baseline / unsafe / idempotent comparison | **yes** |

Without Docker, the integration tests show as **skipped**, not passed. Never describe skipped tests as passing.

## Ground rules for changes

These come from the project's design. Reviews will hold to them.

1. **No mocks in the crash proof.** Anything that claims commit, kill or redelivery coverage must exercise real Redis, real PostgreSQL, owned child processes, a real SIGKILL and BullMQ's own recovery. Unit tests are for pure logic: outcomes, the state machine, IPC validation, redaction and config.
2. **Keep validity separate from correctness.** Missing evidence gives INCONCLUSIVE. It must never become PASS or VIOLATION. Every new piece of required evidence needs a negative-control test showing that its absence prevents PASS.
3. **Make honest claims.** Don't write "exactly-once", don't present a deterministic-replay "rerun", and don't present something as proven without evidence. Mark illustrative output as illustrative, and real output as real.
4. **Act only on owned resources.** Never signal a process by PID or name, never run global Docker prune, `FLUSHALL` or broad cleanup, and only touch resources labelled with the current run ID.
5. **No secrets in artifacts.** Anything newly written to events, reports, manifests or logs must go through the redactor. Add a sentinel test if you add a new output path.
6. **Pinned versions.** Use exact dependency versions and pinned container image tags. Record why in `docs/DECISIONS.md` when you change a stack choice.
7. **The library never calls `process.exit`.** Only `src/cli.ts` maps outcomes to exit codes.
8. **Match the surrounding code.** Strict TypeScript, ESM, and the existing naming and comment density.

## Pull requests

- Keep PRs focused. One logical change per PR.
- Add or update tests. Bug fixes need a test that fails without the fix.
- Update the docs (`README.md` and `docs/`) when behaviour, the CLI or the schemas change, and add an entry under **Unreleased** in [CHANGELOG.md](CHANGELOG.md).
- CI must pass. It runs typecheck, unit tests, integration tests, the demo comparison and the packed-consumer test on `ubuntu-24.04` with Node 24 and 26.
- `main` is protected: every change goes through a pull request with green CI.

Commit messages: an imperative summary line of 72 characters or fewer (for example "Reject checkpoint messages without a job id"), then a blank line and the reason for the change if it isn't obvious.

## Licensing

killpoint is [MIT licensed](LICENSE). By submitting a contribution you agree it is licensed under the same terms (inbound = outbound). There is no CLA.
