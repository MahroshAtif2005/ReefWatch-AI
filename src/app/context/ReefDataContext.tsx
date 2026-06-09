import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { fetchMonitoredReefs, fetchReefStations, getResearcherId, syncResearcherActiveReefs, type LiveReef } from '../services/reefApi';
import { getActiveReefIds, isStorageAvailable, saveActiveReefIds } from '../utils/storage';
export { ACTIVE_IDS_KEY } from '../utils/storage';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

interface ReefDataContextValue {
  allReefs: LiveReef[];
  activeReefs: LiveReef[];
  activeReefIds: string[];    // IDs loaded synchronously from localStorage — available before allReefs loads
  setActiveReefIds: React.Dispatch<React.SetStateAction<string[]>>;  // single source of truth for active selections
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
  const orphanLoggedRef = useRef(false);

  // Log initial IDs loaded from localStorage once on mount
  useEffect(() => {
    console.log('[active-reefs:frontend] localStorage ids on mount:', activeReefIds);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist activeReefIds to localStorage and sync to researcher profile on every change.
  // localStorage write is synchronous and immediate; backend sync is fire-and-forget.
  useEffect(() => {
    const researcherId = getResearcherId();
    console.log('[active-reefs] backend sync payload count:', activeReefIds.length, activeReefIds);
    saveActiveReefIds(activeReefIds);
    syncResearcherActiveReefs(researcherId, activeReefIds).then(() => {
      console.log('[active-reefs] backend sync confirmed for', activeReefIds.length, 'ids');
    }).catch(() => {
      console.warn('[active-reefs] backend sync failed (non-critical, localStorage is source of truth)');
    });
  }, [activeReefIds]);

  const loadReefs = (isBackground = false) => {
    if (isFetchingRef.current) {
      if (isBackground) pendingRefetchRef.current = true;
      return;
    }
    isFetchingRef.current = true;
    if (!isBackground) setIsLoading(true);

    const fetchStart = performance.now();
    console.log('[reefwatch] fetching /api/monitored-reefs…');

    fetchMonitoredReefs()
      .then((data) => {
        const elapsed = Math.round(performance.now() - fetchStart);
        setAllReefs(data);
        setError(null);
        console.log(`[reefwatch] loaded ${data.length} reefs in ${elapsed}ms`);
      })
      .catch((err: unknown) => {
        const elapsed = Math.round(performance.now() - fetchStart);
        console.warn(`[reefwatch] /api/monitored-reefs failed after ${elapsed}ms:`, (err as Error)?.message ?? err);
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

  useEffect(() => {
    loadReefs();
    const interval = setInterval(() => loadReefs(true), REFRESH_INTERVAL_MS);
    fetchReefStations()
      .then((stations) => setTotalStationCount(stations.length))
      .catch(() => {});
    return () => {
      clearInterval(interval);
    };
  }, []);

  const activeReefs = allReefs.filter((reef) => activeReefIds.includes(reef.id));

  // After allReefs loads: log matched vs. orphaned IDs — but NEVER delete orphaned IDs.
  // Orphaned IDs are preserved so the user's full selection survives NOAA data gaps.
  useEffect(() => {
    if (allReefs.length === 0 || orphanLoggedRef.current) return;
    orphanLoggedRef.current = true;

    const validIds = new Set(allReefs.map(r => r.id));
    const matched = activeReefIds.filter(id => validIds.has(id));
    const orphaned = activeReefIds.filter(id => !validIds.has(id));
    console.log('[active-reefs] selected local ids:', activeReefIds.length, activeReefIds);
    console.log('[active-reefs] matched live ids:', matched.length, matched);
    console.log('[active-reefs] orphan/pending ids:', orphaned.length, orphaned);
    console.log('[active-reefs] backend restored count:', matched.length, '(from NOAA data match)');
    if (orphaned.length > 0) {
      console.warn('[active-reefs] orphaned IDs preserved (not in current NOAA data — kept in localStorage):', orphaned);
    }
  }, [allReefs, activeReefIds]);

  // Log whenever allReefs or activeReefIds change so ID mismatches are visible in DevTools
  useEffect(() => {
    if (allReefs.length > 0) {
      const orphaned = activeReefIds.filter(id => !allReefs.find(r => r.id === id));
      console.log(
        '[active-reefs:dashboard] local ids, matched ids, orphaned ids —',
        `local=${activeReefIds.length}`,
        `matched=${activeReefs.length}`,
        `orphaned=${orphaned.length}`,
        '\nlocalIds:', activeReefIds,
        '\nmatchedIds:', activeReefs.map(r => r.id),
        orphaned.length > 0 ? `\norphanedIds (${orphaned.length} preserved in storage, not in current NOAA data):` : '',
        orphaned.length > 0 ? orphaned : '',
      );
    }
  }, [allReefs, activeReefIds, activeReefs]);

  return (
    <ReefDataContext.Provider value={{
      allReefs,
      activeReefs,
      activeReefIds,
      setActiveReefIds: setActiveReefIdsState,
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
