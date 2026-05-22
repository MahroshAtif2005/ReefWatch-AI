import axios from 'axios';
import {
  deleteActiveMonitoredReef,
  getActiveMonitoredReefCount,
  getActiveMonitoredReefs,
  upsertActiveMonitoredReef,
} from '../db/database.js';
import { checkAndSendAlerts } from './alertService.js';
import { fetchNoaaPointCondition, getBaseReefCount } from './noaaService.js';

const MAX_ACTIVE_REEFS = 20;
const aiServiceUrl = process.env.AI_SERVICE_URL || 'http://localhost:8000';
const MONITORING_NOAA_TIMEOUT_MS = 35000;
const MONITORING_NOAA_RETRIES = 3;
const AI_ANALYSIS_TIMEOUT_MS = 30000;

const slugify = (value) => String(value || '')
  .toLowerCase()
  .trim()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

const normalizeStatus = (riskLevel, fallbackStatus) => {
  const normalized = String(riskLevel || '').toLowerCase();
  if (['safe', 'warning', 'critical'].includes(normalized)) return normalized;
  return fallbackStatus;
};

async function runAiAnalysis(station, noaaData) {
  const response = await axios.post(`${aiServiceUrl}/analyze-reef`, {
    reef_name: station.name,
    lat: station.lat,
    lng: station.lng,
    country: station.country,
    sst: noaaData.seaSurfaceTemp,
    anomaly: noaaData.tempAnomaly,
    dhw: noaaData.degreeHeatingWeeks,
    alert_level: noaaData.bleachingAlertLevel,
    data_source: noaaData.source,
    last_updated: noaaData.lastUpdated,
    station_id: station.stationId || station.id,
  }, {
    timeout: AI_ANALYSIS_TIMEOUT_MS,
  });

  return response.data;
}

const pendingNoaaData = (station, error) => ({
  seaSurfaceTemp: null,
  tempAnomaly: null,
  degreeHeatingWeeks: null,
  bleachingAlertLevel: 'Unavailable',
  riskScore: 0,
  status: 'unavailable',
  noaa_data_available: false,
  noaaDataAvailable: false,
  source: 'NOAA Coral Reef Watch unavailable',
  lastUpdated: new Date().toISOString(),
  error: error.message,
});

export function getActiveMonitoringLimit() {
  return MAX_ACTIVE_REEFS;
}

export function getStoredActiveReefs() {
  return getActiveMonitoredReefs();
}

export async function addStationToActiveMonitoring(station) {
  const stationId = station.station_id || station.stationId || station.id;
  const id = `station-${slugify(stationId || station.name)}`;
  const currentCustomCount = getActiveMonitoredReefCount();
  const isExisting = getActiveMonitoredReefs().some((reef) => reef.id === id || reef.stationId === stationId);

  if (!isExisting && getBaseReefCount() + currentCustomCount >= MAX_ACTIVE_REEFS) {
    const error = new Error(`Active monitoring is capped at ${MAX_ACTIVE_REEFS} reefs.`);
    error.statusCode = 409;
    throw error;
  }

  const baseStation = {
    id,
    stationId,
    name: station.name,
    region: 'NOAA Virtual Station',
    country: 'NOAA Virtual Station',
    lat: Number(station.lat),
    lng: Number(station.lng),
  };

  if (!baseStation.name || !Number.isFinite(baseStation.lat) || !Number.isFinite(baseStation.lng)) {
    const error = new Error('Station name, lat, and lng are required to initialize monitoring.');
    error.statusCode = 400;
    throw error;
  }

  console.log(`[monitoring] initializing ${baseStation.name}`, {
    stationId: baseStation.stationId,
    lat: baseStation.lat,
    lng: baseStation.lng,
  });

  let noaaDataStatus = 'fetched';
  let aiAnalysisStatus = 'complete';
  let noaaData;
  let aiAnalysis = null;

  try {
    noaaData = await fetchNoaaPointCondition(baseStation, {
      timeout: MONITORING_NOAA_TIMEOUT_MS,
      retries: MONITORING_NOAA_RETRIES,
    });
  } catch (error) {
    noaaDataStatus = 'unavailable';
    aiAnalysisStatus = 'pending';
    noaaData = pendingNoaaData(baseStation, error);
    console.warn(`[monitoring] NOAA unavailable for ${baseStation.name}; adding as pending`, error.message);
  }

  if (noaaDataStatus === 'fetched') {
    try {
      aiAnalysis = await runAiAnalysis(baseStation, noaaData);
    } catch (error) {
      aiAnalysisStatus = 'pending';
      console.warn(`[monitoring] AI analysis unavailable for ${baseStation.name}; adding without analysis`, error.message);
    }
  }

  const monitoredReef = {
    ...baseStation,
    ...noaaData,
    riskScore: typeof aiAnalysis?.risk_score === 'number' ? aiAnalysis.risk_score : noaaData.riskScore,
    status: normalizeStatus(aiAnalysis?.risk_level, noaaData.status),
    source: aiAnalysis ? `${noaaData.source} + ReefWatch Gemini AI` : noaaData.source,
    aiAnalysis: aiAnalysis?.threat_summary || null,
    confidence: typeof aiAnalysis?.confidence === 'number' ? aiAnalysis.confidence : null,
    createdAt: new Date().toISOString(),
    isCustomMonitored: true,
  };

  upsertActiveMonitoredReef(monitoredReef);
  checkAndSendAlerts([monitoredReef]).catch(console.error);

  console.log(`[monitoring] active ${baseStation.name}`, {
    status: monitoredReef.status,
    riskScore: monitoredReef.riskScore,
  });

  return {
    success: true,
    station: monitoredReef,
    noaaData: noaaDataStatus,
    aiAnalysis: aiAnalysisStatus,
  };
}

export function removeStationFromActiveMonitoring(id) {
  return deleteActiveMonitoredReef(id);
}
