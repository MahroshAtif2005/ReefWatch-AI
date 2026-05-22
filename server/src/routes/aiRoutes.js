import { Router } from 'express';
import axios from 'axios';
import { insertAgentEvent } from '../db/database.js';
import { getLatestSelfImprovementRun } from '../services/selfImprovementStorage.js';

const router = Router();
const aiServiceUrl = process.env.AI_SERVICE_URL || 'http://127.0.0.1:8000';
const AI_SERVICE_TIMEOUT_MS = 30000;
const AI_EVALUATION_TIMEOUT_MS = 120000;
const AI_EVALUATION_SLOW_MESSAGE = 'AI evaluation is taking longer than expected. Try again with a smaller limit or check Gemini quota.';

const describePayload = (body) => ({
  keys: body && typeof body === 'object' ? Object.keys(body) : [],
  messageLength: typeof body?.message === 'string' ? body.message.length : undefined,
  conversationHistoryCount: Array.isArray(body?.conversation_history) ? body.conversation_history.length : undefined,
  reefContextKeys: body?.reef_context && typeof body.reef_context === 'object' ? Object.keys(body.reef_context) : [],
});

const getReefName = (body, responseData) => (
  responseData?.reef_name
  || responseData?.reefName
  || body?.reef_name
  || body?.reefName
  || body?.name
  || 'selected reef'
);

const buildPartialEvaluationResponse = (error, latencyMs) => {
  const latest = getLatestSelfImprovementRun();
  const partial = latest || {
    date: new Date().toISOString().slice(0, 10),
    assessment_count: 0,
    average_score: null,
    accuracy: null,
    specificity: null,
    actionability: null,
    scientific_reliability: null,
    dhw_interpretation: null,
    dhw_interpretation_accuracy: null,
    uncertainty_communication: null,
    hallucination_avoidance: null,
    prompt_updated: false,
    quota_limited: false,
    issues: [],
    before_after: { previous_score: null, latest_score: null },
  };

  return {
    ...partial,
    partial: true,
    status: 'partial',
    summary: AI_EVALUATION_SLOW_MESSAGE,
    research_narrative: partial.research_narrative || AI_EVALUATION_SLOW_MESSAGE,
    warnings: [
      ...(Array.isArray(partial.warnings) ? partial.warnings : []),
      AI_EVALUATION_SLOW_MESSAGE,
    ],
    errors: [
      ...(Array.isArray(partial.errors) ? partial.errors : []),
      error?.message || 'AI evaluation did not finish before the manual UI timeout.',
    ],
    latency_ms: latencyMs,
  };
};

const proxyPost = (targetPath, onSuccess = null) => async (req, res, next) => {
  const targetUrl = `${aiServiceUrl}${targetPath}`;
  const requestStarted = Date.now();
  console.log(`[ai-proxy] POST ${targetPath} hit`, describePayload(req.body));

  try {
    console.log(`[ai-proxy] forwarding to ${targetUrl}`);
    const response = await axios.post(targetUrl, req.body, {
      timeout: AI_SERVICE_TIMEOUT_MS,
    });

    console.log(`[ai-proxy] ${targetPath} response received`, {
      status: response.status,
      latencyMs: Date.now() - requestStarted,
      responseKeys: response.data && typeof response.data === 'object' ? Object.keys(response.data) : [],
    });
    if (onSuccess) {
      onSuccess(req.body, response.data);
    }
    res.status(response.status).json(response.data);
  } catch (error) {
    console.error(`[ai-proxy] ${targetPath} failed`, {
      latencyMs: Date.now() - requestStarted,
      code: error.code,
      status: error.response?.status,
      data: error.response?.data,
      message: error.message,
    });

    if (error.response) {
      res.status(error.response.status).json(error.response.data);
      return;
    }

    const CONNECTION_ERRORS = new Set([
      'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED',
      'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH',
    ]);
    if (CONNECTION_ERRORS.has(error.code)) {
      res.status(503).json({
        error: 'AI service is offline',
        message: 'Start the local FastAPI service: cd ai-service && python3 main.py',
        code: error.code,
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

router.get('/observability/metrics', async (_req, res) => {
  try {
    const response = await axios.get(`${aiServiceUrl}/observability/metrics`, {
      timeout: 10000,
    });

    res.status(response.status).json(response.data);
  } catch {
    res.status(503).json({
      project_name: 'reefwatch-ai',
      phoenix: 'offline',
      hosted_arize: 'unknown',
      metrics: null,
    });
  }
});

router.post('/analyze', proxyPost('/analyze-reef', (body, responseData) => {
  const reefName = getReefName(body, responseData);
  insertAgentEvent(
    'ai_analysis',
    `AI risk assessment completed for ${reefName}`,
    reefName,
    JSON.stringify({
      risk_score: responseData?.risk_score ?? null,
      confidence: responseData?.confidence ?? null,
    }),
  );
}));

router.post('/brief', proxyPost('/generate-brief', (body, responseData) => {
  const reefName = getReefName(body, responseData);
  insertAgentEvent(
    'brief_generated',
    `Conservation brief generated for ${reefName}`,
    reefName,
    null,
  );
}));
router.post('/chat', proxyPost('/chat'));
router.post('/evaluate', async (req, res) => {
  const targetPath = '/self-evaluate';
  const targetUrl = `${aiServiceUrl}${targetPath}`;
  const requestStarted = Date.now();
  const requestedLimit = Number(req.body?.limit);
  const isManualUi = (req.body?.reason || 'manual-ui') === 'manual-ui';
  const hardCap = isManualUi ? 3 : 25;
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(Math.floor(requestedLimit), hardCap)
    : (isManualUi ? 3 : 10);
  const payload = {
    limit,
    reason: req.body?.reason || 'manual-ui',
  };

  console.log(`[ai-proxy] POST ${targetPath} manual evaluation hit`, payload);

  try {
    const response = await axios.post(targetUrl, payload, {
      timeout: AI_EVALUATION_TIMEOUT_MS,
    });

    console.log(`[ai-proxy] ${targetPath} response received`, {
      status: response.status,
      latencyMs: Date.now() - requestStarted,
      responseKeys: response.data && typeof response.data === 'object' ? Object.keys(response.data) : [],
    });
    res.status(response.status).json(response.data);
  } catch (error) {
    const latencyMs = Date.now() - requestStarted;
    console.error(`[ai-proxy] ${targetPath} manual evaluation failed`, {
      latencyMs,
      code: error.code,
      status: error.response?.status,
      data: error.response?.data,
      message: error.message,
    });

    if (error.response?.data && error.response.status < 500) {
      res.status(error.response.status).json(error.response.data);
      return;
    }

    res.status(200).json(buildPartialEvaluationResponse(error, latencyMs));
  }
});

export default router;
