import { getStoredActiveReefs } from './monitoringService.js';
import { fetchReefConditions } from './noaaService.js';

const SOURCE_LABEL = 'NOAA live data';

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const average = (values) => {
  const cleanValues = values.filter(isFiniteNumber);
  if (cleanValues.length === 0) return null;
  return Math.round((cleanValues.reduce((sum, value) => sum + value, 0) / cleanValues.length) * 100) / 100;
};

export function getReefRiskCategory(reef) {
  const alertLevel = String(reef.bleachingAlertLevel || '').toLowerCase();
  const dhw = reef.degreeHeatingWeeks;
  const riskScore = reef.riskScore;

  if (
    reef.status === 'critical'
    || alertLevel.includes('alert level 2')
    || (isFiniteNumber(dhw) && dhw >= 8)
    || (isFiniteNumber(riskScore) && riskScore >= 70)
  ) {
    return 'critical';
  }

  if (
    reef.status === 'warning'
    || alertLevel.includes('warning')
    || alertLevel.includes('watch')
    || alertLevel.includes('alert level 1')
    || (isFiniteNumber(dhw) && dhw >= 4)
    || (isFiniteNumber(riskScore) && riskScore >= 40)
  ) {
    return 'warning';
  }

  return 'safe';
}

export function getCriticalCount(reefs) {
  return reefs.filter((reef) => getReefRiskCategory(reef) === 'critical').length;
}

export function getWarningCount(reefs) {
  return reefs.filter((reef) => getReefRiskCategory(reef) === 'warning').length;
}

export function getHealthyCount(reefs) {
  return reefs.filter((reef) => getReefRiskCategory(reef) === 'safe').length;
}

export function getAverageSst(reefs) {
  return average(reefs.map((reef) => reef.seaSurfaceTemp));
}

export function getAverageAnomaly(reefs) {
  return average(reefs.map((reef) => reef.tempAnomaly));
}

export function getAverageDhw(reefs) {
  return average(reefs.map((reef) => reef.degreeHeatingWeeks));
}

const getRiskScore = (reef) => {
  if (isFiniteNumber(reef.riskScore)) return reef.riskScore;
  return getReefRiskCategory(reef) === 'critical' ? 80 : getReefRiskCategory(reef) === 'warning' ? 45 : 10;
};

const toDateKey = (value) => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return parsed.toISOString().slice(0, 10);
};

const buildSnapshotSeries = (reefs) => {
  const byDate = new Map();

  reefs.forEach((reef) => {
    const date = toDateKey(reef.lastUpdated);
    const current = byDate.get(date) || {
      date,
      seaSurfaceTemps: [],
      anomalies: [],
      dhws: [],
      risks: [],
      reefCount: 0,
    };

    current.seaSurfaceTemps.push(reef.seaSurfaceTemp);
    current.anomalies.push(reef.tempAnomaly);
    current.dhws.push(reef.degreeHeatingWeeks);
    current.risks.push(getRiskScore(reef));
    current.reefCount += 1;
    byDate.set(date, current);
  });

  return Array.from(byDate.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((entry) => ({
      date: entry.date,
      seaSurfaceTemp: average(entry.seaSurfaceTemps),
      sstAnomaly: average(entry.anomalies),
      hotspot: average(entry.anomalies.map((value) => (isFiniteNumber(value) ? Math.max(0, value) : null))),
      degreeHeatingWeeks: average(entry.dhws),
      bleachingRisk: average(entry.risks),
      reefCount: entry.reefCount,
    }));
};

export async function getHistoricalTrends() {
  try {
    const reefs = [
      ...await fetchReefConditions(),
      ...getStoredActiveReefs(),
    ];
    const validReefs = reefs.filter((reef) => !reef.error);
    const series = buildSnapshotSeries(validReefs.length > 0 ? validReefs : reefs);
    const historicalDataAvailable = series.length > 1;
    const mode = historicalDataAvailable ? 'historical' : 'snapshot';
    const lastUpdated = reefs
      .map((reef) => reef.lastUpdated)
      .filter(Boolean)
      .sort()
      .at(-1) || new Date().toISOString();

    return {
      totalMonitoredReefs: reefs.length,
      criticalReefs: getCriticalCount(reefs),
      warningReefs: getWarningCount(reefs),
      healthyReefs: getHealthyCount(reefs),
      averages: {
        seaSurfaceTemp: getAverageSst(validReefs),
        sstAnomaly: getAverageAnomaly(validReefs),
        degreeHeatingWeeks: getAverageDhw(validReefs),
      },
      series,
      mode,
      historicalDataAvailable,
      message: historicalDataAvailable
        ? 'NOAA historical trend data is available.'
        : 'Historical time-series data is not available yet. Showing latest NOAA snapshot.',
      lastUpdated,
      sourceLabel: SOURCE_LABEL,
      source: 'NOAA Coral Reef Watch 5km ERDDAP NOAA_DHW',
    };
  } catch (error) {
    return {
      totalMonitoredReefs: 0,
      criticalReefs: 0,
      warningReefs: 0,
      healthyReefs: 0,
      averages: {
        seaSurfaceTemp: null,
        sstAnomaly: null,
        degreeHeatingWeeks: null,
      },
      series: [],
      mode: 'snapshot',
      historicalDataAvailable: false,
      message: 'NOAA live data is unavailable. Historical trends cannot be calculated right now.',
      lastUpdated: new Date().toISOString(),
      sourceLabel: 'NOAA live data unavailable',
      source: 'NOAA Coral Reef Watch 5km ERDDAP NOAA_DHW',
      error: error.message,
    };
  }
}
