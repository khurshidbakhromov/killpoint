# Example artifacts from real runs

These files were **produced by actual execution** on 2026-10-25, during cycle 1 of the A15 repeatability experiment (`docs/evidence/repeatability.json`). They are copied unchanged from `.crash-retry-lab/repeatability/<run-id>/`. They are not illustrative snippets.

| Case | Outcome | Files |
|---|---|---|
| baseline, unsafe processor, no fault | PASS | `baseline-unsafe-PASS.*` |
| post-commit-crash, unsafe processor | **VIOLATION** (2 effects, balance 200) | `s1-unsafe-VIOLATION.*` |
| post-commit-crash, idempotent processor | PASS (A and B both executed, 1 effect, balance 100) | `s1-idempotent-PASS.*` |

They were recorded before the project was renamed from the provisional "crash-retry-lab" to `killpoint`, so tool names, labels, prefixes (`crl`) and paths inside them use the old name. They are kept unchanged as recorded evidence.

They contain absolute local paths from the development machine (`/home/kb/...`). They contain no credentials; the generated PostgreSQL password is never written to artifacts (checked by A13).
