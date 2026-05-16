export type ReefStatus = 'safe' | 'warning' | 'critical';

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
  lastUpdated: string;
  source: string;
  error?: string;
  aiAnalysis?: string;
  confidence?: number;
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

export interface ArizeStatus {
  configured: boolean;
  projectName: string;
  lastTraceTime: string | null;
  localTraceCount: number;
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

const REEF_API_BASE_URL = 'http://localhost:4000';

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

export async function fetchArizeStatus(): Promise<ArizeStatus> {
  const response = await fetch(`${REEF_API_BASE_URL}/api/arize/status`);

  if (!response.ok) {
    throw new Error(`Arize status request failed with ${response.status}`);
  }

  return response.json();
}

export async function fetchArizeTraces(): Promise<ArizeTrace[]> {
  const response = await fetch(`${REEF_API_BASE_URL}/api/arize/traces`);

  if (!response.ok) {
    throw new Error(`Arize traces request failed with ${response.status}`);
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
  const response = await fetch(`${REEF_API_BASE_URL}/api/ai/brief`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`AI brief request failed with ${response.status}`);
  }

  return response.json();
}

export async function sendResearchChat(payload: {
  message: string;
  conversation_history: ReefChatMessage[];
  reef_context: Record<string, unknown> | null;
}): Promise<ReefChatResponse> {
  console.log('AI chat payload', payload);

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
