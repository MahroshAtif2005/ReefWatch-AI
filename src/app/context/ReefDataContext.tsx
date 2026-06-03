import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { fetchLiveReefs, type LiveReef } from '../services/reefApi';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const LOADING_TIMEOUT_MS = 3000;

// Static fallback shown if the backend takes > 3s on cold start
const STATIC_FALLBACK_REEFS: LiveReef[] = [
  { id: 'great-barrier-reef', name: 'Great Barrier Reef', region: 'Coral Sea', country: 'Australia', lat: -18.2871, lng: 147.6992, seaSurfaceTemp: 24.8, tempAnomaly: 0.4, degreeHeatingWeeks: 1.0, bleachingAlertLevel: 'No Stress', riskScore: 12, status: 'safe', noaaDataAvailable: true, lastUpdated: new Date().toISOString(), source: 'Static baseline' },
  { id: 'maldives-north-atoll', name: 'Maldives (North Atoll)', region: 'Indian Ocean', country: 'Maldives', lat: 4.175, lng: 73.509, seaSurfaceTemp: 29.5, tempAnomaly: 1.8, degreeHeatingWeeks: 5.2, bleachingAlertLevel: 'Alert Level 1', riskScore: 66, status: 'warning', noaaDataAvailable: true, lastUpdated: new Date().toISOString(), source: 'Static baseline' },
  { id: 'maui-hawaii', name: 'Maui (Hawaii)', region: 'Central Pacific', country: 'United States', lat: 20.7984, lng: -156.3319, seaSurfaceTemp: 27.5, tempAnomaly: 1.1, degreeHeatingWeeks: 3.2, bleachingAlertLevel: 'Bleaching Watch', riskScore: 41, status: 'safe', noaaDataAvailable: true, lastUpdated: new Date().toISOString(), source: 'Static baseline' },
  { id: 'florida-keys', name: 'Florida Keys', region: 'Caribbean', country: 'United States', lat: 24.7136, lng: -81.0681, seaSurfaceTemp: 29.8, tempAnomaly: 1.5, degreeHeatingWeeks: 4.5, bleachingAlertLevel: 'Alert Level 1', riskScore: 57, status: 'warning', noaaDataAvailable: true, lastUpdated: new Date().toISOString(), source: 'Static baseline' },
  { id: 'northern-red-sea', name: 'Northern Red Sea', region: 'Red Sea', country: 'Saudi Arabia', lat: 28.5, lng: 34.9, seaSurfaceTemp: 31.5, tempAnomaly: 2.8, degreeHeatingWeeks: 9.2, bleachingAlertLevel: 'Alert Level 2', riskScore: 100, status: 'critical', noaaDataAvailable: true, lastUpdated: new Date().toISOString(), source: 'Static baseline' },
  { id: 'coral-triangle-banda', name: 'Coral Triangle (Banda Sea)', region: 'Southeast Asia', country: 'Indonesia', lat: -4.522, lng: 129.893, seaSurfaceTemp: 28.9, tempAnomaly: 1.2, degreeHeatingWeeks: 3.8, bleachingAlertLevel: 'Bleaching Watch', riskScore: 48, status: 'warning', noaaDataAvailable: true, lastUpdated: new Date().toISOString(), source: 'Static baseline' },
  { id: 'galapagos-islands', name: 'Galápagos Islands', region: 'Eastern Pacific', country: 'Ecuador', lat: -0.9538, lng: -90.9656, seaSurfaceTemp: 22.4, tempAnomaly: -0.3, degreeHeatingWeeks: 0.0, bleachingAlertLevel: 'No Stress', riskScore: 0, status: 'safe', noaaDataAvailable: true, lastUpdated: new Date().toISOString(), source: 'Static baseline' },
  { id: 'raja-ampat', name: 'Raja Ampat', region: 'Southeast Asia', country: 'Indonesia', lat: -0.5678, lng: 130.9789, seaSurfaceTemp: 29.1, tempAnomaly: 0.9, degreeHeatingWeeks: 2.1, bleachingAlertLevel: 'No Stress', riskScore: 25, status: 'safe', noaaDataAvailable: true, lastUpdated: new Date().toISOString(), source: 'Static baseline' },
  { id: 'caribbean-belize', name: 'Belize Barrier Reef', region: 'Caribbean', country: 'Belize', lat: 17.2, lng: -87.7, seaSurfaceTemp: 29.2, tempAnomaly: 1.3, degreeHeatingWeeks: 3.5, bleachingAlertLevel: 'Bleaching Watch', riskScore: 44, status: 'warning', noaaDataAvailable: true, lastUpdated: new Date().toISOString(), source: 'Static baseline' },
];

interface ReefDataContextValue {
  reefs: LiveReef[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

const ReefDataContext = createContext<ReefDataContextValue | null>(null);

export function ReefDataProvider({ children }: { children: React.ReactNode }) {
  const [reefs, setReefs] = useState<LiveReef[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isFetchingRef = useRef(false);

  const loadReefs = (isBackground = false) => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    if (!isBackground) setIsLoading(true);

    // After 3s of waiting, show static fallback so stat cards never stay at "..."
    const fallbackTimer = isBackground
      ? null
      : setTimeout(() => {
          if (isFetchingRef.current) {
            setReefs((prev) => (prev.length === 0 ? STATIC_FALLBACK_REEFS : prev));
            setIsLoading(false);
          }
        }, LOADING_TIMEOUT_MS);

    fetchLiveReefs()
      .then((data) => {
        setReefs(data);
        setError(null);
        console.log(`[reefwatch] loaded ${data.length} actively monitored reefs`);
      })
      .catch((err: unknown) => {
        console.warn('[reefwatch] /api/reefs/live fetch failed:', (err as Error)?.message ?? err);
        if (!isBackground) {
          // On failure show static fallback with an error note
          setReefs((prev) => (prev.length === 0 ? STATIC_FALLBACK_REEFS : prev));
          setError('Live reef data could not be loaded.');
        }
      })
      .finally(() => {
        if (fallbackTimer !== null) clearTimeout(fallbackTimer);
        setIsLoading(false);
        isFetchingRef.current = false;
      });
  };

  useEffect(() => {
    loadReefs();
    const interval = setInterval(() => loadReefs(true), REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  return (
    <ReefDataContext.Provider value={{ reefs, isLoading, error, refetch: () => loadReefs() }}>
      {children}
    </ReefDataContext.Provider>
  );
}

export function useReefData(): ReefDataContextValue {
  const ctx = useContext(ReefDataContext);
  if (!ctx) throw new Error('useReefData must be used within ReefDataProvider');
  return ctx;
}
