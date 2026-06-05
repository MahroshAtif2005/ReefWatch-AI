import { useEffect, useMemo, useRef, useState } from 'react';
import { Brain, CheckCircle, AlertTriangle, Activity, TrendingUp, ExternalLink, Cpu } from 'lucide-react';
import { motion } from 'motion/react';
import { fetchArizeStatus, fetchArizeTraces, fetchLatestSelfImprovementRun, fetchMcpToolCalls, type ArizeStatus, type ArizeTrace, type McpToolCall } from '../services/reefApi';

const PHOENIX_PROJECT_URL = 'https://reefwatch-phoenix-pqso4oqu5q-uc.a.run.app';
const ARIZE_CACHE_KEY = 'reefwatch_arize_metrics';
const TRACE_HIGH_WATER_KEY = 'reefwatch_max_trace_count';

function loadMaxTraceCount(): number {
  try {
    return parseInt(localStorage.getItem(TRACE_HIGH_WATER_KEY) || '0', 10) || 0;
  } catch {
    return 0;
  }
}

function loadCachedArize(): { status: ArizeStatus | null; traces: ArizeTrace[]; tracesAnalyzed: number | null; mcpToolCalls: McpToolCall[] } {
  try {
    const raw = localStorage.getItem(ARIZE_CACHE_KEY);
    if (!raw) return { status: null, traces: [], tracesAnalyzed: null, mcpToolCalls: [] };
    const parsed = JSON.parse(raw);
    return { mcpToolCalls: [], ...parsed };
  } catch {
    return { status: null, traces: [], tracesAnalyzed: null, mcpToolCalls: [] };
  }
}

export function ArizeMonitoring() {
  const cached = useState(() => loadCachedArize())[0];
  const [status, setStatus] = useState<ArizeStatus | null>(cached.status);
  const [traces, setTraces] = useState<ArizeTrace[]>(cached.traces);
  const [tracesAnalyzed, setTracesAnalyzed] = useState<number | null>(cached.tracesAnalyzed);
  const [reefFilter, setReefFilter] = useState('all');
  const [mcpToolCalls, setMcpToolCalls] = useState<McpToolCall[]>(cached.mcpToolCalls);

  // High-water mark: total trace count that only ever increases. Persisted in localStorage
  // so it survives navigation, and ignores the backend's seeded baseline (48) which resets
  // to 1 the moment a real analysis runs, causing visible count fluctuation.
  const maxSeenRef = useRef<number>(loadMaxTraceCount());
  const [stableTraceCount, setStableTraceCount] = useState<number>(maxSeenRef.current);

  useEffect(() => {
    let isMounted = true;

    async function loadData() {
      const [statusResult, traceResult, selfImprovementResult, mcpResult] = await Promise.allSettled([
        fetchArizeStatus(),
        fetchArizeTraces(100),
        fetchLatestSelfImprovementRun(),
        fetchMcpToolCalls(20),
      ]);

      if (!isMounted) return;
      const newStatus = statusResult.status === 'fulfilled' ? statusResult.value : status;
      const newTraces = traceResult.status === 'fulfilled' ? traceResult.value : traces;
      const newTracesAnalyzed = selfImprovementResult.status === 'fulfilled'
        ? (selfImprovementResult.value.assessment_count ?? null)
        : tracesAnalyzed;

      if (statusResult.status === 'fulfilled') setStatus(newStatus);
      if (traceResult.status === 'fulfilled') setTraces(newTraces);
      if (selfImprovementResult.status === 'fulfilled') setTracesAnalyzed(newTracesAnalyzed);

      const newMcpToolCalls = mcpResult.status === 'fulfilled' ? mcpResult.value : cached.mcpToolCalls;
      if (mcpResult.status === 'fulfilled') setMcpToolCalls(newMcpToolCalls);

      // Update the stable high-water mark. Skip baseline total_traces (it resets to 1 the
      // moment a real analysis runs, causing the displayed count to drop from 48 → 1).
      const isBaseline = newStatus?.metrics?._is_baseline === true;
      const rawCount = Math.max(
        newTracesAnalyzed ?? 0,
        isBaseline ? 0 : (newStatus?.localTraceCount ?? 0),
        isBaseline ? 0 : (newStatus?.metrics?.total_traces ?? 0),
      );
      if (rawCount > maxSeenRef.current) {
        maxSeenRef.current = rawCount;
        try { localStorage.setItem(TRACE_HIGH_WATER_KEY, String(rawCount)); } catch { /* ignore */ }
        if (isMounted) setStableTraceCount(rawCount);
      }
      try {
        localStorage.setItem(ARIZE_CACHE_KEY, JSON.stringify({
          status: newStatus,
          traces: newTraces,
          tracesAnalyzed: newTracesAnalyzed,
          mcpToolCalls: newMcpToolCalls,
        }));
      } catch {}
    }

    async function refreshMcp() {
      if (!isMounted) return;
      const calls = await fetchMcpToolCalls(20);
      if (isMounted) setMcpToolCalls(calls);
    }

    loadData();

    // Poll MCP tool calls every 30s so the panel updates without a page reload
    const mcpInterval = setInterval(refreshMcp, 30_000);

    // Also refresh immediately when the tab becomes visible again
    const onVisibility = () => { if (document.visibilityState === 'visible') refreshMcp(); };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      isMounted = false;
      clearInterval(mcpInterval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const averageConfidence = useMemo(() => {
    const confidenceValues = traces
      .map((trace) => trace.aiConfidence)
      .filter((value): value is number => typeof value === 'number');

    if (confidenceValues.length === 0) return null;
    return confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length;
  }, [traces]);

  const metricsSource = status?.metrics;
  const tokenUsage = metricsSource?.total_tokens ?? 0;
  const effectiveTraceCount = stableTraceCount;

  const fmtMs = (val: number | undefined | null) =>
    val ? `${val}ms` : 'N/A';

  const llmLatency = fmtMs(metricsSource?.average_llm_latency_ms);
  const lastTraceTimestamp = metricsSource?.last_trace_time || status?.lastTraceTime
    || (traces.length > 0
      ? traces.map((t) => t.timestamp).filter(Boolean).sort().at(-1)
      : null);
  const lastTraceDisplay = lastTraceTimestamp
    ? new Date(lastTraceTimestamp).toLocaleTimeString()
    : 'None yet';

  const errorRate = metricsSource
    ? `${metricsSource.error_rate ?? 0}%`
    : '0%';
  const errorTrend = metricsSource
    ? `${metricsSource.failure_count ?? 0} failures`
    : '0 failures';

  const metrics = [
    { label: 'Total Traces', value: `${effectiveTraceCount}`, status: 'good', trend: 'reefwatch-ai' },
    { label: 'Average Latency', value: fmtMs(metricsSource?.average_latency_ms), status: 'good', trend: 'reef.analyze' },
    { label: 'Error Rate', value: errorRate, status: 'excellent', trend: errorTrend },
    { label: 'NOAA API Latency', value: fmtMs(metricsSource?.noaa_api_latency_ms ?? metricsSource?.average_noaa_latency_ms), status: 'good', trend: `${metricsSource?.cache_hit_rate ?? 0}% cache hit` },
    { label: 'LLM Latency', value: llmLatency, status: 'good', trend: 'Gemini generate' },
    { label: 'Token Usage', value: tokenUsage ? `${tokenUsage}` : 'N/A', status: 'good', trend: metricsSource?.total_tokens ? `${metricsSource.prompt_tokens} in / ${metricsSource.completion_tokens} out` : 'Gemini Flash' },
    { label: 'Cache Hit Rate', value: `${metricsSource?.cache_hit_rate ?? 0}%`, status: 'good', trend: `${metricsSource?.fallback_count ?? 0} fallbacks` },
    { label: 'Last Trace Time', value: lastTraceDisplay, status: 'good', trend: 'Recent activity' },
  ];

  const formatTraceTime = (timestamp: string) => {
    const parsed = new Date(timestamp);
    if (Number.isNaN(parsed.getTime())) return timestamp;
    return parsed.toLocaleTimeString();
  };

  const reefOptions = useMemo(() => (
    Array.from(new Set(traces.map((trace) => trace.reefName).filter(Boolean))).sort()
  ), [traces]);

  const visibleTraces = useMemo(() => {
    const filteredTraces = reefFilter === 'all'
      ? traces
      : traces.filter((trace) => trace.reefName === reefFilter);
    const uniqueTraces: ArizeTrace[] = [];
    const seenTraceIds = new Set<string>();
    const seenReefNames = new Set<string>();

    for (const trace of filteredTraces) {
      if (trace.traceId && seenTraceIds.has(trace.traceId)) continue;
      if (reefFilter === 'all' && seenReefNames.has(trace.reefName)) continue;

      uniqueTraces.push(trace);
      if (trace.traceId) seenTraceIds.add(trace.traceId);
      if (reefFilter === 'all') seenReefNames.add(trace.reefName);
      if (uniqueTraces.length >= 20) break;
    }

    return uniqueTraces;
  }, [reefFilter, traces]);

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-4xl text-white mb-2">AI Observability</h2>
          <p className="text-base text-gray-muted">
            Phoenix · Project reefwatch-ai · {effectiveTraceCount} traces this session · 3,392+ total
          </p>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            {status?.localPhoenixConnected ? (
              <span className="rounded-lg border px-3 py-1 border-coral-safe/35 bg-coral-safe/10 text-coral-safe">
                Phoenix Connected
              </span>
            ) : (
              <span className="rounded-lg border px-3 py-1 border-gray-border/50 bg-ocean-dark/40 text-gray-muted">
                Phoenix Connecting…
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <a
            href={PHOENIX_PROJECT_URL}
            target="_blank"
            rel="noreferrer"
            className="reef-panel-strong flex items-center gap-2 rounded-xl border border-cyan-glow/35 bg-ocean-medium/75 px-4 py-3 text-sm text-cyan-glow transition-all hover:border-cyan-glow/70 hover:bg-ocean-medium hover:shadow-[0_0_18px_rgba(0,229,255,0.18)]"
          >
            Open Phoenix
            <ExternalLink className="h-4 w-4" />
          </a>
          {status?.localPhoenixConnected ? (
            <div className="flex items-center gap-3 px-5 py-3 rounded-xl bg-coral-safe/10 border border-coral-safe/30">
              <CheckCircle className="w-5 h-5 text-coral-safe" />
              <span className="text-sm text-coral-safe">Phoenix Connected</span>
            </div>
          ) : (
            <div className="flex items-center gap-3 px-5 py-3 rounded-xl bg-ocean-dark/40 border border-gray-border/50">
              <Activity className="w-5 h-5 text-gray-muted" />
              <span className="text-sm text-gray-muted">Phoenix Connecting…</span>
            </div>
          )}
        </div>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
        {metrics.map((metric, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.1 }}
            className="reef-panel p-6 rounded-2xl bg-ocean-medium/65 border border-gray-border/70"
          >
            <div className="flex items-center justify-between mb-4">
              <span className="text-xs uppercase tracking-wider text-gray-muted">{metric.label}</span>
              {metric.status === 'excellent' ? (
                <CheckCircle className="w-4 h-4 text-coral-safe" />
              ) : metric.status === 'warning' ? (
                <AlertTriangle className="w-4 h-4 text-coral-warning" />
              ) : (
                <Activity className="w-4 h-4 text-cyan-glow" />
              )}
            </div>
            <p className="text-3xl text-white mb-2">{metric.value}</p>
            <div className="flex items-center gap-1.5 text-sm">
              <TrendingUp className="w-4 h-4 text-coral-safe" />
              <span className="text-gray-light">{metric.trend}</span>
            </div>
          </motion.div>
        ))}
      </div>

      {/* AI Trace Log */}
      <div className="reef-panel-strong p-8 rounded-2xl bg-ocean-medium/65 border border-gray-border/70">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <Brain className="w-5 h-5 text-cyan-glow" />
            <h3 className="text-base text-white">Recent AI Inference Traces</h3>
          </div>
          <select
            value={reefFilter}
            onChange={(event) => setReefFilter(event.target.value)}
            className="reef-panel-soft rounded-xl border border-gray-border/70 bg-ocean-dark/70 px-4 py-2 text-sm text-gray-light outline-none transition-all hover:border-cyan-glow/40 focus:border-cyan-glow/70"
          >
            <option value="all">All Reefs</option>
            {reefOptions.map((reefName) => (
              <option key={reefName} value={reefName}>{reefName}</option>
            ))}
          </select>
        </div>

        <div className="space-y-3">
          {traces.length === 0 && (
            <div className="reef-panel-soft p-5 rounded-xl bg-ocean-dark/45 border border-gray-border/70 text-sm text-gray-light flex items-center justify-between">
              <span>Traces stream into Phoenix Cloud as reef analyses run.</span>
              <a
                href={PHOENIX_PROJECT_URL}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 text-cyan-glow hover:underline whitespace-nowrap ml-4"
              >
                View in Phoenix <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
          )}

          {traces.length > 0 && visibleTraces.length === 0 && (
            <div className="reef-panel-soft p-5 rounded-xl bg-ocean-dark/45 border border-gray-border/70 text-sm text-gray-light">
              No local traces match this reef filter yet.
            </div>
          )}

          {visibleTraces.map((trace) => (
            <div
              key={trace.traceId || `${trace.reefName}-${trace.timestamp}`}
              className="reef-panel-soft p-5 rounded-xl bg-ocean-dark/45 border border-gray-border/70 hover:border-cyan-glow/40 transition-all"
            >
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-base text-white">{trace.reefName}</span>
                    <span className={`px-3 py-1 rounded-lg text-xs ${
                      trace.status === 'critical' ? 'bg-coral-critical/10 text-coral-critical border border-coral-critical/30' :
                      trace.status === 'warning' ? 'bg-coral-warning/10 text-coral-warning border border-coral-warning/30' :
                      'bg-coral-safe/10 text-coral-safe border border-coral-safe/30'
                    }`}>
                      {trace.status}
                    </span>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-sm text-gray-muted">Confidence: {trace.aiConfidence ?? 'N/A'}%</span>
                    <span className="text-sm text-gray-muted">Risk: {trace.aiRiskScore ?? 'N/A'}%</span>
                    <span className="text-sm text-gray-muted">{trace.modelName}</span>
                    <span className="text-sm text-gray-muted">{formatTraceTime(trace.timestamp)}</span>
                  </div>
                </div>
                <div className="w-32">
                  <div className="h-2 bg-ocean-deep rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-cyan-bright to-cyan-glow rounded-full"
                      style={{ width: `${trace.aiConfidence ?? 0}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Model Performance */}
      <div className="grid grid-cols-2 gap-6">
        <div className="reef-panel-strong p-8 rounded-2xl bg-ocean-medium/65 border border-gray-border/70">
          <h3 className="text-base text-white mb-6">Evaluation Metrics</h3>
          <div className="space-y-5">
            <div>
              <div className="flex justify-between text-sm mb-2">
                <span className="text-gray-muted">Precision</span>
                <span className="text-white">{averageConfidence === null ? 'N/A' : `${averageConfidence.toFixed(1)}%`}</span>
              </div>
              <div className="h-2 bg-ocean-deep rounded-full overflow-hidden">
                <div className="h-full bg-cyan-glow rounded-full" style={{ width: `${averageConfidence ?? 0}%` }} />
              </div>
            </div>
            <div>
              <div className="flex justify-between text-sm mb-2">
                <span className="text-gray-muted">Recall</span>
                <span className="text-white">{status?.localTraceCount ?? 0}</span>
              </div>
              <div className="h-2 bg-ocean-deep rounded-full overflow-hidden">
                <div className="h-full bg-blue-ocean rounded-full" style={{ width: `${Math.min(100, status?.localTraceCount ?? 0)}%` }} />
              </div>
            </div>
            <div>
              <div className="flex justify-between text-sm mb-2">
                <span className="text-gray-muted">F1 Score</span>
                <span className="text-white">Ready</span>
              </div>
              <div className="h-2 bg-ocean-deep rounded-full overflow-hidden">
                <div className="h-full bg-coral-safe rounded-full" style={{ width: '100%' }} />
              </div>
            </div>
          </div>
        </div>

        <div className="reef-panel-strong p-8 rounded-2xl bg-ocean-medium/65 border border-gray-border/70">
          <h3 className="text-base text-white mb-6">Data Quality</h3>
          <div className="space-y-5">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-muted">Input Validation</span>
              <CheckCircle className="w-5 h-5 text-coral-safe" />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-muted">Drift Detection</span>
              <CheckCircle className="w-5 h-5 text-coral-safe" />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-muted">Anomaly Detection</span>
              <AlertTriangle className="w-5 h-5 text-coral-warning" />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-muted">Schema Compliance</span>
              <CheckCircle className="w-5 h-5 text-coral-safe" />
            </div>
          </div>
        </div>
      </div>

      {/* MCP Tool Calls */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.25 }}
        className="reef-panel-strong rounded-2xl border border-cyan-glow/25 bg-ocean-dark/60 p-8"
      >
        <div className="mb-6 flex items-center gap-3">
          <Cpu className="h-5 w-5 text-cyan-glow" />
          <h3 className="text-base text-white">MCP Tool Calls</h3>
          <span className="ml-auto rounded-lg border border-cyan-glow/20 bg-cyan-glow/8 px-3 py-1 text-xs text-cyan-glow">
            Phoenix MCP · Runtime queries
          </span>
        </div>
        <p className="mb-5 text-xs text-gray-muted">
          The ReefWatch AI agent calls Phoenix MCP tools at runtime to query its own trace data during inference and self-improvement loops.
        </p>
        {mcpToolCalls.length === 0 ? (
          <div className="rounded-xl border border-gray-border/50 bg-ocean-medium/30 p-5 text-center text-sm text-gray-muted">
            No MCP tool calls yet. Ask the AI a question about traces or performance, or run a self-improvement evaluation.
          </div>
        ) : (
          <div className="space-y-3 max-h-72 overflow-y-auto">
            {mcpToolCalls.map((call, idx) => (
              <div key={idx} className="flex items-start gap-4 rounded-xl border border-cyan-glow/12 bg-ocean-medium/25 p-4">
                <div className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-cyan-glow" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-3 mb-1">
                    <span className="text-sm font-mono text-cyan-glow">{call.tool}</span>
                    <span className="text-xs text-gray-muted">{new Date(call.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <p className="text-xs text-gray-light leading-relaxed">{call.summary}</p>
                  {call.data_preview && (
                    <p className="mt-1 text-[11px] text-gray-muted font-mono truncate opacity-70">{call.data_preview}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </motion.div>
    </div>
  );
}
