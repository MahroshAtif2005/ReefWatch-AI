import { Router } from 'express';
import { getArizeStatus, getLocalArizeTraces, logReefAssessmentTrace } from '../services/arizeService.js';

const router = Router();

router.post('/trace', async (req, res, next) => {
  try {
    const result = await logReefAssessmentTrace(req.body || {});
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get('/status', async (_req, res, next) => {
  try {
    res.json(await getArizeStatus());
  } catch (error) {
    next(error);
  }
});

router.get('/traces', (req, res, next) => {
  try {
    const limit = Number(req.query.limit || 25);
    res.json(getLocalArizeTraces(Number.isFinite(limit) ? limit : 25));
  } catch (error) {
    next(error);
  }
});

export default router;
