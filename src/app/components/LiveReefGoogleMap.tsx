import { useEffect, useMemo, useState } from 'react';
import { APIProvider, Map as GoogleMap, Marker, useMap } from '@vis.gl/react-google-maps';
import { motion } from 'motion/react';
import { AlertTriangle, CheckCircle2, Clock, Database, Droplet, Loader2, MapPin, Plus, Radio, Search, X } from 'lucide-react';
import {
  addStationToActiveMonitoring,
  fetchLiveReefs,
  fetchReefStationReadings,
  fetchReefStations,
  normalizeBleachingAlertLevel,
  removeFromActiveMonitoring,
  type LiveReef,
  type ReefStation,
  type ReefStationReading,
} from '../services/reefApi';
import type { SearchNavigationTarget } from './Header';

interface LiveReefGoogleMapProps {
  onReefSelect: (reef: {
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
  }) => void;
  focusTarget?: SearchNavigationTarget | null;
  onMonitoredCountChange?: (count: number) => void;
}

const oceanMapStyles = [
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ visibility: 'off' }] },
  { featureType: 'administrative.country', elementType: 'labels.text.fill', stylers: [{ color: '#7fb6c6' }] },
  { featureType: 'administrative.country', elementType: 'labels.text.stroke', stylers: [{ color: '#062332' }] },
  { featureType: 'administrative.province', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#123a49' }] },
  { featureType: 'landscape.natural', elementType: 'geometry', stylers: [{ color: '#0d3444' }] },
  { featureType: 'poi', elementType: 'all', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'all', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', elementType: 'all', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#041f2d' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#4e8796' }] },
  { featureType: 'water', elementType: 'labels.text.stroke', stylers: [{ color: '#041f2d' }] },
] as google.maps.MapTypeStyle[];

const getMarkerStatus = (reef: LiveReef): LiveReef['status'] | 'fallback' => {
  if (reef.status === 'safe' || reef.status === 'warning' || reef.status === 'critical') {
    return reef.status;
  }
  return reef.source.toLowerCase().includes('fallback') ? 'fallback' : reef.status;
};

const getRiskColor = (status: LiveReef['status'] | 'fallback') => {
  switch (status) {
    case 'safe':
      return '#00d9a3';
    case 'warning':
      return '#ff8800';
    case 'critical':
      return '#ff4757';
    case 'fallback':
      return '#7f95a1';
    case 'unavailable':
      return '#7f95a1';
    case 'pending':
      return '#8fcfd6';
    default:
      return '#00e5ff';
  }
};

const getColorMatrix = (status: LiveReef['status'] | 'fallback') => {
  if (status === 'fallback' || status === 'unavailable') {
    return '0 0 0 0 0.50 0 0 0 0 0.58 0 0 0 0 0.63 0 0 0 0.8 0';
  }
  if (status === 'critical') return '0 0 0 0 1 0 0 0 0 0.28 0 0 0 0 0.34 0 0 0 0.9 0';
  if (status === 'warning') return '0 0 0 0 1 0 0 0 0 0.53 0 0 0 0 0 0 0 0 0.9 0';
  return '0 0 0 0 0 0 0 0 0 0.85 0 0 0 0 1 0 0 0 0.9 0';
};

const createMarkerIcon = (status: LiveReef['status'] | 'fallback', monitored: boolean, selected: boolean) => {
  const color = getRiskColor(status);
  const colorMatrix = getColorMatrix(status);

  // 4 visual states: idle → selected-only → monitored → monitored+selected
  const isIdle = !monitored && !selected;
  const isSelectedOnly = !monitored && selected;

  if (isIdle) {
    const size = 12;
    const radius = 3;
    const svg = `
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
        <circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="${color}" opacity="0.55"/>
        <circle cx="${size / 2}" cy="${size / 2}" r="${radius * 0.4}" fill="#e9fbff" opacity="0.45"/>
      </svg>
    `;
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
  }

  const size = monitored ? (selected ? 52 : 44) : 34;
  const radius = monitored ? (selected ? 8 : 6) : 5;
  const svg = `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="glow" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="${isSelectedOnly ? 4 : 5}" result="blur"/>
          <feColorMatrix in="blur" type="matrix" values="${colorMatrix}"/>
          <feMerge>
            <feMergeNode/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
      </defs>
      <circle cx="${size / 2}" cy="${size / 2}" r="${radius + (isSelectedOnly ? 7 : 10)}" fill="${color}" opacity="0.18">
        <animate attributeName="r" values="${radius + (isSelectedOnly ? 4 : 5)};${radius + (isSelectedOnly ? 11 : 14)};${radius + (isSelectedOnly ? 4 : 5)}" dur="${isSelectedOnly ? '2.2s' : '1.8s'}" repeatCount="indefinite"/>
        <animate attributeName="opacity" values="0.24;0.04;0.24" dur="${isSelectedOnly ? '2.2s' : '1.8s'}" repeatCount="indefinite"/>
      </circle>
      <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - (isSelectedOnly ? 10 : 12)}" fill="none" stroke="${color}" stroke-width="${isSelectedOnly ? 1.5 : 2}" opacity="0.5"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="${color}" opacity="1" filter="url(#glow)"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${radius / 2}" fill="#e9fbff" opacity="0.85"/>
    </svg>
  `;

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
};

const getStationVisualStatus = (station: ReefStation | ReefStationReading) => {
  if ('seaSurfaceTemp' in station) {
    return station.error || station.status === 'unavailable' ? 'unavailable' : station.status;
  }

  return 'metadata';
};

const getStationColor = (status: ReefStationReading['status'] | 'metadata') => {
  switch (status) {
    case 'safe':
      return '#00d9a3';
    case 'warning':
      return '#ff8800';
    case 'critical':
      return '#ff4757';
    case 'unavailable':
      return '#7f95a1';
    default:
      return '#00e5ff';
  }
};

const createStationIcon = (status: ReefStationReading['status'] | 'metadata', selected: boolean) => {
  const isMetadata = status === 'metadata';
  const color = getStationColor(status);

  if (selected) {
    const size = 48;
    const radius = 7;
    const colorMatrix = status === 'critical'
      ? '0 0 0 0 1 0 0 0 0 0.28 0 0 0 0 0.34 0 0 0 0.9 0'
      : status === 'warning'
        ? '0 0 0 0 1 0 0 0 0 0.53 0 0 0 0 0 0 0 0 0.9 0'
        : '0 0 0 0 0 0 0 0 0 0.85 0 0 0 0 1 0 0 0 0.9 0';
    const svg = `
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <filter id="glow" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="5" result="blur"/>
            <feColorMatrix in="blur" type="matrix" values="${colorMatrix}"/>
            <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
        </defs>
        <circle cx="${size / 2}" cy="${size / 2}" r="${radius + 10}" fill="${color}" opacity="0.18">
          <animate attributeName="r" values="${radius + 5};${radius + 14};${radius + 5}" dur="1.8s" repeatCount="indefinite"/>
          <animate attributeName="opacity" values="0.24;0.04;0.24" dur="1.8s" repeatCount="indefinite"/>
        </circle>
        <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 12}" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.5"/>
        <circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="${color}" opacity="1" filter="url(#glow)"/>
        <circle cx="${size / 2}" cy="${size / 2}" r="${radius / 2}" fill="#e9fbff" opacity="0.9"/>
      </svg>
    `;
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
  }

  const size = 12;
  const radius = 3;
  const svg = `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="${color}" opacity="0.55"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${radius * 0.4}" fill="#e9fbff" opacity="0.45"/>
    </svg>
  `;

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
};

function ApiKeyFallback() {
  return (
    <div className="relative h-full w-full overflow-hidden bg-gradient-to-br from-ocean-deep via-ocean-dark to-blue-deep/70">
      <div className="absolute inset-0 opacity-10" style={{ backgroundImage: 'linear-gradient(rgba(0, 229, 255, 0.18) 1px, transparent 1px), linear-gradient(90deg, rgba(0, 229, 255, 0.18) 1px, transparent 1px)', backgroundSize: '48px 48px' }} />
      <div className="absolute inset-0 flex items-center justify-center p-8">
        <div className="reef-panel-strong max-w-md rounded-2xl border border-cyan-glow/35 bg-ocean-dark/82 p-8 text-center shadow-2xl">
          <MapPin className="mx-auto mb-4 h-10 w-10 text-cyan-glow" />
          <h2 className="mb-3 text-2xl text-white">Google Maps API key required</h2>
          <p className="text-sm leading-relaxed text-gray-light">
            Add `VITE_GOOGLE_MAPS_API_KEY` to your local `.env` file, then restart Vite to load the live reef map.
          </p>
        </div>
      </div>
      <MapOverlays
        activeCount={0}
        readingCount={0}
        stationCount={0}
        timeRange="live"
        onTimeRangeChange={() => undefined}
      />
    </div>
  );
}

const MAX_ACTIVE_REEFS = 20;
const MONITORED_IDS_STORAGE_KEY = 'reefwatch_monitored_reef_ids';

const CURATED_TERMS = [
  'galapagos',
  'great barrier',
  'florida keys',
  'hawaii',
  'maldives',
  'red sea',
  'raja ampat',
  'caribbean',
];

type TimeRangeMode = 'past-week' | 'live' | 'forecast';

const timeRangeOptions: Array<{ value: TimeRangeMode; label: string; description: string }> = [
  { value: 'past-week', label: 'Past Week', description: 'Historical cached readings' },
  { value: 'live', label: 'Live', description: 'Current NOAA readings' },
  { value: 'forecast', label: 'Forecast', description: 'Forecast mode preview' },
];

const timeRangeLabels: Record<TimeRangeMode, string> = {
  'past-week': 'Past week cached readings',
  live: 'Live NOAA readings',
  forecast: 'Forecast mode preview',
};

const getStatusFromRiskScore = (riskScore: number): LiveReef['status'] => {
  if (riskScore >= 70) return 'critical';
  if (riskScore >= 40) return 'warning';
  return 'safe';
};

const adjustNullableNumber = (value: number | null, amount: number) => {
  if (value === null || value === undefined) return value;
  return Number((value + amount).toFixed(1));
};

const getReefForTimeRange = (reef: LiveReef, timeRange: TimeRangeMode): LiveReef => {
  if (timeRange === 'live') return reef;

  if (timeRange === 'past-week') {
    return {
      ...reef,
      source: reef.source === 'fallback' ? 'NOAA cached fallback' : 'NOAA cached',
    };
  }

  const riskScore = Math.min(100, reef.riskScore + 8);

  return {
    ...reef,
    seaSurfaceTemp: adjustNullableNumber(reef.seaSurfaceTemp, 0.4),
    tempAnomaly: adjustNullableNumber(reef.tempAnomaly, 0.2),
    riskScore,
    status: getStatusFromRiskScore(riskScore),
    bleachingAlertLevel: `Forecast · ${reef.bleachingAlertLevel}`,
    source: 'NOAA forecast placeholder',
  };
};

const getStationForTimeRange = (
  station: ReefStation | ReefStationReading,
  timeRange: TimeRangeMode,
): ReefStation | ReefStationReading => {
  if (!('seaSurfaceTemp' in station) || timeRange === 'live') return station;

  if (timeRange === 'past-week') {
    return {
      ...station,
      source: station.source === 'fallback' ? 'NOAA cached fallback' : 'NOAA cached',
    };
  }

  const riskScore = Math.min(100, station.riskScore + 8);

  return {
    ...station,
    seaSurfaceTemp: adjustNullableNumber(station.seaSurfaceTemp, 0.4),
    tempAnomaly: adjustNullableNumber(station.tempAnomaly, 0.2),
    riskScore,
    status: station.status === 'unavailable' ? station.status : getStatusFromRiskScore(riskScore),
    bleachingAlertLevel: `Forecast · ${station.bleachingAlertLevel}`,
    source: 'NOAA forecast placeholder',
  };
};

function TimeRangeControl({
  value,
  onChange,
}: {
  value: TimeRangeMode;
  onChange: (value: TimeRangeMode) => void;
}) {
  return (
    <div className="reef-panel-soft rounded-2xl border border-gray-border/70 bg-ocean-dark/78 p-2 shadow-2xl backdrop-blur-2xl">
      <div className="flex min-w-[280px] rounded-xl border border-cyan-glow/15 bg-ocean-medium/45 p-1">
        {timeRangeOptions.map((option) => {
          const isSelected = value === option.value;

          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange(option.value)}
              aria-pressed={isSelected}
              title={option.description}
              className={`relative flex-1 rounded-lg px-3 py-2 text-xs transition-all ${
                isSelected
                  ? 'border border-cyan-glow/50 bg-cyan-glow/15 text-white shadow-[0_0_18px_rgba(0,229,255,0.22)]'
                  : 'border border-transparent text-gray-muted hover:bg-ocean-medium/70 hover:text-gray-light'
              }`}
            >
              <span className="relative z-10">{option.label}</span>
              {isSelected && (
                <span className="absolute inset-x-3 bottom-1 h-0.5 rounded-full bg-cyan-glow shadow-[0_0_10px_rgba(0,229,255,0.9)]" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MapOverlays({
  activeCount,
  readingCount,
  stationCount,
  timeRange,
  onTimeRangeChange,
}: {
  activeCount: number;
  readingCount: number;
  stationCount: number;
  timeRange: TimeRangeMode;
  onTimeRangeChange: (value: TimeRangeMode) => void;
}) {
  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: -16 }}
        animate={{ opacity: 1, y: 0 }}
        className="absolute left-4 right-4 top-4 z-10 max-w-[360px] sm:left-8 sm:right-auto sm:top-8"
      >
        <TimeRangeControl value={timeRange} onChange={onTimeRangeChange} />
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="reef-panel-soft absolute bottom-8 left-8 z-10 rounded-2xl border border-gray-border/70 bg-ocean-dark/72 p-5 shadow-2xl backdrop-blur-2xl"
      >
        <h4 className="mb-4 text-xs uppercase tracking-wider text-gray-muted">Risk Level</h4>
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <div className="h-3 w-3 rounded-full border border-white/35 bg-[#20f7c2]" style={{ boxShadow: '0 0 14px rgba(32, 247, 194, 0.95), 0 0 4px rgba(255,255,255,0.45)' }} />
            <span className="text-sm text-gray-light">Safe</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="h-3 w-3 rounded-full border border-white/35 bg-[#ffb020]" style={{ boxShadow: '0 0 14px rgba(255, 176, 32, 0.95), 0 0 4px rgba(255,255,255,0.45)' }} />
            <span className="text-sm text-gray-light">Warning</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="h-3 w-3 rounded-full border border-white/35 bg-[#ff5f6f]" style={{ boxShadow: '0 0 14px rgba(255, 95, 111, 0.95), 0 0 4px rgba(255,255,255,0.45)' }} />
            <span className="text-sm text-gray-light">Critical</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="h-3 w-3 rounded-full border border-white/35 bg-[#b7c4cc]" style={{ boxShadow: '0 0 14px rgba(183, 196, 204, 0.8), 0 0 4px rgba(255,255,255,0.45)' }} />
            <span className="text-sm text-gray-light">Fallback</span>
          </div>
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="reef-panel-strong absolute bottom-8 left-1/2 z-10 flex -translate-x-1/2 items-center gap-3 rounded-full border border-cyan-glow/35 bg-ocean-dark/78 px-5 py-3 text-sm text-gray-light shadow-2xl backdrop-blur-2xl"
      >
        <Radio className="h-4 w-4 text-cyan-glow" />
        <span><span className="text-white">{timeRangeLabels[timeRange]}</span> · <span className="text-white">{stationCount}</span> visible NOAA reef locations · <span className="text-white">{activeCount}</span> selected reefs monitored</span>
      </motion.div>
    </>
  );
}

const formatNumber = (value: number | null, suffix = '') => {
  if (value === null || value === undefined) return 'Unavailable';
  return `${value}${suffix}`;
};

const formatDate = (value: string) => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};

const getSourceLabel = (source: string) => {
  const normalized = source.toLowerCase();
  if (normalized.includes('forecast')) return 'Forecast mode';
  if (normalized.includes('cached')) return 'Cached NOAA';
  if (normalized.includes('fallback')) return 'NOAA fallback';
  if (normalized.includes('unavailable')) return 'NOAA unavailable';
  return 'NOAA live';
};

function DetailMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="reef-panel-soft rounded-xl border border-gray-border/70 bg-ocean-medium/45 p-4">
      <p className="mb-1 text-xs uppercase tracking-wider text-gray-muted">{label}</p>
      <p className="text-lg text-white">{value}</p>
    </div>
  );
}

function ReefSelectionPanel({
  reef,
  timeRangeLabel,
  onClose,
  onToggleMonitoring,
  isMonitored,
}: {
  reef: LiveReef;
  timeRangeLabel: string;
  onClose: () => void;
  onToggleMonitoring: (reef: LiveReef) => void;
  isMonitored: boolean;
}) {
  const markerStatus = getMarkerStatus(reef);
  const color = getRiskColor(markerStatus);
  const bleachingAlertLevel = normalizeBleachingAlertLevel(
    reef.bleachingAlertLevel,
    reef.degreeHeatingWeeks,
  );

  return (
    <motion.div
      initial={{ opacity: 0, x: 32 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 32 }}
      className="reef-panel-strong absolute right-6 top-6 z-20 flex max-h-[calc(100%-3rem)] w-[380px] flex-col rounded-2xl border border-gray-border/70 bg-ocean-dark/88 p-6 shadow-2xl backdrop-blur-2xl"
    >
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h3 className="mb-2 text-2xl text-white">{reef.name}</h3>
          <div className="flex items-center gap-2 text-sm text-gray-light">
            <MapPin className="h-4 w-4 text-cyan-glow" />
            <span>{reef.region}, {reef.country}</span>
          </div>
        </div>
        <button
          onClick={onClose}
          className="rounded-lg border border-gray-border/70 bg-ocean-medium/60 p-2 text-gray-light transition-colors hover:border-cyan-glow/50 hover:text-white"
          aria-label="Close reef details"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mb-5 flex flex-wrap gap-3">
        <span className="rounded-lg border px-3 py-1 text-xs capitalize" style={{ borderColor: `${color}66`, color, backgroundColor: `${color}1a` }}>
          {markerStatus === 'fallback' ? 'fallback' : reef.status}
        </span>
        <span className="flex items-center gap-2 rounded-lg border border-cyan-glow/25 bg-cyan-glow/10 px-3 py-1 text-xs text-cyan-glow">
          <Database className="h-3.5 w-3.5" />
          {getSourceLabel(reef.source)}
        </span>
      </div>

      <div className="space-y-3 overflow-auto pr-1">
        <div className="grid grid-cols-2 gap-3">
          <DetailMetric label="Sea Temp" value={formatNumber(reef.seaSurfaceTemp, '°C')} />
          <DetailMetric label="SST Anomaly" value={formatNumber(reef.tempAnomaly, '°C')} />
          <DetailMetric label="DHW" value={formatNumber(reef.degreeHeatingWeeks)} />
          <DetailMetric label="Risk Score" value={`${reef.riskScore}%`} />
        </div>

        <div className="reef-panel-soft rounded-xl border border-gray-border/70 bg-ocean-medium/45 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm text-gray-muted">
            <AlertTriangle className="h-4 w-4" style={{ color }} />
            <span>Bleaching Alert Level</span>
          </div>
          <p className="text-lg text-white">{bleachingAlertLevel}</p>
        </div>

        <div className="reef-panel-soft rounded-xl border border-gray-border/70 bg-ocean-medium/45 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm text-gray-muted">
            <Clock className="h-4 w-4 text-cyan-glow" />
            <span>Last Updated</span>
          </div>
          <p className="text-sm text-white">{formatDate(reef.lastUpdated)}</p>
          <p className="mt-2 text-xs text-cyan-glow">{timeRangeLabel}</p>
        </div>

        <div className="flex items-center gap-2 text-sm text-gray-light">
          <Droplet className="h-4 w-4 text-cyan-glow" />
          <span>{reef.lat.toFixed(4)}, {reef.lng.toFixed(4)}</span>
        </div>

        {reef.error && (
          <div className="rounded-xl border border-gray-muted/40 bg-gray-muted/10 p-4 text-sm leading-relaxed text-gray-light">
            {reef.error}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => onToggleMonitoring(reef)}
        className={
          isMonitored
            ? 'mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-[#f43f5e] px-5 py-3 text-sm font-medium text-white transition-colors duration-200 hover:bg-[#e11d48]'
            : 'mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-[#10b981] px-5 py-3 text-sm font-medium text-white transition-colors duration-200 hover:bg-[#059669]'
        }
      >
        {isMonitored ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
        {isMonitored ? 'Stop Monitoring' : 'Start Monitoring'}
      </button>
    </motion.div>
  );
}

function StationSelectionPanel({
  station,
  timeRangeLabel,
  onClose,
  onAdd,
  isAdding,
  error,
}: {
  station: ReefStation | ReefStationReading;
  timeRangeLabel: string;
  onClose: () => void;
  onAdd: (station: ReefStation | ReefStationReading) => void;
  isAdding: boolean;
  error: string | null;
}) {
  const hasReading = 'seaSurfaceTemp' in station;
  const visualStatus = getStationVisualStatus(station);
  const color = getStationColor(visualStatus);
  const bleachingAlertLevel = hasReading
    ? normalizeBleachingAlertLevel(station.bleachingAlertLevel, station.degreeHeatingWeeks)
    : null;

  return (
    <motion.div
      initial={{ opacity: 0, x: 32 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 32 }}
      className="reef-panel-strong absolute right-6 top-6 z-20 flex max-h-[calc(100%-3rem)] w-[360px] flex-col rounded-2xl border border-gray-border/70 bg-ocean-dark/88 p-6 shadow-2xl backdrop-blur-2xl"
    >
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h3 className="mb-2 text-2xl text-white">{station.name}</h3>
          <div className="flex items-center gap-2 text-sm text-gray-light">
            <MapPin className="h-4 w-4 text-cyan-glow" />
            <span>{station.lat.toFixed(4)}, {station.lng.toFixed(4)}</span>
          </div>
        </div>
        <button
          onClick={onClose}
          className="rounded-lg border border-gray-border/70 bg-ocean-medium/60 p-2 text-gray-light transition-colors hover:border-cyan-glow/50 hover:text-white"
          aria-label="Close station details"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mb-5 flex flex-wrap gap-3">
        <span className="rounded-lg border border-cyan-glow/30 bg-cyan-glow/10 px-3 py-1 text-xs text-cyan-glow">
          NOAA Virtual Station
        </span>
        <span className="rounded-lg border border-gray-border/70 bg-ocean-medium/45 px-3 py-1 text-xs text-gray-light">
          {station.source}
        </span>
        {hasReading && (
          <span className="rounded-lg border px-3 py-1 text-xs capitalize" style={{ borderColor: `${color}66`, color, backgroundColor: `${color}1a` }}>
            {station.status}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {hasReading ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <DetailMetric label="Sea Temp" value={formatNumber(station.seaSurfaceTemp, '°C')} />
              <DetailMetric label="SST Anomaly" value={formatNumber(station.tempAnomaly, '°C')} />
              <DetailMetric label="DHW" value={formatNumber(station.degreeHeatingWeeks)} />
              <DetailMetric label="Risk Score" value={`${station.riskScore}%`} />
            </div>
            <div className="reef-panel-soft rounded-xl border border-gray-border/70 bg-ocean-medium/45 p-4">
              <p className="mb-1 text-xs uppercase tracking-wider text-gray-muted">Bleaching Alert</p>
              <p className="text-lg text-white">{bleachingAlertLevel}</p>
            </div>
            <div className="reef-panel-soft rounded-xl border border-gray-border/70 bg-ocean-medium/45 p-4">
              <p className="mb-1 text-xs uppercase tracking-wider text-gray-muted">Last Updated</p>
              <p className="text-sm text-white">{formatDate(station.lastUpdated)}</p>
              <p className="mt-2 text-xs text-cyan-glow">{timeRangeLabel}</p>
            </div>
            {station.error && (
              <div className="rounded-xl border border-gray-muted/40 bg-gray-muted/10 p-4 text-sm leading-relaxed text-gray-light">
                {station.error}
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm leading-relaxed text-gray-light">
            Station metadata available. Full analysis not refreshed yet.
          </p>
        )}

        {error && (
          <div className="mt-4 rounded-xl border border-coral-warning/35 bg-coral-warning/10 p-4 text-sm leading-relaxed text-coral-warning">
            {error}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => onAdd(station)}
        disabled={isAdding}
        className="reef-panel-strong mt-5 flex w-full shrink-0 items-center justify-center gap-2.5 rounded-xl border border-cyan-glow/35 bg-ocean-medium/85 px-5 py-3 text-sm text-white shadow-[0_0_0_1px_rgba(0,229,255,0.05)] transition-all hover:border-cyan-glow/70 hover:bg-ocean-medium hover:text-cyan-glow hover:shadow-[0_0_18px_rgba(0,229,255,0.18)] active:scale-[0.99] active:bg-ocean-dark disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isAdding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" aria-hidden="true" />}
        {isAdding ? 'Fetching NOAA data...' : 'Monitor Reef'}
      </button>
    </motion.div>
  );
}

function AddReefPanel({
  allReefs,
  selectedIds,
  onAdd,
  onClose,
}: {
  allReefs: LiveReef[];
  selectedIds: Set<string>;
  onAdd: (reef: LiveReef) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return allReefs
      .filter((r) => !selectedIds.has(r.id))
      .filter((r) => `${r.name} ${r.region} ${r.country}`.toLowerCase().includes(q))
      .slice(0, 8);
  }, [allReefs, selectedIds, query]);

  return (
    <motion.div
      initial={{ opacity: 0, x: 32 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 32 }}
      className="reef-panel-strong absolute right-6 top-6 z-20 w-[360px] rounded-2xl border border-gray-border/70 bg-ocean-dark/88 p-6 shadow-2xl backdrop-blur-2xl"
    >
      <div className="mb-4 flex items-center justify-between gap-4">
        <h3 className="text-lg text-white">Add Reef to Map</h3>
        <button
          onClick={onClose}
          className="rounded-lg border border-gray-border/70 bg-ocean-medium/60 p-2 text-gray-light transition-colors hover:border-cyan-glow/50 hover:text-white"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="relative mb-4">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-muted" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, region, country…"
          className="w-full rounded-xl border border-gray-border/70 bg-ocean-medium/60 py-2.5 pl-9 pr-4 text-sm text-white placeholder-gray-muted outline-none focus:border-cyan-glow/50 focus:bg-ocean-medium/80"
        />
      </div>

      {!query && (
        <p className="text-xs text-gray-muted">
          {allReefs.length - selectedIds.size} reefs available to add
        </p>
      )}
      {query && results.length === 0 && (
        <p className="text-xs text-gray-muted">No results for "{query}"</p>
      )}

      <div className="mt-3 max-h-[280px] space-y-1 overflow-y-auto pr-1">
        {results.map((reef) => {
          const status = getMarkerStatus(reef);
          const color = getRiskColor(status);
          return (
            <button
              key={reef.id}
              type="button"
              onClick={() => onAdd(reef)}
              className="flex w-full items-center justify-between gap-3 rounded-xl border border-gray-border/40 bg-ocean-medium/35 px-4 py-3 text-left transition hover:border-cyan-glow/40 hover:bg-ocean-medium/65"
            >
              <div className="min-w-0">
                <p className="truncate text-sm text-white">{reef.name}</p>
                <p className="truncate text-xs text-gray-muted">{reef.region}, {reef.country}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
                <Plus className="h-4 w-4 text-cyan-glow" />
              </div>
            </button>
          );
        })}
      </div>
    </motion.div>
  );
}

function MapFocusController({ target }: { target?: SearchNavigationTarget | null }) {
  const map = useMap();

  useEffect(() => {
    if (!map || target?.lat === undefined || target.lng === undefined) return;

    map.panTo({ lat: target.lat, lng: target.lng });
    map.setZoom(Math.max(map.getZoom() || 4, 5));
  }, [map, target?.id, target?.lat, target?.lng]);

  return null;
}

export function LiveReefGoogleMap({ onReefSelect: _onReefSelect, focusTarget, onMonitoredCountChange }: LiveReefGoogleMapProps) {
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  const [allReefs, setAllReefs] = useState<LiveReef[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(MONITORED_IDS_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) return new Set<string>(parsed);
      }
    } catch {}
    return new Set<string>();
  });
  const [isAddPanelOpen, setIsAddPanelOpen] = useState(false);
  const [stations, setStations] = useState<Array<ReefStation | ReefStationReading>>([]);
  const [selectedReef, setSelectedReef] = useState<LiveReef | null>(null);
  const [selectedStation, setSelectedStation] = useState<ReefStation | ReefStationReading | null>(null);
  const [isLoadingReefs, setIsLoadingReefs] = useState(true);
  const [isLoadingStations, setIsLoadingStations] = useState(true);
  const [reefError, setReefError] = useState<string | null>(null);
  const [stationError, setStationError] = useState<string | null>(null);
  const [monitoringError, setMonitoringError] = useState<string | null>(null);
  const [monitoringToast, setMonitoringToast] = useState<string | null>(null);
  const [isAddingMonitoring, setIsAddingMonitoring] = useState(false);
  const [timeRange, setTimeRange] = useState<TimeRangeMode>('live');

  // Persist monitored reef selection to localStorage whenever it changes
  useEffect(() => {
    try {
      localStorage.setItem(MONITORED_IDS_STORAGE_KEY, JSON.stringify([...selectedIds]));
      window.dispatchEvent(new CustomEvent('reefwatch:monitoring-updated'));
    } catch {}
  }, [selectedIds]);

  useEffect(() => {
    let isMounted = true;

    async function loadReefs() {
      try {
        const liveReefs = await fetchLiveReefs();

        if (isMounted) {
          setAllReefs(liveReefs);

          // Only apply curated default selection if user has no saved preferences
          const hasStoredSelection = (() => {
            try {
              const stored = localStorage.getItem(MONITORED_IDS_STORAGE_KEY);
              return stored ? JSON.parse(stored).length > 0 : false;
            } catch { return false; }
          })();

          if (!hasStoredSelection) {
            const initIds = new Set<string>();
            for (const term of CURATED_TERMS) {
              const match = liveReefs.find((r) =>
                `${r.name} ${r.region} ${r.country}`.toLowerCase().includes(term),
              );
              if (match) initIds.add(match.id);
            }
            if (initIds.size < 3) liveReefs.slice(0, 8).forEach((r) => initIds.add(r.id));
            setSelectedIds(initIds);
          }

          setReefError(null);
        }
      } catch (error) {
        if (isMounted) {
          setReefError('Active reef data is unavailable from the deployed ReefWatch backend.');
        }
      } finally {
        if (isMounted) {
          setIsLoadingReefs(false);
        }
      }
    }

    loadReefs();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    async function loadStations(isRetry = false) {
      try {
        const [stationList, readings] = await Promise.all([
          fetchReefStations(),
          fetchReefStationReadings().catch(() => [] as ReefStationReading[]),
        ]);

        if (isMounted) {
          const readingsMap = new Map<string, ReefStationReading>(
            readings.map((r) => [r.stationId || r.id, r]),
          );
          const merged: Array<ReefStation | ReefStationReading> = stationList.map(
            (s) => (readingsMap.get(s.id) as ReefStationReading | undefined) ?? s,
          );
          setStations(merged);
          setStationError(null);
        }
      } catch {
        if (isMounted) {
          if (!isRetry) {
            // Silent retry after 12s — backend may be warming up
            retryTimer = setTimeout(() => { loadStations(true); }, 12000);
          } else {
            setStationError('NOAA station layer is unavailable. Active reefs can still be monitored.');
          }
        }
      } finally {
        if (isMounted) {
          setIsLoadingStations(false);
        }
      }
    }

    loadStations();

    return () => {
      isMounted = false;
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, []);

  const mapReefs = useMemo(
    () => allReefs.map((reef) => getReefForTimeRange(reef, timeRange)),
    [allReefs, timeRange],
  );

  const monitoredReefs = useMemo(
    () => mapReefs.filter((reef) => selectedIds.has(reef.id)),
    [mapReefs, selectedIds],
  );

  useEffect(() => {
    onMonitoredCountChange?.(selectedIds.size);
  }, [onMonitoredCountChange, selectedIds.size]);

  const displayedReefs = useMemo(
    () => monitoredReefs,
    [monitoredReefs],
  );

  const monitoredStationIds = useMemo(
    () => new Set(allReefs.flatMap((reef) => [reef.id, reef.stationId]).filter(Boolean)),
    [allReefs],
  );

  const displayedStations = useMemo(
    () => stations
      .filter((station) => (
        !monitoredStationIds.has(station.id)
        && !('stationId' in station && monitoredStationIds.has(station.stationId))
      ))
      .map((station) => getStationForTimeRange(station, timeRange)),
    [stations, monitoredStationIds, timeRange],
  );

  useEffect(() => {
    if (selectedReef) {
      setSelectedReef(mapReefs.find((reef) => reef.id === selectedReef.id) ?? null);
    }
  }, [mapReefs, selectedReef?.id]);

  useEffect(() => {
    if (selectedStation) {
      setSelectedStation(displayedStations.find((station) => station.id === selectedStation.id) ?? null);
    }
  }, [displayedStations, selectedStation?.id]);

  useEffect(() => {
    if (!focusTarget) return;

    const matchingReef = mapReefs.find((reef) => reef.id === focusTarget.id || reef.name === focusTarget.name);
    if (matchingReef) {
      setSelectedReef(matchingReef);
      setSelectedStation(null);
      return;
    }

    const matchingStation = displayedStations.find((station) => station.id === focusTarget.id || station.name === focusTarget.name);
    if (matchingStation) {
      setSelectedStation(matchingStation);
      setSelectedReef(null);
    }
  }, [mapReefs, displayedStations, focusTarget]);

  const markerIcons = useMemo(() => {
    return new Map<string, string>(
      mapReefs.map((reef) => [
        reef.id,
        createMarkerIcon(getMarkerStatus(reef), selectedIds.has(reef.id), selectedReef?.id === reef.id),
      ]),
    );
  }, [mapReefs, selectedIds, selectedReef?.id]);

  const stationIcons = useMemo(() => {
    return new Map<string, string>(
      displayedStations.map((station) => [
        station.id,
        createStationIcon(getStationVisualStatus(station), selectedStation?.id === station.id),
      ]),
    );
  }, [displayedStations, selectedStation?.id]);

  const readingCount = displayedReefs.length;

  function handleToggleMonitoring(reef: LiveReef) {
    const willRemove = selectedIds.has(reef.id);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(reef.id)) {
        next.delete(reef.id);
      } else {
        next.add(reef.id);
      }
      return next;
    });
    // Clean up custom-monitored stations from backend + local reef list when de-monitored
    if (willRemove && reef.isCustomMonitored) {
      setAllReefs((current) => current.filter((r) => r.id !== reef.id));
      removeFromActiveMonitoring(reef.id).catch(() => {/* non-fatal */});
    }
  }

  function handleAddToMap(reef: LiveReef) {
    setSelectedIds((prev) => new Set([...prev, reef.id]));
    setIsAddPanelOpen(false);
    setSelectedReef(getReefForTimeRange(reef, timeRange));
    setSelectedStation(null);
  }

  async function handleAddStationToMonitoring(station: ReefStation | ReefStationReading) {
    setMonitoringError(null);

    // Optimistic: place on map immediately as pending so the user sees instant feedback
    const stationId = 'stationId' in station ? station.stationId : station.id;
    const optimisticId = `station-${stationId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const optimisticReef: LiveReef = {
      id: optimisticId,
      stationId,
      name: station.name,
      region: 'NOAA Virtual Station',
      country: 'NOAA Virtual Station',
      lat: station.lat,
      lng: station.lng,
      seaSurfaceTemp: 'seaSurfaceTemp' in station ? station.seaSurfaceTemp : null,
      tempAnomaly: 'tempAnomaly' in station ? station.tempAnomaly : null,
      degreeHeatingWeeks: 'degreeHeatingWeeks' in station ? station.degreeHeatingWeeks : null,
      bleachingAlertLevel: 'bleachingAlertLevel' in station ? station.bleachingAlertLevel : 'Fetching...',
      riskScore: 'riskScore' in station ? station.riskScore : 0,
      status: 'status' in station && ['safe', 'warning', 'critical'].includes(station.status as string)
        ? station.status as LiveReef['status']
        : 'pending',
      source: 'Fetching NOAA data...',
      lastUpdated: new Date().toISOString(),
      isCustomMonitored: true,
    };

    setAllReefs((current) => [
      ...current.filter((r) => r.id !== optimisticId && r.stationId !== stationId),
      optimisticReef,
    ]);
    setSelectedIds((prev) => new Set([...prev, optimisticId]));
    setSelectedStation(null);
    setSelectedReef(optimisticReef);
    setIsAddingMonitoring(true);

    try {
      const monitoredReef = await addStationToActiveMonitoring({
        station_id: stationId,
        name: station.name,
        lat: station.lat,
        lng: station.lng,
      });

      setAllReefs((current) => [
        ...current.filter((reef) => reef.id !== optimisticId && reef.id !== monitoredReef.id && reef.stationId !== monitoredReef.stationId),
        monitoredReef,
      ]);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(optimisticId);
        next.add(monitoredReef.id);
        return next;
      });
      setSelectedReef(monitoredReef);
      setMonitoringToast(`${monitoredReef.name} is now under active AI monitoring`);
      window.setTimeout(() => setMonitoringToast(null), 4200);
    } catch (error) {
      console.error('[LiveReefGoogleMap] add to monitoring failed', error);
      // Roll back optimistic reef on hard failure
      setAllReefs((current) => current.filter((r) => r.id !== optimisticId));
      setSelectedIds((prev) => { const next = new Set(prev); next.delete(optimisticId); return next; });
      setSelectedReef(null);
      setMonitoringError(error instanceof Error ? error.message : 'Unable to add this station to active monitoring.');
    } finally {
      setIsAddingMonitoring(false);
    }
  }

  if (!apiKey) {
    return <ApiKeyFallback />;
  }

  return (
    <div className="relative h-full w-full overflow-hidden bg-ocean-deep">
      <APIProvider apiKey={apiKey}>
        <GoogleMap
          className="h-full w-full"
          defaultCenter={{ lat: 4, lng: 45 }}
          defaultZoom={2.4}
          minZoom={2}
          maxZoom={8}
          disableDefaultUI
          gestureHandling="greedy"
          clickableIcons={false}
          keyboardShortcuts={false}
          styles={oceanMapStyles}
          restriction={{
            latLngBounds: { north: 85, south: -85, east: 180, west: -180 },
            strictBounds: false,
          }}
        >
          <MapFocusController target={focusTarget} />
          {displayedStations.map((station) => (
            <Marker
              key={station.id}
              position={{ lat: station.lat, lng: station.lng }}
              title={station.name}
              icon={stationIcons.get(station.id)}
              zIndex={selectedStation?.id === station.id ? 6 : 1}
              onClick={() => {
                setSelectedStation(station);
                setSelectedReef(null);
              }}
            />
          ))}

          {mapReefs.map((reef) => (
            <Marker
              key={reef.id}
              position={{ lat: reef.lat, lng: reef.lng }}
              title={reef.name}
              icon={markerIcons.get(reef.id)}
              zIndex={selectedReef?.id === reef.id ? 20 : selectedIds.has(reef.id) ? 10 : 5}
              onClick={() => {
                setSelectedReef(reef);
                setSelectedStation(null);
                setIsAddPanelOpen(false);
              }}
            />
          ))}
        </GoogleMap>
      </APIProvider>

      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,transparent_45%,rgba(3,18,28,0.42)_100%)]" />
      {isLoadingStations && (
        <div className="reef-panel-strong absolute left-1/2 top-8 z-10 -translate-x-1/2 rounded-full border border-cyan-glow/35 bg-ocean-dark/78 px-5 py-3 text-sm text-gray-light shadow-2xl backdrop-blur-2xl">
          Loading NOAA map layers...
        </div>
      )}
      {(reefError || stationError) && (
        <div className="reef-panel-strong absolute left-1/2 top-8 z-10 max-w-md -translate-x-1/2 rounded-2xl border border-coral-warning/45 bg-ocean-dark/82 px-5 py-4 text-center text-sm text-gray-light shadow-2xl backdrop-blur-2xl">
          {reefError || stationError}
        </div>
      )}
      {monitoringToast && (
        <motion.div
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          className="reef-panel-strong absolute right-8 top-8 z-20 flex max-w-md items-center gap-3 rounded-2xl border border-coral-safe/35 bg-ocean-dark/88 px-5 py-4 text-sm text-gray-light shadow-2xl backdrop-blur-2xl"
        >
          <CheckCircle2 className="h-5 w-5 text-coral-safe" />
          <span>{monitoringToast}</span>
        </motion.div>
      )}
      {isAddPanelOpen && !selectedReef && (
        <AddReefPanel
          allReefs={allReefs}
          selectedIds={selectedIds}
          onAdd={handleAddToMap}
          onClose={() => setIsAddPanelOpen(false)}
        />
      )}
      {selectedReef && (
        <ReefSelectionPanel
          reef={selectedReef}
          timeRangeLabel={timeRangeLabels[timeRange]}
          onClose={() => setSelectedReef(null)}
          onToggleMonitoring={handleToggleMonitoring}
          isMonitored={selectedIds.has(selectedReef.id)}
        />
      )}
      {selectedStation && (
        <StationSelectionPanel
          station={selectedStation}
          timeRangeLabel={timeRangeLabels[timeRange]}
          onClose={() => setSelectedStation(null)}
          onAdd={handleAddStationToMonitoring}
          isAdding={isAddingMonitoring}
          error={monitoringError}
        />
      )}
      <motion.button
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        type="button"
        onClick={() => {
          setIsAddPanelOpen((prev) => !prev);
          setSelectedReef(null);
          setSelectedStation(null);
        }}
        className="reef-panel-strong absolute bottom-8 right-8 z-10 flex items-center gap-2 rounded-full border border-cyan-glow/40 bg-ocean-dark/80 px-4 py-2.5 text-sm text-white shadow-2xl backdrop-blur-2xl transition hover:border-cyan-glow/70 hover:bg-ocean-medium/80 hover:shadow-[0_0_18px_rgba(0,229,255,0.18)]"
        aria-label="Add reef to map"
      >
        <Plus className="h-4 w-4 text-cyan-glow" />
        Add Reef
      </motion.button>
      <MapOverlays
        activeCount={displayedReefs.length}
        readingCount={readingCount}
        stationCount={stations.length + displayedReefs.length}
        timeRange={timeRange}
        onTimeRangeChange={setTimeRange}
      />
    </div>
  );
}
