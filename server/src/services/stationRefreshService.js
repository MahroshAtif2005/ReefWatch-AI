import cron from 'node-cron';
import { checkAndSendAlerts } from './alertService.js';
import { fetchNoaaPointCondition } from './noaaService.js';
import { fetchVirtualStations } from './stationService.js';
import { getStationReadingCount, getStationReadings, insertAgentEvent, upsertStationReading } from '../db/database.js';

const REQUEST_DELAY_MS = 200;

let refreshInProgress = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const unavailableReading = (station, error) => ({
  stationId: station.id,
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

const successfulReading = (station, condition) => ({
  stationId: station.id,
  name: station.name,
  lat: station.lat,
  lng: station.lng,
  seaSurfaceTemp: condition.seaSurfaceTemp,
  tempAnomaly: condition.tempAnomaly,
  degreeHeatingWeeks: condition.degreeHeatingWeeks,
  bleachingAlertLevel: condition.bleachingAlertLevel,
  riskScore: condition.riskScore,
  status: condition.status,
  noaa_data_available: true,
  noaaDataAvailable: true,
  source: condition.source,
  lastUpdated: condition.lastUpdated,
  error: null,
});

export function getCachedStationReadings() {
  return getStationReadings();
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
    const stations = await fetchVirtualStations();
    console.log(`[station-refresh] refreshing ${stations.length} NOAA virtual stations`);

    for (let index = 0; index < stations.length; index += 1) {
      const station = stations[index];
      console.log(`[refresh] Processing ${index + 1}/${stations.length}: ${station.name}`);

      try {
        const condition = await fetchNoaaPointCondition(station);
        const reading = successfulReading(station, condition);
        upsertStationReading(reading);
        updatedReadings.push(reading);
        successCount += 1;
        console.log(`[refresh] Success: ${station.name}`);
      } catch (error) {
        const reading = unavailableReading(station, error);
        upsertStationReading(reading);
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
      `Nightly station refresh completed: ${successCount} stations updated`,
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
  const count = getStationReadingCount();

  if (count > 0) {
    console.log(`[station-refresh] startup refresh skipped; ${count} cached readings found`);
    return;
  }

  console.log('[station-refresh] no cached readings found; starting initial refresh');
  startStationRefresh({ reason: 'startup-empty-db' });
}
