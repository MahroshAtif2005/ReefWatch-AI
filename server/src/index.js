import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import agentRoutes from './routes/agentRoutes.js';
import alertRoutes from './routes/alertRoutes.js';
import aiRoutes from './routes/aiRoutes.js';
import arizeRoutes from './routes/arizeRoutes.js';
import reefRoutes from './routes/reefRoutes.js';
import selfImprovementRoutes from './routes/selfImprovementRoutes.js';
import settingsRoutes from './routes/settingsRoutes.js';
import tracesRoutes from './routes/tracesRoutes.js';
import { scheduleReefWatchJobs } from './services/scheduler.js';
import { refreshStationsOnStartupIfEmpty, startStationRefresh } from './services/stationRefreshService.js';
import { startStationEnrichment } from './services/stationEnrichmentService.js';
import { hydrateEnrichedCacheFromDb } from './services/stationService.js';
import { getActiveMonitoredReefs } from './db/database.js';
import { getStoredActiveReefs } from './services/monitoringService.js';

const app = express();
const port = process.env.PORT || 4000;
const host = process.env.HOST || '0.0.0.0';

app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
    'http://localhost:3000',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:5174',
    'http://127.0.0.1:5175',
    'https://project-9b3e2672-8819-4fa5-afe.web.app',
  ],
}));
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'reefwatch-ai-server' });
});

// Returns all actively monitored reefs with their latest NOAA + AI data.
app.get('/api/monitored-reefs', (_req, res, next) => {
  try {
    res.json(getStoredActiveReefs());
  } catch (error) {
    next(error);
  }
});

// Acknowledges the frontend's active-reef ID sync.  A future enhancement could
// use this payload to re-seed the DB after a Cloud Run restart.
app.put('/api/researcher/active-reefs', (_req, res) => {
  const { reef_ids } = _req.body || {};
  res.json({ success: true, synced: Array.isArray(reef_ids) ? reef_ids.length : 0 });
});

app.use('/api/reefs', reefRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/arize', arizeRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/self-improvement', selfImprovementRoutes);
app.use('/self-improvement', selfImprovementRoutes);
app.use('/api/traces', tracesRoutes);

app.use((error, _req, res, _next) => {
  console.error('[reefwatch-api] request failed', error);
  res.status(500).json({
    error: 'Unable to load reef conditions',
    message: error.message,
  });
});

app.listen(port, host, () => {
  console.log(`ReefWatch AI backend running on http://localhost:${port}`);
  hydrateEnrichedCacheFromDb();
  scheduleReefWatchJobs();

  if (process.env.STATION_REFRESH_ON_STARTUP !== 'false') {
    if (!process.env.SKIP_STARTUP_REFRESH) {
      refreshStationsOnStartupIfEmpty();
      // Also refresh any reefs that are stuck as unavailable from a previous failed fetch
      const unavailable = getActiveMonitoredReefs().filter((r) => r.status === 'unavailable');
      if (unavailable.length > 0) {
        console.log(`[startup] ${unavailable.length} unavailable reefs — triggering background refresh`);
        startStationRefresh({ reason: 'startup-unavailable-fix' });
      }
    }
  }

  startStationEnrichment();
});
