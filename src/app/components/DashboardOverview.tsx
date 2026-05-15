import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { AlertTriangle, TrendingUp, Droplet, Activity, ArrowRight, MapPin } from 'lucide-react';
import { fetchLiveReefs, type LiveReef } from '../services/reefApi';

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
});

export function DashboardOverview({ onNavigate }: DashboardOverviewProps) {
  const [reefs, setReefs] = useState<LiveReef[]>([]);
  const [isLoadingReefs, setIsLoadingReefs] = useState(true);
  const [reefError, setReefError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadLiveReefs() {
      try {
        const liveReefs = await fetchLiveReefs();

        if (isMounted) {
          setReefs(liveReefs);
          setReefError(null);
        }
      } catch (error) {
        if (isMounted) {
          setReefError('Live reef data is unavailable. Start the local backend on port 4000 to reconnect.');
        }
      } finally {
        if (isMounted) {
          setIsLoadingReefs(false);
        }
      }
    }

    loadLiveReefs();

    return () => {
      isMounted = false;
    };
  }, []);

  const reefStats = useMemo(() => ({
    total: reefs.length,
    critical: reefs.filter((reef) => reef.status === 'critical').length,
    warning: reefs.filter((reef) => reef.status === 'warning').length,
    healthy: reefs.filter((reef) => reef.status === 'safe').length,
  }), [reefs]);

  const alertReefs = useMemo(() => {
    return [...reefs]
      .sort((a, b) => b.riskScore - a.riskScore)
      .slice(0, 3);
  }, [reefs]);

  const statValue = (value: number) => isLoadingReefs ? '...' : value;

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-7xl mx-auto p-12 space-y-12">
        {/* Hero Stats */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <h1 className="text-4xl text-white mb-3">Global Reef Status</h1>
          <p className="text-gray-muted mb-12">Real-time environmental intelligence across {statValue(reefStats.total)} monitored locations</p>

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
              <p className="text-5xl text-white mb-2">{statValue(reefStats.total)}</p>
              <p className="text-sm text-gray-light">Reef locations</p>
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
              <p className="text-5xl text-coral-critical mb-2">{statValue(reefStats.critical)}</p>
              <p className="text-sm text-gray-light">Urgent attention needed</p>
            </motion.div>

            <motion.div
              whileHover={{ y: -4 }}
              className="reef-panel-strong p-8 rounded-2xl bg-gradient-to-br from-coral-warning/12 to-ocean-dark/95 border border-coral-warning/45 cursor-pointer"
              onClick={() => onNavigate('trends')}
            >
              <div className="flex items-center gap-3 mb-4">
                <TrendingUp className="w-6 h-6 text-coral-warning" />
                <span className="text-sm text-gray-muted">Warning Level</span>
              </div>
              <p className="text-5xl text-coral-warning mb-2">{statValue(reefStats.warning)}</p>
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
              <p className="text-5xl text-coral-safe mb-2">{statValue(reefStats.healthy)}</p>
              <p className="text-sm text-gray-light">Normal conditions</p>
            </motion.div>
          </div>

          {reefError && (
            <div className="mt-6 text-sm text-coral-warning">
              {reefError}
            </div>
          )}
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
                No live reef alerts are available right now.
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

        {/* Recent Insights */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl text-white">AI Insights</h2>
            <button
              onClick={() => onNavigate('analysis')}
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
