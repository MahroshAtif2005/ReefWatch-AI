import { Router } from 'express';
import {
  getLatestSelfImprovementSummary,
  runSelfImprovementLoop,
} from '../services/selfImprovementService.js';
import { computeSevenDayAverage, getRunCount, getRunHistory } from '../services/selfImprovementStorage.js';

const router = Router();

router.get('/latest', (_req, res) => {
  res.json(getLatestSelfImprovementSummary());
});

router.get('/history', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 30, 90);
  const total = getRunCount();
  const history = getRunHistory(limit);
  const seven_day_avg = computeSevenDayAverage();
  console.log(`[self-improvement] history rows in self_improvement_runs=${total}; returning=${history.length}`);
  res.json({ history, seven_day_avg, count: history.length, total });
});

router.post('/run', async (req, res, next) => {
  try {
    const run = await runSelfImprovementLoop({
      date: req.body?.date || new Date().toISOString().slice(0, 10),
      limit: req.body?.limit,
      demo: Boolean(req.body?.demo),
      saveEmpty: Boolean(req.body?.save_empty),
      reason: 'manual-api',
    });
    res.json(run);
  } catch (error) {
    next(error);
  }
});

export default router;
