import cron from 'node-cron';
import axios from 'axios';
import { checkAndSendAlerts } from './alertService.js';
import { fetchNoaaPointCondition } from './noaaService.js';
import { getActiveMonitoredReefCount, getActiveMonitoredReefs, getStationReadings, insertAgentEvent, upsertActiveMonitoredReef } from '../db/database.js';

const REQUEST_DELAY_MS = 200;
const aiServiceUrl = process.env.AI_SERVICE_URL || 'http://localhost:8000';
const AI_ANALYSIS_TIMEOUT_MS = 30000;

let refreshInProgress = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const unavailableReading = (station, error) => ({
  ...station,
  stationId: station.stationId || station.id,
  name: station.name,
  lat: station.lat,
  lng: station.lng,
  seaSurfaceTemp: null,
  tempAnomaly: null,
  degreeHeatingWeeks: null,
  bleachingAlertLevel: 'Unavailable',
  riskScore: 0,
  status: 'unavailable',
  noaa_data_available: false,
  noaaDataAvailable: false,
  source: station.source,
  lastUpdated: new Date().toISOString(),
  error: error.message,
});

const successfulReading = (station, condition, aiAnalysis = null) => ({
  ...station,
  stationId: station.stationId || station.id,
  name: station.name,
  lat: station.lat,
  lng: station.lng,
  seaSurfaceTemp: condition.seaSurfaceTemp,
  tempAnomaly: condition.tempAnomaly,
  degreeHeatingWeeks: condition.degreeHeatingWeeks,
  bleachingAlertLevel: condition.bleachingAlertLevel,
  riskScore: typeof aiAnalysis?.risk_score === 'number' ? aiAnalysis.risk_score : condition.riskScore,
  status: aiAnalysis?.risk_level || condition.status,
  noaa_data_available: true,
  noaaDataAvailable: true,
  source: aiAnalysis ? `${condition.source} + ReefWatch Gemini AI` : condition.source,
  lastUpdated: condition.lastUpdated,
  error: null,
  aiAnalysis: aiAnalysis?.threat_summary || station.aiAnalysis || null,
  confidence: typeof aiAnalysis?.confidence === 'number' ? aiAnalysis.confidence : station.confidence ?? null,
  isCustomMonitored: true,
});

export function getCachedStationReadings() {
  return getStationReadings();
}

function isStillActivelyMonitored(station) {
  return getActiveMonitoredReefs().some((reef) => (
    reef.id === station.id
    || reef.stationId === station.stationId
    || reef.stationId === station.id
  ));
}

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

export async function refreshStationReadings({ reason = 'manual' } = {}) {
  if (refreshInProgress) {
    console.log(`[station-refresh] skipped ${reason}; refresh already running`);
    return { started: false, message: 'Station refresh already running' };
  }

  refreshInProgress = true;
  const startedAt = Date.now();
  let successCount = 0;
  let failureCount = 0;
  const updatedReadings = [];

  try {
    console.log(`[station-refresh] started (${reason})`);
    const stations = getActiveMonitoredReefs();
    console.log(`[station-refresh] refreshing ${stations.length} actively monitored reefs`);

    for (let index = 0; index < stations.length; index += 1) {
      const station = stations[index];
      if (!isStillActivelyMonitored(station)) {
        console.log(`[refresh] Skipping removed reef: ${station.name}`);
        continue;
      }
      console.log(`[refresh] Processing ${index + 1}/${stations.length}: ${station.name}`);

      try {
        const condition = await fetchNoaaPointCondition(station);
        let aiAnalysis = null;
        try {
          aiAnalysis = await runAiAnalysis(station, condition);
        } catch (error) {
          console.warn(`[refresh] AI analysis skipped for ${station.name}: ${error.message}`);
        }
        const reading = successfulReading(station, condition, aiAnalysis);
        if (!isStillActivelyMonitored(station)) {
          console.log(`[refresh] Not saving removed reef: ${station.name}`);
          continue;
        }
        upsertActiveMonitoredReef(reading);
        updatedReadings.push(reading);
        successCount += 1;
        console.log(`[refresh] Success: ${station.name}`);
      } catch (error) {
        if (!isStillActivelyMonitored(station)) {
          console.log(`[refresh] Not saving removed reef after failed refresh: ${station.name}`);
          continue;
        }
        const reading = unavailableReading(station, error);
        upsertActiveMonitoredReef(reading);
        updatedReadings.push(reading);
        failureCount += 1;
        console.error(`[refresh] Failed: ${station.name} (${error.message})`);
      }

      if (index < stations.length - 1) {
        await sleep(REQUEST_DELAY_MS);
      }
    }

    const seconds = Math.round((Date.now() - startedAt) / 1000);
    console.log(`[station-refresh] complete in ${seconds}s: ${successCount} success, ${failureCount} failed`);
    insertAgentEvent(
      'batch_refresh',
      `Nightly monitored reef refresh completed: ${successCount} reefs updated`,
      null,
      null,
    );
    checkAndSendAlerts(updatedReadings).catch(console.error);
    return { started: true, successCount, failureCount };
  } finally {
    refreshInProgress = false;
  }
}

export function startStationRefresh({ reason = 'manual' } = {}) {
  if (refreshInProgress) {
    console.log(`[station-refresh] ${reason} request ignored; refresh already running`);
    return false;
  }

  refreshStationReadings({ reason }).catch((error) => {
    console.error(`[station-refresh] ${reason} crashed`, error);
  });

  return true;
}

export function scheduleStationRefresh() {
  cron.schedule('0 2 * * *', () => {
    startStationRefresh({ reason: 'daily-cron' });
  });

  console.log('[station-refresh] scheduled daily refresh at 2 AM server time');
}

export function refreshStationsOnStartupIfEmpty() {
  const count = getActiveMonitoredReefCount();

  if (count === 0) {
    console.log('[station-refresh] startup refresh skipped; no actively monitored reefs');
    return;
  }

  console.log(`[station-refresh] refreshing ${count} actively monitored reefs on startup`);
  startStationRefresh({ reason: 'startup-active-monitoring' });
}
