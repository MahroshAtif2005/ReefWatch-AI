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

const arizeTraceCountStatement = db.prepare('SELECT COUNT(*) AS count FROM arize_traces');
const lastArizeTraceStatement = db.prepare('SELECT timestamp FROM arize_traces ORDER BY timestamp DESC LIMIT 1');

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

export function getArizeTraceCount() {
  return arizeTraceCountStatement.get().count;
}

export function getLastArizeTraceTime() {
  return lastArizeTraceStatement.get()?.timestamp || null;
}
