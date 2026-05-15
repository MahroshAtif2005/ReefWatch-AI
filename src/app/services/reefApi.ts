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
}

const REEF_API_BASE_URL = 'http://localhost:4000';

export async function fetchLiveReefs(): Promise<LiveReef[]> {
  const response = await fetch(`${REEF_API_BASE_URL}/api/reefs/live`);

  if (!response.ok) {
    throw new Error(`Reef API request failed with ${response.status}`);
  }

  return response.json();
}
