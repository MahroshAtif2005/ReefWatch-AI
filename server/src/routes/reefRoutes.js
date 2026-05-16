import { Router } from 'express';
import { fetchReefConditions } from '../services/noaaService.js';
import { fetchVirtualStations } from '../services/stationService.js';
import { getCachedStationReadings, startStationRefresh } from '../services/stationRefreshService.js';

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

router.get('/stations/readings', (_req, res, next) => {
  try {
    res.json(getCachedStationReadings());
  } catch (error) {
    next(error);
  }
});

router.post('/stations/refresh', (_req, res, next) => {
  try {
    startStationRefresh({ reason: 'manual-endpoint' });
    res.json({ started: true, message: 'Station refresh started' });
  } catch (error) {
    next(error);
  }
});

export default router;
