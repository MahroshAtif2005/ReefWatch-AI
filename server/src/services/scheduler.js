import cron from 'node-cron';
import { runSelfImprovementLoop } from './selfImprovementService.js';
import { scheduleStationRefresh } from './stationRefreshService.js';

let selfImprovementInProgress = false;

export function scheduleSelfImprovementLoop() {
  cron.schedule('0 3 * * *', async () => {
    if (selfImprovementInProgress) {
      console.log('[self-improvement] nightly run skipped; previous run still in progress');
      return;
    }

    selfImprovementInProgress = true;
    const startedAt = new Date().toISOString();
    console.log(`[self-improvement] nightly run starting at ${startedAt} (UTC)`);
    try {
      const result = await runSelfImprovementLoop({ reason: 'nightly-cron' });
      console.log(
        `[self-improvement] nightly run completed: score=${result?.average_score ?? 'n/a'} ` +
        `assessments=${result?.assessment_count ?? 0} ` +
        `prompt_updated=${result?.prompt_updated ?? false}`,
      );
    } catch (error) {
      console.error('[self-improvement] nightly run failed', error.message);
    } finally {
      selfImprovementInProgress = false;
    }
  }, { timezone: 'UTC' });

  const nextRun = '03:00 UTC daily';
  console.log(`[self-improvement] autonomous loop scheduled — next run at ${nextRun}`);
  console.log('[self-improvement] agent identity: autonomous coral reef monitoring agent that critiques and improves its own scientific reasoning over time');
}

export function scheduleReefWatchJobs() {
  scheduleStationRefresh();
  scheduleSelfImprovementLoop();
}
