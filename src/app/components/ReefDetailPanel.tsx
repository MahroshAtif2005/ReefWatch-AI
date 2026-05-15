import { motion } from 'motion/react';
import { X, MapPin, Thermometer, Activity, TrendingUp, TrendingDown, Brain, FileDown } from 'lucide-react';

interface ReefData {
  id: string;
  name: string;
  lat: number;
  lng: number;
  risk: 'safe' | 'warning' | 'critical';
  temperature: number | null;
  bleachingRisk: number;
  tempAnomaly?: number | null;
  degreeHeatingWeeks?: number | null;
  bleachingAlertLevel?: string;
  source?: string;
  lastUpdated?: string;
  error?: string;
}

interface ReefDetailPanelProps {
  reef: ReefData | null;
  onClose: () => void;
}

export function ReefDetailPanel({ reef, onClose }: ReefDetailPanelProps) {
  if (!reef) return null;

  const getRiskColor = (risk: string) => {
    switch (risk) {
      case 'safe': return 'text-coral-safe';
      case 'warning': return 'text-coral-warning';
      case 'critical': return 'text-coral-critical';
      default: return 'text-gray-light';
    }
  };

  const getRiskBg = (risk: string) => {
    switch (risk) {
      case 'safe': return 'bg-coral-safe/10 border-coral-safe/30';
      case 'warning': return 'bg-coral-warning/10 border-coral-warning/30';
      case 'critical': return 'bg-coral-critical/10 border-coral-critical/30';
      default: return 'bg-ocean-medium border-gray-border';
    }
  };

  const formatNumber = (value: number | null | undefined, suffix = '') => {
    if (value === null || value === undefined) return 'Unavailable';
    return `${value}${suffix}`;
  };

  const anomalyLabel = reef.tempAnomaly === null || reef.tempAnomaly === undefined
    ? 'Anomaly unavailable'
    : `${reef.tempAnomaly > 0 ? '+' : ''}${reef.tempAnomaly}°C anomaly`;
  const thermalStressLabel = reef.tempAnomaly === null || reef.tempAnomaly === undefined
    ? 'unavailable'
    : reef.tempAnomaly > 0 ? 'elevated' : 'normal';

  const mockData = {
    confidence: reef.risk === 'critical' ? 94.2 : reef.risk === 'warning' ? 87.5 : 91.3,
    trend: reef.risk === 'critical' ? 'rising' : reef.risk === 'warning' ? 'stable' : 'falling',
    historicalComparison: 'Similar patterns observed during 2016 El Niño event',
    recommendation: reef.risk === 'critical'
      ? 'Immediate conservation intervention recommended. Deploy thermal stress monitoring buoys.'
      : reef.risk === 'warning'
      ? 'Enhanced monitoring advised. Prepare response protocols.'
      : 'Continue routine monitoring. Conditions favorable.',
  };

  return (
    <motion.div
      initial={{ x: '100%' }}
      animate={{ x: 0 }}
      exit={{ x: '100%' }}
      transition={{ type: 'spring', damping: 30, stiffness: 300 }}
      className="reef-panel-strong fixed right-0 top-0 h-full w-[540px] bg-ocean-dark/95 backdrop-blur-2xl border-l border-gray-border/70 shadow-2xl flex flex-col z-50"
    >
      {/* Header - More Spacious */}
      <div className="p-8 border-b border-gray-border/70">
        <div className="flex items-start justify-between mb-6">
          <div className="flex-1">
            <h2 className="text-3xl text-white mb-3">{reef.name}</h2>
            <div className="flex items-center gap-2 text-sm text-gray-muted">
              <MapPin className="w-4 h-4" />
              <span>{reef.lat.toFixed(2)}°N, {reef.lng.toFixed(2)}°E</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2.5 rounded-xl hover:bg-ocean-medium/60 transition-colors"
          >
            <X className="w-5 h-5 text-gray-light" />
          </button>
        </div>

        {/* Risk Badge - Larger */}
        <div className={`inline-flex items-center gap-3 px-5 py-3 rounded-xl border ${getRiskBg(reef.risk)}`}>
          <Activity className={`w-5 h-5 ${getRiskColor(reef.risk)}`} />
          <div>
            <span className={`block capitalize ${getRiskColor(reef.risk)}`}>
              {reef.risk}
            </span>
            <span className="text-xs text-gray-muted">{reef.bleachingRisk}% Bleaching Risk</span>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-8 space-y-8">
        {/* Key Metrics - Larger */}
        <div className="grid grid-cols-2 gap-5">
          <div className="reef-panel p-6 rounded-2xl bg-ocean-medium/65 border border-gray-border/70">
            <div className="flex items-center gap-2 mb-3">
              <Thermometer className="w-4 h-4 text-coral-warning" />
              <span className="text-xs uppercase tracking-wider text-gray-muted">Temperature</span>
            </div>
            <p className="text-3xl text-white mb-2">{formatNumber(reef.temperature, '°C')}</p>
            <p className="text-sm text-coral-warning">
              {anomalyLabel}
            </p>
          </div>

          <div className="reef-panel p-6 rounded-2xl bg-ocean-medium/65 border border-gray-border/70">
            <div className="flex items-center gap-2 mb-3">
              <Activity className="w-4 h-4 text-cyan-glow" />
              <span className="text-xs uppercase tracking-wider text-gray-muted">DHW Index</span>
            </div>
            <p className="text-3xl text-white mb-2">{formatNumber(reef.degreeHeatingWeeks)}</p>
            <p className="text-sm text-gray-muted">Heating Weeks</p>
          </div>
        </div>

        {/* AI Confidence - More Prominent */}
        <div className="reef-panel-strong p-6 rounded-2xl bg-ocean-medium/65 border border-gray-border/70">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <Brain className="w-5 h-5 text-cyan-glow" />
              <span className="text-sm text-white">AI Confidence</span>
            </div>
            <span className="text-2xl text-cyan-glow">{mockData.confidence}%</span>
          </div>
          <div className="w-full h-2.5 bg-ocean-deep rounded-full overflow-hidden">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${mockData.confidence}%` }}
              transition={{ duration: 1, ease: 'easeOut' }}
              className="h-full bg-gradient-to-r from-cyan-bright to-cyan-glow rounded-full"
              style={{ boxShadow: '0 0 12px rgba(0, 212, 255, 0.5)' }}
            />
          </div>
        </div>

        {/* Trend - Cleaner */}
        <div className="reef-panel p-6 rounded-xl bg-ocean-medium/60 border border-gray-border/70">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {mockData.trend === 'rising' ? (
                <TrendingUp className="w-5 h-5 text-coral-critical" />
              ) : mockData.trend === 'falling' ? (
                <TrendingDown className="w-5 h-5 text-coral-safe" />
              ) : (
                <Activity className="w-5 h-5 text-coral-warning" />
              )}
              <span className="text-sm text-white">7-Day Trend</span>
            </div>
            <p className={`capitalize ${
              mockData.trend === 'rising' ? 'text-coral-critical' :
              mockData.trend === 'falling' ? 'text-coral-safe' :
              'text-coral-warning'
            }`}>
              {mockData.trend}
            </p>
          </div>
        </div>

        {/* AI Analysis Summary - More Spacious */}
        <div className="reef-panel-strong p-6 rounded-2xl bg-gradient-to-br from-cyan-glow/7 to-blue-ocean/7 border border-cyan-glow/25">
          <h3 className="text-sm uppercase tracking-wider text-gray-muted mb-4 flex items-center gap-2">
            <Brain className="w-4 h-4 text-cyan-glow" />
            AI Analysis
          </h3>
          <p className="text-base text-gray-light leading-relaxed mb-4">
            Autonomous analysis indicates {reef.risk} bleaching conditions with {mockData.confidence}% confidence.
            Current sea surface temperature of {formatNumber(reef.temperature, '°C')} shows {thermalStressLabel} thermal stress.
          </p>
          <p className="text-sm text-gray-muted italic">
            {mockData.historicalComparison}
          </p>
        </div>

        {/* Explainability - Cleaner */}
        <div className="space-y-4">
          <h3 className="text-sm uppercase tracking-wider text-gray-muted">Explanation</h3>
          <div className="space-y-3">
            <div className="reef-panel-soft p-4 rounded-xl bg-ocean-medium/45 border border-gray-border/70">
              <p className="text-xs uppercase tracking-wider text-gray-muted mb-2">Data Source</p>
              <p className="text-sm text-gray-light">NOAA Coral Reef Watch thermal satellite imagery</p>
            </div>
            <div className="reef-panel-soft p-4 rounded-xl bg-ocean-medium/45 border border-gray-border/70">
              <p className="text-xs uppercase tracking-wider text-gray-muted mb-2">Historical Context</p>
              <p className="text-sm text-gray-light">Matched against 2016, 2020 bleaching events</p>
            </div>
            <div className="reef-panel-soft p-4 rounded-xl bg-ocean-medium/45 border border-gray-border/70">
              <p className="text-xs uppercase tracking-wider text-gray-muted mb-2">Factors Analyzed</p>
              <p className="text-sm text-gray-light">DHW threshold, SST anomaly, regional patterns</p>
            </div>
          </div>
        </div>

        {/* Recommendation - More Prominent */}
        <div className={`reef-panel-strong p-6 rounded-2xl border ${getRiskBg(reef.risk)}`}>
          <h3 className="text-sm uppercase tracking-wider text-gray-muted mb-3">Recommended Action</h3>
          <p className="text-base text-gray-light leading-relaxed">
            {mockData.recommendation}
          </p>
        </div>
      </div>

      {/* Footer Actions - More Spacious */}
      <div className="p-8 border-t border-gray-border/70">
        <button className="reef-panel-strong w-full flex items-center justify-center gap-3 px-6 py-4 bg-cyan-glow hover:bg-cyan-bright text-ocean-deep rounded-xl transition-all hover:shadow-lg hover:shadow-cyan-glow/20">
          <FileDown className="w-5 h-5" />
          <span className="font-medium">Generate Conservation Brief</span>
        </button>
      </div>
    </motion.div>
  );
}
