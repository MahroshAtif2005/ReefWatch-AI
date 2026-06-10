import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { addStationToActiveMonitoring, fetchMonitoredReefs, fetchReefStations, getResearcherId, syncResearcherActiveReefs, type LiveReef } from '../services/reefApi';
import { getActiveReefIds, getStationCatalog, isStorageAvailable, removeStationFromCatalog, saveActiveReefIds, saveStationToCatalog } from '../utils/storage';
export { ACTIVE_IDS_KEY } from '../utils/storage';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export type HydrationStatus = 'loading' | 'restoring' | 'ready';

interface ReefDataContextValue {
  allReefs: LiveReef[];
  activeReefs: LiveReef[];
  activeReefIds: string[];    // IDs loaded synchronously from localStorage — available before allReefs loads
  setActiveReefIds: React.Dispatch<React.SetStateAction<string[]>>;  // single source of truth for active selections
  storageAvailable: boolean;  // false in Safari private mode — show incognito warning
  reefs: LiveReef[];          // alias for allReefs — backwards compat
  totalStationCount: number;
  isLoading: boolean;
  /** loading → waiting for first API response; restoring → re-registering orphaned stations; ready → all done */
  hydrationStatus: HydrationStatus;
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
  const [hydrationStatus, setHydrationStatus] = useState<HydrationStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const isFetchingRef = useRef(false);
  const pendingRefetchRef = useRef(false);
  const orphanLoggedRef = useRef(false);
  const hydrateStartRef = useRef(performance.now());
  const hasSyncedOnMountRef = useRef(false);

  // Log initial IDs loaded from localStorage once on mount
  useEffect(() => {
    const t0 = Math.round(performance.now() - hydrateStartRef.current);
    console.log(`[hydration] t0=+${t0}ms localStorage read → ${activeReefIds.length} ids`, activeReefIds);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist activeReefIds to localStorage on every change, and sync to the researcher profile
  // on user-driven changes. Skip the very first fire (mount) — the backend is already hydrated
  // from GCS on startup, and sending the unchanged localStorage value is pure noise.
  useEffect(() => {
    saveActiveReefIds(activeReefIds);
    if (!hasSyncedOnMountRef.current) {
      hasSyncedOnMountRef.current = true;
      return;
    }
    const researcherId = getResearcherId();
    console.log('[active-reefs] backend sync payload count:', activeReefIds.length, activeReefIds);
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
    const t1 = Math.round(fetchStart - hydrateStartRef.current);
    if (!isBackground) console.log(`[hydration] t1=+${t1}ms → fetching /api/monitored-reefs`);

    fetchMonitoredReefs()
      .then((data) => {
        const elapsed = Math.round(performance.now() - fetchStart);
        const t2 = Math.round(performance.now() - hydrateStartRef.current);
        setAllReefs(data);
        setError(null);
        if (!isBackground) console.log(`[hydration] t2=+${t2}ms NOAA fetch complete (${elapsed}ms RTT) → ${data.length} reefs`);
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

  // Fallback: if loading finishes but allReefs is still empty (API error or no reefs),
  // mark hydration ready so the UI doesn't stay in "loading" forever.
  useEffect(() => {
    if (!isLoading && allReefs.length === 0) {
      console.log(`[hydration] ready=+${Math.round(performance.now() - hydrateStartRef.current)}ms (fallback — API error or empty response)`);
      setHydrationStatus('ready');
    }
  }, [isLoading, allReefs.length]);

  // After allReefs loads: log matched vs. orphaned IDs, auto-recover custom stations
  // from the local catalog if the backend DB was wiped (Cloud Run restart/deploy).
  // Drives hydrationStatus: loading → restoring → ready (or loading → ready if no orphans).
  // Orphaned IDs are NEVER deleted — they persist until resolved.
  useEffect(() => {
    if (allReefs.length === 0 || orphanLoggedRef.current) return;
    orphanLoggedRef.current = true;

    const validIds = new Set(allReefs.map(r => r.id));
    const matched = activeReefIds.filter(id => validIds.has(id));
    const orphaned = activeReefIds.filter(id => !validIds.has(id));

    const t3 = Math.round(performance.now() - hydrateStartRef.current);
    console.log(`[hydration] t3=+${t3}ms orphan check → saved=${activeReefIds.length} matched=${matched.length} orphaned=${orphaned.length}`);
    // Structured diagnostic report visible in DevTools
    console.log(
      `[active-reefs]\nsaved=${activeReefIds.length}\nmatched=${matched.length}\nunmatched=${orphaned.length}\nexample_unmatched=${JSON.stringify(orphaned.slice(0, 3))}\nsource=localStorage`,
    );
    console.log('[active-reefs] selected local ids:', activeReefIds.length, activeReefIds);
    console.log('[active-reefs] matched live ids:', matched.length, matched);
    console.log('[active-reefs] orphan/pending ids:', orphaned.length, orphaned);
    console.log('[active-reefs] backend restored count:', matched.length, '(from NOAA data match)');

    if (orphaned.length === 0) {
      console.log(`[hydration] ready=+${Math.round(performance.now() - hydrateStartRef.current)}ms (no orphans)`);
      setHydrationStatus('ready');
      return;
    }

    console.warn('[active-reefs] orphaned IDs preserved (not in current NOAA data — kept in localStorage):', orphaned);

    // Auto-recover any orphaned IDs that have catalog metadata (custom-monitored stations).
    // This handles the case where Cloud Run's ephemeral SQLite DB was wiped — we re-register
    // the station with the backend so it appears in the next API response.
    const catalog = getStationCatalog();
    const recoverable = orphaned.filter(id => catalog[id]);

    if (recoverable.length === 0) {
      console.log(`[hydration] ready=+${Math.round(performance.now() - hydrateStartRef.current)}ms (orphans not in catalog — unrecoverable)`);
      setHydrationStatus('ready');
      return;
    }

    setHydrationStatus('restoring');
    console.log('[active-reefs] auto-recovering', recoverable.length, 'custom station(s) from local catalog');

    Promise.all(
      recoverable.map(id => {
        const meta = catalog[id];
        return addStationToActiveMonitoring({
          station_id: meta.stationId,
          name: meta.name,
          lat: meta.lat,
          lng: meta.lng,
        }).then(recovered => {
          // Backend should produce the same deterministic ID, but handle divergence gracefully
          if (recovered.id !== id) {
            setActiveReefIdsState(prev => [...prev.filter(x => x !== id), recovered.id]);
            saveStationToCatalog({ ...meta, id: recovered.id });
            removeStationFromCatalog(id);
          }
          return recovered;
        });
      }),
    ).then(recoveredReefs => {
      setAllReefs(prev => {
        const existingIds = new Set(prev.map(r => r.id));
        return [...prev, ...recoveredReefs.filter(r => !existingIds.has(r.id))];
      });
      console.log('[active-reefs] auto-recovery complete:', recoveredReefs.length, 'station(s) restored to backend');
    }).catch(err => {
      console.warn('[active-reefs] auto-recovery failed (will retry on next load):', (err as Error).message ?? err);
    }).finally(() => {
      console.log(`[hydration] ready=+${Math.round(performance.now() - hydrateStartRef.current)}ms (recovery complete)`);
      setHydrationStatus('ready');
    });
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
      hydrationStatus,
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
