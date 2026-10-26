// Absolute path to apps/api of an Optio checkout at commit e1ff7fa, built with its own tsc.
if (!process.env.OPTIO_API) throw new Error('set OPTIO_API to <optio checkout>/apps/api');
export const OPTIO_API = process.env.OPTIO_API;
