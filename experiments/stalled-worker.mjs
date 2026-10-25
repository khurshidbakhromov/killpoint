// Child worker for the BullMQ stalled-recovery experiment. Not part of the package.
import { Worker } from 'bullmq';
const [port, queueName, mode, lockDuration, stalledInterval] = process.argv.slice(2);
const worker = new Worker(queueName, async (job) => {
  process.send({ t: 'processing', pid: process.pid, jobId: job.id, attemptsStarted: job.attemptsStarted, attemptsMade: job.attemptsMade, stalledCounter: job.stalledCounter });
  if (mode === 'hang') await new Promise(() => {});
  return 'ok';
}, { connection: { host: '127.0.0.1', port: Number(port) }, concurrency: 1, lockDuration: Number(lockDuration), stalledInterval: Number(stalledInterval), maxStalledCount: 1 });
await worker.waitUntilReady();
process.send({ t: 'ready', pid: process.pid });
