import { fileURLToPath } from 'node:url';
import { createLedgerAdapter } from '../../examples/ledger/adapter.js';

const fixture = (name: string): string => fileURLToPath(new URL(`./processors/${name}.js`, import.meta.url));

/** Reference ledger adapter plus deliberately broken processors for negative controls. */
export const fixtureAdapter = createLedgerAdapter({
  'before-commit': fixture('before-commit'),
  'no-checkpoint': fixture('no-checkpoint'),
  noop: fixture('noop'),
  'forged-ipc': fixture('forged-ipc'),
  leaky: fixture('leaky'),
});
