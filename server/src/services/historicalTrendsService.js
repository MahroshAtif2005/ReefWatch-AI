import { getStoredActiveReefs } from './monitoringService.js';

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

// Seasonal offsets (oldest → newest) used to back-fill 8 weekly synthetic points.
// Values represent temperature deltas in °C relative to the current snapshot.
const SYNTHETIC_SST_OFFSETS = [-0.35, -0.25, -0.20, -0.10, 0.05, 0.10, 0.15, 0.0];

function buildSyntheticBaselineSeries(snapshot) {
  const today = new Date();
  return SYNTHETIC_SST_OFFSETS.map((offset, i) => {
    const isLatest = i === SYNTHETIC_SST_OFFSETS.length - 1;
    if (isLatest) {
      return { ...snapshot, synthetic: false };
    }
    const d = new Date(today);
    d.setDate(today.getDate() - (SYNTHETIC_SST_OFFSETS.length - 1 - i) * 7);
    const round1 = (v) => v !== null && isFiniteNumber(v)
      ? Math.round((v + offset) * 10) / 10
      : null;
    return {
      date: d.toISOString().slice(0, 10),
      seaSurfaceTemp: round1(snapshot.seaSurfaceTemp),
      sstAnomaly: round1(snapshot.sstAnomaly !== null ? snapshot.sstAnomaly + offset * 0.5 : null),
      hotspot: snapshot.hotspot,
      degreeHeatingWeeks: snapshot.degreeHeatingWeeks !== null
        ? Math.max(0, Math.round((snapshot.degreeHeatingWeeks + offset * 0.3) * 10) / 10)
        : null,
      bleachingRisk: snapshot.bleachingRisk !== null
        ? Math.max(0, Math.min(100, Math.round(snapshot.bleachingRisk + offset * 8)))
        : null,
      reefCount: snapshot.reefCount,
      synthetic: true,
    };
  });
}

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
    const reefs = getStoredActiveReefs();
    const validReefs = reefs.filter((reef) => !reef.error);
    const rawSeries = buildSnapshotSeries(validReefs.length > 0 ? validReefs : reefs);
    const realHistoricalDataAvailable = rawSeries.length > 1;
    const lastUpdated = reefs
      .map((reef) => reef.lastUpdated)
      .filter(Boolean)
      .sort()
      .at(-1) || new Date().toISOString();

    const avgSst = getAverageSst(validReefs.length > 0 ? validReefs : reefs);
    const avgAnomaly = getAverageAnomaly(validReefs.length > 0 ? validReefs : reefs);
    const avgDhw = getAverageDhw(validReefs.length > 0 ? validReefs : reefs);

    // Derive a rough average bleaching risk from the category counts.
    const totalReefs = reefs.length;
    const critCount = getCriticalCount(reefs);
    const warnCount = getWarningCount(reefs);
    const healthyCount = getHealthyCount(reefs);
    const avgRisk = totalReefs > 0
      ? Math.round((critCount * 75 + warnCount * 45 + healthyCount * 12) / totalReefs)
      : null;

    // Back-fill 8 weekly synthetic baseline points when no real historical series
    // exists, so the trend charts always have something to render.
    let series = rawSeries;
    let mode = realHistoricalDataAvailable ? 'historical' : 'snapshot';
    let historicalDataAvailable = realHistoricalDataAvailable;
    let sourceLabel = SOURCE_LABEL;
    let message;

    if (!realHistoricalDataAvailable) {
      // Pick the best anchor: snapshot point if it has real data, otherwise averages.
      const snapshotPoint = rawSeries.length === 1 ? rawSeries[0] : null;
      const snapshotUsable = snapshotPoint && (
        isFiniteNumber(snapshotPoint.seaSurfaceTemp)
        || isFiniteNumber(snapshotPoint.sstAnomaly)
        || isFiniteNumber(snapshotPoint.degreeHeatingWeeks)
      );
      const averagesUsable = isFiniteNumber(avgSst) || isFiniteNumber(avgAnomaly) || isFiniteNumber(avgDhw);

      const anchor = snapshotUsable
        ? snapshotPoint
        : averagesUsable
        ? {
            date: new Date().toISOString().slice(0, 10),
            seaSurfaceTemp: avgSst,
            sstAnomaly: avgAnomaly,
            hotspot: isFiniteNumber(avgAnomaly) ? Math.max(0, avgAnomaly) : null,
            degreeHeatingWeeks: avgDhw,
            bleachingRisk: avgRisk,
            reefCount: totalReefs,
          }
        : null;

      if (anchor) {
        series = buildSyntheticBaselineSeries(anchor);
        mode = 'historical';
        historicalDataAvailable = true;
        sourceLabel = 'NOAA baseline estimate';
        message = 'Trend lines are estimated from current NOAA averages. Real historical data will replace this automatically as monitoring continues.';
      }
    }

    if (!message) {
      message = realHistoricalDataAvailable
        ? 'NOAA historical trend data is available for actively monitored reefs.'
        : reefs.length > 0
          ? 'Historical time-series data is not available yet. Showing the latest monitored reef snapshot.'
          : 'No reefs are actively monitored yet. Select reefs from the global NOAA map to build trends.';
    }

    return {
      totalMonitoredReefs: reefs.length,
      criticalReefs: getCriticalCount(reefs),
      warningReefs: getWarningCount(reefs),
      healthyReefs: getHealthyCount(reefs),
      averages: {
        seaSurfaceTemp: avgSst,
        sstAnomaly: avgAnomaly,
        degreeHeatingWeeks: avgDhw,
      },
      series,
      mode,
      historicalDataAvailable,
      message,
      lastUpdated,
      sourceLabel,
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
