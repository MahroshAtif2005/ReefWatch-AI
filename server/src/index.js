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
import { refreshStationsOnStartupIfEmpty } from './services/stationRefreshService.js';

const app = express();
const port = process.env.PORT || 4000;
const host = '127.0.0.1';

app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
    'http://localhost:3000',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:5174',
    'http://127.0.0.1:5175',
  ],
}));
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'reefwatch-ai-server' });
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
  scheduleReefWatchJobs();

  if (process.env.STATION_REFRESH_ON_STARTUP !== 'false') {
    refreshStationsOnStartupIfEmpty();
  }
});
