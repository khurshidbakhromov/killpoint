/**
 * A15 release-readiness experiment: N full cycles of baseline/unsafe/idempotent. Every
 * outcome and duration is recorded; nothing is retried or omitted.
 * Usage: node dist/scripts/repeatability.js [cycles=10] [out=docs/evidence/repeatability.json]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { resolveConfig } from '../src/config.js';
import { runDemoComparison } from '../src/core/demo.js';
import { batchExitCode, type Outcome } from '../src/core/outcomes.js';
import { ledgerAdapter } from '../examples/ledger/adapter.js';

const cycles = Number(process.argv[2] ?? 10);
const out = resolve(process.argv[3] ?? 'docs/evidence/repeatability.json');
const config = resolveConfig({ adapter: ledgerAdapter, outputDir: resolve('.crash-retry-lab/repeatability') });
const controller = new AbortController();
process.on('SIGINT', () => controller.abort());

const rows: Array<{ cycle: number; case: string; expected: Outcome; observed: Outcome; durationMs: number | null; runId: string; reasons: string[] }> = [];
const started = new Date();
for (let cycle = 1; cycle <= cycles && !controller.signal.aborted; cycle++) {
  const result = await runDemoComparison(config, { signal: controller.signal });
  result.cases.forEach((c, i) => {
    const run = result.runs[i]!;
    rows.push({ cycle, case: c.name, expected: c.expected, observed: c.observed, durationMs: run.report.durationMs, runId: run.runId, reasons: run.report.reasons });
  });
  process.stderr.write(`cycle ${cycle}: ${result.cases.map((c) => c.observed).join(' / ')}\n`);
}
const durations = rows.map((r) => r.durationMs ?? 0).sort((a, b) => a - b);
const summary = {
  experiment: 'A15 repeatability',
  startedAt: started.toISOString(),
  finishedAt: new Date().toISOString(),
  node: process.versions.node,
  platform: `${process.platform} ${process.arch}`,
  cyclesRequested: cycles,
  casesRun: rows.length,
  matchingExpectation: rows.filter((r) => r.expected === r.observed).length,
  outcomeCounts: rows.reduce<Record<string, number>>((acc, r) => ((acc[`${r.case} -> ${r.observed}`] = (acc[`${r.case} -> ${r.observed}`] ?? 0) + 1), acc), {}),
  durationMs: { min: durations[0] ?? null, median: durations[Math.floor(durations.length / 2)] ?? null, max: durations.at(-1) ?? null },
  timing: config.timing,
  rows,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${summary.matchingExpectation}/${summary.casesRun} cases matched expectations; written to ${out}\n`);
const mismatched = rows.some((r) => r.expected !== r.observed);
process.exitCode = mismatched ? Math.max(1, batchExitCode(rows.map((r) => r.observed === 'VIOLATION' && r.expected === 'VIOLATION' ? 'PASS' : r.observed))) : 0;
