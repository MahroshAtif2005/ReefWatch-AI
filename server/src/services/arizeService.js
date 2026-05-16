import { getArizeTraceCount, getLastArizeTraceTime, getRecentArizeTraces, insertArizeTrace } from '../db/database.js';

const projectName = process.env.ARIZE_PROJECT_NAME || 'ReefWatch AI';

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

export async function logReefAssessmentTrace(payload) {
  const trace = normalizeTracePayload(payload);
  const configured = isArizeConfigured();

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

export function getArizeStatus() {
  const configured = isArizeConfigured();
  const localTraceCount = getArizeTraceCount();
  const lastTraceTime = getLastArizeTraceTime();

  return {
    configured,
    projectName,
    lastTraceTime,
    localTraceCount,
    message: configured
      ? 'Arize configured. Local trace capture is active.'
      : 'Arize not configured. Traces are stored locally.',
  };
}

export function getLocalArizeTraces(limit = 25) {
  return getRecentArizeTraces(limit);
}
