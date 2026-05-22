import { motion, AnimatePresence } from 'motion/react';
import { useEffect, useState } from 'react';
import { Activity, AlertTriangle, Brain, Database, FileText, RefreshCw } from 'lucide-react';
import { fetchAgentActivity, type AgentActivityEvent } from '../services/reefApi';

const eventTypes = {
  noaa_fetch: { icon: Database, color: 'text-blue-ocean' },
  ai_analysis: { icon: Brain, color: 'text-cyan-glow' },
  brief_generated: { icon: FileText, color: 'text-gray-light' },
  noaa_error: { icon: AlertTriangle, color: 'text-coral-warning' },
  batch_refresh: { icon: RefreshCw, color: 'text-coral-safe' },
};

const getEventConfig = (type: AgentActivityEvent['event_type']) => (
  eventTypes[type as keyof typeof eventTypes] || { icon: Activity, color: 'text-cyan-glow' }
);

export function LiveActivityTicker() {
  const [currentEvent, setCurrentEvent] = useState<AgentActivityEvent | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function updateEvent() {
      try {
        const [latestEvent] = await fetchAgentActivity();
        if (isMounted) setCurrentEvent(latestEvent || null);
      } catch {
        if (isMounted) setCurrentEvent(null);
      }
    }

    updateEvent();
    const interval = window.setInterval(updateEvent, 30000);

    return () => {
      isMounted = false;
      window.clearInterval(interval);
    };
  }, []);

  if (!currentEvent) return null;

  const eventConfig = getEventConfig(currentEvent.event_type);
  const Icon = eventConfig.icon;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="fixed bottom-8 left-1/2 -translate-x-1/2 z-40"
    >
      <div className="reef-panel-strong px-6 py-3 rounded-full bg-ocean-dark/88 backdrop-blur-2xl border border-gray-border/70 shadow-2xl">
        <AnimatePresence mode="wait">
          <motion.div
            key={currentEvent.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.3 }}
            className="flex items-center gap-3"
          >
            <motion.div
              animate={{ scale: [1, 1.2, 1] }}
              transition={{ duration: 2, repeat: Infinity }}
              className="w-1.5 h-1.5 rounded-full bg-cyan-glow"
              style={{ boxShadow: '0 0 8px rgba(0, 212, 255, 0.8)' }}
            />
            <div className={eventConfig.color}>
              <Icon className="w-4 h-4" />
            </div>
            <span className="text-sm text-gray-light">{currentEvent.description}</span>
          </motion.div>
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
