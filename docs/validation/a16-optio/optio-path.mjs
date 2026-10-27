// Absolute path to apps/api of an Optio checkout at commit e1ff7fa, built with its own tsc.
// killpoint workers start with a minimal environment (PATH and NODE_ENV only), so the parent
// records OPTIO_API in .optio-api when it loads lab.config.mjs, and workers read it from there.
import { readFileSync, writeFileSync } from 'node:fs';

const file = new URL('./.optio-api', import.meta.url);

function resolveOptioApi() {
  if (process.env.OPTIO_API) {
    writeFileSync(file, `${process.env.OPTIO_API}\n`);
    return process.env.OPTIO_API;
  }
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    throw new Error('set OPTIO_API to <optio checkout>/apps/api');
  }
}

export const OPTIO_API = resolveOptioApi();
