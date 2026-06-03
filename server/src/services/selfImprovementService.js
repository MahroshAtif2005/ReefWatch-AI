import axios from 'axios';
import { getArizeTracesBetween, getRecentArizeTraces, insertAgentEvent } from '../db/database.js';
import {
  appendSelfImprovementRun,
  getLatestSelfImprovementRun,
  getPreviousSelfImprovementRun,
} from './selfImprovementStorage.js';
import { getStoredActiveReefs } from './monitoringService.js';

const aiServiceUrl = process.env.AI_SERVICE_URL || 'http://localhost:8000';

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function getDateWindow(dateString = getYesterdayDateString()) {
  const normalizedDate = String(dateString).slice(0, 10);
  const start = new Date(`${normalizedDate}T00:00:00.000Z`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return {
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    filterUsed: `timestamp >= ${start.toISOString()} AND timestamp < ${end.toISOString()} (UTC day)`,
  };
}

export function getYesterdayDateString(now = new Date()) {
  const yesterday = new Date(now);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return toIsoDate(yesterday);
}

function isReefAssessmentTrace(trace) {
  const source = String(trace.source || '').toLowerCase();
  const modelName = String(trace.modelName || '').toLowerCase();
  return Boolean(trace.reefName) && (
    source.includes('noaa')
    || source.includes('gemini')
    || modelName.includes('reef')
    || modelName.includes('noaa')
  );
}

function getTraceNoaaInput(trace) {
  const noaaInput = trace?.noaaInputData;
  if (typeof noaaInput === 'string') {
    try {
      return JSON.parse(noaaInput);
    } catch {
      return {};
    }
  }
  return noaaInput && typeof noaaInput === 'object' ? noaaInput : {};
}

function hasValidNoaaMetrics(trace) {
  const noaa = getTraceNoaaInput(trace);
  const source = String(trace?.source || noaa.source || '').toLowerCase();
  const status = String(trace?.status || '').toLowerCase();

  return (
    noaa.noaa_data_available !== false
    && noaa.noaaDataAvailable !== false
    && status !== 'unavailable'
    && !source.includes('unavailable')
    && !source.includes('fallback')
    && noaa.seaSurfaceTemp !== null
    && noaa.seaSurfaceTemp !== undefined
    && noaa.tempAnomaly !== null
    && noaa.tempAnomaly !== undefined
    && noaa.degreeHeatingWeeks !== null
    && noaa.degreeHeatingWeeks !== undefined
  );
}

function isValidReefAssessmentTrace(trace) {
  return isReefAssessmentTrace(trace) && hasValidNoaaMetrics(trace);
}

function filterToMonitoredTraces(traces) {
  const monitoredKeys = new Set(
    getStoredActiveReefs()
      .flatMap((reef) => [reef.id, reef.stationId, reef.name])
      .filter(Boolean)
      .map((value) => String(value).toLowerCase()),
  );

  if (monitoredKeys.size === 0) return [];

  return traces.filter((trace) => (
    monitoredKeys.has(String(trace.reefId || '').toLowerCase())
    || monitoredKeys.has(String(trace.reefName || '').toLowerCase())
  ));
}

function traceToAssessment(trace) {
  return {
    trace_id: trace.traceId,
    reef_name: trace.reefName,
    timestamp: trace.timestamp,
    input_data: {
      reef_id: trace.reefId,
      reef_name: trace.reefName,
      coordinates: trace.coordinates,
      noaa: getTraceNoaaInput(trace),
      status: trace.status,
      source: trace.source,
    },
    model_output: {
      risk_score: trace.aiRiskScore,
      confidence: trace.aiConfidence,
      summary: trace.aiSummary,
      model_name: trace.modelName,
      status: trace.status,
    },
  };
}

function getAvailableTraceTypes(traces) {
  return [...new Set(traces.map((trace) => {
    const source = trace.source || 'unknown-source';
    const model = trace.modelName || 'unknown-model';
    const status = trace.status || 'unknown-status';
    return `${source} | ${model} | ${status}`;
  }))];
}

function normalizeRunSummary(run) {
  const summary = run.summary || '';
  if (run.quota_limited && (run.average_score ?? 0) < 0.75 && !run.prompt_updated) {
    return 'Prompt update was needed but skipped because Gemini quota was exhausted.';
  }
  if ((run.average_score ?? 1) < 0.75 && !run.prompt_updated && summary.includes('quality met the threshold')) {
    return summary.replace(
      'The current prompt was kept because quality met the threshold or no safe rewrite was available.',
      'Prompt update was needed but no safe rewrite was available.',
    );
  }
  return summary;
}

export function getLatestSelfImprovementSummary() {
  const latest = getLatestSelfImprovementRun();
  if (!latest) {
    return {
      date: null,
      assessment_count: 0,
      average_score: null,
      accuracy: null,
      specificity: null,
      actionability: null,
      scientific_reliability: null,
      dhw_interpretation: null,
      dhw_interpretation_accuracy: null,
      uncertainty_communication: null,
      hallucination_avoidance: null,
      prompt_updated: false,
      quota_limited: false,
      issues: [],
      summary: 'No self-improvement run has completed yet.',
      before_after: {
        previous_score: null,
        latest_score: null,
      },
    };
  }

  const previous = getPreviousSelfImprovementRun();
  return {
    date: latest.date ?? null,
    assessment_count: latest.assessment_count ?? 0,
    average_score: latest.average_score ?? null,
    accuracy: latest.accuracy ?? null,
    specificity: latest.specificity ?? null,
    actionability: latest.actionability ?? null,
    scientific_reliability: latest.scientific_reliability ?? null,
    dhw_interpretation: latest.dhw_interpretation ?? latest.dhw_interpretation_accuracy ?? null,
    dhw_interpretation_accuracy: latest.dhw_interpretation_accuracy ?? latest.dhw_interpretation ?? null,
    uncertainty_communication: latest.uncertainty_communication ?? null,
    hallucination_avoidance: latest.hallucination_avoidance ?? null,
    prompt_updated: Boolean(latest.prompt_updated),
    quota_limited: Boolean(latest.quota_limited),
    issues: Array.isArray(latest.issues) ? latest.issues : [],
    summary: normalizeRunSummary(latest),
    prompt_change_summary: latest.prompt_change_summary ?? latest.gemini_improvement_summary ?? '',
    before_after: {
      previous_score: previous?.average_score ?? latest.before_after?.previous_score ?? null,
      latest_score: latest.average_score ?? latest.before_after?.latest_score ?? null,
    },
  };
}

function normalizeLimit(limit, fallback = null) {
  if (limit === undefined || limit === null || limit === '') return fallback;
  const parsed = Number(limit);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function emptyRun({ date, reason, debug, warning }) {
  return {
    date,
    assessment_count: 0,
    attempted_assessment_count: 0,
    average_score: null,
    accuracy: null,
    specificity: null,
    actionability: null,
    scientific_reliability: null,
    dhw_interpretation: null,
    dhw_interpretation_accuracy: null,
    uncertainty_communication: null,
    hallucination_avoidance: null,
    prompt_updated: false,
    quota_limited: false,
    issues: [],
    summary: warning || 'No reef assessment traces were found for the requested run.',
    reason,
    stored: false,
    before_after: {
      previous_score: getLatestSelfImprovementRun()?.average_score ?? null,
      latest_score: null,
    },
    ...debug,
  };
}

export async function runSelfImprovementLoop({
  date = getYesterdayDateString(),
  reason = 'manual',
  limit = null,
  demo = false,
  saveEmpty = false,
} = {}) {
  console.log(`[self-improvement] starting ${reason} run for ${date}`);
  const { startIso, endIso, filterUsed } = getDateWindow(date);
  const exactDateTraces = getArizeTracesBetween(startIso, endIso);
  let candidateTraces = exactDateTraces;
  let source = 'phoenix';
  let warning = null;

  console.log(`[self-improvement] date range ${startIso} -> ${endIso}`);
  console.log(`[self-improvement] Phoenix/local trace query result count=${exactDateTraces.length}`);

  let traces = filterToMonitoredTraces(candidateTraces.filter(isValidReefAssessmentTrace));
  console.log(`[self-improvement] reef assessment traces after filtering=${traces.length}`);

  if (traces.length === 0 && demo) {
    const today = getDateWindow(toIsoDate(new Date()));
    const todayTraces = getArizeTracesBetween(today.startIso, today.endIso);
    const todayReefTraces = filterToMonitoredTraces(todayTraces.filter(isValidReefAssessmentTrace));
    console.log(`[self-improvement] demo today fallback count=${todayReefTraces.length}`);

    if (todayReefTraces.length > 0) {
      candidateTraces = todayTraces;
      traces = todayReefTraces;
      source = 'local_fallback';
      warning = 'No exact-date traces found; using today’s reef assessments for demo.';
    }
  }

  if (traces.length === 0) {
    const recentTraces = getRecentArizeTraces(50);
    const recentReefTraces = filterToMonitoredTraces(recentTraces.filter(isValidReefAssessmentTrace));
    console.log(`[self-improvement] recent local fallback count=${recentReefTraces.length}`);

    if (recentReefTraces.length > 0) {
      candidateTraces = recentTraces;
      traces = recentReefTraces;
      source = 'local_fallback';
      warning = demo
        ? 'No exact-date traces found; using most recent reef assessments for demo.'
        : 'No exact-date traces found; using most recent local reef assessments.';
    }
  }

  const debug = {
    source: traces.length > 0 ? source : 'none',
    source_trace_count: traces.length,
    date_start: startIso,
    date_end: endIso,
    filter_used: filterUsed,
    available_trace_types: getAvailableTraceTypes(candidateTraces),
    ...(warning ? { warning } : {}),
  };

  const demoDefaultLimit = reason === 'manual-api' ? 10 : null;
  const effectiveLimit = normalizeLimit(limit, demoDefaultLimit);
  const selectedTraces = effectiveLimit ? traces.slice(0, effectiveLimit) : traces;
  const assessments = selectedTraces.map(traceToAssessment);

  console.log(`[self-improvement] fallback/source=${debug.source}; fallback result count=${traces.length}; judging=${assessments.length}; limit=${effectiveLimit ?? 'none'}`);

  if (assessments.length === 0 && !saveEmpty) {
    console.log('[self-improvement] empty run not saved; pass save_empty=true to persist');
    const latest = getLatestSelfImprovementRun();
    const cachedScores = latest && typeof latest.average_score === 'number' ? {
      average_score: latest.average_score,
      accuracy: latest.accuracy ?? null,
      specificity: latest.specificity ?? null,
      actionability: latest.actionability ?? null,
      scientific_reliability: latest.scientific_reliability ?? null,
      dhw_interpretation: latest.dhw_interpretation ?? latest.dhw_interpretation_accuracy ?? null,
      dhw_interpretation_accuracy: latest.dhw_interpretation_accuracy ?? latest.dhw_interpretation ?? null,
      uncertainty_communication: latest.uncertainty_communication ?? null,
      hallucination_avoidance: latest.hallucination_avoidance ?? null,
      issues: Array.isArray(latest.issues) ? latest.issues : [],
      cached_from: latest.date,
      cached: true,
    } : {};
    return {
      ...emptyRun({
        date,
        reason,
        debug,
        warning: warning || 'No reef assessment traces were found for the requested date or local fallback.',
      }),
      status: 'no_traces',
      ...cachedScores,
    };
  }

  const response = await axios.post(`${aiServiceUrl}/self-improvement/run`, {
    date,
    assessments,
    limit: effectiveLimit,
  }, {
    timeout: 300000,
  });

  const previous = getLatestSelfImprovementRun();
  const run = {
    ...response.data,
    reason,
    ...debug,
    limited_to: effectiveLimit,
    stored_at: new Date().toISOString(),
    previous_score: previous?.average_score ?? null,
    quality_score: response.data.average_score ?? null,
    dhw_interpretation: response.data.dhw_interpretation ?? response.data.dhw_interpretation_accuracy ?? null,
    prompt_change_summary: response.data.gemini_improvement_summary ?? '',
    before_after: {
      previous_score: previous?.average_score ?? null,
      latest_score: response.data.average_score ?? null,
    },
  };
  run.summary = normalizeRunSummary(run);

  if (run.assessment_count > 0 || saveEmpty) {
    appendSelfImprovementRun(run);
    insertAgentEvent(
      'self_improvement_loop',
      run.summary || `Self-improvement loop completed for ${date}`,
      null,
      JSON.stringify({
        date,
        assessment_count: run.assessment_count,
        average_score: run.average_score,
        prompt_updated: run.prompt_updated,
        quota_limited: run.quota_limited,
        source: run.source,
      }),
    );
  }

  console.log(`[self-improvement] completed ${date}: score=${run.average_score}, prompt_updated=${run.prompt_updated}`);
  return run;
}
