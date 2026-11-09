/**
 * BudgetGuard worker entrypoint.
 *
 * Two ways to trigger a check cycle (both use the same runCheckAll):
 *   1. Built-in cron: every 15 minutes (node-cron, zero infra)
 *   2. POST /internal/worker/check-all with header `x-worker-secret` —
 *      for external schedulers (Railway Cron, GitHub Actions, QStash...)
 *
 * Deploy (Railway): one service, `npm start`, DATABASE_URL + APP_ENCRYPTION_KEY set.
 */

import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import cron from 'node-cron';

import { runCheckAll, type CheckResult } from './check-all';
import { env } from './env';

const startedAt = new Date();
console.info(`[worker] booting — port ${env.port}, globalDryRun=${env.globalDryRun}`);

let running = false;

async function guardedRunCheckAll(trigger: string): Promise<CheckResult[]> {
  if (running) {
    console.warn(`[worker] check already in progress — skipping trigger "${trigger}"`);
    return [];
  }
  running = true;
  try {
    return await runCheckAll();
  } finally {
    running = false;
  }
}

// 1) Built-in 15-minute cron (spec §3: "Engine starts checking every 15 min")
cron.schedule('*/15 * * * *', () => {
  console.info('[cron] 15-minute tick');
  void guardedRunCheckAll('cron');
});

// Run one check shortly after boot so a fresh deploy proves itself.
setTimeout(() => {
  void guardedRunCheckAll('boot');
}, 5_000);

// 2) Minimal HTTP surface for external schedulers + health checks
function handle(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://localhost:${env.port}`);

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        startedAt: startedAt.toISOString(),
        busy: running,
        dryRun: env.globalDryRun,
      }),
    );
    return;
  }

  if (url.pathname === '/internal/worker/check-all' && req.method === 'POST') {
    if ((req.headers['x-worker-secret'] ?? '') !== env.workerSecret) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid worker secret' }));
      return;
    }
    void guardedRunCheckAll('http')
      .then((results) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, checked: results.length, results }));
      })
      .catch((err) => {
        console.error('[http] check-all failed:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'check failed — see worker logs' }));
      });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}

createServer(handle).listen(env.port, () => {
  console.info(`[worker] HTTP listening on :${env.port} (POST /internal/worker/check-all)`);
});
