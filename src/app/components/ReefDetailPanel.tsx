import { useState } from 'react';
import { motion } from 'motion/react';
import { X, MapPin, Thermometer, Activity, TrendingUp, TrendingDown, Brain, FileDown, Loader2, Printer } from 'lucide-react';
import { generateConservationBrief, normalizeBleachingAlertLevel } from '../services/reefApi';

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

function renderMarkdown(markdown: string) {
  const lines = markdown.split('\n');
  const nodes = [];
  let listItems: string[] = [];

  const flushList = () => {
    if (listItems.length > 0) {
      nodes.push(
        <ul key={`list-${nodes.length}`} className="my-4 space-y-2 list-disc pl-6 text-gray-light">
          {listItems.map((item, index) => (
            <li key={`${item}-${index}`}>{item.replace(/^[-*]\s*/, '')}</li>
          ))}
        </ul>
      );
      listItems = [];
    }
  };

  lines.forEach((line, index) => {
    const trimmed = line.trim();

    if (!trimmed) {
      flushList();
      return;
    }

    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      listItems.push(trimmed);
      return;
    }

    flushList();

    if (trimmed.startsWith('## ')) {
      nodes.push(
        <h2 key={index} className="mt-7 mb-3 text-2xl text-white">
          {trimmed.replace(/^##\s*/, '')}
        </h2>
      );
    } else if (trimmed.startsWith('# ')) {
      nodes.push(
        <h1 key={index} className="mb-4 text-3xl text-white">
          {trimmed.replace(/^#\s*/, '')}
        </h1>
      );
    } else {
      nodes.push(
        <p key={index} className="mb-3 leading-7 text-gray-light">
          {trimmed}
        </p>
      );
    }
  });

  flushList();
  return nodes;
}

export function ReefDetailPanel({ reef, onClose }: ReefDetailPanelProps) {
  const [briefMarkdown, setBriefMarkdown] = useState<string | null>(null);
  const [isGeneratingBrief, setIsGeneratingBrief] = useState(false);
  const [briefError, setBriefError] = useState<string | null>(null);

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
  const bleachingAlertLevel = normalizeBleachingAlertLevel(
    reef.bleachingAlertLevel,
    reef.degreeHeatingWeeks,
  );

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

  async function handleGenerateBrief() {
    setIsGeneratingBrief(true);
    setBriefError(null);

    try {
      const response = await generateConservationBrief({
        reef_id: reef.id,
        reef_name: reef.name,
        sst: reef.temperature,
        anomaly: reef.tempAnomaly ?? null,
        dhw: reef.degreeHeatingWeeks ?? null,
        alert_level: bleachingAlertLevel,
        risk_score: reef.bleachingRisk,
      });
      setBriefMarkdown(response.brief);
    } catch {
      setBriefError('Unable to generate the conservation brief from the deployed ReefWatch backend.');
    } finally {
      setIsGeneratingBrief(false);
    }
  }

  return (
    <>
      <style>{`
        @media print {
          body * { visibility: hidden; }
          #reef-detail-print-brief, #reef-detail-print-brief * { visibility: visible; }
          #reef-detail-print-brief {
            position: absolute;
            inset: 0;
            width: 100%;
            padding: 32px;
            color: #0b3d52;
            background: white;
          }
          #reef-detail-print-brief h1,
          #reef-detail-print-brief h2,
          #reef-detail-print-brief p,
          #reef-detail-print-brief li { color: #0b3d52 !important; }
          .print-hidden { display: none !important; }
        }
      `}</style>

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

        <div className="reef-panel-soft rounded-xl border border-gray-border/70 bg-ocean-medium/45 p-5">
          <p className="mb-2 text-xs uppercase tracking-wider text-gray-muted">Bleaching Alert Level</p>
          <p className="text-xl text-white">{bleachingAlertLevel}</p>
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
        {briefError && (
          <p className="mb-3 rounded-xl border border-coral-warning/30 bg-coral-warning/10 px-4 py-3 text-sm text-coral-warning">
            {briefError}
          </p>
        )}
        <button
          onClick={handleGenerateBrief}
          disabled={isGeneratingBrief}
          className="reef-panel-strong w-full flex items-center justify-center gap-3 px-6 py-4 bg-cyan-glow hover:bg-cyan-bright text-ocean-deep rounded-xl transition-all hover:shadow-lg hover:shadow-cyan-glow/20 disabled:cursor-not-allowed disabled:opacity-70"
        >
          {isGeneratingBrief ? <Loader2 className="w-5 h-5 animate-spin" /> : <FileDown className="w-5 h-5" />}
          <span className="font-medium">{isGeneratingBrief ? 'Generating Brief' : 'Generate Conservation Brief'}</span>
        </button>
      </div>

      </motion.div>

      {briefMarkdown && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[60] flex items-center justify-center bg-ocean-deep/70 p-8 backdrop-blur-xl"
        >
          <motion.div
            initial={{ y: 18, scale: 0.98 }}
            animate={{ y: 0, scale: 1 }}
            className="reef-panel-strong flex max-h-[86vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-gray-border/70 bg-ocean-dark/96"
          >
            <div className="print-hidden flex items-center justify-between border-b border-gray-border/70 p-6">
              <div>
                <h3 className="text-2xl text-white">Conservation Brief</h3>
                <p className="text-sm text-gray-muted">{reef.name}</p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => window.print()}
                  className="inline-flex items-center gap-2 rounded-xl border border-cyan-glow/20 bg-ocean-medium/35 px-4 py-2 text-sm text-cyan-glow transition hover:bg-cyan-glow/10"
                >
                  <Printer className="h-4 w-4" />
                  Download as PDF
                </button>
                <button
                  onClick={() => setBriefMarkdown(null)}
                  className="rounded-xl p-2.5 transition hover:bg-ocean-medium/60"
                >
                  <X className="h-5 w-5 text-gray-light" />
                </button>
              </div>
            </div>

            <article id="reef-detail-print-brief" className="overflow-auto p-8">
              {renderMarkdown(briefMarkdown)}
            </article>
          </motion.div>
        </motion.div>
      )}
    </>
  );
}
