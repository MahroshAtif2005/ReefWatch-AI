import { Component, useEffect, useMemo, type ErrorInfo, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { AlertTriangle, TrendingUp, Droplet, Activity, ArrowRight, Loader2, MapPin, RefreshCw, Radio } from 'lucide-react';
import { type LiveReef } from '../services/reefApi';
import { useReefData } from '../context/ReefDataContext';
import { SelfImprovementCard } from './SelfImprovementCard';

class CardErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('[CardErrorBoundary]', error, info); }
  render() {
    if (this.state.error) {
      return (
        <div className="rounded-2xl border border-coral-critical/30 bg-coral-critical/5 p-6 text-sm text-coral-critical">
          <div className="mb-1 flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4" />
            Self-Improvement card failed to load
          </div>
          <p className="text-gray-muted">{(this.state.error as Error).message}</p>
        </div>
      );
    }
    return this.state.error === null ? this.props.children : null;
  }
}

interface DashboardOverviewProps {
  onNavigate: (view: string, reef?: any) => void;
}

const recentInsights = [
  {
    title: 'Thermal Stress Rising',
    description: 'Pacific sector showing 15% increase in bleaching risk over past 7 days',
    severity: 'high',
    time: '2 hours ago',
  },
  {
    title: 'Model Confidence High',
    description: 'AI prediction accuracy at 94.2% across all monitored locations',
    severity: 'good',
    time: '4 hours ago',
  },
  {
    title: 'Historical Pattern Match',
    description: 'Current conditions similar to 2016 El Niño bleaching event',
    severity: 'warning',
    time: '6 hours ago',
  },
];

const toNavigationReef = (reef: LiveReef) => ({
  id: reef.id,
  name: reef.name,
  lat: reef.lat,
  lng: reef.lng,
  risk: reef.riskScore,
  temp: reef.seaSurfaceTemp,
  tempAnomaly: reef.tempAnomaly,
  degreeHeatingWeeks: reef.degreeHeatingWeeks,
  bleachingAlertLevel: reef.bleachingAlertLevel,
  source: reef.source,
  lastUpdated: reef.lastUpdated,
  error: reef.error,
});

export function DashboardOverview({ onNavigate }: DashboardOverviewProps) {
  const { allReefs, activeReefs, activeReefIds, storageAvailable, totalStationCount, isLoading: isLoadingReefs, error: reefError, refetch } = useReefData();

  // total = full user selection (including reefs not yet matched to NOAA data).
  // critical/warning/healthy are derived only from matched reefs that have live status.
  const reefStats = useMemo(() => ({
    total: activeReefIds.length,
    critical: activeReefs.filter((reef) => reef.status === 'critical').length,
    warning: activeReefs.filter((reef) => reef.status === 'warning').length,
    healthy: activeReefs.filter((reef) => reef.status === 'safe').length,
  }), [activeReefIds, activeReefs]);

  // UI display only — highest-risk NOAA reefs on the dashboard overview.
  const alertReefs = useMemo(() => {
    return [...allReefs]
      .filter((reef) => reef.status === 'critical' || reef.status === 'warning' || reef.riskScore >= 40)
      .sort((a, b) => b.riskScore - a.riskScore)
      .slice(0, 3);
  }, [allReefs]);

  // dataReady: NOAA data has finished loading (or returned at least one reef).
  // Used only for critical/warning/healthy counts which depend on live NOAA status.
  // The total selection count (activeReefIds) is always available immediately from localStorage.
  const dataReady = !isLoadingReefs || allReefs.length > 0;
  // Only the status-derived stats (critical/warning/healthy) need to wait for NOAA data.
  const statusStatValue = (value: number): number | string => dataReady ? value : '...';

  // IDs that exist in localStorage but couldn't be matched to any reef returned by the backend.
  // Only meaningful after data has loaded. During loading: all selected IDs are "pending".
  const orphanedCount = dataReady
    ? activeReefIds.filter(id => !allReefs.find(r => r.id === id)).length
    : 0;
  // During loading, selected IDs count as pending until NOAA data arrives.
  const pendingCount = !dataReady ? activeReefIds.length : orphanedCount;
  const liveCount = !dataReady ? 0 : activeReefs.length;

  // Sub-label for the Active Monitoring card — shows detailed breakdown as soon as possible.
  const activeMonitoringSubLabel = !dataReady && activeReefIds.length > 0
    ? 'Loading live NOAA status…'
    : pendingCount > 0
    ? `${liveCount} live · ${pendingCount} pending NOAA`
    : activeReefIds.length > 0
    ? 'Actively monitored'
    : 'No reefs selected';

  // Debug logs at dashboard level
  useEffect(() => {
    console.log(
      '[active-reefs] selected local ids:', activeReefIds.length, activeReefIds,
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (dataReady) {
      const matched = activeReefs.map(r => r.id);
      const orphaned = activeReefIds.filter(id => !allReefs.find(r => r.id === id));
      console.log('[active-reefs] matched live ids:', matched.length, matched);
      console.log('[active-reefs] orphan/pending ids:', orphaned.length, orphaned);
    }
  }, [dataReady]);

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-7xl mx-auto p-12 space-y-12">
        {/* Hero Stats */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <h1 className="text-4xl text-white mb-3">Global Reef Status</h1>
          <p className="text-gray-muted mb-12">{totalStationCount > 0 ? totalStationCount : '...'} NOAA reef stations monitored globally · {reefStats.total} under deep AI analysis</p>

          <div className="grid grid-cols-4 gap-6">
            <motion.div
              whileHover={{ y: -4 }}
              className="reef-panel p-8 rounded-2xl bg-gradient-to-br from-ocean-medium/90 to-ocean-dark/95 border border-gray-border/70 cursor-pointer"
              onClick={() => onNavigate('map')}
            >
              <div className="flex items-center gap-3 mb-4">
                <Activity className="w-6 h-6 text-cyan-glow" />
                <span className="text-sm text-gray-muted">Active Monitoring</span>
              </div>
              <p className="text-5xl text-white mb-2">{reefStats.total}</p>
              <p className="text-sm text-gray-light">{activeMonitoringSubLabel}</p>
            </motion.div>

            <motion.div
              whileHover={{ y: -4 }}
              className="reef-panel-strong p-8 rounded-2xl bg-gradient-to-br from-coral-critical/12 to-ocean-dark/95 border border-coral-critical/45 cursor-pointer"
              onClick={() => onNavigate('map')}
            >
              <div className="flex items-center gap-3 mb-4">
                <AlertTriangle className="w-6 h-6 text-coral-critical" />
                <span className="text-sm text-gray-muted">Critical Risk</span>
              </div>
              <p className="text-5xl text-coral-critical mb-2">{statusStatValue(reefStats.critical)}</p>
              <p className="text-sm text-gray-light">Urgent attention needed</p>
            </motion.div>

            <motion.div
              whileHover={{ y: -4 }}
              className="reef-panel-strong p-8 rounded-2xl bg-gradient-to-br from-coral-warning/12 to-ocean-dark/95 border border-coral-warning/45 cursor-pointer"
              onClick={() => onNavigate('analytics')}
            >
              <div className="flex items-center gap-3 mb-4">
                <TrendingUp className="w-6 h-6 text-coral-warning" />
                <span className="text-sm text-gray-muted">Warning Level</span>
              </div>
              <p className="text-5xl text-coral-warning mb-2">{statusStatValue(reefStats.warning)}</p>
              <p className="text-sm text-gray-light">Elevated stress detected</p>
            </motion.div>

            <motion.div
              whileHover={{ y: -4 }}
              className="reef-panel-strong p-8 rounded-2xl bg-gradient-to-br from-coral-safe/12 to-ocean-dark/95 border border-coral-safe/45 cursor-pointer"
              onClick={() => onNavigate('map')}
            >
              <div className="flex items-center gap-3 mb-4">
                <Droplet className="w-6 h-6 text-coral-safe" />
                <span className="text-sm text-gray-muted">Healthy Reefs</span>
              </div>
              <p className="text-5xl text-coral-safe mb-2">{statusStatValue(reefStats.healthy)}</p>
              <p className="text-sm text-gray-light">Normal conditions</p>
            </motion.div>
          </div>

          {reefError && (
            <div className="mt-6 flex items-center gap-4 text-sm text-coral-warning">
              <span>{reefError}</span>
              <button
                onClick={refetch}
                className="inline-flex items-center gap-2 rounded-lg border border-coral-warning/30 bg-coral-warning/10 px-3 py-1.5 text-coral-warning transition hover:bg-coral-warning/20"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Retry
              </button>
            </div>
          )}

          {/* Loading banner — only shown when reefs are selected and data is still in flight.
               Never shown when activeReefIds is empty — there's nothing to load yet. */}
          {!dataReady && activeReefIds.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.06 }}
              className="mt-8 flex items-center gap-4 rounded-2xl border border-cyan-glow/25 bg-ocean-medium/60 p-6"
            >
              <Loader2 className="h-5 w-5 shrink-0 animate-spin text-cyan-glow" />
              <span className="text-sm text-gray-light">Loading reef data…</span>
            </motion.div>
          )}

          {/* Orphaned IDs warning — shown when some saved reef IDs couldn't be matched after loading.
               IDs are preserved in storage; this is display-only, never a deletion. */}
          {dataReady && orphanedCount > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-6 flex items-center gap-3 rounded-xl border border-coral-warning/30 bg-coral-warning/6 px-5 py-3"
            >
              <AlertTriangle className="h-4 w-4 shrink-0 text-coral-warning" />
              <span className="text-sm text-coral-warning">
                {activeReefs.length} active reef{activeReefs.length !== 1 ? 's' : ''} matched live NOAA data
                {'; '}{orphanedCount} saved reef{orphanedCount !== 1 ? 's' : ''} could not be matched (IDs preserved — selections will restore when NOAA data is available).
              </span>
            </motion.div>
          )}

          {/* Onboarding card — shown immediately when no reefs are selected (no waiting for
               dataReady). First-time users and incognito sessions see this right away. */}
          {activeReefIds.length === 0 && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.06 }}
              className="mt-8 rounded-2xl border border-cyan-glow/30 bg-gradient-to-br from-cyan-glow/8 to-ocean-dark/60 p-8"
            >
              <div className="flex items-start gap-5">
                <div className="mt-1 flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-cyan-glow/35 bg-cyan-glow/12">
                  <Radio className="h-6 w-6 text-cyan-glow" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-xl text-white mb-1">No reefs being monitored yet</h3>
                  <p className="text-sm text-gray-muted mb-6">To start monitoring coral reefs:</p>

                  <ol className="mb-6 space-y-2 text-sm text-gray-light">
                    <li className="flex items-start gap-3">
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-cyan-glow/40 bg-cyan-glow/10 text-xs text-cyan-glow font-medium">1</span>
                      Open the <button onClick={() => onNavigate('map')} className="text-cyan-glow underline underline-offset-2 hover:text-cyan-bright transition-colors">Live Reef Map</button>
                    </li>
                    <li className="flex items-start gap-3">
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-cyan-glow/40 bg-cyan-glow/10 text-xs text-cyan-glow font-medium">2</span>
                      Select one or more reef stations
                    </li>
                    <li className="flex items-start gap-3">
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-cyan-glow/40 bg-cyan-glow/10 text-xs text-cyan-glow font-medium">3</span>
                      Click <span className="rounded-md border border-gray-border/50 bg-ocean-medium/60 px-1.5 py-0.5 text-xs text-white">Save Monitoring Selection</span>
                    </li>
                  </ol>

                  <div className="mb-6 rounded-xl border border-cyan-glow/15 bg-ocean-deep/40 px-4 py-3">
                    <p className="mb-2 text-xs text-gray-muted">ReefWatch AI will then:</p>
                    <ul className="space-y-1.5 text-sm text-gray-light">
                      <li className="flex items-center gap-2"><span className="text-cyan-glow">•</span> Track those reefs on the dashboard</li>
                      <li className="flex items-center gap-2"><span className="text-cyan-glow">•</span> Generate AI risk assessments</li>
                      <li className="flex items-center gap-2"><span className="text-cyan-glow">•</span> Include them in conservation reports</li>
                      <li className="flex items-center gap-2"><span className="text-cyan-glow">•</span> Send alerts when risk becomes critical</li>
                    </ul>
                  </div>

                  <button
                    onClick={() => onNavigate('map')}
                    className="inline-flex items-center gap-2 rounded-xl border border-cyan-glow/50 bg-cyan-glow/15 px-5 py-2.5 text-sm text-cyan-glow transition hover:bg-cyan-glow/25 hover:border-cyan-glow/70"
                  >
                    <MapPin className="h-4 w-4" />
                    Go to Live Reef Map
                    <ArrowRight className="h-4 w-4" />
                  </button>

                  {/* Private-browsing note embedded in onboarding card */}
                  {!storageAvailable && (
                    <div className="mt-5 flex items-start gap-3 rounded-xl border border-coral-warning/30 bg-coral-warning/6 px-4 py-3">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-coral-warning" />
                      <p className="text-sm text-gray-light leading-relaxed">
                        <span className="font-medium text-coral-warning">Private browsing detected.</span>{' '}
                        Monitoring selections may not persist — local storage is disabled or cleared automatically in private mode.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          )}

          {/* Private-browsing warning for users who already have reefs selected */}
          {activeReefIds.length > 0 && !storageAvailable && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.07 }}
              className="mt-4 flex items-start gap-4 rounded-2xl border border-coral-warning/30 bg-coral-warning/6 p-5"
            >
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-coral-warning" />
              <div>
                <p className="text-sm text-white mb-1">Private browsing detected</p>
                <p className="text-sm text-gray-light leading-relaxed">
                  Active reef selections will work during this session but won't be saved after you close the browser window.
                </p>
              </div>
            </motion.div>
          )}
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.08 }}
        >
          <CardErrorBoundary><SelfImprovementCard /></CardErrorBoundary>
        </motion.div>

        {/* Critical Alerts Section */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
        >
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl text-white">Critical Alerts</h2>
            <button
              onClick={() => onNavigate('map')}
              className="text-sm text-cyan-glow hover:text-cyan-bright flex items-center gap-2 transition-colors"
            >
              View All on Map
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>

          <div className="grid gap-4">
            {isLoadingReefs && (
              <div className="reef-panel-strong p-6 rounded-xl bg-ocean-medium/75 border border-gray-border/70 text-sm text-gray-light">
                Loading live reef conditions...
              </div>
            )}

            {!isLoadingReefs && alertReefs.length === 0 && (
              <div className="reef-panel-strong p-6 rounded-xl bg-ocean-medium/75 border border-gray-border/70 text-sm text-gray-light">
                No monitored reefs are currently in warning or critical status.
              </div>
            )}

            {alertReefs.map((reef, i) => (
              <motion.div
                key={reef.id}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.1 }}
                whileHover={{ x: 4 }}
                onClick={() => onNavigate('map', toNavigationReef(reef))}
                className="reef-panel-strong p-6 rounded-xl bg-ocean-medium/75 border border-coral-critical/45 hover:border-coral-critical/60 cursor-pointer transition-all"
              >
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="text-lg text-white">{reef.name}</h3>
                      <span className="px-3 py-1 rounded-lg bg-coral-critical/10 text-coral-critical text-xs border border-coral-critical/30">
                        {reef.riskScore}% Risk
                      </span>
                    </div>
                    <div className="flex items-center gap-4 text-sm text-gray-light">
                      <div className="flex items-center gap-2">
                        <MapPin className="w-4 h-4" />
                        <span>{reef.region}, {reef.country}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span>Sea Temp: {reef.seaSurfaceTemp ?? 'Unavailable'}{reef.seaSurfaceTemp !== null ? '°C' : ''}</span>
                      </div>
                    </div>
                  </div>
                  <ArrowRight className="w-5 h-5 text-gray-muted" />
                </div>
              </motion.div>
            ))}
          </div>
        </motion.div>

        {/* Monitored Reefs Section */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.16 }}
        >
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl text-white">Monitored Reefs</h2>
            <button
              onClick={() => onNavigate('map')}
              className="text-sm text-cyan-glow hover:text-cyan-bright flex items-center gap-2 transition-colors"
            >
              Add from Map
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>

          {activeReefs.length === 0 ? (
            <div className="reef-panel-strong rounded-2xl border border-cyan-glow/25 bg-ocean-medium/60 p-8 text-sm leading-relaxed text-gray-light">
              <div className="mb-3 flex items-center gap-3 text-white">
                <Radio className="h-5 w-5 text-cyan-glow" />
                No reefs are actively monitored yet
              </div>
              Open the global NOAA map, select a reef location, and click Start Monitoring to enable AI analysis, alerts, and briefs for that reef.
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {activeReefs.map((reef) => (
                <button
                  key={reef.id}
                  onClick={() => onNavigate('map', toNavigationReef(reef))}
                  className="reef-panel-strong rounded-xl border border-cyan-glow/16 bg-ocean-medium/55 p-5 text-left transition hover:border-cyan-glow/40 hover:bg-ocean-medium/70"
                >
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <span className="text-white">{reef.name}</span>
                    <span className={`rounded-lg border px-2 py-1 text-[11px] capitalize ${
                      reef.status === 'critical'
                        ? 'border-coral-critical/35 bg-coral-critical/10 text-coral-critical'
                        : reef.status === 'warning'
                        ? 'border-coral-warning/35 bg-coral-warning/10 text-coral-warning'
                        : 'border-coral-safe/35 bg-coral-safe/10 text-coral-safe'
                    }`}>
                      {reef.status}
                    </span>
                  </div>
                  <p className="text-xs text-gray-muted">
                    DHW {reef.degreeHeatingWeeks ?? 'Unavailable'} · Risk {reef.riskScore}%
                  </p>
                </button>
              ))}
            </div>
          )}
        </motion.div>

        {/* Recent Insights */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl text-white">AI Insights</h2>
            <button
              onClick={() => onNavigate('analytics')}
              className="text-sm text-cyan-glow hover:text-cyan-bright flex items-center gap-2 transition-colors"
            >
              View Analysis
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-3 gap-6">
            {recentInsights.map((insight, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3 + i * 0.1 }}
                whileHover={{ y: -4 }}
                className={`reef-panel p-6 rounded-xl border cursor-pointer transition-all ${
                  insight.severity === 'high'
                    ? 'bg-coral-critical/7 border-coral-critical/45 hover:border-coral-critical/60'
                    : insight.severity === 'warning'
                    ? 'bg-coral-warning/7 border-coral-warning/45 hover:border-coral-warning/60'
                    : 'bg-coral-safe/7 border-coral-safe/45 hover:border-coral-safe/60'
                }`}
              >
                <h3 className="text-white mb-2">{insight.title}</h3>
                <p className="text-sm text-gray-light mb-4 leading-relaxed">{insight.description}</p>
                <span className="text-xs text-gray-muted">{insight.time}</span>
              </motion.div>
            ))}
          </div>
        </motion.div>

        {/* Quick Actions */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="grid grid-cols-2 gap-6"
        >
          <button
            onClick={() => onNavigate('map')}
            className="reef-panel-strong p-8 rounded-2xl bg-gradient-to-br from-cyan-glow/12 to-ocean-dark/95 border border-cyan-glow/45 hover:border-cyan-glow/60 transition-all text-left group"
          >
            <MapPin className="w-8 h-8 text-cyan-glow mb-4" />
            <h3 className="text-xl text-white mb-2">Explore Live Map</h3>
            <p className="text-sm text-gray-light mb-4">Interactive global reef monitoring with real-time data overlays</p>
            <span className="text-sm text-cyan-glow flex items-center gap-2 group-hover:gap-3 transition-all">
              Open Map
              <ArrowRight className="w-4 h-4" />
            </span>
          </button>

          <button
            onClick={() => onNavigate('reports')}
            className="reef-panel-strong p-8 rounded-2xl bg-gradient-to-br from-blue-ocean/12 to-ocean-dark/95 border border-blue-ocean/45 hover:border-blue-ocean/60 transition-all text-left group"
          >
            <TrendingUp className="w-8 h-8 text-blue-ocean mb-4" />
            <h3 className="text-xl text-white mb-2">Generate Report</h3>
            <p className="text-sm text-gray-light mb-4">AI-powered conservation briefs with actionable insights</p>
            <span className="text-sm text-blue-ocean flex items-center gap-2 group-hover:gap-3 transition-all">
              Create Report
              <ArrowRight className="w-4 h-4" />
            </span>
          </button>
        </motion.div>
      </div>
    </div>
  );
}
