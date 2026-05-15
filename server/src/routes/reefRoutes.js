import { Router } from 'express';
import { fetchReefConditions } from '../services/noaaService.js';
import { fetchVirtualStations } from '../services/stationService.js';

const router = Router();

router.get('/live', async (_req, res, next) => {
  try {
    const reefs = await fetchReefConditions();
    res.json(reefs);
  } catch (error) {
    next(error);
  }
});

router.get('/stations', async (_req, res, next) => {
  try {
    const stations = await fetchVirtualStations();
    res.json(stations);
  } catch (error) {
    next(error);
  }
});

export default router;
