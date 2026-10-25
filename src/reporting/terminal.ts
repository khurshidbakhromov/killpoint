import type { RunReport } from './schema.js';
import type { ComparisonCase } from '../core/outcomes.js';

function value(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** Answers: what happened, was the experiment valid, expected vs observed, where is the evidence, how to rerun. */
export function formatSummary(report: RunReport): string {
  const lines: string[] = [];
  const experiment = report.validity.valid ? 'VALID' : 'NOT VALID';
  lines.push(`Scenario:  ${report.scenario.padEnd(20)} Experiment: ${experiment}`);
  lines.push(`Processor: ${report.processor.padEnd(20)} Outcome:    ${report.outcome}`);
  if (report.outcome !== report.evaluatedOutcome) lines.push(`           (evaluated ${report.evaluatedOutcome}; downgraded because cleanup failed)`);
  if (report.fault) {
    const exit = report.fault.exit ? `exit signal ${report.fault.exit.signal ?? 'none'}` : 'exit unconfirmed';
    lines.push(`Fault:     SIGKILL worker A at "${report.fault.requested.checkpoint}" -> ${report.fault.confirmed ? 'confirmed' : 'NOT confirmed'} (${exit})`);
  }
  if (report.job) {
    lines.push(`Job:       ${report.job.state}, attemptsStarted ${report.job.attemptsStarted}, stalledCounter ${report.job.stalledCounter}`);
  }
  for (const inv of report.invariants) {
    const mark = inv.verdict === 'pass' ? 'ok  ' : inv.verdict === 'fail' ? 'FAIL' : '--  ';
    lines.push(`  ${mark} ${inv.description}: expected ${value(inv.expected)}, observed ${value(inv.observed)}`);
  }
  if (report.validity.missing.length > 0) lines.push(`Missing evidence: ${report.validity.missing.join(', ')}`);
  for (const reason of report.reasons) lines.push(`Reason:    ${reason}`);
  if (report.cleanup.status !== 'ok') lines.push(`Cleanup:   ${report.cleanup.status.toUpperCase()} - see report`);
  lines.push(`Evidence:  ${report.artifacts.report}`);
  lines.push(`Rerun:     ${report.rerun.command}`);
  return lines.join('\n');
}

export function formatComparison(cases: readonly ComparisonCase[], ok: boolean): string {
  const lines = ['Demo comparison:'];
  for (const c of cases) {
    lines.push(`  ${c.expected === c.observed ? 'ok  ' : 'FAIL'} ${c.name.padEnd(32)} expected ${c.expected.padEnd(9)} observed ${c.observed}`);
  }
  lines.push(ok ? 'All expected outcomes observed.' : 'Comparison FAILED: not every expected outcome was observed.');
  return lines.join('\n');
}
