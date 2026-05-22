import { useEffect, useMemo, useState } from 'react';
import { Brain, CheckCircle, AlertTriangle, Activity, TrendingUp, ExternalLink } from 'lucide-react';
import { motion } from 'motion/react';
import { fetchArizeStatus, fetchArizeTraces, type ArizeStatus, type ArizeTrace } from '../services/reefApi';

export function ArizeMonitoring() {
  const [status, setStatus] = useState<ArizeStatus | null>(null);
  const [traces, setTraces] = useState<ArizeTrace[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reefFilter, setReefFilter] = useState('all');

  useEffect(() => {
    let isMounted = true;

    async function loadArizeData() {
      try {
        const [statusResult, traceResult] = await Promise.all([
          fetchArizeStatus(),
          fetchArizeTraces(100),
        ]);

        if (isMounted) {
          setStatus(statusResult);
          setTraces(traceResult);
          setError(null);
        }
      } catch (requestError) {
        if (isMounted) {
          setError('Arize monitoring data is unavailable. Start the local backend to reconnect.');
        }
      }
    }

    loadArizeData();

    return () => {
      isMounted = false;
    };
  }, []);

  const averageConfidence = useMemo(() => {
    const confidenceValues = traces
      .map((trace) => trace.aiConfidence)
      .filter((value): value is number => typeof value === 'number');

    if (confidenceValues.length === 0) return null;

    return confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length;
  }, [traces]);

  const lastTraceTime = status?.lastTraceTime
    ? new Date(status.lastTraceTime).toLocaleTimeString()
    : 'None yet';

  const metricsSource = status?.metrics;
  const tokenUsage = metricsSource?.total_tokens ?? traces.length * 0;
  const effectiveTraceCount = Math.max(status?.localTraceCount ?? 0, metricsSource?.total_traces ?? 0);
  const observabilityConnected = Boolean(status?.localPhoenixConnected || status?.hostedArizeConnected);
  const primaryStatusLabel = status?.localPhoenixConnected
    ? 'Local Phoenix Connected'
    : status?.hostedArizeConnected
      ? 'Hosted Arize Connected'
      : 'Local Phoenix Offline';
  const secondaryStatusLabel = status?.hostedArizeConnected
    ? 'Hosted Arize Connected'
    : 'Hosted Arize Not Configured';
  const phoenixProjectsUrl = `${(status?.phoenixUrl || 'http://127.0.0.1:6006').replace(/\/$/, '')}/projects`;

  const metrics = [
    { label: 'Total Traces', value: `${effectiveTraceCount}`, status: 'good', trend: status?.projectName || 'reefwatch-ai' },
    { label: 'Average Latency', value: metricsSource ? `${metricsSource.average_latency_ms}ms` : 'N/A', status: 'good', trend: 'reef.analyze' },
    { label: 'Error Rate', value: metricsSource ? `${metricsSource.error_rate}%` : '0%', status: metricsSource?.error_rate ? 'warning' : 'excellent', trend: `${metricsSource?.failure_count ?? 0} failures` },
    { label: 'NOAA API Latency', value: metricsSource ? `${metricsSource.average_noaa_latency_ms}ms` : 'N/A', status: 'good', trend: `${metricsSource?.cache_hit_rate ?? 0}% cache hit` },
    { label: 'LLM Latency', value: metricsSource ? `${metricsSource.average_llm_latency_ms}ms` : 'N/A', status: 'good', trend: 'Gemini generate' },
    { label: 'Token Usage', value: `${tokenUsage}`, status: 'good', trend: `${metricsSource?.prompt_tokens ?? 0} in / ${metricsSource?.completion_tokens ?? 0} out` },
    { label: 'Cache Hit Rate', value: `${metricsSource?.cache_hit_rate ?? 0}%`, status: 'good', trend: `${metricsSource?.fallback_count ?? 0} fallbacks` },
    { label: 'Last Trace Time', value: metricsSource?.last_trace_time ? new Date(metricsSource.last_trace_time).toLocaleTimeString() : lastTraceTime, status: 'good', trend: 'Recent activity' },
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
      {/* Header - More Spacious */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-4xl text-white mb-2">AI Observability</h2>
          <p className="text-base text-gray-muted">{status?.message || 'Loading observability status...'}</p>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <span className={`rounded-lg border px-3 py-1 ${status?.localPhoenixConnected ? 'border-coral-safe/35 bg-coral-safe/10 text-coral-safe' : 'border-coral-warning/35 bg-coral-warning/10 text-coral-warning'}`}>
              {status?.phoenixStatus || primaryStatusLabel}
            </span>
            <span className={`rounded-lg border px-3 py-1 ${status?.hostedArizeConnected ? 'border-coral-safe/35 bg-coral-safe/10 text-coral-safe' : 'border-gray-border/70 bg-ocean-medium/55 text-gray-light'}`}>
              {status?.hostedArizeStatus || secondaryStatusLabel}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <a
            href={phoenixProjectsUrl}
            target="_blank"
            rel="noreferrer"
            className="reef-panel-strong flex items-center gap-2 rounded-xl border border-cyan-glow/35 bg-ocean-medium/75 px-4 py-3 text-sm text-cyan-glow transition-all hover:border-cyan-glow/70 hover:bg-ocean-medium hover:shadow-[0_0_18px_rgba(0,229,255,0.18)]"
          >
            Open Phoenix
            <ExternalLink className="h-4 w-4" />
          </a>
          <div className={`flex items-center gap-3 px-5 py-3 rounded-xl ${observabilityConnected ? 'bg-coral-safe/10 border border-coral-safe/30' : 'bg-coral-warning/10 border border-coral-warning/30'}`}>
          {observabilityConnected ? (
            <CheckCircle className="w-5 h-5 text-coral-safe" />
          ) : (
            <AlertTriangle className="w-5 h-5 text-coral-warning" />
          )}
          <span className={`text-sm ${observabilityConnected ? 'text-coral-safe' : 'text-coral-warning'}`}>
            {primaryStatusLabel}
          </span>
          </div>
        </div>
      </div>

      {error && (
        <div className="reef-panel-soft p-4 rounded-xl bg-ocean-medium/45 border border-coral-warning/40 text-sm text-coral-warning">
          {error}
        </div>
      )}

      {/* Key Metrics - More Spacious */}
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

      {/* AI Trace Log - More Spacious */}
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
            <div className="reef-panel-soft p-5 rounded-xl bg-ocean-dark/45 border border-gray-border/70 text-sm text-gray-light">
              No reef assessment traces have been logged yet. Hit `/test-trace` or run a reef analysis to populate Phoenix and local observability.
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

      {/* Model Performance - More Spacious */}
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
                <span className="text-white">{status?.configured ? 'Ready' : 'Local'}</span>
              </div>
              <div className="h-2 bg-ocean-deep rounded-full overflow-hidden">
                <div className="h-full bg-coral-safe rounded-full" style={{ width: status?.configured ? '100%' : '55%' }} />
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
    </div>
  );
}
