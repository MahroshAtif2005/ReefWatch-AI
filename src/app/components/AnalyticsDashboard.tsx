import { LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { TrendingUp, Droplet, Activity, AlertCircle } from 'lucide-react';

const temperatureData = [
  { date: 'May 1', temp: 26.2, baseline: 26.5 },
  { date: 'May 3', temp: 26.8, baseline: 26.5 },
  { date: 'May 5', temp: 27.4, baseline: 26.5 },
  { date: 'May 7', temp: 28.1, baseline: 26.5 },
  { date: 'May 9', temp: 28.9, baseline: 26.5 },
  { date: 'May 11', temp: 29.3, baseline: 26.5 },
  { date: 'May 13', temp: 29.8, baseline: 26.5 },
  { date: 'May 15', temp: 30.2, baseline: 26.5 },
];

const bleachingRiskData = [
  { date: 'May 1', risk: 18 },
  { date: 'May 3', risk: 24 },
  { date: 'May 5', risk: 35 },
  { date: 'May 7', risk: 48 },
  { date: 'May 9', risk: 56 },
  { date: 'May 11', risk: 67 },
  { date: 'May 13', risk: 74 },
  { date: 'May 15', risk: 82 },
];

const CustomTooltip = ({ active, payload }: any) => {
  if (active && payload && payload.length) {
    return (
      <div className="px-3 py-2 rounded-lg bg-ocean-dark/95 backdrop-blur-xl border border-gray-border">
        <p className="text-xs text-gray-muted mb-1">{payload[0].payload.date}</p>
        {payload.map((entry: any, index: number) => (
          <p key={index} className="text-sm" style={{ color: entry.color }}>
            {entry.name}: {entry.value}{entry.name.includes('temp') ? '°C' : '%'}
          </p>
        ))}
      </div>
    );
  }
  return null;
};

export function AnalyticsDashboard() {
  return (
    <div className="space-y-8">
      {/* Global Statistics - More Spacious */}
      <div className="grid grid-cols-4 gap-6">
        <div className="reef-panel p-6 rounded-2xl bg-ocean-medium/65 border border-gray-border/70">
          <div className="flex items-center gap-2 mb-4">
            <Activity className="w-5 h-5 text-cyan-glow" />
            <span className="text-xs uppercase tracking-wider text-gray-muted">Monitoring</span>
          </div>
          <p className="text-4xl text-white mb-1">247</p>
          <p className="text-sm text-gray-light">Reef locations</p>
        </div>

        <div className="reef-panel-strong p-6 rounded-2xl bg-ocean-medium/65 border border-coral-critical/45">
          <div className="flex items-center gap-2 mb-4">
            <AlertCircle className="w-5 h-5 text-coral-critical" />
            <span className="text-xs uppercase tracking-wider text-gray-muted">Critical</span>
          </div>
          <p className="text-4xl text-coral-critical mb-1">23</p>
          <p className="text-sm text-gray-light">High priority</p>
        </div>

        <div className="reef-panel-strong p-6 rounded-2xl bg-ocean-medium/65 border border-coral-warning/45">
          <div className="flex items-center gap-2 mb-4">
            <TrendingUp className="w-5 h-5 text-coral-warning" />
            <span className="text-xs uppercase tracking-wider text-gray-muted">Warning</span>
          </div>
          <p className="text-4xl text-coral-warning mb-1">58</p>
          <p className="text-sm text-gray-light">Elevated stress</p>
        </div>

        <div className="reef-panel-strong p-6 rounded-2xl bg-ocean-medium/65 border border-coral-safe/45">
          <div className="flex items-center gap-2 mb-4">
            <Droplet className="w-5 h-5 text-coral-safe" />
            <span className="text-xs uppercase tracking-wider text-gray-muted">Healthy</span>
          </div>
          <p className="text-4xl text-coral-safe mb-1">166</p>
          <p className="text-sm text-gray-light">Normal</p>
        </div>
      </div>

      {/* Charts - More Spacious */}
      <div className="grid grid-cols-2 gap-8">
        {/* Ocean Temperature Trend */}
        <div className="reef-panel-strong p-8 rounded-2xl bg-ocean-medium/65 border border-gray-border/70">
          <div className="flex items-center justify-between mb-8">
            <h3 className="text-base text-white">Ocean Temperature Trend</h3>
            <span className="text-sm text-coral-warning">+3.7°C above baseline</span>
          </div>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={temperatureData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(34,211,238,0.07)" />
              <XAxis
                dataKey="date"
                stroke="#67e8f9"
                style={{ fontSize: '12px' }}
                tick={{ fill: '#67e8f9' }}
              />
              <YAxis
                stroke="#67e8f9"
                style={{ fontSize: '12px' }}
                tick={{ fill: '#67e8f9' }}
                domain={[25, 31]}
              />
              <Tooltip content={<CustomTooltip />} />
              <Line
                type="monotone"
                dataKey="baseline"
                stroke="#67e8f9"
                strokeDasharray="5 5"
                strokeWidth={1}
                dot={false}
                name="Baseline"
              />
              <Line
                type="monotone"
                dataKey="temp"
                stroke="#ff8800"
                strokeWidth={3}
                dot={{ fill: '#ff8800', r: 4 }}
                name="Current temp"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Bleaching Risk Evolution */}
        <div className="reef-panel-strong p-8 rounded-2xl bg-ocean-medium/65 border border-gray-border/70">
          <div className="flex items-center justify-between mb-8">
            <h3 className="text-base text-white">Bleaching Risk Evolution</h3>
            <span className="text-sm text-coral-critical">Rising trend</span>
          </div>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={bleachingRiskData}>
              <defs>
                <linearGradient id="riskGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#ff4757" stopOpacity={0.3}/>
                  <stop offset="95%" stopColor="#ff4757" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(34,211,238,0.07)" />
              <XAxis
                dataKey="date"
                stroke="#67e8f9"
                style={{ fontSize: '12px' }}
                tick={{ fill: '#67e8f9' }}
              />
              <YAxis
                stroke="#67e8f9"
                style={{ fontSize: '12px' }}
                tick={{ fill: '#67e8f9' }}
                domain={[0, 100]}
              />
              <Tooltip content={<CustomTooltip />} />
              <Area
                type="monotone"
                dataKey="risk"
                stroke="#ff4757"
                strokeWidth={3}
                fillOpacity={1}
                fill="url(#riskGradient)"
                name="Bleaching risk"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
