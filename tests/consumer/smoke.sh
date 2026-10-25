#!/usr/bin/env bash
# A14: pack the package, install the tarball into a clean temporary project outside the
# source tree, and run the idempotent reference scenario through the installed binary.
# The worker bootstrap must launch from the installed package's compiled JavaScript.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/crl-consumer-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

cd "$ROOT"
npm run build >/dev/null
TARBALL="$(npm pack --silent --pack-destination "$WORK" | tail -1)"
echo "packed $TARBALL"

cd "$WORK"
npm init -y >/dev/null
npm install --no-audit --no-fund "./$TARBALL" >/dev/null
test ! -e node_modules/crash-retry-lab/src || { echo "TypeScript sources leaked into the package" >&2; exit 1; }
test -f node_modules/crash-retry-lab/dist/src/control/worker-bootstrap.js

# Library import from the consumer project.
node --input-type=module -e "import('crash-retry-lab').then(m => { if (typeof m.runScenario !== 'function') process.exit(1); })"

set +e
npx --no-install crash-retry-lab run --scenario post-commit-crash --implementation idempotent --output-dir "$WORK/runs"
CODE=$?
set -e
echo "consumer run exit code: $CODE"
test "$CODE" -eq 0
