import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.resolve(__dirname, '../../reefwatch.db');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS station_readings (
    station_id TEXT PRIMARY KEY,
    name TEXT,
    lat REAL,
    lng REAL,
    sea_surface_temp REAL,
    temp_anomaly REAL,
    degree_heating_weeks REAL,
    bleaching_alert_level TEXT,
    risk_score INTEGER,
    status TEXT,
    source TEXT,
    last_updated TEXT,
    error TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS arize_traces (
    trace_id TEXT PRIMARY KEY,
    reef_id TEXT,
    reef_name TEXT,
    lat REAL,
    lng REAL,
    noaa_input_data TEXT,
    ai_risk_score INTEGER,
    ai_confidence REAL,
    ai_summary TEXT,
    model_name TEXT,
    status TEXT,
    timestamp TEXT,
    source TEXT,
    arize_status TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS active_monitored_reefs (
    id TEXT PRIMARY KEY,
    station_id TEXT,
    name TEXT,
    region TEXT,
    country TEXT,
    lat REAL,
    lng REAL,
    sea_surface_temp REAL,
    temp_anomaly REAL,
    degree_heating_weeks REAL,
    bleaching_alert_level TEXT,
    risk_score INTEGER,
    status TEXT,
    last_updated TEXT,
    source TEXT,
    error TEXT,
    ai_analysis TEXT,
    ai_confidence REAL,
    created_at TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT,
    description TEXT,
    reef_name TEXT,
    metadata TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS self_improvement_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_date TEXT,
    quality_score REAL,
    accuracy REAL,
    specificity REAL,
    actionability REAL,
    scientific_reliability REAL,
    dhw_interpretation REAL,
    uncertainty_communication REAL,
    hallucination_avoidance REAL,
    main_weaknesses TEXT,
    prompt_updated INTEGER,
    previous_score REAL,
    assessment_count INTEGER,
    quota_limited INTEGER,
    summary TEXT,
    research_narrative TEXT,
    prompt_change_summary TEXT,
    raw_run TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

try {
  db.exec(`
    INSERT OR IGNORE INTO settings (key, value, updated_at)
    SELECT key, COALESCE(value, ''), COALESCE(updated_at, datetime('now'))
    FROM app_settings
    WHERE value IS NOT NULL
  `);
} catch {
  // Older installs may not have the temporary app_settings table.
}

const upsertStationReadingStatement = db.prepare(`
  INSERT INTO station_readings (
    station_id,
    name,
    lat,
    lng,
    sea_surface_temp,
    temp_anomaly,
    degree_heating_weeks,
    bleaching_alert_level,
    risk_score,
    status,
    source,
    last_updated,
    error
  )
  VALUES (
    @station_id,
    @name,
    @lat,
    @lng,
    @sea_surface_temp,
    @temp_anomaly,
    @degree_heating_weeks,
    @bleaching_alert_level,
    @risk_score,
    @status,
    @source,
    @last_updated,
    @error
  )
  ON CONFLICT(station_id) DO UPDATE SET
    name = excluded.name,
    lat = excluded.lat,
    lng = excluded.lng,
    sea_surface_temp = excluded.sea_surface_temp,
    temp_anomaly = excluded.temp_anomaly,
    degree_heating_weeks = excluded.degree_heating_weeks,
    bleaching_alert_level = excluded.bleaching_alert_level,
    risk_score = excluded.risk_score,
    status = excluded.status,
    source = excluded.source,
    last_updated = excluded.last_updated,
    error = excluded.error
`);

const getStationReadingsStatement = db.prepare(`
  SELECT
    station_id,
    name,
    lat,
    lng,
    sea_surface_temp,
    temp_anomaly,
    degree_heating_weeks,
    bleaching_alert_level,
    risk_score,
    status,
    source,
    last_updated,
    error
  FROM station_readings
  ORDER BY name ASC
`);

const stationReadingCountStatement = db.prepare('SELECT COUNT(*) AS count FROM station_readings');

const insertArizeTraceStatement = db.prepare(`
  INSERT INTO arize_traces (
    trace_id,
    reef_id,
    reef_name,
    lat,
    lng,
    noaa_input_data,
    ai_risk_score,
    ai_confidence,
    ai_summary,
    model_name,
    status,
    timestamp,
    source,
    arize_status
  )
  VALUES (
    @trace_id,
    @reef_id,
    @reef_name,
    @lat,
    @lng,
    @noaa_input_data,
    @ai_risk_score,
    @ai_confidence,
    @ai_summary,
    @model_name,
    @status,
    @timestamp,
    @source,
    @arize_status
  )
`);

const getRecentArizeTracesStatement = db.prepare(`
  SELECT
    trace_id,
    reef_id,
    reef_name,
    lat,
    lng,
    noaa_input_data,
    ai_risk_score,
    ai_confidence,
    ai_summary,
    model_name,
    status,
    timestamp,
    source,
    arize_status
  FROM arize_traces
  ORDER BY timestamp DESC
  LIMIT ?
`);

const getArizeTracesBetweenStatement = db.prepare(`
  SELECT
    trace_id,
    reef_id,
    reef_name,
    lat,
    lng,
    noaa_input_data,
    ai_risk_score,
    ai_confidence,
    ai_summary,
    model_name,
    status,
    timestamp,
    source,
    arize_status
  FROM arize_traces
  WHERE timestamp >= ? AND timestamp < ?
  ORDER BY timestamp ASC
`);

const arizeTraceCountStatement = db.prepare('SELECT COUNT(*) AS count FROM arize_traces');
const lastArizeTraceStatement = db.prepare('SELECT timestamp FROM arize_traces ORDER BY timestamp DESC LIMIT 1');
const lastArizeTraceForReefStatement = db.prepare(`
  SELECT timestamp
  FROM arize_traces
  WHERE reef_id = ? OR reef_name = ?
  ORDER BY timestamp DESC
  LIMIT 1
`);

const upsertActiveMonitoredReefStatement = db.prepare(`
  INSERT INTO active_monitored_reefs (
    id,
    station_id,
    name,
    region,
    country,
    lat,
    lng,
    sea_surface_temp,
    temp_anomaly,
    degree_heating_weeks,
    bleaching_alert_level,
    risk_score,
    status,
    last_updated,
    source,
    error,
    ai_analysis,
    ai_confidence,
    created_at
  )
  VALUES (
    @id,
    @station_id,
    @name,
    @region,
    @country,
    @lat,
    @lng,
    @sea_surface_temp,
    @temp_anomaly,
    @degree_heating_weeks,
    @bleaching_alert_level,
    @risk_score,
    @status,
    @last_updated,
    @source,
    @error,
    @ai_analysis,
    @ai_confidence,
    @created_at
  )
  ON CONFLICT(id) DO UPDATE SET
    station_id = excluded.station_id,
    name = excluded.name,
    region = excluded.region,
    country = excluded.country,
    lat = excluded.lat,
    lng = excluded.lng,
    sea_surface_temp = excluded.sea_surface_temp,
    temp_anomaly = excluded.temp_anomaly,
    degree_heating_weeks = excluded.degree_heating_weeks,
    bleaching_alert_level = excluded.bleaching_alert_level,
    risk_score = excluded.risk_score,
    status = excluded.status,
    last_updated = excluded.last_updated,
    source = excluded.source,
    error = excluded.error,
    ai_analysis = excluded.ai_analysis,
    ai_confidence = excluded.ai_confidence
`);

const getActiveMonitoredReefsStatement = db.prepare(`
  SELECT
    id,
    station_id,
    name,
    region,
    country,
    lat,
    lng,
    sea_surface_temp,
    temp_anomaly,
    degree_heating_weeks,
    bleaching_alert_level,
    risk_score,
    status,
    last_updated,
    source,
    error,
    ai_analysis,
    ai_confidence,
    created_at
  FROM active_monitored_reefs
  ORDER BY created_at ASC
`);

const activeMonitoredReefCountStatement = db.prepare('SELECT COUNT(*) AS count FROM active_monitored_reefs');
const deleteActiveMonitoredReefStatement = db.prepare('DELETE FROM active_monitored_reefs WHERE id = ? OR station_id = ?');

const insertAgentEventStatement = db.prepare(`
  INSERT INTO agent_events (
    event_type,
    description,
    reef_name,
    metadata
  )
  VALUES (?, ?, ?, ?)
`);

const insertAgentEventWithTimestampStatement = db.prepare(`
  INSERT INTO agent_events (
    event_type,
    description,
    reef_name,
    metadata,
    timestamp
  )
  VALUES (?, ?, ?, ?, ?)
`);

const getRecentAgentEventsStatement = db.prepare(`
  SELECT
    id,
    event_type,
    description,
    reef_name,
    timestamp
  FROM agent_events
  ORDER BY timestamp DESC
  LIMIT ?
`);

const getSettingStatement = db.prepare('SELECT value FROM settings WHERE key = ?');
const getAllSettingsStatement = db.prepare('SELECT key, value FROM settings ORDER BY key ASC');
const upsertSettingStatement = db.prepare(`
  INSERT INTO settings (
    key,
    value,
    updated_at
  )
  VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET
    value = excluded.value,
    updated_at = excluded.updated_at
`);

const insertSelfImprovementRunStatement = db.prepare(`
  INSERT INTO self_improvement_runs (
    run_date,
    quality_score,
    accuracy,
    specificity,
    actionability,
    scientific_reliability,
    dhw_interpretation,
    uncertainty_communication,
    hallucination_avoidance,
    main_weaknesses,
    prompt_updated,
    previous_score,
    assessment_count,
    quota_limited,
    summary,
    research_narrative,
    prompt_change_summary,
    raw_run,
    created_at
  )
  VALUES (
    @run_date,
    @quality_score,
    @accuracy,
    @specificity,
    @actionability,
    @scientific_reliability,
    @dhw_interpretation,
    @uncertainty_communication,
    @hallucination_avoidance,
    @main_weaknesses,
    @prompt_updated,
    @previous_score,
    @assessment_count,
    @quota_limited,
    @summary,
    @research_narrative,
    @prompt_change_summary,
    @raw_run,
    @created_at
  )
`);

const getLatestSelfImprovementRunStatement = db.prepare(`
  SELECT *
  FROM self_improvement_runs
  ORDER BY datetime(created_at) DESC, id DESC
  LIMIT 1
`);

const getSelfImprovementRunsStatement = db.prepare(`
  SELECT *
  FROM self_improvement_runs
  ORDER BY datetime(created_at) DESC, id DESC
  LIMIT ?
`);

const getSelfImprovementRunsForHistoryStatement = db.prepare(`
  SELECT *
  FROM self_improvement_runs
  ORDER BY run_date ASC, id ASC
  LIMIT ?
`);

const selfImprovementRunCountStatement = db.prepare(`
  SELECT COUNT(*) AS count
  FROM self_improvement_runs
`);

const toApiReading = (row) => ({
  id: row.station_id,
  stationId: row.station_id,
  name: row.name,
  lat: row.lat,
  lng: row.lng,
  type: 'station',
  seaSurfaceTemp: row.sea_surface_temp,
  tempAnomaly: row.temp_anomaly,
  degreeHeatingWeeks: row.degree_heating_weeks,
  bleachingAlertLevel: row.bleaching_alert_level,
  riskScore: row.risk_score,
  status: row.status,
  noaa_data_available: row.status !== 'unavailable',
  noaaDataAvailable: row.status !== 'unavailable',
  source: row.source,
  lastUpdated: row.last_updated,
  error: row.error,
});

export function upsertStationReading(reading) {
  upsertStationReadingStatement.run({
    station_id: reading.stationId,
    name: reading.name,
    lat: reading.lat,
    lng: reading.lng,
    sea_surface_temp: reading.seaSurfaceTemp,
    temp_anomaly: reading.tempAnomaly,
    degree_heating_weeks: reading.degreeHeatingWeeks,
    bleaching_alert_level: reading.bleachingAlertLevel,
    risk_score: reading.riskScore,
    status: reading.status,
    source: reading.source,
    last_updated: reading.lastUpdated,
    error: reading.error || null,
  });
}

export function getStationReadings() {
  return getStationReadingsStatement.all().map(toApiReading);
}

export function getStationReadingCount() {
  return stationReadingCountStatement.get().count;
}

const isReefAssessmentTrace = (trace) => {
  const source = String(trace.source || '').toLowerCase();
  const modelName = String(trace.modelName || '').toLowerCase();
  const status = String(trace.status || '').toLowerCase();
  if (source.includes('fallback') || source.includes('unavailable') || status === 'unavailable') return false;
  return Boolean(trace.reefName) && (
    source.includes('noaa')
    || source.includes('gemini')
    || modelName.includes('reef')
    || modelName.includes('noaa')
  );
};

const toApiTrace = (row) => ({
  traceId: row.trace_id,
  reefId: row.reef_id,
  reefName: row.reef_name,
  coordinates: {
    lat: row.lat,
    lng: row.lng,
  },
  noaaInputData: JSON.parse(row.noaa_input_data || '{}'),
  aiRiskScore: row.ai_risk_score,
  aiConfidence: row.ai_confidence,
  aiSummary: row.ai_summary,
  modelName: row.model_name,
  status: row.status,
  timestamp: row.timestamp,
  source: row.source,
  arizeStatus: row.arize_status,
});

const toReefAssessmentTrace = (trace) => ({
  traceId: trace.traceId,
  reefName: trace.reefName,
  reefId: trace.reefId,
  timestamp: trace.timestamp,
  metrics: {
    coordinates: trace.coordinates,
    seaSurfaceTemp: trace.noaaInputData?.seaSurfaceTemp ?? null,
    tempAnomaly: trace.noaaInputData?.tempAnomaly ?? null,
    degreeHeatingWeeks: trace.noaaInputData?.degreeHeatingWeeks ?? null,
    bleachingAlertLevel: trace.noaaInputData?.bleachingAlertLevel ?? null,
  },
  assessment: {
    riskScore: trace.aiRiskScore,
    confidence: trace.aiConfidence,
    summary: trace.aiSummary,
    modelName: trace.modelName,
    status: trace.status,
  },
  riskLevel: trace.status,
  sourceType: trace.source,
  traceType: 'reef_assessment',
});

const toApiActiveMonitoredReef = (row) => ({
  id: row.id,
  stationId: row.station_id,
  name: row.name,
  region: row.region,
  country: row.country,
  lat: row.lat,
  lng: row.lng,
  seaSurfaceTemp: row.sea_surface_temp,
  tempAnomaly: row.temp_anomaly,
  degreeHeatingWeeks: row.degree_heating_weeks,
  bleachingAlertLevel: row.bleaching_alert_level,
  riskScore: row.risk_score,
  status: row.status,
  noaa_data_available: row.status !== 'unavailable',
  noaaDataAvailable: row.status !== 'unavailable',
  lastUpdated: row.last_updated,
  source: row.source,
  error: row.error,
  aiAnalysis: row.ai_analysis,
  confidence: row.ai_confidence,
  isCustomMonitored: true,
});

export function insertArizeTrace(trace) {
  insertArizeTraceStatement.run({
    trace_id: trace.traceId,
    reef_id: trace.reefId,
    reef_name: trace.reefName,
    lat: trace.coordinates?.lat ?? null,
    lng: trace.coordinates?.lng ?? null,
    noaa_input_data: JSON.stringify(trace.noaaInputData || {}),
    ai_risk_score: trace.aiRiskScore,
    ai_confidence: trace.aiConfidence,
    ai_summary: trace.aiSummary,
    model_name: trace.modelName,
    status: trace.status,
    timestamp: trace.timestamp,
    source: trace.source,
    arize_status: trace.arizeStatus,
  });
}

export function getRecentArizeTraces(limit = 25) {
  return getRecentArizeTracesStatement.all(limit).map(toApiTrace);
}

export function getArizeTracesBetween(startIso, endIso) {
  return getArizeTracesBetweenStatement.all(startIso, endIso).map(toApiTrace);
}

export function getReefAssessmentTracesBetween(startIso, endIso) {
  return getArizeTracesBetween(startIso, endIso)
    .filter(isReefAssessmentTrace)
    .map(toReefAssessmentTrace);
}

export function getRecentReefAssessmentTraces(limit = 25) {
  return getRecentArizeTraces(Math.max(limit * 10, 500))
    .filter(isReefAssessmentTrace)
    .slice(0, limit)
    .map(toReefAssessmentTrace);
}

export function getArizeTraceCount() {
  return arizeTraceCountStatement.get().count;
}

export function getLastArizeTraceTime() {
  return lastArizeTraceStatement.get()?.timestamp || null;
}

export function getLastArizeTraceTimeForReef(reefId, reefName) {
  return lastArizeTraceForReefStatement.get(reefId, reefName)?.timestamp || null;
}

export function upsertActiveMonitoredReef(reef) {
  upsertActiveMonitoredReefStatement.run({
    id: reef.id,
    station_id: reef.stationId || reef.id,
    name: reef.name,
    region: reef.region || 'NOAA Virtual Station',
    country: reef.country || 'NOAA Virtual Station',
    lat: reef.lat,
    lng: reef.lng,
    sea_surface_temp: reef.seaSurfaceTemp,
    temp_anomaly: reef.tempAnomaly,
    degree_heating_weeks: reef.degreeHeatingWeeks,
    bleaching_alert_level: reef.bleachingAlertLevel,
    risk_score: reef.riskScore,
    status: reef.status,
    last_updated: reef.lastUpdated,
    source: reef.source,
    error: reef.error || null,
    ai_analysis: reef.aiAnalysis || null,
    ai_confidence: reef.confidence ?? null,
    created_at: reef.createdAt || new Date().toISOString(),
  });
}

export function getActiveMonitoredReefs() {
  return getActiveMonitoredReefsStatement.all().map(toApiActiveMonitoredReef);
}

export function getActiveMonitoredReefCount() {
  return activeMonitoredReefCountStatement.get().count;
}

export function deleteActiveMonitoredReef(id) {
  return deleteActiveMonitoredReefStatement.run(id, id).changes;
}

export function insertAgentEvent(type, description, reefName = null, metadata = null, timestamp = null) {
  try {
    if (timestamp) {
      insertAgentEventWithTimestampStatement.run(type, description, reefName, metadata, timestamp);
    } else {
      insertAgentEventStatement.run(type, description, reefName, metadata);
    }
  } catch (error) {
    console.warn('[agent-events] insert failed', error.message);
  }
}

export function getRecentAgentEvents(limit = 50) {
  return getRecentAgentEventsStatement.all(limit).map((row) => ({
    id: row.id,
    event_type: row.event_type,
    description: row.description,
    reef_name: row.reef_name,
    timestamp: row.timestamp,
  }));
}

export async function getSetting(key) {
  return getSettingStatement.get(key)?.value || null;
}

export async function setSetting(key, value) {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) {
    const error = new Error('Setting key is required.');
    error.statusCode = 400;
    throw error;
  }

  const normalizedValue = String(value ?? '');
  upsertSettingStatement.run(normalizedKey, normalizedValue, new Date().toISOString());
  return normalizedValue;
}

export async function getAllSettings() {
  return getAllSettingsStatement.all().reduce((settings, row) => ({
    ...settings,
    [row.key]: row.value,
  }), {});
}

function toApiSelfImprovementRun(row) {
  if (!row) return null;
  let rawRun = {};
  try {
    rawRun = JSON.parse(row.raw_run || '{}');
  } catch {
    rawRun = {};
  }

  let issues = [];
  try {
    issues = JSON.parse(row.main_weaknesses || '[]');
  } catch {
    issues = [];
  }

  return {
    ...rawRun,
    id: row.id,
    date: row.run_date,
    run_date: row.run_date,
    average_score: row.quality_score,
    quality_score: row.quality_score,
    accuracy: row.accuracy,
    specificity: row.specificity,
    actionability: row.actionability,
    scientific_reliability: row.scientific_reliability,
    dhw_interpretation: row.dhw_interpretation,
    dhw_interpretation_accuracy: row.dhw_interpretation,
    uncertainty_communication: row.uncertainty_communication,
    hallucination_avoidance: row.hallucination_avoidance,
    issues,
    main_weaknesses: issues,
    prompt_updated: Boolean(row.prompt_updated),
    previous_score: row.previous_score,
    assessment_count: row.assessment_count ?? rawRun.assessment_count ?? 0,
    quota_limited: Boolean(row.quota_limited),
    summary: row.summary || rawRun.summary || '',
    research_narrative: row.research_narrative || rawRun.research_narrative || '',
    prompt_change_summary: row.prompt_change_summary || rawRun.gemini_improvement_summary || '',
    created_at: row.created_at,
    stored_at: rawRun.stored_at || row.created_at,
    before_after: rawRun.before_after || {
      previous_score: row.previous_score,
      latest_score: row.quality_score,
    },
  };
}

export function insertSelfImprovementRun(run) {
  const issues = Array.isArray(run.issues)
    ? run.issues
    : Array.isArray(run.main_weaknesses)
      ? run.main_weaknesses
      : [];
  const previousScore = run.previous_score ?? run.before_after?.previous_score ?? null;
  const createdAt = run.stored_at || run.completed_at || new Date().toISOString();

  insertSelfImprovementRunStatement.run({
    run_date: run.date ?? run.run_date ?? null,
    quality_score: run.average_score ?? run.quality_score ?? null,
    accuracy: run.accuracy ?? null,
    specificity: run.specificity ?? null,
    actionability: run.actionability ?? null,
    scientific_reliability: run.scientific_reliability ?? null,
    dhw_interpretation: run.dhw_interpretation ?? run.dhw_interpretation_accuracy ?? null,
    uncertainty_communication: run.uncertainty_communication ?? null,
    hallucination_avoidance: run.hallucination_avoidance ?? null,
    main_weaknesses: JSON.stringify(issues),
    prompt_updated: run.prompt_updated ? 1 : 0,
    previous_score: previousScore,
    assessment_count: run.assessment_count ?? 0,
    quota_limited: run.quota_limited ? 1 : 0,
    summary: run.summary ?? '',
    research_narrative: run.research_narrative ?? '',
    prompt_change_summary: run.prompt_change_summary ?? run.gemini_improvement_summary ?? '',
    raw_run: JSON.stringify(run),
    created_at: createdAt,
  });
}

export function getLatestSelfImprovementRunFromDb() {
  return toApiSelfImprovementRun(getLatestSelfImprovementRunStatement.get());
}

export function getSelfImprovementRunsFromDb(limit = 30) {
  return getSelfImprovementRunsStatement.all(limit).map(toApiSelfImprovementRun);
}

export function getSelfImprovementRunsForHistoryFromDb(limit = 14) {
  return getSelfImprovementRunsForHistoryStatement.all(limit).map(toApiSelfImprovementRun);
}

export function getSelfImprovementRunCountFromDb() {
  return selfImprovementRunCountStatement.get().count;
}
