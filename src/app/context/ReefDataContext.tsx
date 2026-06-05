import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { fetchMonitoredReefs, fetchReefStations, type LiveReef } from '../services/reefApi';
import { getActiveReefIds, isStorageAvailable, saveActiveReefIds } from '../utils/storage';
export { ACTIVE_IDS_KEY } from '../utils/storage';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

interface ReefDataContextValue {
  allReefs: LiveReef[];
  activeReefs: LiveReef[];
  activeReefIds: string[];    // IDs loaded synchronously from localStorage — available before allReefs loads
  storageAvailable: boolean;  // false in Safari private mode — show incognito warning
  reefs: LiveReef[];          // alias for allReefs — backwards compat
  totalStationCount: number;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

const ReefDataContext = createContext<ReefDataContextValue | null>(null);

export function ReefDataProvider({ children }: { children: React.ReactNode }) {
  const [allReefs, setAllReefs] = useState<LiveReef[]>([]);
  const [activeReefIds, setActiveReefIdsState] = useState<string[]>(getActiveReefIds);
  const [storageAvailable] = useState(isStorageAvailable);
  const [totalStationCount, setTotalStationCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isFetchingRef = useRef(false);
  const pendingRefetchRef = useRef(false);

  const loadReefs = (isBackground = false) => {
    if (isFetchingRef.current) {
      if (isBackground) pendingRefetchRef.current = true;
      return;
    }
    isFetchingRef.current = true;
    if (!isBackground) setIsLoading(true);

    fetchMonitoredReefs()
      .then((data) => {
        setAllReefs(data);
        setError(null);
        console.log(`[reefwatch] loaded ${data.length} reefs from backend`);
      })
      .catch((err: unknown) => {
        console.warn('[reefwatch] /api/monitored-reefs fetch failed:', (err as Error)?.message ?? err);
        if (!isBackground) {
          setError('Live reef data could not be loaded.');
        }
      })
      .finally(() => {
        setIsLoading(false);
        isFetchingRef.current = false;
        if (pendingRefetchRef.current) {
          pendingRefetchRef.current = false;
          loadReefs(true);
        }
      });
  };

  // Accept IDs from the event detail so we never need to re-read localStorage
  // (which fails in Safari private mode). If detail.ids is present, use it directly;
  // fall back to reading localStorage for old/external callers.
  const syncActiveIds = (e: Event) => {
    const event = e as CustomEvent<{ ids?: string[] }>;
    if (Array.isArray(event.detail?.ids)) {
      setActiveReefIdsState(event.detail.ids);
      saveActiveReefIds(event.detail.ids); // noop if storage unavailable
    } else {
      setActiveReefIdsState(getActiveReefIds());
    }
  };

  useEffect(() => {
    loadReefs();
    const interval = setInterval(() => loadReefs(true), REFRESH_INTERVAL_MS);
    fetchReefStations()
      .then((stations) => setTotalStationCount(stations.length))
      .catch(() => {});
    window.addEventListener('reefwatch:monitoring-updated', syncActiveIds);
    return () => {
      clearInterval(interval);
      window.removeEventListener('reefwatch:monitoring-updated', syncActiveIds);
    };
  }, []);

  const activeReefs = allReefs.filter((reef) => activeReefIds.includes(reef.id));

  return (
    <ReefDataContext.Provider value={{
      allReefs,
      activeReefs,
      activeReefIds,
      storageAvailable,
      reefs: allReefs,
      totalStationCount,
      isLoading,
      error,
      refetch: () => loadReefs(),
    }}>
      {children}
    </ReefDataContext.Provider>
  );
}

export function useReefData(): ReefDataContextValue {
  const ctx = useContext(ReefDataContext);
  if (!ctx) throw new Error('useReefData must be used within ReefDataProvider');
  return ctx;
}
