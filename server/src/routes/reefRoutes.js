import { Router } from 'express';
import { fetchReefConditions } from '../services/noaaService.js';
import { fetchVirtualStations } from '../services/stationService.js';
import { getCachedStationReadings, startStationRefresh } from '../services/stationRefreshService.js';
import { getHistoricalTrends } from '../services/historicalTrendsService.js';
import { checkAndSendAlerts } from '../services/alertService.js';
import {
  addStationToActiveMonitoring,
  getStoredActiveReefs,
  removeStationFromActiveMonitoring,
} from '../services/monitoringService.js';

const router = Router();

router.get('/live', async (_req, res, next) => {
  try {
    const reefs = [
      ...await fetchReefConditions(),
      ...getStoredActiveReefs(),
    ];
    checkAndSendAlerts(reefs).catch(console.error);
    res.json(reefs);
  } catch (error) {
    next(error);
  }
});

router.get('/historical-trends', async (_req, res, next) => {
  try {
    res.json(await getHistoricalTrends());
  } catch (error) {
    next(error);
  }
});

router.post('/monitor', async (req, res, next) => {
  try {
    const monitoringResult = await addStationToActiveMonitoring(req.body);
    res.status(200).json(monitoringResult);
  } catch (error) {
    if (error.statusCode) {
      res.status(200).json({
        success: false,
        station: null,
        noaaData: 'unavailable',
        aiAnalysis: 'pending',
        error: 'Unable to update active monitoring',
        message: error.message,
      });
      return;
    }

    console.error('[monitoring] initialization failed', error.message);
    res.status(200).json({
      success: false,
      station: null,
      noaaData: 'unavailable',
      aiAnalysis: 'pending',
      error: 'Unable to initialize active monitoring',
      message: 'ReefWatch could not add this station to active monitoring.',
      details: error.message,
    });
  }
});

router.delete('/monitor/:id', (req, res, next) => {
  try {
    const removed = removeStationFromActiveMonitoring(req.params.id);
    res.json({ removed: removed > 0 });
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
