import axios from 'axios';
import {
  getArizeTraceCount,
  getLastArizeTraceTime,
  getLastArizeTraceTimeForReef,
  getRecentArizeTraces,
  insertArizeTrace,
} from '../db/database.js';

const projectName = process.env.ARIZE_PROJECT_NAME || process.env.PHOENIX_PROJECT_NAME || 'reefwatch-ai';
const aiServiceUrl = process.env.AI_SERVICE_URL || 'http://localhost:8000';
const phoenixUiUrl = process.env.PHOENIX_UI_URL || 'http://127.0.0.1:6006';
const TRACE_COOLDOWN_MS = 5 * 60 * 1000;

const normalizeTracePayload = (payload) => ({
  traceId: payload.traceId || `trace-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  reefId: payload.reefId,
  reefName: payload.reefName,
  coordinates: payload.coordinates || {},
  noaaInputData: payload.noaaInputData || {},
  aiRiskScore: payload.aiRiskScore ?? null,
  aiConfidence: payload.aiConfidence ?? null,
  aiSummary: payload.aiSummary || 'NOAA-based reef risk assessment logged locally.',
  modelName: payload.modelName || 'NOAA Coral Reef Watch rules',
  status: payload.status || 'unknown',
  timestamp: payload.timestamp || new Date().toISOString(),
  source: payload.source || 'local',
});

export function isArizeConfigured() {
  return Boolean(process.env.ARIZE_API_KEY && process.env.ARIZE_SPACE_ID);
}

async function getAiObservabilityStatus() {
  try {
    const response = await axios.get(`${aiServiceUrl}/observability/metrics`, {
      timeout: 3500,
    });
    return response.data;
  } catch (error) {
    console.warn('[arize] AI observability status unavailable', error.message);
    return {
      project_name: projectName,
      phoenix: 'offline',
      phoenix_url: phoenixUiUrl,
      hosted_arize: isArizeConfigured() ? 'unknown' : 'not_configured',
      arize_project_name: projectName,
      metrics: null,
    };
  }
}

export async function logReefAssessmentTrace(payload) {
  const trace = normalizeTracePayload(payload);
  const configured = isArizeConfigured();
  const lastTraceTime = getLastArizeTraceTimeForReef(trace.reefId, trace.reefName);

  if (lastTraceTime) {
    const elapsed = Date.now() - new Date(lastTraceTime).getTime();
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < TRACE_COOLDOWN_MS) {
      console.log(`[arize] skipped local trace for ${trace.reefName}; analyzed ${Math.round(elapsed / 1000)}s ago`);
      return {
        configured,
        logged: false,
        skipped: true,
        message: 'Trace skipped due to 5 minute reef analysis cooldown.',
        trace,
      };
    }
  }

  // Arize API submission is intentionally guarded until keys are provided.
  // Local persistence always happens so the monitoring page remains useful.
  const arizeStatus = configured ? 'configured-local-pending' : 'local-only';
  const savedTrace = {
    ...trace,
    arizeStatus,
  };

  insertArizeTrace(savedTrace);

  if (!configured) {
    console.log(`[arize] Arize not configured; stored local trace for ${trace.reefName}`);
    return {
      configured: false,
      logged: true,
      message: 'Arize not configured. Trace stored locally.',
      trace: savedTrace,
    };
  }

  console.log(`[arize] Arize configured; stored local trace for ${trace.reefName}`);
  return {
    configured: true,
    logged: true,
    message: 'Trace stored locally. Arize submission hook is ready for API keys.',
    trace: savedTrace,
  };
}

export async function getArizeStatus() {
  const configured = isArizeConfigured();
  const localTraceCount = getArizeTraceCount();
  const lastTraceTime = getLastArizeTraceTime();
  const aiObservability = await getAiObservabilityStatus();
  const localPhoenixConnected = aiObservability.phoenix === 'connected';
  const hostedArizeConnected = configured && aiObservability.hosted_arize === 'connected';

  return {
    configured,
    localPhoenixConnected,
    hostedArizeConnected,
    phoenixStatus: localPhoenixConnected ? 'Local Phoenix Connected' : 'Local Phoenix Offline',
    hostedArizeStatus: hostedArizeConnected ? 'Hosted Arize Connected' : 'Hosted Arize Not Configured',
    phoenixUrl: aiObservability.phoenix_url || phoenixUiUrl,
    projectName,
    lastTraceTime,
    localTraceCount,
    metrics: aiObservability.metrics,
    message: localPhoenixConnected
      ? 'Local Phoenix connected. ReefWatch AI traces are streaming to Phoenix.'
      : configured
        ? 'Hosted Arize configured. Local Phoenix is offline.'
        : 'Local Phoenix offline. Hosted Arize is not configured; traces are stored locally.',
  };
}

export function getLocalArizeTraces(limit = 25) {
  return getRecentArizeTraces(limit);
}
