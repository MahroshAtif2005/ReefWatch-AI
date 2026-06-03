import { upsertStationReading } from '../db/database.js';
import { fetchNoaaPointCondition } from './noaaService.js';
import { fetchVirtualStations, setEnrichedStationData } from './stationService.js';
import { logReefAssessmentTrace } from './arizeService.js';

const ENRICH_STARTUP_DELAY_MS = 8000;
const ENRICH_STATION_DELAY_MS = 350;
const ENRICH_BATCH_SIZE = 4;
const ENRICH_BATCH_PAUSE_MS = 1200;
const NOAA_TIMEOUT_MS = 12000;
const NOAA_RETRIES = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let enrichmentRunning = false;

async function enrichAllStations() {
  if (enrichmentRunning) return;
  enrichmentRunning = true;

  try {
    const stations = await fetchVirtualStations();
    console.log(`[station-enrichment] starting background NOAA fetch for ${stations.length} stations`);

    let success = 0;
    let skipped = 0;

    for (let i = 0; i < stations.length; i += ENRICH_BATCH_SIZE) {
      const batch = stations.slice(i, i + ENRICH_BATCH_SIZE);

      for (const station of batch) {
        try {
          const condition = await fetchNoaaPointCondition(station, {
            timeout: NOAA_TIMEOUT_MS,
            retries: NOAA_RETRIES,
            fast: false, // use all 12 snap offsets for background enrichment
          });

          const enriched = {
            seaSurfaceTemp: condition.seaSurfaceTemp,
            tempAnomaly: condition.tempAnomaly,
            degreeHeatingWeeks: condition.degreeHeatingWeeks,
            bleachingAlertLevel: condition.bleachingAlertLevel,
            riskScore: condition.riskScore,
            status: condition.status,
            source: condition.source,
            lastUpdated: condition.lastUpdated,
            stationId: station.id,
            type: 'station',
          };

          setEnrichedStationData(station.id, enriched);

          // Persist to DB so it survives Cloud Run container restarts
          upsertStationReading({
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
            source: condition.source,
            lastUpdated: condition.lastUpdated,
            error: null,
          });

          logReefAssessmentTrace({
            reefId: station.id,
            reefName: station.name,
            coordinates: { lat: station.lat, lng: station.lng },
            noaaInputData: {
              seaSurfaceTemp: condition.seaSurfaceTemp,
              tempAnomaly: condition.tempAnomaly,
              degreeHeatingWeeks: condition.degreeHeatingWeeks,
              bleachingAlertLevel: condition.bleachingAlertLevel,
            },
            aiRiskScore: condition.riskScore,
            aiConfidence: null,
            modelName: 'NOAA Coral Reef Watch 5km',
            status: condition.status,
            timestamp: condition.lastUpdated,
            source: condition.source,
          }).catch(() => {});

          success += 1;
        } catch {
          skipped += 1;
        }

        await sleep(ENRICH_STATION_DELAY_MS);
      }

      await sleep(ENRICH_BATCH_PAUSE_MS);
    }

    console.log(`[station-enrichment] complete: ${success} enriched, ${skipped} skipped`);
  } catch (error) {
    console.warn('[station-enrichment] enrichment run failed:', error.message);
  } finally {
    enrichmentRunning = false;
  }
}

export function startStationEnrichment() {
  setTimeout(() => {
    enrichAllStations().catch((error) => {
      console.warn('[station-enrichment] crashed:', error.message);
    });
  }, ENRICH_STARTUP_DELAY_MS);
}
