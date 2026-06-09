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
  reasoning_steps?: string[];
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
    noaa_api_latency_ms: number;
    high_risk_count: number;
    fallback_count: number;
    cache_hit_rate: number;
    average_confidence: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    last_trace_time: string | null;
    last_error: string | null;
    /** True when the backend is serving seeded baseline data (no real traces this session) */
    _is_baseline?: boolean;
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

export interface SelfImprovementVerifiedMetrics {
  average_score: number | null;
  accuracy: number | null;
  specificity: number | null;
  actionability: number | null;
  scientific_reliability: number | null;
  dhw_interpretation: number | null;
  dhw_interpretation_accuracy: number | null;
  uncertainty_communication: number | null;
  hallucination_avoidance: number | null;
  last_eval_at: string | null;
}

export interface SelfImprovementRun {
  /** Raw run status from the backend (e.g. completed, improved, skipped_healthy). */
  status?: 'completed' | 'improved' | 'degraded' | 'partial' | 'insufficient_data' | 'timeout' | 'error' | 'no_traces' | 'skipped_healthy' | string;
  /**
   * Computed overall system state — always use this for badge/narrative logic.
   * healthy | improved | degraded | rewrite_pending_verification | skipped_healthy | no_data
   */
  system_status?: 'healthy' | 'improved' | 'degraded' | 'rewrite_pending_verification' | 'skipped_healthy' | 'no_data' | string;
  /**
   * Describes the prompt rewrite lifecycle across multiple runs.
   * none | rewritten_pending | confirmed_improved | did_not_improve
   */
  prompt_rewrite_status?: 'none' | 'rewritten_pending' | 'confirmed_improved' | 'did_not_improve';
  /** Metrics from the latest non-skipped full evaluation (authoritative for display). */
  latest_verified_metrics?: SelfImprovementVerifiedMetrics | null;
  /** Human-readable summary of the current system state. */
  current_state_summary?: string | null;
  /** ISO timestamp of the latest full evaluation (not a skip). */
  last_full_eval_at?: string | null;
  cached_from?: string | null;
  cached?: boolean;
  /** ISO timestamp of when this run (or health check) completed. */
  last_checked?: string | null;
  /** Human-readable reason why the full Gemini eval was skipped. */
  skip_reason?: string | null;
  /** "manual" | "nightly_scheduler" | "fresh_live_reef_analysis" etc. */
  source?: string | null;
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
  /** Which model-reasoning dimensions triggered the rewrite (e.g. "actionability, specificity"). */
  rewrite_reason?: string | null;
  /** Root cause diagnosis from the self-improvement run. */
  diagnosis?: {
    failing_dimensions: string[];
    failing_scores: Record<string, number>;
    model_reasoning_dimensions: string[];
    data_gap_dimensions: string[];
    data_gap_likely: boolean;
    rewrite_warranted: boolean;
    diagnosis_summary: string;
  } | null;
  empty?: boolean;
  partial?: boolean;
  before_after: {
    previous_score: number | null;
    latest_score: number | null;
  };
}

export interface SelfImprovementHistoryPoint {
  date: string | null;
  stored_at?: string | null;
  completed_at?: string | null;
  last_checked?: string | null;
  source?: string | null;
  status?: string | null;
  skip_reason?: string | null;
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

// ── V2 Production Evaluation System types ──────────────────────────────────

export interface PromptVersionEntry {
  version: string;
  deployed_at: string | null;
  experiment_score: number | null;
  improvement_delta: number | null;
  rewrite_reason: string | null;
}

export interface ExperimentResult {
  experiment_id: string;
  status: string;
  timestamp: string;
  benchmark_cases_used: number;
  baseline_score: number | null;
  candidate_score: number | null;
  delta: number | null;
  promoted: boolean;
  promotion_reason: string;
  baseline_dimensions: Record<string, number>;
  candidate_dimensions: Record<string, number>;
  dimension_deltas: Record<string, number>;
  rewrite_reason: string | null;
  diagnosis_summary: string | null;
}

export interface SelfImprovementV2Status {
  prompt_version: string;
  prompt_deployed_at: string | null;
  prompt_experiment_score: number | null;
  prompt_baseline_score: number | null;
  prompt_improvement_delta: number | null;
  prompt_rewrite_reason: string | null;
  benchmark_dataset_size: number;
  latest_experiment: {
    experiment_id: string | null;
    timestamp: string | null;
    baseline_score: number | null;
    candidate_score: number | null;
    delta: number | null;
    promoted: boolean | null;
    promotion_reason: string | null;
    benchmark_cases: number | null;
  } | null;
  prompt_history: PromptVersionEntry[];
  current_quality: number | null;
  current_system_status: string | null;
  /** Stable score from the most recent experiment's baseline — use this for trend comparisons. */
  benchmark_score: number | null;
  /** Score from the latest fresh random-sample evaluation — may be noisy. */
  fresh_sample_score: number | null;
  /** True when the last experiment was rejected and the cooldown window is still active. */
  rejection_cooldown_active: boolean;
  last_updated: string;
}

export interface BenchmarkStats {
  total_cases: number;
  evaluation_types: Record<string, number>;
  oldest: string | null;
  newest: string | null;
  gcs_bucket: string;
}

export interface CostTelemetry {
  last_eval_calls: number;
  last_experiment_calls: number;
  nightly_cycle_calls: number;
  total_calls_this_session: number;
  last_eval_at: string | null;
  last_experiment_at: string | null;
  last_nightly_at: string | null;
  rejection_cooldown_active: boolean;
  last_experiment_rejected_at: string | null;
  cost_caps: {
    max_benchmark_cases_per_experiment: number;
    max_candidate_prompts_per_cycle: number;
    max_judge_comparisons: number;
    rejection_cooldown_hours: number;
    rejection_retry_threshold: number;
  };
}

export async function fetchCostTelemetry(): Promise<CostTelemetry> {
  const response = await fetch(`${REEF_API_BASE_URL}/api/self-improvement/cost-telemetry`);
  if (!response.ok) throw new Error(`cost telemetry request failed: ${response.status}`);
  return response.json();
}

export async function fetchSelfImprovementV2Status(): Promise<SelfImprovementV2Status> {
  const response = await fetch(`${REEF_API_BASE_URL}/api/self-improvement/v2/status`);
  if (!response.ok) throw new Error(`v2 status request failed: ${response.status}`);
  return response.json();
}

export async function fetchSelfImprovementV2Experiments(limit = 10): Promise<{ experiments: ExperimentResult[]; count: number }> {
  const response = await fetch(`${REEF_API_BASE_URL}/api/self-improvement/v2/experiments?limit=${limit}`);
  if (!response.ok) throw new Error(`v2 experiments request failed: ${response.status}`);
  return response.json();
}

export async function fetchSelfImprovementV2PromptHistory(): Promise<{ active_version: string; history: PromptVersionEntry[]; total_versions: number }> {
  const response = await fetch(`${REEF_API_BASE_URL}/api/self-improvement/v2/prompt-history`);
  if (!response.ok) throw new Error(`v2 prompt history request failed: ${response.status}`);
  return response.json();
}

export async function fetchBenchmarkStats(): Promise<BenchmarkStats> {
  const response = await fetch(`${REEF_API_BASE_URL}/api/self-improvement/v2/benchmark-stats`);
  if (!response.ok) throw new Error(`benchmark stats request failed: ${response.status}`);
  return response.json();
}

export const REEF_API_BASE_URL = 'https://reefwatch-ai-service-876566369096.us-central1.run.app';
const BACKEND_HEALTH_TIMEOUT_MS = 4500;

export const RESEARCHER_ID_KEY = 'reefwatch_researcher_id';

export function getResearcherId(): string {
  try {
    let id = localStorage.getItem(RESEARCHER_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(RESEARCHER_ID_KEY, id);
    }
    return id;
  } catch {
    return 'anonymous';
  }
}

export async function syncResearcherActiveReefs(researcherId: string, reefIds: string[]): Promise<void> {
  try {
    await fetch(`${REEF_API_BASE_URL}/api/researcher/active-reefs`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ researcher_id: researcherId, reef_ids: reefIds }),
    });
  } catch {
    // non-critical background sync
  }
}
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
    const response = await fetch(`${REEF_API_BASE_URL}/api/health`, { signal: AbortSignal.timeout(BACKEND_HEALTH_TIMEOUT_MS) });
    if (!response.ok) {
      console.warn('[reefwatch] Cloud Run backend unavailable (non-OK response)');
      return false;
    }
    const data = await response.json();
    if (data?.ok === true) {
      console.log('[reefwatch] Cloud Run backend connected');
      return true;
    }
    console.warn('[reefwatch] Cloud Run backend unavailable (unexpected response)');
    return false;
  } catch {
    console.warn('[reefwatch] Cloud Run backend unavailable');
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

export async function fetchMonitoredReefs(): Promise<LiveReef[]> {
  const response = await fetch(`${REEF_API_BASE_URL}/api/monitored-reefs`);

  if (!response.ok) {
    throw new Error(`Monitored reefs request failed with ${response.status}`);
  }

  return response.json();
}

export async function fetchReefStations(): Promise<ReefStation[]> {
  const response = await fetch(`${REEF_API_BASE_URL}/api/reefs/stations`, {
    signal: AbortSignal.timeout(20000),
  });

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

export interface McpToolCall {
  timestamp: string;
  tool: string;
  summary: string;
  data_preview?: string;
}

export async function fetchMcpToolCalls(limit = 20): Promise<McpToolCall[]> {
  const response = await fetch(`${REEF_API_BASE_URL}/api/mcp/tool-calls?limit=${limit}`);
  if (!response.ok) return [];
  const data = await response.json();
  return Array.isArray(data.tool_calls) ? data.tool_calls : [];
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
    body: JSON.stringify({ researcher_id: getResearcherId(), ...(reefId ? { reefId } : {}) }),
  });

  const data = await response.json().catch(() => null) as TestAlertResponse | null;

  if (!response.ok || !data?.success || !data.emailSent) {
    throw new Error(data?.message || `Test alert request failed with ${response.status}`);
  }

  return data;
}

export async function fetchSettings(researcherId?: string): Promise<Record<string, string>> {
  const url = researcherId
    ? `${REEF_API_BASE_URL}/api/settings?researcher_id=${encodeURIComponent(researcherId)}`
    : `${REEF_API_BASE_URL}/api/settings`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Settings request failed with ${response.status}`);
  }

  return response.json();
}

export async function saveSettings(
  settings: Record<string, string | number | boolean>,
  researcherId?: string,
): Promise<{ success: boolean }> {
  const body: Record<string, unknown> = { settings };
  if (researcherId) body.researcher_id = researcherId;
  const response = await fetch(`${REEF_API_BASE_URL}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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
    reasoning_steps: Array.isArray(data.reasoning_steps) ? data.reasoning_steps : [],
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
    const response = await fetch(`${REEF_API_BASE_URL}/api/self-improvement/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
  station_id?: string;
  name: string;
  lat: number;
  lng: number;
  researcher_id?: string;
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

export async function removeFromActiveMonitoring(id: string, researcherId?: string): Promise<{ removed: boolean }> {
  const url = researcherId
    ? `${REEF_API_BASE_URL}/api/reefs/monitor/${encodeURIComponent(id)}?researcher_id=${encodeURIComponent(researcherId)}`
    : `${REEF_API_BASE_URL}/api/reefs/monitor/${encodeURIComponent(id)}`;
  const response = await fetch(url, {
    method: 'DELETE',
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, `Remove monitoring request failed with ${response.status}`));
  }

  return response.json();
}
