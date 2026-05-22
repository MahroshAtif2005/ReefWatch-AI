import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Activity, AlertCircle, Droplet, Info, Loader2, ThermometerSun, TrendingUp, Waves } from 'lucide-react';
import { fetchHistoricalTrends, type HistoricalTrendPoint, type HistoricalTrendsResponse } from '../services/reefApi';

const formatNumber = (value: number | null | undefined, suffix = '') => {
  if (value === null || value === undefined || Number.isNaN(value)) return 'N/A';
  return `${value}${suffix}`;
};

const formatDate = (value: string) => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const formatTimestamp = (value: string | null | undefined) => {
  if (!value) return 'Unavailable';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};

const chartValueLabel: Record<string, string> = {
  seaSurfaceTemp: 'Sea temperature',
  sstAnomaly: 'SST anomaly',
  degreeHeatingWeeks: 'DHW',
  bleachingRisk: 'Bleaching risk',
};

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;

  return (
    <div className="rounded-lg border border-gray-border bg-ocean-dark/95 px-3 py-2 shadow-2xl backdrop-blur-xl">
      <p className="mb-1 text-xs text-gray-muted">{formatDate(label)}</p>
      {payload.map((entry: any) => {
        const unit = entry.dataKey === 'bleachingRisk' ? '%' : entry.dataKey === 'degreeHeatingWeeks' ? ' °C-weeks' : '°C';
        return (
          <p key={entry.dataKey} className="text-sm" style={{ color: entry.color }}>
            {chartValueLabel[entry.dataKey] || entry.name}: {entry.value ?? 'N/A'}{entry.value === null ? '' : unit}
          </p>
        );
      })}
    </div>
  );
};

function StatCard({
  icon,
  label,
  value,
  helper,
  tone = 'cyan',
}: {
  icon: ReactNode;
  label: string;
  value: string | number;
  helper: string;
  tone?: 'cyan' | 'critical' | 'warning' | 'safe';
}) {
  const toneClasses = {
    cyan: 'border-gray-border/70 text-cyan-glow',
    critical: 'border-coral-critical/45 text-coral-critical',
    warning: 'border-coral-warning/45 text-coral-warning',
    safe: 'border-coral-safe/45 text-coral-safe',
  };

  return (
    <div className={`reef-panel-strong rounded-2xl border bg-ocean-medium/65 p-6 ${toneClasses[tone]}`}>
      <div className="mb-4 flex items-center gap-2">
        {icon}
        <span className="text-xs uppercase tracking-wider text-gray-muted">{label}</span>
      </div>
      <p className="mb-1 text-4xl text-white">{value}</p>
      <p className="text-sm text-gray-light">{helper}</p>
    </div>
  );
}

function ChartEmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-[240px] items-center justify-center rounded-xl border border-gray-border/70 bg-ocean-dark/40 p-6 text-center text-sm leading-relaxed text-gray-light">
      {message}
    </div>
  );
}

function SnapshotMetricCard({
  title,
  subtitle,
  value,
  unit,
  color,
  helper,
  icon,
  thresholds,
}: {
  title: string;
  subtitle: string;
  value: number | null | undefined;
  unit: string;
  color: string;
  helper: string;
  icon: ReactNode;
  thresholds?: ReactNode;
}) {
  return (
    <div className="reef-panel-strong rounded-2xl border border-gray-border/70 bg-ocean-medium/65 p-8">
      <div className="mb-8 flex items-center justify-between gap-4">
        <h3 className="text-base text-white">{title}</h3>
        <span className="text-sm text-gray-muted">{subtitle}</span>
      </div>
      <div className="rounded-xl border border-gray-border/70 bg-ocean-dark/45 p-6">
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3 text-gray-light">
            <span className="rounded-lg border border-cyan-glow/20 bg-cyan-glow/10 p-2" style={{ color }}>
              {icon}
            </span>
            <span className="text-sm">Latest reading</span>
          </div>
          <span className="rounded-lg border border-gray-border/70 bg-ocean-medium/60 px-3 py-1 text-xs text-gray-muted">
            Snapshot
          </span>
        </div>
        <div className="flex items-end gap-2">
          <span className="text-5xl text-white">{formatNumber(value)}</span>
          <span className="pb-2 text-sm text-gray-muted">{unit}</span>
        </div>
        <p className="mt-4 text-sm leading-relaxed text-gray-light">{helper}</p>
        {thresholds && <div className="mt-5">{thresholds}</div>}
      </div>
    </div>
  );
}

function TrendChart({
  title,
  subtitle,
  data,
  dataKey,
  color,
  unit,
  domain,
  area = false,
  thresholds,
}: {
  title: string;
  subtitle: string;
  data: HistoricalTrendPoint[];
  dataKey: keyof HistoricalTrendPoint;
  color: string;
  unit: string;
  domain?: [number, number] | ['auto', 'auto'];
  area?: boolean;
  thresholds?: Array<{ value: number; label: string; color: string }>;
}) {
  const usableData = data.filter((point) => point[dataKey] !== null && point[dataKey] !== undefined);
  const gradientId = `${String(dataKey)}Gradient`;

  return (
    <div className="reef-panel-strong rounded-2xl border border-gray-border/70 bg-ocean-medium/65 p-8">
      <div className="mb-8 flex items-center justify-between gap-4">
        <h3 className="text-base text-white">{title}</h3>
        <span className="text-sm text-gray-muted">{subtitle}</span>
      </div>

      {usableData.length === 0 ? (
        <ChartEmptyState message={`${title} is unavailable because NOAA did not return this metric.`} />
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          {area ? (
            <AreaChart data={usableData}>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={color} stopOpacity={0.32} />
                  <stop offset="95%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(34,211,238,0.07)" />
              <XAxis dataKey="date" tickFormatter={formatDate} stroke="#67e8f9" tick={{ fill: '#67e8f9', fontSize: 12 }} />
              <YAxis stroke="#67e8f9" tick={{ fill: '#67e8f9', fontSize: 12 }} domain={domain || ['auto', 'auto']} unit={unit} />
              <Tooltip content={<CustomTooltip />} />
              {thresholds?.map((threshold) => (
                <ReferenceLine key={threshold.label} y={threshold.value} stroke={threshold.color} strokeDasharray="4 4" label={{ value: threshold.label, fill: threshold.color, fontSize: 11 }} />
              ))}
              <Area type="monotone" dataKey={dataKey} stroke={color} strokeWidth={3} fillOpacity={1} fill={`url(#${gradientId})`} name={chartValueLabel[String(dataKey)]} />
            </AreaChart>
          ) : (
            <LineChart data={usableData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(34,211,238,0.07)" />
              <XAxis dataKey="date" tickFormatter={formatDate} stroke="#67e8f9" tick={{ fill: '#67e8f9', fontSize: 12 }} />
              <YAxis stroke="#67e8f9" tick={{ fill: '#67e8f9', fontSize: 12 }} domain={domain || ['auto', 'auto']} unit={unit} />
              <Tooltip content={<CustomTooltip />} />
              {thresholds?.map((threshold) => (
                <ReferenceLine key={threshold.label} y={threshold.value} stroke={threshold.color} strokeDasharray="4 4" label={{ value: threshold.label, fill: threshold.color, fontSize: 11 }} />
              ))}
              <Line type="monotone" dataKey={dataKey} stroke={color} strokeWidth={3} dot={{ fill: color, r: 4 }} name={chartValueLabel[String(dataKey)]} />
            </LineChart>
          )}
        </ResponsiveContainer>
      )}
    </div>
  );
}

export function AnalyticsDashboard() {
  const [trends, setTrends] = useState<HistoricalTrendsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadTrends() {
      try {
        const result = await fetchHistoricalTrends();
        if (isMounted) {
          setTrends(result);
          setError(result.error || null);
        }
      } catch {
        if (isMounted) {
          setError('Historical trends are unavailable. Start the local backend on port 4000 to reconnect.');
          setTrends(null);
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    loadTrends();

    return () => {
      isMounted = false;
    };
  }, []);

  const series = trends?.series || [];
  const latestSnapshot = series.at(-1);
  const isSnapshotMode = trends?.mode === 'snapshot' || !trends?.historicalDataAvailable;
  const snapshotMessage = useMemo(() => {
    if (!trends) return '';
    return trends.mode === 'historical'
      ? 'NOAA historical data is powering these trends.'
      : trends.message;
  }, [trends]);

  if (isLoading) {
    return (
      <div className="reef-panel-strong flex min-h-[360px] items-center justify-center rounded-2xl border border-gray-border/70 bg-ocean-medium/65 text-gray-light">
        <Loader2 className="mr-3 h-5 w-5 animate-spin text-cyan-glow" />
        Loading NOAA reef trends...
      </div>
    );
  }

  if (!trends) {
    return (
      <div className="reef-panel-strong rounded-2xl border border-coral-warning/40 bg-ocean-medium/65 p-8 text-coral-warning">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-8 pb-8">
      <div className="reef-panel-soft rounded-2xl border border-cyan-glow/20 bg-ocean-dark/60 p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <Info className="mt-0.5 h-5 w-5 text-cyan-glow" />
            <div>
              <p className="text-sm text-white">{snapshotMessage}</p>
              <p className="mt-1 text-xs text-gray-muted">
                Source: {trends.sourceLabel} · Last updated {formatTimestamp(trends.lastUpdated)}
              </p>
            </div>
          </div>
          <div className="rounded-lg border border-gray-border/70 bg-ocean-medium/55 px-3 py-2 text-xs text-gray-light">
            Avg SST {formatNumber(trends.averages.seaSurfaceTemp, '°C')} · Avg anomaly {formatNumber(trends.averages.sstAnomaly, '°C')} · Avg DHW {formatNumber(trends.averages.degreeHeatingWeeks, ' °C-weeks')}
          </div>
        </div>
      </div>

      {error && (
        <div className="reef-panel-soft rounded-xl border border-coral-warning/40 bg-coral-warning/10 p-4 text-sm text-coral-warning">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={<Activity className="h-5 w-5 text-cyan-glow" />} label="Monitoring" value={trends.totalMonitoredReefs} helper="Real reef locations" />
        <StatCard icon={<AlertCircle className="h-5 w-5 text-coral-critical" />} label="Critical" value={trends.criticalReefs} helper="High DHW or alert level" tone="critical" />
        <StatCard icon={<TrendingUp className="h-5 w-5 text-coral-warning" />} label="Warning" value={trends.warningReefs} helper="Elevated thermal stress" tone="warning" />
        <StatCard icon={<Droplet className="h-5 w-5 text-coral-safe" />} label="Healthy" value={trends.healthyReefs} helper="Safe or normal status" tone="safe" />
      </div>

      {isSnapshotMode ? (
        <div className="grid grid-cols-1 gap-8 xl:grid-cols-2">
          <SnapshotMetricCard
            title="Ocean Temperature"
            subtitle="SST · °C"
            value={latestSnapshot?.seaSurfaceTemp}
            unit="°C"
            color="#ffb020"
            helper="Latest average sea surface temperature across monitored reef locations."
            icon={<ThermometerSun className="h-5 w-5" />}
          />
          <SnapshotMetricCard
            title="SST Anomaly"
            subtitle="Positive anomaly · °C"
            value={latestSnapshot?.sstAnomaly}
            unit="°C"
            color="#00e5ff"
            helper="Latest average SST anomaly from NOAA Coral Reef Watch readings."
            icon={<Waves className="h-5 w-5" />}
          />
          <SnapshotMetricCard
            title="Degree Heating Weeks"
            subtitle="DHW · °C-weeks"
            value={latestSnapshot?.degreeHeatingWeeks}
            unit="°C-weeks"
            color="#ff8800"
            helper="Latest average accumulated heat stress. DHW 4 and DHW 8 are common bleaching stress thresholds."
            icon={<TrendingUp className="h-5 w-5" />}
            thresholds={
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="rounded-lg border border-coral-warning/30 bg-coral-warning/10 px-3 py-2 text-coral-warning">DHW 4 warning</div>
                <div className="rounded-lg border border-coral-critical/30 bg-coral-critical/10 px-3 py-2 text-coral-critical">DHW 8 critical</div>
              </div>
            }
          />
          <SnapshotMetricCard
            title="Bleaching Risk"
            subtitle="Calculated risk · %"
            value={latestSnapshot?.bleachingRisk}
            unit="%"
            color="#ff4757"
            helper="Latest average ReefWatch bleaching risk score derived from NOAA metrics and alert levels."
            icon={<AlertCircle className="h-5 w-5" />}
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-8 xl:grid-cols-2">
          <TrendChart
            title="Ocean Temperature Trend"
            subtitle="SST · °C"
            data={series}
            dataKey="seaSurfaceTemp"
            color="#ffb020"
            unit="°C"
          />
          <TrendChart
            title="SST Anomaly Trend"
            subtitle="Positive anomaly · °C"
            data={series}
            dataKey="sstAnomaly"
            color="#00e5ff"
            unit="°C"
          />
          <TrendChart
            title="DHW Trend"
            subtitle="Degree Heating Weeks · °C-weeks"
            data={series}
            dataKey="degreeHeatingWeeks"
            color="#ff8800"
            unit=""
            thresholds={[
              { value: 4, label: 'DHW 4', color: '#ffb020' },
              { value: 8, label: 'DHW 8', color: '#ff4757' },
            ]}
          />
          <TrendChart
            title="Bleaching Risk Evolution"
            subtitle="Calculated from NOAA metrics"
            data={series}
            dataKey="bleachingRisk"
            color="#ff4757"
            unit="%"
            domain={[0, 100]}
            area
          />
        </div>
      )}
    </div>
  );
}
