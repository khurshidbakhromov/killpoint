import adapter from './adapter.mjs';
// Optio's workspace packages export TypeScript source (its production image runs via tsx),
// so the worker processes need the same loader.
export default { adapter, outputDir: '.killpoint/runs', workerExecArgv: ['--import', 'tsx'] };
