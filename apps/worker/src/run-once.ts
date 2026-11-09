/**
 * One-shot check cycle, then exit.
 * Use with external cron: Railway Cron, GitHub Actions schedule, crontab…
 *   0,15,30,45 * * * *  npm run check-once
 */

import 'dotenv/config';

import { runCheckAll } from './check-all';

runCheckAll()
  .then((results) => {
    const totalExecuted = results.reduce((acc, r) => acc + r.executed, 0);
    const totalProposed = results.reduce((acc, r) => acc + r.proposed, 0);
    console.info(`[run-once] checked=${results.length} proposed=${totalProposed} executed=${totalExecuted}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error('[run-once] failed:', err);
    process.exit(1);
  });
