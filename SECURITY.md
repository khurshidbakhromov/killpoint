# Security policy

## Supported versions

killpoint is experimental and has not been published to npm. Only the latest commit on `main` receives fixes.

| Version | Supported |
|---|---|
| `main` (0.1.0-experimental) | yes |
| anything else | no |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub: go to [Security → Report a vulnerability](https://github.com/khurshidbakhromov/killpoint/security/advisories/new). Please include:
- the affected commit, and what an attacker controls;
- steps to reproduce, or a proof of concept (please describe the class of problem and do not attack third-party systems);
- the impact as you understand it.

You can expect an acknowledgement within 7 days. This is a single-maintainer project, so timelines are best effort. Once a fix is available, we will credit you in the advisory unless you prefer otherwise.

## Threat model

killpoint deliberately kills processes and starts containers. These are the boundaries it is meant to enforce, and a break in any of them is a security bug:
- It signals **only** the worker child processes it forked itself, never an arbitrary PID or a process chosen by name.
- It removes **only** Docker resources labelled with the current run ID, and never prunes globally.
- Its services bind to **loopback** with ephemeral ports.
- The generated per-run database password and common credential shapes are **redacted** from reports, events, manifests and logs by default.

These are **not** security boundaries:
- **Config, adapter and processor modules are trusted local code.** They run with your privileges. Do not load configuration you have not reviewed. A malicious config is out of scope.
- The disposable Redis has no password and PostgreSQL uses a generated test password. Both are for local test use only. Never point killpoint at production services or production data.
- `captureRawOutput: true` intentionally writes unredacted worker output to local files.
