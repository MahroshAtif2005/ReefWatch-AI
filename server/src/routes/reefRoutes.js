import { Router } from 'express';
import { fetchReefConditions } from '../services/noaaService.js';

const router = Router();

router.get('/live', async (_req, res, next) => {
  try {
    const reefs = await fetchReefConditions();
    res.json(reefs);
  } catch (error) {
    next(error);
  }
});

export default router;
