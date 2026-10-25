// M0 experiment: does BullMQ redeliver an active job to a second worker after the
// first worker process is SIGKILLed? Measures timings with real Redis.
// Usage: node experiments/stalled-recovery.mjs <redisPort> [lockMs] [stalledMs]
import { fork } from 'node:child_process';
import { Queue, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
const [port, lockMs = '2000', stalledMs = '1000'] = process.argv.slice(2);
const qn = `exp-${Date.now()}`;
const conn = { host: '127.0.0.1', port: Number(port) };
const t0 = performance.now();
const log = (m, extra = {}) => console.log(JSON.stringify({ ms: Math.round(performance.now() - t0), m, ...extra }));
const rc = new Redis(conn);
const q = new Queue(qn, { connection: conn });
const ev = new QueueEvents(qn, { connection: conn });
await ev.waitUntilReady();
for (const e of ['active', 'stalled', 'completed', 'failed']) ev.on(e, (a) => log(`qe:${e}`, a));
const start = (name, mode) => new Promise((res) => {
  const c = fork(new URL('./stalled-worker.mjs', import.meta.url), [port, qn, mode, lockMs, stalledMs]);
  c.on('message', (msg) => { log(`${name}:${msg.t}`, msg); if (msg.t === 'ready') res(c); });
  c.on('exit', (code, sig) => log(`${name}:exit`, { code, sig }));
  return c;
});
const a = await start('A', 'hang');
const job = await q.add('op', { op: 'x' }, { attempts: 1 });
await new Promise((r) => a.on('message', (m) => m.t === 'processing' && r()));
await new Promise((r) => setTimeout(r, Number(lockMs) * 2)); // show A keeps renewing while blocked
log('lock-held-while-blocked', { lockTtl: await rc.pttl(`bull:${qn}:${job.id}:lock`) });
const killed = new Promise((r) => a.on('exit', r));
a.kill('SIGKILL'); log('sent SIGKILL'); await killed;
const b = await start('B', 'ok');
const done = await new Promise((r) => { ev.on('completed', r); ev.on('failed', r); setTimeout(() => r('timeout'), 30000); });
const j = await q.getJob(job.id);
log('final', { state: await j.getState(), attemptsStarted: j.attemptsStarted, attemptsMade: j.attemptsMade, stalledCounter: j.stalledCounter, done });
b.kill('SIGTERM'); await q.obliterate({ force: true }); await q.close(); await ev.close(); rc.disconnect();
