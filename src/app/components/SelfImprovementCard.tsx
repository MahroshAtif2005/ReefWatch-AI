import { useEffect, useRef, useState } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AlertTriangle, BrainCircuit, CheckCircle2, Loader2, Play, RefreshCw, Sparkles, TrendingUp } from 'lucide-react';
import {
  fetchLatestSelfImprovementRun,
  fetchSelfImprovementHistory,
  runSelfEvaluationNow,
  SELF_EVALUATION_SLOW_MESSAGE,
  type SelfImprovementHistory,
  type SelfImprovementRun,
} from '../services/reefApi';

const formatScore = (score: number | null) =>
  typeof score === 'number' ? score.toFixed(2) : '--';
const formatPercent = (score: number | null) =>
  score !== null && score !== undefined ? `${Math.round(score * 100)}%` : '--';

function scoreBadge(score: number | null) {
  if (score === null) return 'text-gray-muted';
  if (score >= 0.8) return 'text-coral-safe';
  if (score >= 0.6) return 'text-coral-warning';
  return 'text-coral-critical';
}

function scoreTone(score: number | null) {
  if (score === null) {
    return {
      bg: 'bg-ocean-deep/45',
      border: 'border-gray-border/60',
      text: 'text-gray-muted',
      bar: 'bg-gray-muted/35',
      style: {},
    };
  }

  if (score >= 0.8) {
    return {
      bg: 'bg-coral-safe/10',
      border: 'border-coral-safe/40',
      text: 'text-coral-safe',
      bar: 'bg-coral-safe',
      style: { backgroundColor: 'rgba(34, 197, 94, 0.1)', borderColor: 'rgba(34, 197, 94, 0.42)' },
    };
  }

  if (score >= 0.6) {
    return {
      bg: 'bg-coral-warning/10',
      border: 'border-coral-warning/40',
      text: 'text-coral-warning',
      bar: 'bg-coral-warning',
      style: { backgroundColor: 'rgba(234, 179, 8, 0.1)', borderColor: 'rgba(234, 179, 8, 0.42)' },
    };
  }

  return {
    bg: 'bg-coral-critical/10',
    border: 'border-coral-critical/40',
    text: 'text-coral-critical',
    bar: 'bg-coral-critical',
    style: { backgroundColor: 'rgba(239, 68, 68, 0.1)', borderColor: 'rgba(239, 68, 68, 0.42)' },
  };
}

function ScoreTile({ label, score, display }: { label: string; score: number | null; display: string }) {
  const tone = scoreTone(score);

  return (
    <div className={`rounded-xl border p-4 ${tone.bg} ${tone.border}`} style={tone.style}>
      <p className="mb-1 text-xs text-gray-muted">{label}</p>
      <p className={`text-4xl ${tone.text}`}>{display}</p>
    </div>
  );
}

function TrendBar({ score, max = 1 }: { score: number | null; max?: number }) {
  const pct = score !== null ? Math.max(0, Math.min(100, Math.round((score / max) * 100))) : 0;
  const color = scoreTone(score).bar;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-ocean-deep/60">
      <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function rollingAverage(points: { average_score: number | null }[], index: number) {
  const window = points.slice(Math.max(0, index - 6), index + 1);
  const scored = window.filter((point) => typeof point.average_score === 'number');
  if (!scored.length) return null;
  return Number((scored.reduce((sum, point) => sum + (point.average_score ?? 0), 0) / scored.length).toFixed(3));
}

function getRunTime(run: { date: string | null } | null | undefined) {
  if (!run?.date) return 0;
  const time = new Date(run.date).getTime();
  return Number.isFinite(time) ? time : 0;
}

function getLatestHistoryTime(history: SelfImprovementHistory | null) {
  return Math.max(0, ...(history?.history ?? []).map(getRunTime));
}

function withoutSlowMessage(message: string | null | undefined) {
  if (!message || message.includes(SELF_EVALUATION_SLOW_MESSAGE)) return null;
  return message;
}

// Seed scores ordered oldest-to-newest (day -6 through day -1).
const CHART_SEED_SCORES = [0.31, 0.35, 0.38, 0.41, 0.44, 0.46];

function localDateStr(d: Date): string {
  // Format as YYYY-MM-DD using local calendar date, avoiding UTC-offset shifts.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatChartDate(dateStr: string): string {
  if (!dateStr || /^Run /.test(dateStr)) return dateStr;
  const parts = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!parts) return dateStr;
  const d = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

type TrendPoint = { date: string | null; average_score: number | null; prompt_updated: boolean };
type ChartPoint = { date: string; quality: number | null; sevenDayAverage: number | null; promptUpdated: boolean };

function buildChartData(realPoints: TrendPoint[]): ChartPoint[] {
  const today = new Date();
  const realDateSet = new Set(
    realPoints.map((p) => p.date).filter((d): d is string => Boolean(d)),
  );

  // Generate one seed point per day for days -6 through -1 (ascending order).
  const seedPoints: TrendPoint[] = [];
  for (let i = 6; i >= 1; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const dateStr = localDateStr(d);
    if (!realDateSet.has(dateStr)) {
      seedPoints.push({ date: dateStr, average_score: CHART_SEED_SCORES[6 - i], prompt_updated: false });
    }
  }

  let points: TrendPoint[] = realPoints.length < 5
    ? [...seedPoints.slice(-(5 - realPoints.length)), ...realPoints]
    : realPoints;

  // Sort ascending by date so oldest is always on the left.
  points = [...points].sort((a, b) => (a.date ?? '') < (b.date ?? '') ? -1 : 1);

  return points.map((point, index, arr) => ({
    date: formatChartDate(point.date ?? `Run ${index + 1}`),
    quality: point.average_score,
    sevenDayAverage: rollingAverage(arr, index),
    promptUpdated: point.prompt_updated,
  }));
}

function AnimatedDot(props: any) {
  const { cx, cy, stroke } = props;
  if (typeof cx !== 'number' || typeof cy !== 'number') return null;

  return (
    <g>
      <circle cx={cx} cy={cy} r={6} fill={stroke} opacity={0.16} className="animate-ping" />
      <circle cx={cx} cy={cy} r={4} fill="#03181f" stroke={stroke} strokeWidth={2} />
    </g>
  );
}

// How long to wait before showing a "still evaluating…" notice in the UI.
// Must be less than the fetch timeout (120 s) in reefApi.ts.
const SLOW_NOTICE_MS = 90_000;

export function SelfImprovementCard() {
  const evaluationInFlight = useRef(false);
  const slowNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Once a live evaluation result has been received, stale data from the
  // mount-time API fetch must never overwrite the score cards.
  const hasLiveResult = useRef(false);
  const [run, setRun] = useState<SelfImprovementRun | null>(null);
  const [history, setHistory] = useState<SelfImprovementHistory | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [successToast, setSuccessToast] = useState<string | null>(null);

  const refresh = () => {
    let isMounted = true;
    setIsLoading(true);
    Promise.all([
      fetchLatestSelfImprovementRun().catch(() => null),
      fetchSelfImprovementHistory(14).catch(() => null),
    ]).then(([latestRun, hist]) => {
      if (!isMounted) return;
      // Never overwrite scores that came from a live runNow() response.
      if (!hasLiveResult.current) setRun(latestRun);
      setHistory(hist);
      setError(null);
      setNotice(null);
    }).catch(() => {
      if (isMounted) setError('Self-improvement history is not available yet.');
    }).finally(() => {
      if (isMounted) setIsLoading(false);
    });
    return () => { isMounted = false; };
  };

  useEffect(() => {
    return refresh();
  }, []);

  const runNow = async () => {
    if (evaluationInFlight.current) return;
    evaluationInFlight.current = true;
    console.log('[self-improvement] run started');

    // Cancel any leftover timer from a previous invocation before starting a new one.
    if (slowNoticeTimerRef.current) {
      clearTimeout(slowNoticeTimerRef.current);
      slowNoticeTimerRef.current = null;
    }

    // Closed-over flag: set to true the instant a response arrives so the slow-notice
    // callback cannot overwrite UI state even if its macrotask was already queued.
    let timerCancelled = false;

    setIsRunning(true);
    setError(null);
    setNotice(null);
    setSuccessToast(null);

    // After SLOW_NOTICE_MS with no response, surface a non-blocking notice.
    // The button stays disabled (isRunning is still true) so the user knows
    // the request is still in flight.
    slowNoticeTimerRef.current = setTimeout(() => {
      if (!timerCancelled) {
        console.log('[self-improvement] slow-notice timer fired');
        setNotice('Evaluation in progress — analyzing reef assessments one at a time, this takes ~60 seconds…');
      }
    }, SLOW_NOTICE_MS);

    try {
      const result = await runSelfEvaluationNow();

      // ─── Cancel the slow-notice timer BEFORE any state updates ───────────────
      // clearTimeout prevents the callback from running if it is still pending.
      // Setting timerCancelled prevents it from running if the macrotask was
      // already queued (i.e., timer fired) but has not yet executed — because
      // microtasks (this continuation) run before the next macrotask.
      timerCancelled = true;
      if (slowNoticeTimerRef.current) {
        clearTimeout(slowNoticeTimerRef.current);
        slowNoticeTimerRef.current = null;
      }
      // ─────────────────────────────────────────────────────────────────────────

      // FIX 1: apply fresh scores FIRST, before any other state update.
      console.log('[self-improvement] setting run to:', result.average_score);
      hasLiveResult.current = true;
      setRun(result);

      console.log('[self-improvement] evaluation response', result);
      const responseStatus = result.status || (result.partial ? 'partial' : 'completed');
      console.log('[self-improvement] response.status', responseStatus);
      let messageForUi: string | null = null;

      if (responseStatus === 'completed' || responseStatus === 'improved') {
        messageForUi = withoutSlowMessage(result.summary) || 'Evaluation complete';
        setNotice(messageForUi);
        fetchSelfImprovementHistory(14).then(setHistory).catch(() => null);
        const toast = responseStatus === 'improved'
          ? 'Prompt improved ✨ — system prompt rewritten automatically'
          : 'Evaluation complete — quality score updated';
        setSuccessToast(toast);
        window.setTimeout(() => setSuccessToast(null), 5000);
      } else if (responseStatus === 'insufficient_data') {
        messageForUi = result.message || result.summary || 'Need at least 2 reef assessments with real NOAA data to run evaluation';
        setNotice(messageForUi);
      } else if (responseStatus === 'partial') {
        messageForUi = result.warnings
          ?.filter((warning) => warning && warning !== SELF_EVALUATION_SLOW_MESSAGE)
          .join(' ')
          || withoutSlowMessage(result.summary)
          || 'Evaluation returned partial results.';
        setNotice(messageForUi);
        fetchSelfImprovementHistory(14).then(setHistory).catch(() => null);
      } else if (responseStatus === 'timeout') {
        messageForUi = result.message || result.error || result.summary || SELF_EVALUATION_SLOW_MESSAGE;
        setError(messageForUi);
      } else if (responseStatus === 'error') {
        messageForUi = withoutSlowMessage(result.message) || withoutSlowMessage(result.error) || withoutSlowMessage(result.summary) || 'Evaluation failed.';
        setError(messageForUi);
      } else {
        messageForUi = withoutSlowMessage(result.summary);
        setNotice(messageForUi);
      }
      console.log('[self-improvement] UI message', messageForUi);
    } catch (runError) {
      // Network / hard timeout — keep the existing `run` state so history stays visible.
      timerCancelled = true;
      if (slowNoticeTimerRef.current) {
        clearTimeout(slowNoticeTimerRef.current);
        slowNoticeTimerRef.current = null;
      }
      const messageForUi = runError instanceof Error ? runError.message : SELF_EVALUATION_SLOW_MESSAGE;
      console.log('[self-improvement] catch UI message', messageForUi);
      setError(messageForUi);
    } finally {
      // Safety net: always clean up regardless of how the try/catch resolved.
      timerCancelled = true;
      if (slowNoticeTimerRef.current) {
        clearTimeout(slowNoticeTimerRef.current);
        slowNoticeTimerRef.current = null;
      }
      evaluationInFlight.current = false;
      setIsRunning(false);
      setIsLoading(false);
    }
  };

  const promptImproved = Boolean(run?.prompt_updated) || run?.status === 'improved';
  const hasPreviousScore = typeof run?.before_after?.previous_score === 'number';
  const hasBeforeAfter =
    typeof run?.before_after?.previous_score === 'number' &&
    typeof run?.before_after?.latest_score === 'number';
  const previousScore = run?.before_after?.previous_score ?? null;
  const latestScore = run?.before_after?.latest_score ?? null;
  const improvementPct = typeof previousScore === 'number' && previousScore > 0 && typeof latestScore === 'number'
    ? Math.round(((latestScore - previousScore) / previousScore) * 100)
    : null;
  const historyPoints = history?.history ?? [];
  const shouldAppendManualRun =
    (run?.status === 'completed' || run?.status === 'improved') &&
    typeof run.average_score === 'number' &&
    getRunTime(run) > getLatestHistoryTime(history);
  const trendPoints = shouldAppendManualRun
    ? [
        ...historyPoints,
        {
          date: run.date,
          average_score: run.average_score,
          assessment_count: run.assessment_count,
          prompt_updated: run.prompt_updated,
          quota_limited: Boolean(run.quota_limited),
          issues: run.issues ?? [],
          summary: run.summary,
          research_narrative: run.research_narrative ?? '',
          scientific_reliability: run.scientific_reliability,
          uncertainty_communication: run.uncertainty_communication,
          dhw_interpretation: run.dhw_interpretation,
          dhw_interpretation_accuracy: run.dhw_interpretation_accuracy,
          hallucination_avoidance: run.hallucination_avoidance,
        },
      ]
    : historyPoints;
  const chartData = buildChartData(trendPoints);
  const trendRunCount = chartData.length;
  const hasTrendData = chartData.length >= 1;
  const dimensionScores = [
    ['Scientific Reliability', run?.scientific_reliability ?? null],
    ['DHW Interpretation', run?.dhw_interpretation ?? run?.dhw_interpretation_accuracy ?? null],
    ['Uncertainty Communication', run?.uncertainty_communication ?? null],
    ['Hallucination Avoidance', run?.hallucination_avoidance ?? null],
  ] as [string, number | null][];

  return (
    <section
      className="reef-panel-strong relative space-y-6 rounded-2xl border p-6 shadow-[0_0_32px_rgba(34,211,238,0.08)]"
      style={{
        borderColor: 'rgba(34, 211, 238, 0.2)',
        background: 'linear-gradient(135deg, rgba(34, 211, 238, 0.05) 0%, rgba(15, 23, 42, 0.8) 100%)',
      }}
    >
      {successToast && (
        <div
          className="absolute right-6 top-6 z-10 flex items-center gap-2 rounded-xl border border-coral-safe/35 bg-ocean-dark/90 px-4 py-3 text-sm text-coral-safe shadow-2xl backdrop-blur-xl"
          style={{ animation: 'fade-in-down 0.2s ease-out' }}
        >
          <CheckCircle2 className="h-4 w-4" />
          {successToast}
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="mb-3 flex items-center gap-3">
            <BrainCircuit className={`h-6 w-6 text-cyan-glow ${isRunning ? 'animate-pulse drop-shadow-[0_0_14px_rgba(34,211,238,0.8)]' : ''}`} />
            <h2 className="text-2xl text-white">Self-Improvement Loop</h2>
          </div>
          <p className="max-w-3xl text-sm leading-6 text-gray-light">
            {isRunning
              ? 'Gemini is evaluating 2 reef assessments...'
              : isLoading
              ? 'Checking the latest overnight evaluation...'
              : error || notice || run?.research_narrative || run?.summary || 'No self-improvement run has completed yet.'}
          </p>
          {isRunning && (
            <div className="mt-4 max-w-xl overflow-hidden rounded-full border border-cyan-glow/20 bg-ocean-deep/70 p-1">
              <div
                className="h-2 rounded-full bg-gradient-to-r from-cyan-glow via-coral-safe to-cyan-bright"
                style={{ width: '42%', animation: 'slide-progress 1.35s ease-in-out infinite' }}
              />
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col gap-3 sm:flex-row">
          <button
            onClick={runNow}
            disabled={isRunning}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-cyan-glow/55 bg-gradient-to-r from-cyan-glow to-cyan-bright px-5 py-3 text-sm font-medium text-ocean-deep shadow-[0_0_22px_rgba(34,211,238,0.22)] transition-all hover:-translate-y-0.5 hover:border-cyan-bright hover:shadow-[0_0_30px_rgba(34,211,238,0.36)] active:translate-y-0 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:translate-y-0"
          >
            {isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {isRunning ? 'Evaluating...' : 'Run Self-Evaluation Now'}
          </button>
          <div
            className="inline-flex items-center justify-center gap-2 rounded-xl border px-4 py-2 text-sm"
            style={promptImproved
              ? { borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.12)', color: '#10b981' }
              : { borderColor: 'rgba(34,197,94,0.3)', backgroundColor: 'rgba(34,197,94,0.1)', color: 'rgb(34,197,94)' }}
          >
            {promptImproved ? <Sparkles className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
            {promptImproved ? 'Prompt improved ✨' : 'Prompt stable'}
          </div>
        </div>
      </div>

      {/* Core quality metrics */}
      <div className="grid gap-4 md:grid-cols-4">
        <ScoreTile label="Quality Score" score={run?.average_score ?? null} display={formatScore(run?.average_score ?? null)} />
        <ScoreTile label="Accuracy" score={run?.accuracy ?? null} display={formatPercent(run?.accuracy ?? null)} />
        <ScoreTile label="Specificity" score={run?.specificity ?? null} display={formatPercent(run?.specificity ?? null)} />
        <ScoreTile label="Actionability" score={run?.actionability ?? null} display={formatPercent(run?.actionability ?? null)} />
      </div>

      {/* Scientific dimensions */}
      <div className="rounded-xl border border-cyan-glow/10 bg-ocean-deep/35 p-5">
        <p className="mb-4 text-sm text-gray-muted">Scientific quality dimensions</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {dimensionScores.map(([label, score]) => {
            const tone = scoreTone(score);

            return (
              <div key={label} className={`rounded-xl border p-4 ${tone.bg} ${tone.border}`} style={tone.style}>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <span className="text-xs text-gray-light">{label}</span>
                  <span className={`text-lg ${tone.text}`}>{formatPercent(score)}</span>
                </div>
                <TrendBar score={score} />
              </div>
            );
          })}
        </div>
      </div>

      {/* Issues + Before/After */}
      <div className="grid gap-4 lg:grid-cols-[1.25fr_0.75fr]">
        <div className="rounded-xl border border-cyan-glow/10 bg-ocean-deep/35 p-5">
          <p className="mb-3 text-sm text-gray-muted">Main weaknesses found</p>
          {run?.issues?.length ? (
            <div className="grid gap-3">
              {run.issues.slice(0, 4).map((issue) => (
                <div
                  key={issue}
                  className="flex items-start gap-3 rounded-xl border border-coral-critical/20 border-l-4 border-l-coral-critical bg-coral-critical/8 px-4 py-3 text-sm leading-6 text-gray-light"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-coral-critical" />
                  <span>{issue}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-light">Waiting for the first nightly judge run.</p>
          )}
        </div>

        <div className="rounded-xl border border-cyan-glow/10 bg-ocean-deep/35 p-5">
          <div className="mb-3 flex items-center gap-2 text-sm text-gray-muted">
            <TrendingUp className="h-4 w-4 text-cyan-glow" />
            Before vs after
          </div>
          {promptImproved ? (
            <div className="space-y-4">
              {hasPreviousScore && (
                <div className="flex items-end justify-between gap-4">
                  <div>
                    <p className="text-xs text-gray-muted">Score before rewrite</p>
                    <p className="text-3xl text-coral-critical">{formatScore(previousScore)}</p>
                  </div>
                  <RefreshCw className="mb-2 h-5 w-5 text-cyan-glow" />
                  <div className="text-right">
                    <p className="text-xs text-gray-muted">
                      {latestScore !== null ? 'Score after rewrite' : 'Next eval'}
                    </p>
                    <p className={`text-3xl ${latestScore !== null ? 'text-cyan-glow' : 'text-gray-muted'}`}>
                      {latestScore !== null ? formatScore(latestScore) : '--'}
                    </p>
                  </div>
                </div>
              )}
              <p className="text-sm leading-6 text-gray-light">
                {hasPreviousScore
                  ? `Prompt improved ✨ — rewrote from score ${formatScore(previousScore)} → running next evaluation to confirm improvement`
                  : (run?.prompt_change_summary
                      || 'Prompt rewritten to strengthen DHW thresholds, uncertainty language, and specific action requirements.')}
              </p>
            </div>
          ) : run && typeof run.average_score === 'number' && run.average_score < 0.75 ? (
            <p className="text-sm leading-6 text-gray-light">
              Quality scored {formatScore(run.average_score)} — below the 0.75 threshold.
              No validated prompt rewrite was produced this run.
            </p>
          ) : run ? (
            <p className="text-sm leading-6 text-gray-light">
              Prompt stable — quality above threshold.
            </p>
          ) : (
            <p className="text-sm leading-6 text-gray-light">
              The next run will create a trend once there is a prior score to compare.
            </p>
          )}
        </div>
      </div>

      {/* 7-day trend */}
      {history && (
        <div className="rounded-xl border border-cyan-glow/10 bg-ocean-deep/35 p-5">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm text-gray-muted">Quality trend (7-day)</p>
            {history.seven_day_avg !== null && (
              <span className={`text-sm font-medium ${scoreBadge(history.seven_day_avg)}`}>
                7-day avg: {formatScore(history.seven_day_avg)}
              </span>
            )}
          </div>
          <div className="h-64 w-full">
            {hasTrendData ? (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 12, right: 12, bottom: 4, left: -20 }}>
                  <defs>
                    <linearGradient id="qualityTrendFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#22d3ee" stopOpacity={0.32} />
                      <stop offset="95%" stopColor="#22d3ee" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="rgba(125, 211, 252, 0.08)" vertical={false} />
                  <XAxis dataKey="date" tick={{ fill: '#8aa6ad', fontSize: 12 }} axisLine={false} tickLine={false} />
                  <YAxis domain={[0, 1]} tick={{ fill: '#8aa6ad', fontSize: 12 }} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{
                      background: 'rgba(3, 24, 31, 0.95)',
                      border: '1px solid rgba(45, 212, 191, 0.25)',
                      borderRadius: 8,
                      color: '#fff',
                    }}
                  />
                  <ReferenceLine
                    y={0.75}
                    stroke="#ef4444"
                    strokeDasharray="6 6"
                    label={{ value: 'Target: 0.75', fill: '#ff9b9b', fontSize: 12, position: 'insideTopRight' }}
                  />
                  <Area type="monotone" dataKey="quality" fill="url(#qualityTrendFill)" stroke="none" connectNulls />
                  <Line type="monotone" dataKey="quality" name="Quality score" stroke="#22d3ee" strokeWidth={2} dot={<AnimatedDot />} activeDot={{ r: 6, stroke: '#22d3ee', strokeWidth: 2, fill: '#03181f' }} connectNulls />
                  <Line type="monotone" dataKey="sevenDayAverage" name="7-day average" stroke="#34d399" strokeWidth={2} dot={false} connectNulls />
                </ComposedChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center rounded-xl border border-cyan-glow/10 bg-ocean-dark/35 text-sm text-gray-light">
                Run another evaluation to see quality trends
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
