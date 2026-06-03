import { motion, AnimatePresence } from 'motion/react';
import { useEffect, useState } from 'react';
import { Activity, AlertTriangle, Brain, CheckCircle2, Database, FileText, Loader2, RefreshCw, X } from 'lucide-react';
import { fetchAgentActivity, sendTestAlert, type AgentActivityEvent } from '../services/reefApi';
import { format, isToday, formatDistanceToNow, differenceInMinutes } from 'date-fns';

const eventTypes = {
  noaa_fetch: { icon: Database, color: 'text-blue-ocean' },
  ai_analysis: { icon: Brain, color: 'text-cyan-glow' },
  brief_generated: { icon: FileText, color: 'text-gray-light' },
  noaa_error: { icon: AlertTriangle, color: 'text-coral-warning' },
  batch_refresh: { icon: RefreshCw, color: 'text-coral-safe' },
  alert: { icon: AlertTriangle, color: 'text-coral-critical' },
};

const getEventConfig = (type: AgentActivityEvent['event_type']) => (
  eventTypes[type as keyof typeof eventTypes] || { icon: Activity, color: 'text-cyan-glow' }
);

const formatTimestamp = (timestamp: string | Date | null) => {
  if (!timestamp) return '';
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return String(timestamp);

  const diffMinutes = Math.abs(differenceInMinutes(new Date(), parsed));
  if (diffMinutes < 60) {
    return formatDistanceToNow(parsed, { addSuffix: true });
  }

  if (isToday(parsed)) {
    return `Today at ${format(parsed, 'h:mm a')}`;
  }

  return format(parsed, "MMM d 'at' h:mm a");
};

export function LiveAgentFeed() {
  const [events, setEvents] = useState<AgentActivityEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showFullLog, setShowFullLog] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [isSendingAlert, setIsSendingAlert] = useState(false);
  const [alertToast, setAlertToast] = useState<string | null>(null);
  const [alertError, setAlertError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadActivity() {
      try {
        const activity = await fetchAgentActivity();
        if (!isMounted) return;
        setEvents(activity);
        setLastUpdated(new Date().toISOString());
        setError(null);
      } catch {
        if (isMounted) {
          setError('Agent activity is unavailable from the deployed ReefWatch backend.');
        }
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }

    loadActivity();
    const interval = window.setInterval(loadActivity, 30000);

    return () => {
      isMounted = false;
      window.clearInterval(interval);
    };
  }, []);

  const visibleEvents = events.slice(0, 8);

  async function handleSendTestAlert() {
    setIsSendingAlert(true);
    setAlertError(null);
    setAlertToast(null);

    try {
      const result = await sendTestAlert();
      setAlertToast(`Alert sent! Check inbox at ${result.sentTo || 'rosche.atif@gmail.com'}`);
      window.setTimeout(() => setAlertToast(null), 5000);
      const activity = await fetchAgentActivity();
      setEvents(activity);
      setLastUpdated(new Date().toISOString());
    } catch (sendError) {
      const message = sendError instanceof Error ? sendError.message : 'Unable to send test alert.';
      setAlertError(message);
      window.setTimeout(() => setAlertError(null), 6000);
    } finally {
      setIsSendingAlert(false);
    }
  }

  return (
    <div className="relative h-full flex flex-col">
      {alertToast && (
        <div
          className="absolute right-4 top-4 z-20 flex max-w-sm items-center gap-2 rounded-xl border border-coral-safe/35 bg-ocean-dark/95 px-4 py-3 text-sm text-coral-safe shadow-2xl backdrop-blur-xl"
          style={{ animation: 'fade-in-down 0.2s ease-out' }}
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>{alertToast}</span>
        </div>
      )}

      {alertError && (
        <div
          className="absolute right-4 top-4 z-20 flex max-w-sm items-center gap-2 rounded-xl border border-coral-critical/45 bg-ocean-dark/95 px-4 py-3 text-sm text-coral-critical shadow-2xl backdrop-blur-xl"
          style={{ animation: 'fade-in-down 0.2s ease-out' }}
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{alertError}</span>
        </div>
      )}

      <div className="p-4 border-b border-gray-border/70 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-cyan-glow" />
          <h2 className="text-lg text-white">Live Agent Activity</h2>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleSendTestAlert}
            disabled={isSendingAlert}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#fb923c]/70 bg-[#dc2626] px-5 py-3 text-sm font-semibold text-white shadow-[0_0_28px_rgba(220,38,38,0.35)] transition-all hover:-translate-y-0.5 hover:bg-[#ea580c] hover:shadow-[0_0_34px_rgba(234,88,12,0.42)] active:translate-y-0 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:translate-y-0"
          >
            {isSendingAlert ? <Loader2 className="h-4 w-4 animate-spin" /> : <AlertTriangle className="h-4 w-4" />}
            {isSendingAlert ? 'Sending alert...' : '🚨 Trigger Alert Demo'}
          </button>
          <motion.div
            animate={{ opacity: [1, 0.5, 1] }}
            transition={{ duration: 2, repeat: Infinity }}
            className="flex items-center gap-2"
          >
            <div className="w-2 h-2 rounded-full bg-cyan-glow" />
            <span className="text-xs text-gray-muted">Live DB events</span>
          </motion.div>
        </div>
      </div>

      <div className="flex-1 overflow-hidden p-4 space-y-2">
        {isLoading && (
          <div className="reef-panel-soft p-4 rounded-lg bg-ocean-medium/60 border border-gray-border/70 text-sm text-gray-light">
            Loading agent activity...
          </div>
        )}

        {!isLoading && error && (
          <div className="reef-panel-soft p-4 rounded-lg bg-coral-warning/10 border border-coral-warning/35 text-sm text-coral-warning">
            {error}
          </div>
        )}

        {!isLoading && !error && events.length === 0 && (
          <div className="reef-panel-soft p-4 rounded-lg bg-ocean-medium/60 border border-gray-border/70 text-sm text-gray-light">
            No activity yet.
          </div>
        )}

        <AnimatePresence initial={false}>
          {visibleEvents.map((event) => {
            const eventConfig = getEventConfig(event.event_type);
            const Icon = eventConfig.icon;

            return (
              <motion.div
                key={event.id}
                initial={{ opacity: 0, x: -20, height: 0 }}
                animate={{ opacity: 1, x: 0, height: 'auto' }}
                exit={{ opacity: 0, x: 20, height: 0 }}
                transition={{ duration: 0.3 }}
                className="overflow-hidden"
              >
                <div className="reef-panel-soft p-3 rounded-lg bg-ocean-medium/60 border border-gray-border/70 hover:border-cyan-glow/40 transition-all">
                  <div className="flex items-start gap-3">
                    <div className={`mt-0.5 ${eventConfig.color}`}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-light leading-relaxed">{event.description}</p>
                      {event.reef_name && (
                        <span className="mt-1 block text-xs text-cyan-glow">{event.reef_name}</span>
                      )}
                      <span className="text-xs text-gray-muted mt-1 block">
                        {formatTimestamp(event.timestamp)}
                      </span>
                    </div>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      <div className="p-4 border-t border-gray-border/70">
        <div className="flex items-center justify-between text-xs text-gray-muted">
          <span>Last updated: {lastUpdated ? new Date(lastUpdated).toLocaleTimeString() : 'Waiting'}</span>
          <button onClick={() => setShowFullLog(true)} className="text-cyan-glow hover:underline">View Full Log</button>
        </div>
      </div>

      {showFullLog && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-ocean-deep/70 p-6 backdrop-blur-xl">
          <div className="reef-panel-strong max-h-[82vh] w-full max-w-3xl overflow-hidden rounded-2xl border border-gray-border/70 bg-ocean-dark/96 shadow-2xl">
            <div className="flex items-center justify-between border-b border-gray-border/70 p-5">
              <div>
                <h3 className="text-xl text-white">Agent Activity Log</h3>
                <p className="text-sm text-gray-muted">Last {events.length} database events</p>
              </div>
              <button onClick={() => setShowFullLog(false)} className="rounded-xl p-2.5 transition hover:bg-ocean-medium/60">
                <X className="h-5 w-5 text-gray-light" />
              </button>
            </div>
            <div className="max-h-[62vh] space-y-3 overflow-auto p-5">
              {events.length === 0 && (
                <div className="reef-panel-soft rounded-xl border border-gray-border/70 bg-ocean-medium/45 p-4 text-sm text-gray-light">
                  No activity yet.
                </div>
              )}
              {events.map((event) => {
                const eventConfig = getEventConfig(event.event_type);
                const Icon = eventConfig.icon;

                return (
                  <div key={event.id} className="reef-panel-soft rounded-xl border border-gray-border/70 bg-ocean-medium/45 p-4">
                    <div className="flex items-start gap-3">
                      <Icon className={`mt-0.5 h-4 w-4 ${eventConfig.color}`} />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-gray-light">{event.description}</p>
                        <div className="mt-2 flex flex-wrap gap-3 text-xs text-gray-muted">
                          <span>{event.event_type}</span>
                          {event.reef_name && <span className="text-cyan-glow">{event.reef_name}</span>}
                          <span>{formatTimestamp(event.timestamp)}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
