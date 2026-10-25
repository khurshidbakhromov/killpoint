## What and why

<!-- What does this change, and why? Link the issue (e.g. "Closes #12"). -->

## How it was verified

<!-- Commands you ran and their results. Say plainly if integration tests were skipped (no Docker). -->

- [ ] `npm run typecheck`
- [ ] `npm run test:unit`
- [ ] `npm run test:integration` (real Docker; skipped ≠ passed)
- [ ] `npm run test:consumer` (if packaging, bin or exports changed)

## Checklist

- [ ] Missing or invalid evidence still cannot produce PASS or VIOLATION (add a negative-control test for any new required evidence)
- [ ] No mocks stand in for commit, kill or redelivery proof
- [ ] Only run-owned processes and Docker resources are touched
- [ ] Any new output path is redacted (sentinel test added if needed)
- [ ] Docs and `CHANGELOG.md` (Unreleased) updated if behaviour, CLI or schemas changed
- [ ] Stack or semantic decisions recorded in `docs/DECISIONS.md`
