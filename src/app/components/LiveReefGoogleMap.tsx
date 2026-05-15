import { useEffect, useMemo, useState } from 'react';
import { APIProvider, Map as GoogleMap, Marker } from '@vis.gl/react-google-maps';
import { motion } from 'motion/react';
import { AlertTriangle, Clock, Database, Droplet, MapPin, Radio, ThermometerSun, X } from 'lucide-react';
import { fetchLiveReefs, fetchReefStations, type LiveReef, type ReefStation } from '../services/reefApi';

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

const getMarkerStatus = (reef: LiveReef) => reef.source === 'fallback' || reef.error ? 'fallback' : reef.status;

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
    default:
      return '#00e5ff';
  }
};

const createMarkerIcon = (status: LiveReef['status'] | 'fallback', selected: boolean) => {
  const color = getRiskColor(status);
  const size = selected ? 52 : 42;
  const radius = selected ? 8 : 6;
  const colorMatrix = status === 'fallback'
    ? '0 0 0 0 0.50 0 0 0 0 0.58 0 0 0 0 0.63 0 0 0 0.8 0'
    : `0 0 0 0 ${status === 'critical' ? '1' : '0'} 0 0 0 0 ${status === 'warning' ? '0.53' : '0.85'} 0 0 0 0 ${status === 'critical' ? '0.34' : '0.72'} 0 0 0 0.95 0`;
  const svg = `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="glow" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="5" result="blur"/>
          <feColorMatrix in="blur" type="matrix" values="${colorMatrix}"/>
          <feMerge>
            <feMergeNode/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
      </defs>
      <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 4}" fill="${color}" opacity="0.14"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 12}" fill="none" stroke="${color}" stroke-width="2" opacity="0.5"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="${color}" filter="url(#glow)"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${radius / 2}" fill="#e9fbff" opacity="0.85"/>
    </svg>
  `;

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
};

const createStationIcon = (selected: boolean) => {
  const size = selected ? 22 : 14;
  const radius = selected ? 4 : 2.8;
  const opacity = selected ? 0.9 : 0.48;
  const svg = `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${size / 2}" cy="${size / 2}" r="${radius + 3}" fill="#6fb7bf" opacity="0.12"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="#8fcfd6" opacity="${opacity}"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="#d7fbff" stroke-width="0.7" opacity="0.35"/>
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
      <MapOverlays activeCount={0} stationCount={0} />
    </div>
  );
}

function MapOverlays({ activeCount, stationCount }: { activeCount: number; stationCount: number }) {
  const [timeRange, setTimeRange] = useState(100);

  return (
    <>
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
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="reef-panel-soft absolute bottom-8 right-8 z-10 min-w-[320px] rounded-2xl border border-gray-border/70 bg-ocean-dark/72 p-5 shadow-2xl backdrop-blur-2xl"
      >
        <h4 className="mb-4 text-xs uppercase tracking-wider text-gray-muted">Time Range</h4>
        <div className="space-y-4">
          <input
            type="range"
            min="0"
            max="100"
            value={timeRange}
            onChange={(event) => setTimeRange(Number(event.target.value))}
            className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-ocean-medium accent-cyan-glow"
            aria-label="Map time range"
          />
          <div className="flex justify-between text-xs text-gray-muted">
            <span>Past Week</span>
            <span className="text-cyan-glow">Live</span>
            <span>Forecast</span>
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
        <span><span className="text-white">{stationCount}</span> NOAA stations tracked · <span className="text-white">{activeCount}</span> under active AI monitoring</span>
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

function DetailMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="reef-panel-soft rounded-xl border border-gray-border/70 bg-ocean-medium/45 p-4">
      <p className="mb-1 text-xs uppercase tracking-wider text-gray-muted">{label}</p>
      <p className="text-lg text-white">{value}</p>
    </div>
  );
}

function ReefSelectionPanel({ reef, onClose }: { reef: LiveReef; onClose: () => void }) {
  const markerStatus = getMarkerStatus(reef);
  const color = getRiskColor(markerStatus);

  return (
    <motion.div
      initial={{ opacity: 0, x: 32 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 32 }}
      className="reef-panel-strong absolute right-6 top-6 z-10 flex max-h-[calc(100%-3rem)] w-[380px] flex-col rounded-2xl border border-gray-border/70 bg-ocean-dark/88 p-6 shadow-2xl backdrop-blur-2xl"
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
          {reef.source === 'fallback' ? 'NOAA fallback' : 'NOAA live'}
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
          <p className="text-lg text-white">{reef.bleachingAlertLevel}</p>
        </div>

        <div className="reef-panel-soft rounded-xl border border-gray-border/70 bg-ocean-medium/45 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm text-gray-muted">
            <Clock className="h-4 w-4 text-cyan-glow" />
            <span>Last Updated</span>
          </div>
          <p className="text-sm text-white">{formatDate(reef.lastUpdated)}</p>
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
    </motion.div>
  );
}

function StationSelectionPanel({ station, onClose }: { station: ReefStation; onClose: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, x: 32 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 32 }}
      className="reef-panel-strong absolute right-6 top-6 z-10 w-[360px] rounded-2xl border border-gray-border/70 bg-ocean-dark/88 p-6 shadow-2xl backdrop-blur-2xl"
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
      </div>

      <button
        type="button"
        className="reef-panel-strong w-full rounded-xl border border-cyan-glow/40 bg-cyan-glow/12 px-5 py-3 text-sm text-cyan-glow transition-colors hover:border-cyan-glow/65 hover:bg-cyan-glow/18"
      >
        Request Full Analysis
      </button>
    </motion.div>
  );
}

export function LiveReefGoogleMap({ onReefSelect: _onReefSelect }: LiveReefGoogleMapProps) {
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  const [reefs, setReefs] = useState<LiveReef[]>([]);
  const [stations, setStations] = useState<ReefStation[]>([]);
  const [selectedReef, setSelectedReef] = useState<LiveReef | null>(null);
  const [selectedStation, setSelectedStation] = useState<ReefStation | null>(null);
  const [isLoadingReefs, setIsLoadingReefs] = useState(true);
  const [isLoadingStations, setIsLoadingStations] = useState(true);
  const [reefError, setReefError] = useState<string | null>(null);
  const [stationError, setStationError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadReefs() {
      try {
        const liveReefs = await fetchLiveReefs();

        if (isMounted) {
          setReefs(liveReefs);
          setReefError(null);
        }
      } catch (error) {
        if (isMounted) {
          setReefError('Active reef data is unavailable. Start the local backend on port 4000 to reconnect.');
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

    async function loadStations() {
      try {
        const stationList = await fetchReefStations();

        if (isMounted) {
          setStations(stationList);
          setStationError(null);
        }
      } catch (error) {
        if (isMounted) {
          setStationError('NOAA station layer is unavailable. Active reefs can still be monitored.');
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
    };
  }, []);

  const markerIcons = useMemo(() => {
    return new Map<string, string>(
      reefs.map((reef) => [
        reef.id,
        createMarkerIcon(getMarkerStatus(reef), selectedReef?.id === reef.id),
      ]),
    );
  }, [reefs, selectedReef?.id]);

  const stationIcons = useMemo(() => {
    return new Map<string, string>(
      stations.map((station) => [
        station.id,
        createStationIcon(selectedStation?.id === station.id),
      ]),
    );
  }, [stations, selectedStation?.id]);

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
          {stations.map((station) => (
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

          {reefs.map((reef) => (
            <Marker
              key={reef.id}
              position={{ lat: reef.lat, lng: reef.lng }}
              title={reef.name}
              icon={markerIcons.get(reef.id)}
              zIndex={selectedReef?.id === reef.id ? 20 : 10}
              onClick={() => {
                setSelectedReef(reef);
                setSelectedStation(null);
              }}
            />
          ))}
        </GoogleMap>
      </APIProvider>

      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,transparent_45%,rgba(3,18,28,0.42)_100%)]" />
      {(isLoadingReefs || isLoadingStations) && (
        <div className="reef-panel-strong absolute left-1/2 top-8 z-10 -translate-x-1/2 rounded-full border border-cyan-glow/35 bg-ocean-dark/78 px-5 py-3 text-sm text-gray-light shadow-2xl backdrop-blur-2xl">
          Loading NOAA map layers...
        </div>
      )}
      {(reefError || stationError) && (
        <div className="reef-panel-strong absolute left-1/2 top-8 z-10 max-w-md -translate-x-1/2 rounded-2xl border border-coral-warning/45 bg-ocean-dark/82 px-5 py-4 text-center text-sm text-gray-light shadow-2xl backdrop-blur-2xl">
          {reefError || stationError}
        </div>
      )}
      {selectedReef && (
        <ReefSelectionPanel
          reef={selectedReef}
          onClose={() => setSelectedReef(null)}
        />
      )}
      {selectedStation && (
        <StationSelectionPanel
          station={selectedStation}
          onClose={() => setSelectedStation(null)}
        />
      )}
      <MapOverlays activeCount={reefs.length} stationCount={stations.length} />
    </div>
  );
}
