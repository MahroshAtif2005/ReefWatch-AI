import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getLatestSelfImprovementRunFromDb,
  getSelfImprovementRunCountFromDb,
  getSelfImprovementRunsForHistoryFromDb,
  getSelfImprovementRunsFromDb,
  insertSelfImprovementRun,
} from '../db/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.resolve(__dirname, '../../../data');
const runsPath = path.join(dataDir, 'self_improvement_runs.json');

function ensureDataFile() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(runsPath)) {
    fs.writeFileSync(runsPath, '[]\n');
  }
}

export function readSelfImprovementRuns() {
  ensureDataFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(runsPath, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn('[self-improvement] unable to read local run history', error.message);
    return [];
  }
}

export function appendSelfImprovementRun(run) {
  const runs = readSelfImprovementRuns();
  runs.push(run);
  fs.writeFileSync(runsPath, `${JSON.stringify(runs, null, 2)}\n`);
  try {
    insertSelfImprovementRun(run);
  } catch (error) {
    console.warn('[self-improvement] unable to write SQLite run history', error.message);
  }
  return run;
}

export function getLatestSelfImprovementRun() {
  const dbRun = getLatestSelfImprovementRunFromDb();
  if (dbRun) return dbRun;

  const runs = readSelfImprovementRuns();
  return [...runs].sort((a, b) => {
    const aTime = new Date(a.stored_at || a.completed_at || a.date || 0).getTime();
    const bTime = new Date(b.stored_at || b.completed_at || b.date || 0).getTime();
    return bTime - aTime;
  })[0] || null;
}

export function getPreviousSelfImprovementRun() {
  const dbRuns = getSelfImprovementRunsFromDb(2);
  if (dbRuns.length > 1) return dbRuns[1];

  const runs = readSelfImprovementRuns();
  const sorted = [...runs].sort((a, b) => {
    const aTime = new Date(a.stored_at || a.completed_at || a.date || 0).getTime();
    const bTime = new Date(b.stored_at || b.completed_at || b.date || 0).getTime();
    return bTime - aTime;
  });
  return sorted[1] || null;
}

export function getRunHistory(limit = 30) {
  const dbRuns = getSelfImprovementRunsForHistoryFromDb(limit);
  if (dbRuns.length) {
    return dbRuns.map((run) => ({
      id: run.id,
      date: run.date ?? null,
      run_date: run.run_date ?? run.date ?? null,
      average_score: run.average_score ?? null,
      quality_score: run.quality_score ?? run.average_score ?? null,
      accuracy: run.accuracy ?? null,
      specificity: run.specificity ?? null,
      actionability: run.actionability ?? null,
      assessment_count: run.assessment_count ?? 0,
      prompt_updated: Boolean(run.prompt_updated),
      quota_limited: Boolean(run.quota_limited),
      issues: Array.isArray(run.issues) ? run.issues : [],
      summary: run.summary ?? '',
      research_narrative: run.research_narrative ?? '',
      scientific_reliability: run.scientific_reliability ?? null,
      uncertainty_communication: run.uncertainty_communication ?? null,
      dhw_interpretation: run.dhw_interpretation ?? run.dhw_interpretation_accuracy ?? null,
      dhw_interpretation_accuracy: run.dhw_interpretation_accuracy ?? run.dhw_interpretation ?? null,
      hallucination_avoidance: run.hallucination_avoidance ?? null,
    }));
  }

  const runs = readSelfImprovementRuns();
  return [...runs]
    .sort((a, b) => {
      const aTime = new Date(a.stored_at || a.completed_at || a.date || 0).getTime();
      const bTime = new Date(b.stored_at || b.completed_at || b.date || 0).getTime();
      return aTime - bTime;
    })
    .slice(0, limit)
    .map((run) => ({
      date: run.date ?? null,
      run_date: run.run_date ?? run.date ?? null,
      average_score: run.average_score ?? null,
      quality_score: run.quality_score ?? run.average_score ?? null,
      accuracy: run.accuracy ?? null,
      specificity: run.specificity ?? null,
      actionability: run.actionability ?? null,
      assessment_count: run.assessment_count ?? 0,
      prompt_updated: Boolean(run.prompt_updated),
      quota_limited: Boolean(run.quota_limited),
      issues: Array.isArray(run.issues) ? run.issues : [],
      summary: run.summary ?? '',
      research_narrative: run.research_narrative ?? '',
      scientific_reliability: run.scientific_reliability ?? null,
      uncertainty_communication: run.uncertainty_communication ?? null,
      dhw_interpretation: run.dhw_interpretation ?? run.dhw_interpretation_accuracy ?? null,
      dhw_interpretation_accuracy: run.dhw_interpretation_accuracy ?? null,
      hallucination_avoidance: run.hallucination_avoidance ?? null,
    }));
}

export function getRunCount() {
  const dbCount = getSelfImprovementRunCountFromDb();
  if (dbCount > 0) return dbCount;
  return readSelfImprovementRuns().length;
}

export function computeSevenDayAverage() {
  const history = getRunHistory(7);
  const scored = history.filter((r) => typeof r.average_score === 'number');
  if (!scored.length) return null;
  return Number(
    (scored.reduce((sum, r) => sum + r.average_score, 0) / scored.length).toFixed(3),
  );
}
