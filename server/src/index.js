import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import reefRoutes from './routes/reefRoutes.js';

const app = express();
const port = process.env.PORT || 4000;
const host = '127.0.0.1';

app.use(cors({
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
}));
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'reefwatch-ai-server' });
});

app.use('/api/reefs', reefRoutes);

app.use((error, _req, res, _next) => {
  console.error('[reefwatch-api] request failed', error);
  res.status(500).json({
    error: 'Unable to load reef conditions',
    message: error.message,
  });
});

app.listen(port, host, () => {
  console.log(`ReefWatch AI backend running on http://localhost:${port}`);
});
