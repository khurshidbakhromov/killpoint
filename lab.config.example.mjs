// Example configuration for your own application. Copy to lab.config.mjs and adapt.
// This module executes local code: only load configuration you trust.
import { ledgerAdapter } from 'killpoint/examples/ledger';

/** @type {import('killpoint').LabConfig} */
export default {
  adapter: ledgerAdapter, // replace with your adapter (see docs/INTEGRATION.md)
  outputDir: '.killpoint/runs',
  // Test-only short lock timings so recovery takes seconds. Not production guidance.
  timing: { lockDurationMs: 3000, stalledIntervalMs: 1000, maxStalledCount: 1 },
  deadlines: { checkpointMs: 20000 },
  captureRawOutput: false,
};
