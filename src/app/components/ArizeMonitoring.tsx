import { Brain, CheckCircle, AlertTriangle, Activity, TrendingUp } from 'lucide-react';
import { motion } from 'motion/react';

export function ArizeMonitoring() {
  const metrics = [
    { label: 'Model Accuracy', value: '94.2%', status: 'excellent', trend: '+2.1%' },
    { label: 'Prediction Confidence', value: '91.8%', status: 'good', trend: '+0.8%' },
    { label: 'Hallucination Risk', value: '2.3%', status: 'excellent', trend: '-0.4%' },
    { label: 'Response Latency', value: '287ms', status: 'good', trend: '-12ms' },
  ];

  const traces = [
    { id: 1, reef: 'Great Barrier Reef', confidence: 94.2, result: 'warning', time: '14:32:18' },
    { id: 2, reef: 'Raja Ampat', confidence: 89.1, result: 'critical', time: '14:31:45' },
    { id: 3, reef: 'Maldives Cluster', confidence: 96.5, result: 'safe', time: '14:30:22' },
    { id: 4, reef: 'Caribbean Coral', confidence: 91.3, result: 'critical', time: '14:29:58' },
    { id: 5, reef: 'Red Sea Reefs', confidence: 93.7, result: 'safe', time: '14:28:41' },
  ];

  return (
    <div className="space-y-8">
      {/* Header - More Spacious */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-4xl text-white mb-2">AI Observability</h2>
          <p className="text-base text-gray-muted">Powered by Arize Phoenix</p>
        </div>
        <div className="flex items-center gap-3 px-5 py-3 rounded-xl bg-coral-safe/10 border border-coral-safe/30">
          <CheckCircle className="w-5 h-5 text-coral-safe" />
          <span className="text-sm text-coral-safe">System Healthy</span>
        </div>
      </div>

      {/* Key Metrics - More Spacious */}
      <div className="grid grid-cols-4 gap-6">
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
              ) : (
                <Activity className="w-4 h-4 text-cyan-glow" />
              )}
            </div>
            <p className="text-3xl text-white mb-2">{metric.value}</p>
            <div className="flex items-center gap-1.5 text-sm">
              <TrendingUp className={`w-4 h-4 ${metric.trend.startsWith('+') || metric.trend.startsWith('-') ? 'text-coral-safe' : 'text-gray-muted'}`} />
              <span className="text-gray-light">{metric.trend}</span>
            </div>
          </motion.div>
        ))}
      </div>

      {/* AI Trace Log - More Spacious */}
      <div className="reef-panel-strong p-8 rounded-2xl bg-ocean-medium/65 border border-gray-border/70">
        <div className="flex items-center gap-3 mb-6">
          <Brain className="w-5 h-5 text-cyan-glow" />
          <h3 className="text-base text-white">Recent AI Inference Traces</h3>
        </div>

        <div className="space-y-3">
          {traces.map((trace) => (
            <div
              key={trace.id}
              className="reef-panel-soft p-5 rounded-xl bg-ocean-dark/45 border border-gray-border/70 hover:border-cyan-glow/40 transition-all"
            >
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-base text-white">{trace.reef}</span>
                    <span className={`px-3 py-1 rounded-lg text-xs ${
                      trace.result === 'critical' ? 'bg-coral-critical/10 text-coral-critical border border-coral-critical/30' :
                      trace.result === 'warning' ? 'bg-coral-warning/10 text-coral-warning border border-coral-warning/30' :
                      'bg-coral-safe/10 text-coral-safe border border-coral-safe/30'
                    }`}>
                      {trace.result}
                    </span>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-sm text-gray-muted">Confidence: {trace.confidence}%</span>
                    <span className="text-sm text-gray-muted">{trace.time}</span>
                  </div>
                </div>
                <div className="w-32">
                  <div className="h-2 bg-ocean-deep rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-cyan-bright to-cyan-glow rounded-full"
                      style={{ width: `${trace.confidence}%` }}
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
                <span className="text-white">93.7%</span>
              </div>
              <div className="h-2 bg-ocean-deep rounded-full overflow-hidden">
                <div className="h-full bg-cyan-glow rounded-full" style={{ width: '93.7%' }} />
              </div>
            </div>
            <div>
              <div className="flex justify-between text-sm mb-2">
                <span className="text-gray-muted">Recall</span>
                <span className="text-white">91.2%</span>
              </div>
              <div className="h-2 bg-ocean-deep rounded-full overflow-hidden">
                <div className="h-full bg-blue-ocean rounded-full" style={{ width: '91.2%' }} />
              </div>
            </div>
            <div>
              <div className="flex justify-between text-sm mb-2">
                <span className="text-gray-muted">F1 Score</span>
                <span className="text-white">92.4%</span>
              </div>
              <div className="h-2 bg-ocean-deep rounded-full overflow-hidden">
                <div className="h-full bg-coral-safe rounded-full" style={{ width: '92.4%' }} />
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
