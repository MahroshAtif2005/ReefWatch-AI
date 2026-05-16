import { Router } from 'express';
import axios from 'axios';

const router = Router();
const aiServiceUrl = process.env.AI_SERVICE_URL || 'http://localhost:8000';

const proxyPost = (targetPath) => async (req, res, next) => {
  try {
    const response = await axios.post(`${aiServiceUrl}${targetPath}`, req.body, {
      timeout: 120000,
    });

    res.status(response.status).json(response.data);
  } catch (error) {
    if (error.response) {
      res.status(error.response.status).json(error.response.data);
      return;
    }

    if (error.code === 'ECONNREFUSED') {
      res.status(503).json({
        error: 'AI service is offline',
        message: 'Start the local FastAPI service on http://localhost:8000.',
      });
      return;
    }

    next(error);
  }
};

router.get('/health', async (_req, res) => {
  try {
    const response = await axios.get(`${aiServiceUrl}/health`, {
      timeout: 10000,
    });

    res.status(response.status).json(response.data);
  } catch {
    res.status(503).json({
      status: 'offline',
      phoenix: 'unknown',
      gemini: 'unknown',
    });
  }
});

router.post('/analyze', proxyPost('/analyze-reef'));
router.post('/brief', proxyPost('/generate-brief'));
router.post('/chat', proxyPost('/chat'));
router.post('/evaluate', proxyPost('/self-evaluate'));

export default router;
