import { motion, AnimatePresence } from 'motion/react';
import { useEffect, useState } from 'react';
import { Database, Brain, FileText, AlertTriangle, CheckCircle } from 'lucide-react';

interface AgentEvent {
  id: string;
  type: 'data' | 'analysis' | 'report' | 'alert' | 'success';
  message: string;
}

const eventTypes = {
  data: { icon: Database, color: 'text-blue-ocean' },
  analysis: { icon: Brain, color: 'text-cyan-glow' },
  report: { icon: FileText, color: 'text-gray-light' },
  alert: { icon: AlertTriangle, color: 'text-coral-warning' },
  success: { icon: CheckCircle, color: 'text-coral-safe' },
};

const sampleEvents: Omit<AgentEvent, 'id'>[] = [
  { type: 'data', message: 'NOAA thermal data retrieved' },
  { type: 'analysis', message: 'Running bleaching risk analysis' },
  { type: 'alert', message: 'Elevated temperature detected' },
  { type: 'success', message: 'Report generated' },
  { type: 'data', message: 'Syncing historical events' },
  { type: 'analysis', message: 'AI confidence: 94.2%' },
  { type: 'report', message: 'Trace logged to Arize' },
  { type: 'alert', message: 'High-risk anomaly flagged' },
];

export function LiveActivityTicker() {
  const [currentEvent, setCurrentEvent] = useState<AgentEvent | null>(null);

  useEffect(() => {
    const updateEvent = () => {
      const randomEvent = sampleEvents[Math.floor(Math.random() * sampleEvents.length)];
      setCurrentEvent({
        ...randomEvent,
        id: `event-${Date.now()}`,
      });
    };

    updateEvent();
    const interval = setInterval(updateEvent, 4000);
    return () => clearInterval(interval);
  }, []);

  if (!currentEvent) return null;

  const eventConfig = eventTypes[currentEvent.type];
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
            <span className="text-sm text-gray-light">{currentEvent.message}</span>
          </motion.div>
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
