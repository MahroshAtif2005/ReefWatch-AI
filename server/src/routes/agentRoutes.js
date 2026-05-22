import { Router } from 'express';
import { getRecentAgentEvents } from '../db/database.js';

const router = Router();

router.get('/activity', (_req, res, next) => {
  try {
    res.json(getRecentAgentEvents(50));
  } catch (error) {
    next(error);
  }
});

export default router;
