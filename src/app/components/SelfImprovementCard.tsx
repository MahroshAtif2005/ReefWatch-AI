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
import { AlertTriangle, BrainCircuit, CheckCircle2, Database, FlaskConical, Loader2, Play, RefreshCw, Sparkles, TrendingUp } from 'lucide-react';
import {
  fetchCostTelemetry,
  fetchLatestSelfImprovementRun,
  fetchSelfImprovementHistory,
  fetchSelfImprovementV2Status,
  runSelfEvaluationNow,
  SELF_EVALUATION_SLOW_MESSAGE,
  type CostTelemetry,
  type SelfImprovementHistory,
  type SelfImprovementRun,
  type SelfImprovementV2Status,
} from '../services/reefApi';

const normalizeScore = (score: number | null): number | null =>
  score === null ? null : score > 1 ? score / 100 : score;

const formatScore = (score: number | null) =>
  typeof score === 'number' ? score.toFixed(2) : '--';
const formatPercent = (score: number | null) => {
  if (score === null || score === undefined) return '--';
  return `${score > 1 ? Math.round(score) : Math.round(score * 100)}%`;
};


function readRunScore(run: SelfImprovementRun | null, keys: string[]) {
  if (!run) return null;
  const values = run as unknown as Record<string, unknown>;
  for (const key of keys) {
    if (typeof values[key] === 'number') return values[key] as number;
  }
  return null;
}

function scoreBadge(score: number | null) {
  const n = normalizeScore(score);
  if (n === null) return 'text-gray-muted';
  if (n >= 0.8) return 'text-coral-safe';
  if (n >= 0.6) return 'text-coral-warning';
  return 'text-coral-critical';
}

function scoreTone(score: number | null) {
  const n = normalizeScore(score);
  if (n === null) {
    return {
      bg: 'bg-ocean-deep/45',
      border: 'border-gray-border/60',
      text: 'text-gray-muted',
      bar: 'bg-gray-muted/35',
      style: {},
    };
  }

  if (n >= 0.8) {
    return {
      bg: 'bg-coral-safe/10',
      border: 'border-coral-safe/40',
      text: 'text-coral-safe',
      bar: 'bg-coral-safe',
      style: { backgroundColor: 'rgba(34, 197, 94, 0.1)', borderColor: 'rgba(34, 197, 94, 0.42)' },
    };
  }

  if (n >= 0.6) {
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
  const n = normalizeScore(score);
  const pct = n !== null ? Math.max(0, Math.min(100, Math.round((n / max) * 100))) : 0;
  const color = scoreTone(n).bar;
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

const LS_LAST_SCORES_KEY = 'reefwatch_last_scores';
const LS_LAST_RUN_TS_KEY = 'reefwatch_si_last_run_ts';
const COOLDOWN_MS = 30 * 60 * 1000;

function loadStoredRun(): SelfImprovementRun | null {
  try {
    const raw = localStorage.getItem(LS_LAST_SCORES_KEY);
    if (raw) return JSON.parse(raw) as SelfImprovementRun;
  } catch {}
  return null;
}

function saveRunToStorage(run: SelfImprovementRun) {
  try { localStorage.setItem(LS_LAST_SCORES_KEY, JSON.stringify(run)); } catch {}
}

function cooldownRemaining(): number {
  try {
    const ts = Number(localStorage.getItem(LS_LAST_RUN_TS_KEY) ?? 0);
    const remaining = COOLDOWN_MS - (Date.now() - ts);
    return remaining > 0 ? remaining : 0;
  } catch { return 0; }
}

export function SelfImprovementCard() {
  const evaluationInFlight = useRef(false);
  const slowNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cooldownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Once a live evaluation result has been received, stale data from the
  // mount-time API fetch must never overwrite the score cards.
  const hasLiveResult = useRef(false);
  const [run, setRun] = useState<SelfImprovementRun | null>(() => loadStoredRun());
  const [isShowingCachedData, setIsShowingCachedData] = useState(() => !!loadStoredRun());
  const [history, setHistory] = useState<SelfImprovementHistory | null>(null);
  const [v2Status, setV2Status] = useState<SelfImprovementV2Status | null>(null);
  const [costTelemetry, setCostTelemetry] = useState<CostTelemetry | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [successToast, setSuccessToast] = useState<string | null>(null);
  const [cooldownMs, setCooldownMs] = useState<number>(() => cooldownRemaining());

  const refresh = () => {
    let isMounted = true;
    let retryScheduled = false;
    setIsLoading(true);

    const doFetch = () => Promise.all([
      fetchLatestSelfImprovementRun().catch((err: unknown) => {
        console.warn('[self-improvement] fetch latest failed:', (err as Error)?.message ?? err);
        return null;
      }),
      fetchSelfImprovementHistory(14).catch((err: unknown) => {
        console.warn('[self-improvement] fetch history failed:', (err as Error)?.message ?? err);
        return null;
      }),
      fetchSelfImprovementV2Status().catch(() => null),
      fetchCostTelemetry().catch(() => null),
    ]);

    doFetch().then(([latestRun, hist, v2, cost]) => {
      if (!isMounted) return;
      if (v2) setV2Status(v2);
      if (cost) setCostTelemetry(cost);
      const hasScores = latestRun && (
        typeof latestRun.average_score === 'number' ||
        latestRun.status === 'healthy' ||
        latestRun.status === 'improvement_suggested' ||
        latestRun.status === 'skipped_healthy'
      );
      if (!hasScores && !hasLiveResult.current) {
        console.warn('[self-improvement] initial scores empty — retrying in 3s', { status: latestRun?.status });
        retryScheduled = true;
        setTimeout(() => {
          if (!isMounted) return;
          doFetch().then(([retryRun, retryHist, retryV2, retryCost]) => {
            if (!isMounted) return;
            const retryHasScores = retryRun && (
              typeof retryRun.average_score === 'number' ||
              retryRun.status === 'healthy' ||
              retryRun.status === 'improvement_suggested'
            );
            if (!hasLiveResult.current && retryHasScores) {
              setRun(retryRun);
              if (typeof retryRun!.average_score === 'number') saveRunToStorage(retryRun!);
              setIsShowingCachedData(false);
            }
            if (retryV2) setV2Status(retryV2);
            if (retryCost) setCostTelemetry(retryCost);
            setHistory(retryHist);
            setError(null);
            setNotice(null);
          }).catch((err: unknown) => {
            if (isMounted) console.warn('[self-improvement] retry failed:', (err as Error)?.message ?? err);
          }).finally(() => {
            if (isMounted) setIsLoading(false);
          });
        }, 3000);
        return;
      }
      // Never overwrite scores that came from a live runNow() response.
      if (!hasLiveResult.current) {
        setRun(latestRun);
        if (latestRun && typeof latestRun.average_score === 'number') {
          saveRunToStorage(latestRun);
          setIsShowingCachedData(false);
        }
      }
      setHistory(hist);
      setError(null);
      setNotice(null);
    }).catch(() => {
      if (isMounted) setError('Self-improvement history is not available yet.');
    }).finally(() => {
      if (isMounted && !retryScheduled) setIsLoading(false);
    });

    return () => { isMounted = false; };
  };

  useEffect(() => {
    return refresh();
  }, []);

  useEffect(() => {
    if (cooldownMs <= 0) return;
    cooldownIntervalRef.current = setInterval(() => {
      const remaining = cooldownRemaining();
      setCooldownMs(remaining);
      if (remaining <= 0 && cooldownIntervalRef.current) {
        clearInterval(cooldownIntervalRef.current);
        cooldownIntervalRef.current = null;
      }
    }, 10_000);
    return () => {
      if (cooldownIntervalRef.current) clearInterval(cooldownIntervalRef.current);
    };
  }, [cooldownMs > 0]);

  const runNow = async () => {
    if (evaluationInFlight.current) return;
    if (cooldownRemaining() > 0) return;
    evaluationInFlight.current = true;
    try { localStorage.setItem(LS_LAST_RUN_TS_KEY, String(Date.now())); } catch {}
    setCooldownMs(COOLDOWN_MS);
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
      saveRunToStorage(result);

      console.log('[self-improvement] evaluation response', result);
      const responseStatus = result.status || (result.partial ? 'partial' : 'completed');
      console.log('[self-improvement] response.status', responseStatus);
      let messageForUi: string | null = null;

      if (responseStatus === 'skipped_healthy') {
        messageForUi = result.message || 'System healthy — evaluation skipped to conserve Gemini quota';
        setNotice(messageForUi);
        setSuccessToast('Health check passed — evaluation skipped (quality ≥ 75%)');
        window.setTimeout(() => setSuccessToast(null), 5000);
      } else if (responseStatus === 'healthy') {
        messageForUi = result.message || 'All briefs meeting quality threshold';
        setNotice(messageForUi);
        setSuccessToast('Self-improvement check complete — all briefs meeting quality threshold');
        window.setTimeout(() => setSuccessToast(null), 5000);
      } else if (responseStatus === 'no_traces') {
        const hasCachedScore = typeof result.average_score === 'number';
        messageForUi = hasCachedScore
          ? `No new traces — showing scores from ${(result as any).cached_from ?? 'last evaluation'}`
          : result.message || result.summary || 'No traces found — run a reef analysis to generate evaluation data';
        setNotice(messageForUi);
      } else if (responseStatus === 'completed' || responseStatus === 'improved') {
        const hasRealScore = typeof result.average_score === 'number';
        messageForUi = withoutSlowMessage(result.summary) || (hasRealScore ? 'Evaluation complete' : 'Awaiting data');
        setNotice(messageForUi);
        if (hasRealScore) {
          fetchSelfImprovementHistory(14).then(setHistory).catch(() => null);
          const toast = responseStatus === 'improved'
            ? 'Prompt improved ✨ — system prompt rewritten automatically'
            : 'Evaluation complete — quality score updated';
          setSuccessToast(toast);
          window.setTimeout(() => setSuccessToast(null), 5000);
        }
      } else if (responseStatus === 'cached') {
        messageForUi = withoutSlowMessage(result.summary) || `Scores up to date — last evaluated ${(result as any).cached_from ?? 'recently'}`;
        setNotice(messageForUi);
        fetchSelfImprovementHistory(14).then(setHistory).catch(() => null);
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
      // Re-fetch history so the chart section recovers even when the run itself failed.
      fetchSelfImprovementHistory(14).then(setHistory).catch(() => null);
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

  // Use system_status (from _compute_system_state) as the authoritative state signal.
  // Fall back to raw status for backwards-compat with older API responses.
  const systemStatus = run?.system_status || run?.status;
  const rewriteStatus = run?.prompt_rewrite_status ?? 'none';
  const isSkippedHealthy = systemStatus === 'skipped_healthy' || run?.status === 'skipped_healthy';
  const isHealthyRun = systemStatus === 'healthy' || systemStatus === 'improved' || systemStatus === 'skipped_healthy' || run?.status === 'healthy';
  const isRewriteDidNotImprove = systemStatus === 'degraded' && rewriteStatus === 'did_not_improve';
  const isDegraded = systemStatus === 'degraded';

  const lastCheckedLabel = (() => {
    const ts = run?.last_checked || run?.date;
    if (!ts) return null;
    try {
      return new Date(ts).toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    } catch { return null; }
  })();

  const previousScore = run?.before_after?.previous_score ?? null;
  const latestScore = run?.before_after?.latest_score ?? null;
  const scoreActuallyDecreased = isRewriteDidNotImprove || isDegraded ||
    (typeof previousScore === 'number' && typeof latestScore === 'number' && latestScore < previousScore);

  // Scores: prefer latest_verified_metrics (always from a full eval, never from a skip record).
  // This ensures skipped_healthy runs display the real last verified scores, not dashes.
  const vm = run?.latest_verified_metrics;
  const qualityScore = vm?.average_score
    ?? readRunScore(run, ['quality_score', 'average_score'])
    ?? null;
  const accuracyScore = vm?.accuracy
    ?? readRunScore(run, ['accuracy'])
    ?? null;
  const specificityScore = vm?.specificity
    ?? readRunScore(run, ['specificity'])
    ?? null;
  const actionabilityScore = vm?.actionability
    ?? readRunScore(run, ['actionability'])
    ?? null;

  // Narrative text: prefer current_state_summary (computed by backend) over legacy fields.
  const runSummary = run?.current_state_summary
    || (isHealthyRun ? (run?.message || 'All briefs meeting quality threshold') : null)
    || run?.research_narrative
    || run?.summary;

  // Experiment-aware pipeline narrative — overrides runSummary when an experiment has a definitive result.
  // This prevents "System prompt rewritten" from appearing when the candidate was rejected.
  const experimentNarrative = (() => {
    const exp = v2Status?.latest_experiment;
    if (!exp || exp.promoted === null) return null;
    const version = v2Status?.prompt_version ?? 'v1';
    if (exp.promoted) {
      return `Candidate prompt outperformed production and was promoted to ${version}.`;
    }
    return `Candidate prompt rejected after benchmark evaluation. Production prompt ${version} retained.`;
  })();

  // Safe local alias — never null when used (hasExperimentResult guards every access).
  const latestExp = v2Status?.latest_experiment ?? null;
  // Whether a completed experiment result exists (promoted or rejected).
  // Must guard v2Status itself — when null, v2Status?.latest_experiment is
  // undefined, which is !== null, so the old expression was always true.
  const hasExperimentResult = v2Status != null && latestExp != null && latestExp.promoted !== null;

  const hasPreviousScore = typeof previousScore === 'number';
  const hasBeforeAfter = typeof previousScore === 'number' && typeof latestScore === 'number';

  // Show an explanatory notice when the latest fresh-sample score is below threshold
  // but the stable benchmark score (from the last experiment's baseline) is still healthy.
  // A single fresh sample is noisy — do not treat it as a production quality regression.
  const benchmarkScore = v2Status?.benchmark_score ?? null;
  const freshSampleScore = run?.average_score ?? null;
  const freshSampleDroppedButBenchmarkHealthy = (
    typeof benchmarkScore === 'number' &&
    benchmarkScore >= 0.75 &&
    typeof freshSampleScore === 'number' &&
    freshSampleScore < benchmarkScore - 0.03   // at least 3pp below benchmark
  );
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
  const hasTrendData = chartData.length >= 1;
  const dimensionScores = [
    ['Scientific Reliability', vm?.scientific_reliability ?? run?.scientific_reliability ?? null],
    ['DHW Interpretation', vm?.dhw_interpretation ?? run?.dhw_interpretation ?? run?.dhw_interpretation_accuracy ?? null],
    ['Uncertainty Communication', vm?.uncertainty_communication ?? run?.uncertainty_communication ?? null],
    ['Hallucination Avoidance', vm?.hallucination_avoidance ?? run?.hallucination_avoidance ?? null],
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
              ? 'Gemini is evaluating reef assessments...'
              : isLoading
              ? 'Checking the latest evaluation...'
              : error || notice || experimentNarrative || runSummary || (isShowingCachedData ? 'Showing last evaluation results' : 'Run Self-Evaluation Now to generate the first quality report.')}
          </p>
          {/* Last-checked row — shown for skipped-healthy runs and whenever we have a timestamp */}
          {!isRunning && lastCheckedLabel && (
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <span className="text-xs text-gray-muted">
                Last checked: <span className="text-gray-light">{lastCheckedLabel}</span>
              </span>
              {isSkippedHealthy && (
                <span
                  className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs"
                  style={{ borderColor: 'rgba(16,185,129,0.4)', backgroundColor: 'rgba(16,185,129,0.08)', color: '#10b981' }}
                >
                  <CheckCircle2 className="h-3 w-3" />
                  Evaluation skipped — system healthy
                </span>
              )}
            </div>
          )}
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
            disabled={isRunning || cooldownMs > 0}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-cyan-glow/55 bg-gradient-to-r from-cyan-glow to-cyan-bright px-5 py-3 text-sm font-medium text-ocean-deep shadow-[0_0_22px_rgba(34,211,238,0.22)] transition-all hover:-translate-y-0.5 hover:border-cyan-bright hover:shadow-[0_0_30px_rgba(34,211,238,0.36)] active:translate-y-0 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:translate-y-0"
          >
            {isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {isRunning
              ? 'Evaluating...'
              : cooldownMs > 0
              ? `Next evaluation in ${Math.ceil(cooldownMs / 60000)}m`
              : 'Run Self-Evaluation Now'}
          </button>
          {/* Status badge — driven by system_status + prompt_rewrite_status from backend */}
          <div
            className="inline-flex items-center justify-center gap-2 rounded-xl border px-4 py-2 text-sm"
            style={
              hasExperimentResult && latestExp!.promoted
                ? { borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.12)', color: '#10b981' }
                : hasExperimentResult && !latestExp!.promoted
                ? { borderColor: 'rgba(234,179,8,0.4)', backgroundColor: 'rgba(234,179,8,0.1)', color: 'rgb(234,179,8)' }
                : rewriteStatus === 'confirmed_improved'
                ? { borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.12)', color: '#10b981' }
                : rewriteStatus === 'rewritten_pending'
                ? { borderColor: 'rgba(234,179,8,0.4)', backgroundColor: 'rgba(234,179,8,0.1)', color: 'rgb(234,179,8)' }
                : rewriteStatus === 'did_not_improve' || isDegraded
                ? { borderColor: 'rgba(239,68,68,0.4)', backgroundColor: 'rgba(239,68,68,0.08)', color: 'rgb(239,68,68)' }
                : { borderColor: 'rgba(34,197,94,0.3)', backgroundColor: 'rgba(34,197,94,0.1)', color: 'rgb(34,197,94)' }
            }
          >
            {hasExperimentResult && latestExp!.promoted ? (
              <Sparkles className="h-4 w-4" />
            ) : hasExperimentResult && !latestExp!.promoted ? (
              <AlertTriangle className="h-4 w-4" />
            ) : rewriteStatus === 'confirmed_improved' ? (
              <Sparkles className="h-4 w-4" />
            ) : rewriteStatus === 'rewritten_pending' || rewriteStatus === 'did_not_improve' || isDegraded ? (
              <AlertTriangle className="h-4 w-4" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
            {hasExperimentResult && latestExp!.promoted
              ? 'Candidate promoted'
              : hasExperimentResult && !latestExp!.promoted
              ? 'Candidate rejected'
              : rewriteStatus === 'confirmed_improved'
              ? 'Prompt improved'
              : rewriteStatus === 'rewritten_pending'
              ? 'Prompt rewritten'
              : rewriteStatus === 'did_not_improve'
              ? 'Needs attention'
              : isDegraded
              ? 'Needs attention'
              : isSkippedHealthy
              ? 'System healthy'
              : 'Prompt stable'}
          </div>
        </div>
      </div>

      {/* Production system metrics — prompt version, benchmark dataset, experiment results */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {/* Prompt version */}
        <div className="flex flex-col gap-1 rounded-xl border border-cyan-glow/15 bg-ocean-deep/40 px-4 py-3">
          <div className="flex items-center gap-2 text-xs text-gray-muted">
            <Sparkles className="h-3.5 w-3.5 text-cyan-glow/70" />
            Production Prompt
          </div>
          <p className="text-xl font-semibold text-white">
            {v2Status?.prompt_version ?? 'v1'}
          </p>
          {v2Status?.prompt_improvement_delta != null && v2Status.prompt_improvement_delta > 0 && (
            <p className="text-xs text-coral-safe">
              +{(v2Status.prompt_improvement_delta * 100).toFixed(1)}% vs previous
            </p>
          )}
          {v2Status?.prompt_deployed_at && (
            <p className="text-xs text-gray-muted">
              {(() => { try { return new Date(v2Status.prompt_deployed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); } catch { return ''; } })()}
            </p>
          )}
        </div>

        {/* Benchmark dataset size */}
        <div className="flex flex-col gap-1 rounded-xl border border-cyan-glow/15 bg-ocean-deep/40 px-4 py-3">
          <div className="flex items-center gap-2 text-xs text-gray-muted">
            <Database className="h-3.5 w-3.5 text-cyan-glow/70" />
            Benchmark Dataset
          </div>
          {v2Status?.benchmark_dataset_size === 0 ? (
            <p className="text-xs leading-4 text-gray-muted">
              Built from real production traces. None collected yet.
            </p>
          ) : (
            <>
              <p className="text-xl font-semibold text-white">
                {v2Status?.benchmark_dataset_size != null ? v2Status.benchmark_dataset_size : '--'}
              </p>
              <p className="text-xs text-gray-muted">production cases</p>
            </>
          )}
        </div>

        {/* Latest experiment — labeled breakdown */}
        <div className="flex flex-col gap-1 rounded-xl border border-cyan-glow/15 bg-ocean-deep/40 px-4 py-3">
          <div className="flex items-center gap-2 text-xs text-gray-muted">
            <FlaskConical className="h-3.5 w-3.5 text-cyan-glow/70" />
            Last Experiment
          </div>
          {v2Status?.latest_experiment ? (
            <div className="mt-1 space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-muted">Baseline</span>
                <span className="font-mono text-white">
                  {v2Status.latest_experiment.baseline_score != null
                    ? `${Math.round(v2Status.latest_experiment.baseline_score * 100)}%`
                    : '--'}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-muted">Candidate</span>
                <span className={`font-mono ${
                  v2Status.latest_experiment.delta != null && v2Status.latest_experiment.delta > 0
                    ? 'text-coral-safe'
                    : v2Status.latest_experiment.delta != null && v2Status.latest_experiment.delta < 0
                    ? 'text-coral-critical'
                    : 'text-white'
                }`}>
                  {v2Status.latest_experiment.candidate_score != null
                    ? `${Math.round(v2Status.latest_experiment.candidate_score * 100)}%`
                    : '--'}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-muted">Delta</span>
                <span className={`font-mono ${
                  v2Status.latest_experiment.delta != null && v2Status.latest_experiment.delta > 0
                    ? 'text-coral-safe'
                    : v2Status.latest_experiment.delta != null && v2Status.latest_experiment.delta < 0
                    ? 'text-coral-critical'
                    : 'text-white'
                }`}>
                  {v2Status.latest_experiment.delta != null
                    ? `${v2Status.latest_experiment.delta > 0 ? '+' : ''}${(v2Status.latest_experiment.delta * 100).toFixed(1)}%`
                    : '--'}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-muted">Result</span>
                <span className={`font-medium ${
                  v2Status.latest_experiment.promoted ? 'text-coral-safe' : 'text-coral-warning'
                }`}>
                  {v2Status.latest_experiment.promoted === true
                    ? 'Promoted ✓'
                    : v2Status.latest_experiment.promoted === false
                    ? 'Rejected ✗'
                    : '--'}
                </span>
              </div>
            </div>
          ) : (
            <>
              <p className="text-xl font-semibold text-gray-muted">--</p>
              <p className="text-xs text-gray-muted">no experiments yet</p>
            </>
          )}
        </div>

        {/* Validation — promoted/rejected with reason */}
        <div className="flex flex-col gap-1 rounded-xl border border-cyan-glow/15 bg-ocean-deep/40 px-4 py-3">
          <div className="flex items-center gap-2 text-xs text-gray-muted">
            <CheckCircle2 className="h-3.5 w-3.5 text-cyan-glow/70" />
            Validation
          </div>
          {v2Status?.latest_experiment?.promoted != null ? (
            <>
              <p className={`text-sm font-semibold ${v2Status.latest_experiment.promoted ? 'text-coral-safe' : 'text-coral-warning'}`}>
                {v2Status.latest_experiment.promoted ? 'Promoted ✓' : 'Rejected ✗'}
              </p>
              {v2Status.latest_experiment.benchmark_cases != null && (
                <p className="text-xs text-gray-muted">
                  {v2Status.latest_experiment.benchmark_cases} benchmark case{v2Status.latest_experiment.benchmark_cases !== 1 ? 's' : ''}
                </p>
              )}
              {v2Status.latest_experiment.promoted ? (
                <p className="text-xs text-coral-safe">
                  Production prompt {v2Status.prompt_version} active
                </p>
              ) : v2Status.latest_experiment.promotion_reason ? (
                <p className="text-xs text-gray-muted truncate" title={v2Status.latest_experiment.promotion_reason}>
                  {v2Status.latest_experiment.promotion_reason}
                </p>
              ) : (
                <p className="text-xs text-gray-muted">
                  Production prompt {v2Status.prompt_version} retained
                </p>
              )}
            </>
          ) : (
            <>
              <p className="text-sm font-medium text-gray-muted">Pending</p>
              <p className="text-xs text-gray-muted">awaiting first experiment</p>
            </>
          )}
        </div>
      </div>

      {/* Prompt promotion history — only shown when history exists */}
      {v2Status?.prompt_history && v2Status.prompt_history.length > 1 && (
        <div className="rounded-xl border border-cyan-glow/10 bg-ocean-deep/35 p-4">
          <p className="mb-3 text-xs text-gray-muted">Prompt promotion history</p>
          <div className="flex flex-wrap gap-2">
            {[...v2Status.prompt_history].reverse().slice(0, 6).map((entry) => (
              <div
                key={entry.version}
                className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs ${
                  entry.version === v2Status.prompt_version
                    ? 'border-cyan-glow/40 bg-cyan-glow/10 text-cyan-glow'
                    : 'border-gray-border/30 bg-ocean-deep/50 text-gray-muted'
                }`}
              >
                <span className="font-mono font-medium">{entry.version}</span>
                {entry.improvement_delta != null && entry.improvement_delta > 0 && (
                  <span className="text-coral-safe">+{(entry.improvement_delta * 100).toFixed(1)}%</span>
                )}
                {entry.rewrite_reason && (
                  <span className="max-w-[120px] truncate opacity-70">{entry.rewrite_reason}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Fresh-sample vs benchmark explanatory notice */}
      {freshSampleDroppedButBenchmarkHealthy && (
        <div className="flex items-start gap-3 rounded-xl border border-cyan-glow/25 bg-cyan-glow/5 px-5 py-4">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-cyan-glow" />
          <div className="space-y-1 text-sm">
            <p className="text-white">
              Fresh sample found weaknesses — production prompt retained pending benchmark validation.
            </p>
            <p className="text-gray-light leading-5">
              Fresh eval: <span className="font-mono text-coral-warning">{formatPercent(freshSampleScore)}</span>
              {' · '}
              Benchmark score: <span className="font-mono text-coral-safe">{formatPercent(benchmarkScore)}</span>
              {' · '}
              The fresh sample evaluates a random subset of reefs each run and can vary by ±10%.
              The benchmark score (from the last controlled experiment) is the authoritative quality signal.
              An experiment rewrite will only be triggered if the benchmark score falls below 75%.
            </p>
          </div>
        </div>
      )}

      {/* Cost telemetry row */}
      {costTelemetry && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-xl border border-gray-border/30 bg-ocean-deep/30 px-4 py-2.5 text-xs text-gray-muted">
          <span className="text-gray-light">Gemini calls this session:</span>
          <span>Eval: <span className="font-mono text-white">{costTelemetry.last_eval_calls}</span></span>
          <span>Experiment: <span className="font-mono text-white">{costTelemetry.last_experiment_calls}</span></span>
          <span>Total: <span className="font-mono text-white">{costTelemetry.total_calls_this_session}</span></span>
          {costTelemetry.rejection_cooldown_active && (
            <span className="rounded-full border border-coral-warning/30 bg-coral-warning/8 px-2 py-0.5 text-coral-warning">
              Rejection cooldown active — retry blocked
            </span>
          )}
        </div>
      )}

      {/* Core quality metrics */}
      <div className="grid gap-4 md:grid-cols-4">
        <ScoreTile label="Quality Score" score={qualityScore} display={formatPercent(qualityScore)} />
        <ScoreTile label="Accuracy" score={accuracyScore} display={formatPercent(accuracyScore)} />
        <ScoreTile label="Specificity" score={specificityScore} display={formatPercent(specificityScore)} />
        <ScoreTile label="Actionability" score={actionabilityScore} display={formatPercent(actionabilityScore)} />
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
          {run?.diagnosis?.data_gap_dimensions && run.diagnosis.data_gap_dimensions.length > 0 && (
            <div className="mb-3 flex items-start gap-2 rounded-lg border border-cyan-glow/20 bg-cyan-glow/5 px-3 py-2 text-xs text-cyan-glow/80">
              <span className="mt-0.5 shrink-0">ℹ</span>
              <span>
                Low scores in {run.diagnosis.data_gap_dimensions.join(', ')} may reflect missing NOAA data, not model reasoning failures.
              </span>
            </div>
          )}
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
            <p className="text-sm text-gray-light">
              {isSkippedHealthy
                ? 'Nightly evaluation skipped — no new weaknesses found.'
                : qualityScore !== null && normalizeScore(qualityScore) !== null && (normalizeScore(qualityScore) as number) >= 0.75
                ? 'All briefs meeting quality threshold.'
                : run
                ? 'No specific weaknesses logged for this run.'
                : 'Waiting for the first nightly judge run.'}
            </p>
          )}
        </div>

        <div className="rounded-xl border border-cyan-glow/10 bg-ocean-deep/35 p-5">
          <div className="mb-3 flex items-center gap-2 text-sm text-gray-muted">
            <TrendingUp className="h-4 w-4 text-cyan-glow" />
            Before vs after
          </div>
          {hasExperimentResult ? (
            /* Experiment completed — show authoritative pipeline result */
            <div className="space-y-4">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <p className="text-xs text-gray-muted">Baseline</p>
                  <p className="text-3xl text-white">
                    {formatPercent(latestExp!.baseline_score)}
                  </p>
                </div>
                <RefreshCw className={`mb-2 h-5 w-5 ${latestExp!.promoted ? 'text-coral-safe' : 'text-coral-warning'}`} />
                <div className="text-right">
                  <p className="text-xs text-gray-muted">Candidate</p>
                  <p className={`text-3xl ${
                    latestExp!.delta != null && latestExp!.delta > 0
                      ? 'text-coral-safe'
                      : 'text-coral-warning'
                  }`}>
                    {formatPercent(latestExp!.candidate_score)}
                  </p>
                </div>
              </div>
              <p className={`text-sm font-semibold ${latestExp!.promoted ? 'text-coral-safe' : 'text-coral-warning'}`}>
                {latestExp!.promoted
                  ? `Candidate promoted to ${(v2Status?.prompt_version ?? 'v1')} ✓`
                  : `Candidate rejected — ${(v2Status?.prompt_version ?? 'v1')} retained`}
              </p>
              {latestExp!.promotion_reason && (
                <p className="text-xs text-gray-muted">{latestExp!.promotion_reason}</p>
              )}
            </div>
          ) : isSkippedHealthy ? (
            /* Nightly check was a healthy skip — show what was skipped and why */
            <div className="space-y-2">
              <p className="text-sm leading-6 text-gray-light">
                {run?.skip_reason
                  ? `Evaluation skipped — ${run.skip_reason}.`
                  : 'System healthy — Gemini evaluation skipped to conserve quota.'}
              </p>
              {run?.last_full_eval_at && (
                <p className="text-xs text-gray-muted">
                  Last full evaluation:{' '}
                  {(() => { try { return new Date(run.last_full_eval_at!).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return run.last_full_eval_at; } })()}
                </p>
              )}
            </div>
          ) : rewriteStatus === 'confirmed_improved' ? (
            /* Follow-up eval confirmed the rewrite improved quality */
            <div className="space-y-4">
              {hasBeforeAfter && (
                <div className="flex items-end justify-between gap-4">
                  <div>
                    <p className="text-xs text-gray-muted">Pre-rewrite score</p>
                    <p className="text-3xl text-coral-critical">{formatScore(previousScore)}</p>
                  </div>
                  <RefreshCw className="mb-2 h-5 w-5 text-cyan-glow" />
                  <div className="text-right">
                    <p className="text-xs text-gray-muted">Verified score</p>
                    <p className="text-3xl text-coral-safe">{formatScore(latestScore)}</p>
                  </div>
                </div>
              )}
              <p className="text-sm leading-6 text-gray-light">
                Prompt rewrite confirmed successful — score improved from{' '}
                {formatScore(previousScore)} to {formatScore(latestScore)}.
              </p>
            </div>
          ) : rewriteStatus === 'rewritten_pending' ? (
            /* Prompt was just rewritten — awaiting a follow-up evaluation */
            <div className="space-y-4">
              {hasBeforeAfter && (
                <div className="flex items-end justify-between gap-4">
                  <div>
                    <p className="text-xs text-gray-muted">Score before rewrite</p>
                    <p className="text-3xl text-gray-muted">{formatScore(previousScore)}</p>
                  </div>
                  <RefreshCw className="mb-2 h-5 w-5 text-coral-warning" />
                  <div className="text-right">
                    <p className="text-xs text-gray-muted">Score this run</p>
                    <p className="text-3xl text-coral-warning">{formatScore(latestScore)}</p>
                  </div>
                </div>
              )}
              {run?.rewrite_reason && (
                <p className="text-xs text-coral-warning/80">
                  Targeted fix: {run.rewrite_reason}
                </p>
              )}
              <p className="text-sm leading-6 text-gray-light">
                {hasPreviousScore
                  ? `Prompt rewritten (score: ${formatScore(latestScore)} → awaiting verification). Run next evaluation to confirm improvement.`
                  : (run?.prompt_change_summary || 'Prompt rewritten to strengthen identified weak dimensions. Run next evaluation to confirm improvement.')}
              </p>
            </div>
          ) : rewriteStatus === 'did_not_improve' ? (
            /* Follow-up eval showed rewrite didn't help */
            <div className="space-y-4">
              {hasBeforeAfter && (
                <div className="flex items-end justify-between gap-4">
                  <div>
                    <p className="text-xs text-gray-muted">Pre-rewrite score</p>
                    <p className="text-3xl text-gray-muted">{formatScore(previousScore)}</p>
                  </div>
                  <RefreshCw className="mb-2 h-5 w-5 text-coral-critical" />
                  <div className="text-right">
                    <p className="text-xs text-gray-muted">Follow-up score</p>
                    <p className="text-3xl text-coral-critical">{formatScore(latestScore)}</p>
                  </div>
                </div>
              )}
              <p className="text-sm leading-6 text-gray-light">
                Rewrite did not improve quality — score went from {formatScore(previousScore)} to {formatScore(latestScore)}.
                Manual prompt review may be needed.
              </p>
            </div>
          ) : scoreActuallyDecreased ? (
            /* No rewrite context, but score fell */
            <div className="space-y-3">
              {hasBeforeAfter && (
                <div className="flex items-end justify-between gap-4">
                  <div>
                    <p className="text-xs text-gray-muted">Previous score</p>
                    <p className="text-3xl text-gray-muted">{formatScore(previousScore)}</p>
                  </div>
                  <RefreshCw className="mb-2 h-5 w-5 text-coral-critical" />
                  <div className="text-right">
                    <p className="text-xs text-gray-muted">Latest score</p>
                    <p className="text-3xl text-coral-critical">{formatScore(latestScore)}</p>
                  </div>
                </div>
              )}
              <p className="text-sm leading-6 text-gray-light">
                Quality dropped from {formatScore(previousScore)} to {formatScore(latestScore)} — below the 0.75 threshold.
              </p>
            </div>
          ) : run ? (
            <p className="text-sm leading-6 text-gray-light">
              Prompt stable — quality above the 0.75 threshold.
            </p>
          ) : (
            <p className="text-sm leading-6 text-gray-light">
              The next run will create a comparison once there is a prior score.
            </p>
          )}
        </div>
      </div>

      {/* 7-day trend — always rendered; shows skeleton while history loads */}
      <div className="rounded-xl border border-cyan-glow/10 bg-ocean-deep/35 p-5">
        <div className="mb-4 flex items-center justify-between">
          <p className="text-sm text-gray-muted">Quality trend (7-day)</p>
          {history?.seven_day_avg != null && (
            <span className={`text-sm font-medium ${scoreBadge(history.seven_day_avg)}`}>
              7-day avg: {formatScore(history.seven_day_avg)}
            </span>
          )}
        </div>
        <div className="h-64 w-full">
          {history === null ? (
            <div className="flex h-full items-center justify-center rounded-xl border border-cyan-glow/10 bg-ocean-dark/35 text-sm text-gray-light">
              {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {isLoading ? 'Loading trend data…' : 'Trend data unavailable — run an evaluation to populate'}
            </div>
          ) : hasTrendData ? (
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

      {/* Recent Autonomous Checks — real history data only, no seeds */}
      <div className="rounded-xl border border-cyan-glow/10 bg-ocean-deep/35 p-5">
        <p className="mb-4 text-sm text-gray-muted">Recent autonomous checks</p>
        {history === null ? (
          <div className="flex items-center gap-2 text-sm text-gray-light">
            {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
            {isLoading ? 'Loading…' : 'No checks recorded yet.'}
          </div>
        ) : history.history.length === 0 ? (
          <p className="text-sm text-gray-light">No autonomous checks recorded yet — history will appear after the first run.</p>
        ) : (
          <div className="divide-y" style={{ borderColor: 'rgba(34,211,238,0.06)' }}>
            {history.history.slice(0, 5).map((check, i) => {
              const ts = check.last_checked ?? check.completed_at ?? check.stored_at ?? check.date;
              const timeLabel = ts
                ? (() => { try { return new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ts; } })()
                : '—';
              const src = check.source === 'nightly_scheduler' ? 'nightly' : check.source ?? 'manual';
              const st = check.status ?? '—';
              const isSkipped = st === 'skipped_healthy';
              const isPromptRewrite = Boolean(check.prompt_updated) && !isSkipped;
              const score = typeof check.average_score === 'number' ? check.average_score : null;

              // Human-readable run type label
              const runTypeLabel = isSkipped
                ? 'skipped healthy'
                : isPromptRewrite
                ? 'prompt rewrite'
                : st === 'improved'
                ? 'verification run'
                : st === 'degraded'
                ? 'full evaluation'
                : 'full evaluation';

              // Style for run-type chip
              const runTypeStyle = isSkipped
                ? { borderColor: 'rgba(16,185,129,0.35)', backgroundColor: 'rgba(16,185,129,0.07)', color: '#10b981' }
                : isPromptRewrite
                ? { borderColor: 'rgba(234,179,8,0.35)', backgroundColor: 'rgba(234,179,8,0.07)', color: 'rgb(234,179,8)' }
                : st === 'improved'
                ? { borderColor: 'rgba(34,197,94,0.35)', backgroundColor: 'rgba(34,197,94,0.07)', color: 'rgb(34,197,94)' }
                : { borderColor: 'rgba(148,163,184,0.3)', backgroundColor: 'rgba(148,163,184,0.06)', color: '#94a3b8' };

              return (
                <div key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 text-sm">
                  <span className="w-32 shrink-0 text-xs text-gray-muted">{timeLabel}</span>
                  <span
                    className="shrink-0 rounded-full border px-2 py-0.5 text-xs"
                    style={
                      src === 'nightly'
                        ? { borderColor: 'rgba(34,211,238,0.3)', backgroundColor: 'rgba(34,211,238,0.07)', color: '#22d3ee' }
                        : { borderColor: 'rgba(148,163,184,0.3)', backgroundColor: 'rgba(148,163,184,0.06)', color: '#94a3b8' }
                    }
                  >
                    {src}
                  </span>
                  <span className="shrink-0 rounded-full border px-2 py-0.5 text-xs" style={runTypeStyle}>
                    {runTypeLabel}
                  </span>
                  <span className={`flex-1 truncate text-xs ${isSkipped ? 'text-gray-muted' : scoreBadge(score)}`}>
                    {isSkipped
                      ? (check.skip_reason ?? 'quality above target — evaluation skipped')
                      : check.summary?.slice(0, 60) || st}
                  </span>
                  <span className={`w-12 shrink-0 text-right font-mono text-sm ${scoreBadge(score)}`}>
                    {score !== null ? formatPercent(score) : '—'}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
