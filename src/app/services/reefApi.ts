export type ReefStatus = 'safe' | 'warning' | 'critical' | 'pending' | 'unavailable';

export interface LiveReef {
  id: string;
  name: string;
  region: string;
  country: string;
  lat: number;
  lng: number;
  seaSurfaceTemp: number | null;
  tempAnomaly: number | null;
  degreeHeatingWeeks: number | null;
  bleachingAlertLevel: string;
  riskScore: number;
  status: ReefStatus;
  noaa_data_available?: boolean;
  noaaDataAvailable?: boolean;
  lastUpdated: string;
  source: string;
  error?: string;
  aiAnalysis?: string;
  confidence?: number;
  stationId?: string;
  isCustomMonitored?: boolean;
}

export interface ReefAnalysisRequest {
  reef_name: string;
  lat: number;
  lng: number;
  sst: number | null;
  anomaly: number | null;
  dhw: number | null;
  alert_level: string;
}

export interface ReefBriefRequest {
  reef_id: string;
  reef_name: string;
  sst: number | null;
  anomaly: number | null;
  dhw: number | null;
  alert_level: string;
  risk_score: number;
}

export interface ReefBriefResponse {
  brief: string;
  reef_name: string;
  generated_at: string;
}

export interface MonitorStationResponse {
  success: boolean;
  station: LiveReef | null;
  noaaData: 'fetched' | 'unavailable';
  aiAnalysis: 'complete' | 'pending';
  error?: string;
  message?: string;
  details?: string;
}

export interface ReefChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ReefChatResponse {
  answer: string;
  data_used: string[];
  confidence: number;
  follow_up_suggestions: string[];
}

export interface AiHealth {
  status: string;
  phoenix: string;
  gemini: string;
}

export interface ReefStation {
  id: string;
  name: string;
  lat: number;
  lng: number;
  type: 'station';
  status: 'station';
  source: string;
}

export interface ReefStationReading {
  id: string;
  stationId: string;
  name: string;
  lat: number;
  lng: number;
  type: 'station';
  seaSurfaceTemp: number | null;
  tempAnomaly: number | null;
  degreeHeatingWeeks: number | null;
  bleachingAlertLevel: string;
  riskScore: number;
  status: ReefStatus | 'unavailable';
  source: string;
  lastUpdated: string;
  error: string | null;
}

export interface HistoricalTrendPoint {
  date: string;
  seaSurfaceTemp: number | null;
  sstAnomaly: number | null;
  hotspot: number | null;
  degreeHeatingWeeks: number | null;
  bleachingRisk: number | null;
  reefCount: number;
}

export interface HistoricalTrendsResponse {
  totalMonitoredReefs: number;
  criticalReefs: number;
  warningReefs: number;
  healthyReefs: number;
  averages: {
    seaSurfaceTemp: number | null;
    sstAnomaly: number | null;
    degreeHeatingWeeks: number | null;
  };
  series: HistoricalTrendPoint[];
  mode: 'historical' | 'snapshot';
  historicalDataAvailable: boolean;
  message: string;
  lastUpdated: string;
  sourceLabel: string;
  source: string;
  error?: string;
}

export interface ArizeStatus {
  configured: boolean;
  localPhoenixConnected?: boolean;
  hostedArizeConnected?: boolean;
  phoenixStatus?: string;
  hostedArizeStatus?: string;
  phoenixUrl?: string;
  projectName: string;
  lastTraceTime: string | null;
  localTraceCount: number;
  metrics?: {
    total_traces: number;
    success_count: number;
    failure_count: number;
    error_rate: number;
    average_latency_ms: number;
    average_llm_latency_ms: number;
    average_noaa_latency_ms: number;
    high_risk_count: number;
    fallback_count: number;
    cache_hit_rate: number;
    average_confidence: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    last_trace_time: string | null;
    last_error: string | null;
  } | null;
  message: string;
}

export interface ArizeTrace {
  traceId: string;
  reefId: string;
  reefName: string;
  coordinates: {
    lat: number | null;
    lng: number | null;
  };
  noaaInputData: {
    seaSurfaceTemp?: number | null;
    tempAnomaly?: number | null;
    degreeHeatingWeeks?: number | null;
    bleachingAlertLevel?: string;
  };
  aiRiskScore: number | null;
  aiConfidence: number | null;
  aiSummary: string;
  modelName: string;
  status: 'safe' | 'warning' | 'critical' | string;
  timestamp: string;
  source: string;
  arizeStatus: string;
}

export interface AgentActivityEvent {
  id: number;
  event_type: 'noaa_fetch' | 'ai_analysis' | 'brief_generated' | 'noaa_error' | 'batch_refresh' | string;
  description: string;
  reef_name: string | null;
  timestamp: string;
}

export interface TestAlertResponse {
  success: boolean;
  emailSent: boolean;
  reef?: string;
  sentTo?: string;
  message?: string;
}

export interface SelfImprovementRun {
  status?: 'completed' | 'partial' | 'insufficient_data' | 'timeout' | 'error' | string;
  date: string | null;
  assessment_count: number;
  average_score: number | null;
  accuracy: number | null;
  specificity: number | null;
  actionability: number | null;
  scientific_reliability: number | null;
  dhw_interpretation: number | null;
  uncertainty_communication: number | null;
  dhw_interpretation_accuracy: number | null;
  hallucination_avoidance: number | null;
  prompt_updated: boolean;
  quota_limited?: boolean;
  warnings?: string[];
  message?: string;
  error?: string;
  errors?: string[];
  issues: string[];
  summary: string;
  research_narrative?: string;
  prompt_change_summary?: string;
  empty?: boolean;
  partial?: boolean;
  before_after: {
    previous_score: number | null;
    latest_score: number | null;
  };
}

export interface SelfImprovementHistoryPoint {
  date: string | null;
  average_score: number | null;
  assessment_count: number;
  prompt_updated: boolean;
  quota_limited: boolean;
  issues: string[];
  summary: string;
  research_narrative: string;
  scientific_reliability: number | null;
  uncertainty_communication: number | null;
  dhw_interpretation: number | null;
  dhw_interpretation_accuracy: number | null;
  hallucination_avoidance: number | null;
}

export interface SelfImprovementHistory {
  history: SelfImprovementHistoryPoint[];
  seven_day_avg: number | null;
  count: number;
}

const REEF_API_BASE_URL = 'http://localhost:4000';
const SELF_EVALUATION_TIMEOUT_MS = 120000;
export const SELF_EVALUATION_SLOW_MESSAGE =
  'AI evaluation is taking longer than expected. Try again with a smaller limit or check Gemini quota.';

export function normalizeBleachingAlertLevel(
  alertLevel: string | null | undefined,
  degreeHeatingWeeks: number | null | undefined,
) {
  const dhw = degreeHeatingWeeks ?? 0;
  const normalizedAlert = (alertLevel || '').trim().toLowerCase();

  if (dhw >= 8) return 'Alert Level 2';
  if (dhw > 4) return 'Alert Level 1';
  if (
    dhw > 0
    && (!alertLevel || normalizedAlert.includes('no stress') || normalizedAlert.includes('unavailable'))
  ) {
    return 'Bleaching Watch';
  }

  return alertLevel || 'Unavailable';
}

export async function checkBackendHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${REEF_API_BASE_URL}/api/health`, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) {
      console.warn('[reefwatch] Node backend unavailable (non-OK response)');
      return false;
    }
    const data = await response.json();
    if (data?.ok === true) {
      console.log('[reefwatch] Node backend connected on port 4000');
      return true;
    }
    console.warn('[reefwatch] Node backend unavailable (unexpected response)');
    return false;
  } catch {
    console.warn('[reefwatch] Node backend unavailable');
    return false;
  }
}

async function getErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.text();
    return body ? `${fallback}: ${body}` : fallback;
  } catch {
    return fallback;
  }
}

export async function fetchLiveReefs(): Promise<LiveReef[]> {
  const response = await fetch(`${REEF_API_BASE_URL}/api/reefs/live`);

  if (!response.ok) {
    throw new Error(`Reef API request failed with ${response.status}`);
  }

  return response.json();
}

export async function fetchReefStations(): Promise<ReefStation[]> {
  const response = await fetch(`${REEF_API_BASE_URL}/api/reefs/stations`);

  if (!response.ok) {
    throw new Error(`Reef station request failed with ${response.status}`);
  }

  return response.json();
}

export async function fetchReefStationReadings(): Promise<ReefStationReading[]> {
  const response = await fetch(`${REEF_API_BASE_URL}/api/reefs/stations/readings`);

  if (!response.ok) {
    throw new Error(`Reef station readings request failed with ${response.status}`);
  }

  return response.json();
}

export async function fetchHistoricalTrends(): Promise<HistoricalTrendsResponse> {
  const response = await fetch(`${REEF_API_BASE_URL}/api/reefs/historical-trends`);

  if (!response.ok) {
    throw new Error(`Historical trends request failed with ${response.status}`);
  }

  return response.json();
}

export async function fetchArizeStatus(): Promise<ArizeStatus> {
  const response = await fetch(`${REEF_API_BASE_URL}/api/arize/status`);

  if (!response.ok) {
    throw new Error(`Arize status request failed with ${response.status}`);
  }

  return response.json();
}

export async function fetchArizeTraces(limit = 100): Promise<ArizeTrace[]> {
  const response = await fetch(`${REEF_API_BASE_URL}/api/arize/traces?limit=${limit}`);

  if (!response.ok) {
    throw new Error(`Arize traces request failed with ${response.status}`);
  }

  return response.json();
}

export async function fetchAgentActivity(): Promise<AgentActivityEvent[]> {
  const response = await fetch(`${REEF_API_BASE_URL}/api/agent/activity`);

  if (!response.ok) {
    throw new Error(`Agent activity request failed with ${response.status}`);
  }

  return response.json();
}

export async function sendTestAlert(reefId?: string): Promise<TestAlertResponse> {
  const response = await fetch(`${REEF_API_BASE_URL}/api/alerts/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reefId ? { reefId } : {}),
  });

  const data = await response.json().catch(() => null) as TestAlertResponse | null;

  if (!response.ok || !data?.success || !data.emailSent) {
    throw new Error(data?.message || `Test alert request failed with ${response.status}`);
  }

  return data;
}

export async function fetchSettings(): Promise<Record<string, string>> {
  const response = await fetch(`${REEF_API_BASE_URL}/api/settings`);

  if (!response.ok) {
    throw new Error(`Settings request failed with ${response.status}`);
  }

  return response.json();
}

export async function saveSettings(settings: Record<string, string | number | boolean>): Promise<{ success: boolean }> {
  const response = await fetch(`${REEF_API_BASE_URL}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings }),
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, `Alert settings request failed with ${response.status}`));
  }

  return response.json();
}

export async function analyzeReef(payload: ReefAnalysisRequest) {
  const response = await fetch(`${REEF_API_BASE_URL}/api/ai/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`AI analysis request failed with ${response.status}`);
  }

  return response.json();
}

export async function generateConservationBrief(payload: ReefBriefRequest): Promise<ReefBriefResponse> {
  console.log('[generateConservationBrief] POST', `${REEF_API_BASE_URL}/api/ai/brief`, payload);

  const response = await fetch(`${REEF_API_BASE_URL}/api/ai/brief`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, `AI brief request failed with ${response.status}`));
  }

  return response.json();
}

export async function sendResearchChat(payload: {
  message: string;
  conversation_history: ReefChatMessage[];
  reef_context: Record<string, unknown> | null;
}): Promise<ReefChatResponse> {
  console.log('AI chat payload shape', {
    messageLength: payload.message.length,
    conversationHistoryCount: payload.conversation_history.length,
    reefContextKeys: payload.reef_context ? Object.keys(payload.reef_context) : [],
  });

  const response = await fetch(`${REEF_API_BASE_URL}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, `AI chat request failed with ${response.status}`));
  }

  const data = await response.json();

  if (!data || typeof data.answer !== 'string') {
    throw new Error(`AI chat response was missing an answer: ${JSON.stringify(data)}`);
  }

  return {
    answer: data.answer,
    data_used: Array.isArray(data.data_used) ? data.data_used : [],
    confidence: typeof data.confidence === 'number' ? data.confidence : 0,
    follow_up_suggestions: Array.isArray(data.follow_up_suggestions) ? data.follow_up_suggestions : [],
  };
}

export async function fetchAiHealth(): Promise<AiHealth> {
  const response = await fetch(`${REEF_API_BASE_URL}/api/ai/health`);

  if (!response.ok) {
    throw new Error(`AI health request failed with ${response.status}`);
  }

  return response.json();
}

export async function fetchLatestSelfImprovementRun(): Promise<SelfImprovementRun> {
  const response = await fetch(`${REEF_API_BASE_URL}/api/self-improvement/latest`);

  if (!response.ok) {
    throw new Error(`Self-improvement request failed with ${response.status}`);
  }

  return response.json();
}

export async function fetchSelfImprovementHistory(limit = 14): Promise<SelfImprovementHistory> {
  const response = await fetch(
    `${REEF_API_BASE_URL}/api/self-improvement/history?limit=${limit}`,
  );

  if (!response.ok) {
    throw new Error(`Self-improvement history request failed with ${response.status}`);
  }

  return response.json();
}

export async function runSelfEvaluationNow(): Promise<SelfImprovementRun> {
  const controller = new AbortController();
  const fetchTimeout = setTimeout(() => controller.abort(), SELF_EVALUATION_TIMEOUT_MS);
  try {
    const response = await fetch(`${REEF_API_BASE_URL}/api/ai/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'manual-ui', limit: 2 }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(await getErrorMessage(response, SELF_EVALUATION_SLOW_MESSAGE));
    }

    return response.json();
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(SELF_EVALUATION_SLOW_MESSAGE);
    }
    throw error;
  } finally {
    clearTimeout(fetchTimeout);
  }
}

export async function addStationToActiveMonitoring(payload: {
  station_id: string;
  name: string;
  lat: number;
  lng: number;
}): Promise<LiveReef> {
  const response = await fetch(`${REEF_API_BASE_URL}/api/reefs/monitor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, `Monitoring request failed with ${response.status}`));
  }

  const data = await response.json() as MonitorStationResponse | LiveReef;

  if ('station' in data) {
    if (!data.success || !data.station) {
      throw new Error(data.message || data.error || 'Unable to add this station to active monitoring.');
    }

    return data.station;
  }

  return data;
}

export async function removeFromActiveMonitoring(id: string): Promise<{ removed: boolean }> {
  const response = await fetch(`${REEF_API_BASE_URL}/api/reefs/monitor/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, `Remove monitoring request failed with ${response.status}`));
  }

  return response.json();
}
