#!/usr/bin/env node
/**
 * Thin CLI: parses arguments, wires SIGINT/SIGTERM to cancellation, prints summaries and maps
 * outcomes to exit codes (0 PASS, 1 VIOLATION, 2 INCONCLUSIVE/ERROR). All logic lives in the library.
 */
import { parseArgs } from 'node:util';
import { loadConfigFile, resolveConfig, ConfigError, type ResolvedConfig } from './config.js';
import { runScenario } from './core/runner.js';
import { checkRerun, cleanupFromManifest, readManifest, runDemoComparison } from './core/demo.js';
import { exitCodeFor } from './core/outcomes.js';
import { SCENARIOS, type ScenarioKind } from './core/scenario.js';
import { preflight } from './infra/preflight.js';
import { formatComparison, formatSummary } from './reporting/terminal.js';

const USAGE = `crash-retry-lab <command> [options]

Commands:
  doctor                       Check platform, Node, Docker/Compose and output directory
  run                          Run one scenario
      --scenario <name>        post-commit-crash | baseline   (default post-commit-crash)
      --implementation <name>  processor implementation from the adapter
  demo [--compare]             Reference comparison: baseline PASS, unsafe VIOLATION, idempotent PASS
  rerun --manifest <path>      Re-execute a recorded failure boundary against compatible inputs
      --allow-changed-inputs   Run anyway as a new, labelled experiment if inputs changed
  cleanup --manifest <path>    Remove a crashed run's owned compose project (scoped by run id)

Common options:
  --config <path>              Trusted local config module (default: built-in reference ledger)
  --output-dir <path>          Artifact directory (default .crash-retry-lab/runs)
  --quiet                      Only print the final summary

Exit codes: 0 PASS, 1 VIOLATION, 2 INCONCLUSIVE or ERROR.`;

async function loadConfig(path: string | undefined, outputDir: string | undefined): Promise<ResolvedConfig> {
  if (path) {
    const loaded = await loadConfigFile(path);
    return outputDir ? { ...loaded, outputDir: resolveConfig({ adapter: loaded.adapter, outputDir }).outputDir } : loaded;
  }
  const { ledgerAdapter } = await import('../examples/ledger/adapter.js');
  return resolveConfig({ adapter: ledgerAdapter, ...(outputDir ? { outputDir } : {}) });
}

function installSignalHandlers(controller: AbortController): void {
  let count = 0;
  const handler = (sig: NodeJS.Signals): void => {
    count += 1;
    if (count === 1) {
      process.stderr.write(`\n${sig} received: stopping, preserving evidence and cleaning owned resources (repeat to force exit)\n`);
      controller.abort();
    } else {
      process.stderr.write('forced exit: owned resources may remain; use `crash-retry-lab cleanup --manifest <run>/manifest.json`\n');
      process.exit(2);
    }
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      scenario: { type: 'string', default: 'post-commit-crash' },
      implementation: { type: 'string' },
      manifest: { type: 'string' },
      'output-dir': { type: 'string' },
      compare: { type: 'boolean', default: false },
      'allow-changed-inputs': { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(`${USAGE}\n`);
    return command || values.help ? 0 : 2;
  }
  const controller = new AbortController();
  installSignalHandlers(controller);
  const onProgress = values.quiet ? undefined : (line: string): void => void process.stderr.write(`· ${line}\n`);

  switch (command) {
    case 'doctor': {
      const result = await preflight({ outputDir: values['output-dir'] ?? '.crash-retry-lab/runs' });
      for (const check of result.checks) process.stdout.write(`${check.ok ? 'ok  ' : check.severity === 'warning' ? 'warn' : 'FAIL'} ${check.id.padEnd(11)} ${check.detail}\n`);
      process.stdout.write(result.ok ? 'Environment supported.\n' : 'Environment NOT supported; runs will exit 2.\n');
      return result.ok ? 0 : 2;
    }
    case 'run': {
      if (!SCENARIOS.includes(values.scenario as ScenarioKind)) throw new ConfigError([`unknown scenario "${values.scenario}" (expected ${SCENARIOS.join(' | ')})`]);
      const config = await loadConfig(values.config, values['output-dir']);
      const result = await runScenario({
        config,
        scenario: values.scenario as ScenarioKind,
        ...(values.implementation ? { processor: values.implementation } : {}),
        signal: controller.signal,
        ...(onProgress ? { onProgress } : {}),
      });
      process.stdout.write(`${formatSummary(result.report)}\n`);
      return exitCodeFor(result.outcome);
    }
    case 'demo': {
      const config = await loadConfig(values.config, values['output-dir']);
      const result = await runDemoComparison(config, { signal: controller.signal, ...(onProgress ? { onProgress } : {}) });
      for (const run of result.runs) process.stdout.write(`\n${formatSummary(run.report)}\n`);
      process.stdout.write(`\n${formatComparison(result.cases, result.ok)}\n`);
      for (const mismatch of result.mismatches) process.stdout.write(`  ${mismatch}\n`);
      return result.exitCode;
    }
    case 'rerun': {
      if (!values.manifest) throw new ConfigError(['rerun requires --manifest <path>']);
      const manifest = readManifest(values.manifest);
      const config = await loadConfig(values.config ?? manifest.fingerprints.configPath ?? undefined, values['output-dir']);
      const check = checkRerun(manifest, config);
      if (!check.compatible && !values['allow-changed-inputs']) {
        process.stderr.write(`rerun rejected: recorded inputs differ:\n${check.differences.map((d) => `  - ${d}`).join('\n')}\nPass --allow-changed-inputs to run a new, labelled experiment.\n`);
        return 2;
      }
      if (!check.compatible) process.stderr.write(`NOTE: inputs changed; this is a new experiment, not a rerun of ${manifest.runId}\n`);
      const result = await runScenario({
        config,
        scenario: manifest.scenario,
        processor: manifest.processor,
        signal: controller.signal,
        rerunOf: { runId: manifest.runId, inputsChanged: !check.compatible },
        ...(onProgress ? { onProgress } : {}),
      });
      process.stdout.write(`${formatSummary(result.report)}\n`);
      return exitCodeFor(result.outcome);
    }
    case 'cleanup': {
      if (!values.manifest) throw new ConfigError(['cleanup requires --manifest <path>']);
      const steps = await cleanupFromManifest(readManifest(values.manifest));
      for (const step of steps) process.stdout.write(`${step.ok ? 'ok  ' : 'FAIL'} ${step.name}: ${step.detail}\n`);
      return steps.every((s) => s.ok) ? 0 : 2;
    }
    default:
      process.stderr.write(`unknown command "${command}"\n\n${USAGE}\n`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof ConfigError ? error.message : `error: ${(error as Error)?.message ?? String(error)}`;
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
  },
);
