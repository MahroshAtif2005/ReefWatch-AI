import { Router } from 'express';
import { getRecentReefAssessmentTraces, getReefAssessmentTracesBetween } from '../db/database.js';

const router = Router();

function normalizeDate(date) {
  return String(date || new Date().toISOString().slice(0, 10)).slice(0, 10);
}

router.get('/reef-assessments', (req, res, next) => {
  try {
    const date = normalizeDate(req.query.date);
    const startIso = `${date}T00:00:00.000Z`;
    const endDate = new Date(startIso);
    endDate.setUTCDate(endDate.getUTCDate() + 1);
    const endIso = endDate.toISOString();
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    let traces = getReefAssessmentTracesBetween(startIso, endIso).slice(0, limit);
    let dateMatched = true;

    if (traces.length === 0) {
      traces = getRecentReefAssessmentTraces(limit);
      dateMatched = false;
    }

    res.json({
      date,
      source: 'node_local_traces',
      source_trace_count: traces.length,
      available_trace_types: [...new Set(traces.map((trace) => `${trace.sourceType || 'unknown-source'} | ${trace.traceType}`))],
      date_matched: dateMatched,
      traces,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
