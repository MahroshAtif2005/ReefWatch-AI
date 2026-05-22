import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Bell,
  BellDot,
  Check,
  ChevronDown,
  FileText,
  Loader2,
  LogOut,
  MapPin,
  Microscope,
  Search,
  Settings,
  SlidersHorizontal,
  User,
  Waves,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import {
  fetchHistoricalTrends,
  fetchLiveReefs,
  fetchReefStationReadings,
  fetchReefStations,
  type HistoricalTrendsResponse,
  type LiveReef,
  type ReefStation,
  type ReefStationReading,
} from '../services/reefApi';

interface HeaderProps {
  onNavigate: (view: string, target?: SearchNavigationTarget) => void;
}

type SearchResult = {
  id: string;
  title: string;
  subtitle: string;
  view: string;
  type: 'reef' | 'station' | 'alert' | 'report' | 'analysis' | 'trend' | 'page';
  group: 'Reef Locations' | 'NOAA Stations' | 'Alerts' | 'Reports' | 'AI Analyses' | 'Historical Data' | 'Pages';
  target?: SearchNavigationTarget;
};

export type SearchNavigationTarget = (Partial<LiveReef> & Partial<ReefStationReading> & {
  id: string;
  name: string;
  lat?: number;
  lng?: number;
  searchTargetType?: 'reef' | 'station' | 'alert' | 'report' | 'analysis' | 'trend' | 'page';
});

type NotificationItem = {
  id: string;
  title: string;
  body: string;
  time: string;
  unread: boolean;
  tone: 'critical' | 'warning' | 'info';
  view: string;
};

const pageResults: SearchResult[] = [
  { id: 'page-map', title: 'Live Reef Map', subtitle: 'Explore NOAA-backed reef locations', view: 'map', type: 'page', group: 'Pages' },
  { id: 'page-reports', title: 'Conservation Reports', subtitle: 'Generate and export reef management reports', view: 'reports', type: 'page', group: 'Pages' },
  { id: 'page-analysis', title: 'AI Analysis', subtitle: 'Risk assessment and ReefWatch intelligence', view: 'analysis', type: 'page', group: 'Pages' },
  { id: 'page-trends', title: 'Historical Trends', subtitle: 'NOAA snapshot and historical trend monitoring', view: 'trends', type: 'page', group: 'Pages' },
  { id: 'page-agents', title: 'Agent Activity', subtitle: 'Autonomous ReefWatch AI operations', view: 'agents', type: 'page', group: 'Pages' },
  { id: 'page-workspace', title: 'Researcher Workspace', subtitle: 'Ask research questions against live reef context', view: 'workspace', type: 'page', group: 'Pages' },
];

const initialNotifications: NotificationItem[] = [
  {
    id: 'alert-critical',
    title: 'Critical bleaching risk detected',
    body: 'One monitored reef is currently classified as critical.',
    time: 'Now',
    unread: true,
    tone: 'critical',
    view: 'map',
  },
  {
    id: 'noaa-update',
    title: 'NOAA live snapshot refreshed',
    body: 'Coral Reef Watch conditions are available for monitored locations.',
    time: '12 min ago',
    unread: true,
    tone: 'info',
    view: 'trends',
  },
  {
    id: 'ai-insight',
    title: 'AI insight ready',
    body: 'Review current risk drivers and recommended conservation actions.',
    time: '28 min ago',
    unread: false,
    tone: 'warning',
    view: 'analysis',
  },
];

const resultIcon = {
  reef: MapPin,
  station: Waves,
  alert: BellDot,
  report: FileText,
  analysis: Microscope,
  trend: Activity,
  page: Search,
};

const groupOrder: SearchResult['group'][] = [
  'Reef Locations',
  'NOAA Stations',
  'Alerts',
  'Reports',
  'AI Analyses',
  'Historical Data',
  'Pages',
];

const matches = (term: string, values: Array<unknown>) => values.some((value) => String(value || '').toLowerCase().includes(term));

export function Header({ onNavigate }: HeaderProps) {
  const [query, setQuery] = useState('');
  const [reefs, setReefs] = useState<LiveReef[]>([]);
  const [stations, setStations] = useState<Array<ReefStation | ReefStationReading>>([]);
  const [trends, setTrends] = useState<HistoricalTrendsResponse | null>(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isSearchLoading, setIsSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [notifications, setNotifications] = useState(initialNotifications);
  const headerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!headerRef.current?.contains(event.target as Node)) {
        setIsSearchOpen(false);
        setIsNotificationsOpen(false);
        setIsProfileOpen(false);
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, []);

  useEffect(() => {
    let isMounted = true;
    const shouldFetch = isSearchOpen && query.trim().length > 0 && reefs.length === 0 && stations.length === 0 && !searchError;

    if (!shouldFetch) return;

    setIsSearchLoading(true);
    Promise.all([
      fetchLiveReefs(),
      fetchReefStationReadings().catch(() => fetchReefStations()),
      fetchHistoricalTrends().catch(() => null),
    ])
      .then(([liveReefs, stationResults, trendResults]) => {
        if (isMounted) {
          setReefs(liveReefs);
          setStations(stationResults);
          setTrends(trendResults);
          setSearchError(null);
        }
      })
      .catch(() => {
        if (isMounted) {
          setSearchError('Live reef search is unavailable. Page results remain searchable.');
        }
      })
      .finally(() => {
        if (isMounted) {
          setIsSearchLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [isSearchOpen, query, reefs.length, stations.length, searchError]);

  const searchResults = useMemo<SearchResult[]>(() => {
    const term = query.trim().toLowerCase();
    if (!term) return [];

    const reefResults = reefs
      .filter((reef) => matches(term, [reef.name, reef.region, reef.country, reef.status, reef.bleachingAlertLevel, reef.source, reef.aiAnalysis]))
      .slice(0, 8)
      .map((reef) => ({
        id: `reef-${reef.id}`,
        title: reef.name,
        subtitle: `${reef.region}, ${reef.country} · ${reef.status} · Risk ${reef.riskScore}%`,
        view: 'map',
        type: 'reef' as const,
        group: 'Reef Locations' as const,
        target: { ...reef, searchTargetType: 'reef' as const },
      }));

    const stationResults = stations
      .filter((station) => matches(term, [station.name, station.source, 'NOAA station', 'station', 'reef location']))
      .slice(0, 8)
      .map((station) => ({
        id: `station-${station.id}`,
        title: station.name,
        subtitle: `NOAA station · ${station.lat.toFixed(4)}, ${station.lng.toFixed(4)}${'riskScore' in station ? ` · Risk ${station.riskScore}%` : ''}`,
        view: 'map',
        type: 'station' as const,
        group: 'NOAA Stations' as const,
        target: { ...station, searchTargetType: 'station' as const },
      }));

    const alertResults = reefs
      .filter((reef) => reef.status === 'critical' || reef.status === 'warning' || reef.riskScore >= 40)
      .filter((reef) => matches(term, ['critical', 'warning', 'alert', reef.name, reef.country, reef.region, reef.bleachingAlertLevel, reef.status]))
      .slice(0, 6)
      .map((reef) => ({
        id: `alert-${reef.id}`,
        title: `${reef.status === 'critical' ? 'Critical' : 'Warning'} alert · ${reef.name}`,
        subtitle: `${reef.bleachingAlertLevel} · DHW ${reef.degreeHeatingWeeks ?? 'N/A'} · Risk ${reef.riskScore}%`,
        view: 'map',
        type: 'alert' as const,
        group: 'Alerts' as const,
        target: { ...reef, searchTargetType: 'alert' as const },
      }));

    const reportResults = reefs
      .filter((reef) => matches(term, ['report', 'conservation', reef.name, reef.country, reef.region, reef.status]))
      .slice(0, 5)
      .map((reef) => ({
        id: `report-${reef.id}`,
        title: `${reef.name} conservation report`,
        subtitle: `${reef.region}, ${reef.country} · ${reef.status} monitoring summary`,
        view: 'reports',
        type: 'report' as const,
        group: 'Reports' as const,
        target: { ...reef, searchTargetType: 'report' as const },
      }));

    const analysisResults = reefs
      .filter((reef) => matches(term, ['analysis', 'ai', 'risk', reef.name, reef.country, reef.region, reef.aiAnalysis, reef.status]))
      .slice(0, 5)
      .map((reef) => ({
        id: `analysis-${reef.id}`,
        title: `${reef.name} AI analysis`,
        subtitle: `Risk ${reef.riskScore}% · ${reef.bleachingAlertLevel}`,
        view: 'analysis',
        type: 'analysis' as const,
        group: 'AI Analyses' as const,
        target: { ...reef, searchTargetType: 'analysis' as const },
      }));

    const trendResults: SearchResult[] = trends && matches(term, ['historical', 'trend', 'sst', 'anomaly', 'dhw', 'bleaching risk', trends.sourceLabel, trends.message])
      ? [{
          id: 'trend-live-snapshot',
          title: trends.mode === 'snapshot' ? 'Latest NOAA snapshot' : 'Historical NOAA trends',
          subtitle: `${trends.sourceLabel} · ${trends.totalMonitoredReefs} monitored reefs`,
          view: 'trends',
          type: 'trend',
          group: 'Historical Data',
        }]
      : [];

    const localResults = pageResults.filter((result) => matches(term, [result.title, result.subtitle, result.type]));
    return [...reefResults, ...stationResults, ...alertResults, ...reportResults, ...analysisResults, ...trendResults, ...localResults];
  }, [query, reefs, stations, trends]);

  const groupedResults = useMemo(() => {
    return groupOrder
      .map((group) => ({
        group,
        results: searchResults.filter((result) => result.group === group),
      }))
      .filter((section) => section.results.length > 0);
  }, [searchResults]);

  const unreadCount = notifications.filter((notification) => notification.unread).length;

  function handleResultClick(result: SearchResult) {
    onNavigate(result.view, result.target);
    setQuery('');
    setIsSearchOpen(false);
  }

  function handleNotificationClick(notification: NotificationItem) {
    setNotifications((current) => current.map((item) => item.id === notification.id ? { ...item, unread: false } : item));
    onNavigate(notification.view);
    setIsNotificationsOpen(false);
  }

  function markAllNotificationsRead() {
    setNotifications((current) => current.map((item) => ({ ...item, unread: false })));
  }

  function handleProfileAction(view?: string) {
    if (view) onNavigate(view);
    setIsProfileOpen(false);
  }

  return (
    <motion.header
      ref={headerRef}
      initial={{ y: -20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      className="relative z-30 flex h-20 items-center justify-between border-b border-cyan-glow/10 bg-gradient-to-r from-ocean-dark/66 via-ocean-dark/58 to-ocean-deep/62 px-8 backdrop-blur-2xl"
    >
      <div className="max-w-2xl min-w-0 flex-1">
        <div className="relative">
          <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-muted" />
          <input
            type="text"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setIsSearchOpen(true);
            }}
            onFocus={() => setIsSearchOpen(true)}
            placeholder="Search reef locations, reports, analyses..."
            className="w-full rounded-xl border border-cyan-glow/10 bg-ocean-medium/56 py-3 pl-11 pr-4 text-sm text-white transition-all placeholder:text-gray-muted focus:border-cyan-glow/30 focus:outline-none focus:ring-2 focus:ring-cyan-glow/12"
          />

          <AnimatePresence>
            {isSearchOpen && query.trim() && (
              <motion.div
                initial={{ opacity: 0, y: 8, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.98 }}
                className="reef-panel-strong absolute left-0 right-0 top-[calc(100%+0.75rem)] z-50 overflow-hidden rounded-2xl border border-gray-border/70 bg-ocean-dark/95 shadow-2xl backdrop-blur-2xl"
              >
                <div className="border-b border-gray-border/60 px-4 py-3 text-xs uppercase tracking-wider text-gray-muted">
                  Search Results
                </div>
                {isSearchLoading && (
                  <div className="flex items-center gap-3 px-4 py-5 text-sm text-gray-light">
                    <Loader2 className="h-4 w-4 animate-spin text-cyan-glow" />
                    Searching live reef data...
                  </div>
                )}
                {!isSearchLoading && searchError && (
                  <div className="border-b border-coral-warning/20 bg-coral-warning/10 px-4 py-3 text-sm text-coral-warning">
                    {searchError}
                  </div>
                )}
                {!isSearchLoading && searchResults.length === 0 && (
                  <div className="px-4 py-5 text-sm text-gray-light">
                    No reef data found for this search.
                  </div>
                )}
                {!isSearchLoading && groupedResults.length > 0 && (
                  <div className="max-h-[460px] overflow-y-auto py-2">
                    {groupedResults.map((section) => (
                      <div key={section.group} className="py-1">
                        <div className="px-4 py-2 text-[11px] uppercase tracking-wider text-cyan-glow/80">
                          {section.group}
                        </div>
                        {section.results.map((result) => {
                          const Icon = resultIcon[result.type];
                          return (
                            <button
                              key={result.id}
                              type="button"
                              onClick={() => handleResultClick(result)}
                              className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-cyan-glow/10"
                            >
                              <Icon className="mt-0.5 h-4 w-4 text-cyan-glow" />
                              <span>
                                <span className="block text-sm text-white">{result.title}</span>
                                <span className="mt-0.5 block text-xs text-gray-muted">{result.subtitle}</span>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3 xl:gap-6">
        <div className="hidden items-center gap-2 lg:flex">
          <motion.div
            animate={{ scale: [1, 1.2, 1] }}
            transition={{ duration: 2, repeat: Infinity }}
            className="h-2 w-2 rounded-full bg-cyan-glow"
            style={{ boxShadow: '0 0 12px rgba(0, 212, 255, 0.8)' }}
          />
          <span className="text-xs text-gray-light">AI Active</span>
        </div>

        <div className="hidden items-center gap-2 rounded-xl border border-cyan-glow/8 bg-ocean-medium/34 px-4 py-2 shadow-[inset_0_1px_0_rgba(191,253,255,0.04)] xl:flex">
          <Activity className="h-4 w-4 text-blue-ocean" />
          <span className="text-xs text-gray-light">NOAA Live</span>
        </div>

        <div className="relative">
          <button
            type="button"
            onClick={() => {
              setIsNotificationsOpen((open) => !open);
              setIsProfileOpen(false);
            }}
            className="relative rounded-xl p-2.5 transition-colors hover:bg-ocean-medium/42"
            aria-label="Open notifications"
          >
            {unreadCount > 0 ? <BellDot className="h-5 w-5 text-coral-warning" /> : <Bell className="h-5 w-5 text-gray-light" />}
            {unreadCount > 0 && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-coral-warning" />}
          </button>

          <AnimatePresence>
            {isNotificationsOpen && (
              <motion.div
                initial={{ opacity: 0, y: 8, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.98 }}
                className="reef-panel-strong absolute right-0 top-[calc(100%+0.75rem)] z-50 w-96 overflow-hidden rounded-2xl border border-gray-border/70 bg-ocean-dark/95 shadow-2xl backdrop-blur-2xl"
              >
                <div className="flex items-center justify-between border-b border-gray-border/60 px-4 py-3">
                  <div>
                    <p className="text-sm text-white">Notifications</p>
                    <p className="text-xs text-gray-muted">{unreadCount} unread reef updates</p>
                  </div>
                  <button type="button" onClick={markAllNotificationsRead} className="text-xs text-cyan-glow hover:text-white">
                    Mark all read
                  </button>
                </div>
                <div className="max-h-[360px] overflow-y-auto">
                  {notifications.map((notification) => (
                    <button
                      key={notification.id}
                      type="button"
                      onClick={() => handleNotificationClick(notification)}
                      className="flex w-full gap-3 border-b border-gray-border/35 px-4 py-4 text-left transition-colors last:border-b-0 hover:bg-cyan-glow/10"
                    >
                      <span className={`mt-1 h-2.5 w-2.5 rounded-full ${
                        notification.unread
                          ? notification.tone === 'critical'
                            ? 'bg-coral-critical'
                            : notification.tone === 'warning'
                              ? 'bg-coral-warning'
                              : 'bg-cyan-glow'
                          : 'bg-gray-muted/35'
                      }`} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-3">
                          <span className="text-sm text-white">{notification.title}</span>
                          <span className="shrink-0 text-xs text-gray-muted">{notification.time}</span>
                        </span>
                        <span className="mt-1 block text-xs leading-relaxed text-gray-light">{notification.body}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="relative">
          <button
            type="button"
            onClick={() => {
              setIsProfileOpen((open) => !open);
              setIsNotificationsOpen(false);
            }}
            className="flex items-center gap-2 rounded-xl px-4 py-2 transition-colors hover:bg-ocean-medium/42"
            aria-label="Open profile menu"
          >
            <User className="h-5 w-5 text-gray-light" />
            <span className="hidden text-sm text-gray-light 2xl:inline">Researcher</span>
            <ChevronDown className={`h-4 w-4 text-gray-muted transition-transform ${isProfileOpen ? 'rotate-180' : ''}`} />
          </button>

          <AnimatePresence>
            {isProfileOpen && (
              <motion.div
                initial={{ opacity: 0, y: 8, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.98 }}
                className="reef-panel-strong absolute right-0 top-[calc(100%+0.75rem)] z-50 w-72 overflow-hidden rounded-2xl border border-gray-border/70 bg-ocean-dark/95 shadow-2xl backdrop-blur-2xl"
              >
                <div className="border-b border-gray-border/60 px-4 py-4">
                  <p className="text-sm text-white">Researcher</p>
                  <p className="text-xs text-gray-muted">reefwatch.local</p>
                </div>
                <button type="button" onClick={() => handleProfileAction('workspace')} className="flex w-full items-center gap-3 px-4 py-3 text-sm text-gray-light transition-colors hover:bg-cyan-glow/10 hover:text-white">
                  <User className="h-4 w-4 text-cyan-glow" />
                  Profile
                </button>
                <button type="button" onClick={() => handleProfileAction('settings')} className="flex w-full items-center gap-3 px-4 py-3 text-sm text-gray-light transition-colors hover:bg-cyan-glow/10 hover:text-white">
                  <Settings className="h-4 w-4 text-cyan-glow" />
                  Settings
                </button>
                <button type="button" onClick={() => handleProfileAction('monitoring')} className="flex w-full items-center gap-3 px-4 py-3 text-sm text-gray-light transition-colors hover:bg-cyan-glow/10 hover:text-white">
                  <SlidersHorizontal className="h-4 w-4 text-cyan-glow" />
                  Monitoring Preferences
                </button>
                <button type="button" onClick={() => handleProfileAction('map')} className="flex w-full items-center gap-3 px-4 py-3 text-sm text-gray-light transition-colors hover:bg-cyan-glow/10 hover:text-white">
                  <Waves className="h-4 w-4 text-cyan-glow" />
                  ReefWatch Account
                </button>
                <div className="border-t border-gray-border/60">
                  <button type="button" onClick={() => handleProfileAction()} className="flex w-full items-center gap-3 px-4 py-3 text-sm text-coral-warning transition-colors hover:bg-coral-warning/10">
                    <LogOut className="h-4 w-4" />
                    Logout
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.header>
  );
}
