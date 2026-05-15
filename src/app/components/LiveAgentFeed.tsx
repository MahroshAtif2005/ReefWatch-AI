import { motion, AnimatePresence } from 'motion/react';
import { useEffect, useState } from 'react';
import { Database, Brain, FileText, Activity, AlertTriangle, CheckCircle } from 'lucide-react';

interface AgentEvent {
  id: string;
  type: 'data' | 'analysis' | 'report' | 'alert' | 'success';
  message: string;
  timestamp: Date;
}

const eventTypes = {
  data: { icon: Database, color: 'text-blue-ocean' },
  analysis: { icon: Brain, color: 'text-cyan-glow' },
  report: { icon: FileText, color: 'text-gray-light' },
  alert: { icon: AlertTriangle, color: 'text-coral-warning' },
  success: { icon: CheckCircle, color: 'text-coral-safe' },
};

const sampleEvents: Omit<AgentEvent, 'id' | 'timestamp'>[] = [
  { type: 'data', message: 'NOAA thermal satellite data retrieved for Pacific sector' },
  { type: 'analysis', message: 'Running bleaching risk analysis on 247 reef locations' },
  { type: 'alert', message: 'Elevated sea temperature detected - Great Barrier Reef sector 4' },
  { type: 'success', message: 'Conservation report generated for Maldives reef cluster' },
  { type: 'data', message: 'Syncing historical bleaching events from 2015-2025' },
  { type: 'analysis', message: 'AI confidence score calculated: 94.2% for Raja Ampat prediction' },
  { type: 'report', message: 'Logging AI trace to Arize Phoenix monitoring platform' },
  { type: 'alert', message: 'High-risk anomaly flagged - Caribbean coral stress index rising' },
  { type: 'success', message: 'Degree Heating Week threshold analysis complete' },
  { type: 'data', message: 'Retrieving ocean current patterns from NOAA buoy network' },
];

export function LiveAgentFeed() {
  const [events, setEvents] = useState<AgentEvent[]>([]);

  useEffect(() => {
    // Initialize with some events
    const initialEvents = sampleEvents.slice(0, 5).map((event, i) => ({
      ...event,
      id: `event-${i}`,
      timestamp: new Date(Date.now() - (5 - i) * 3000),
    }));
    setEvents(initialEvents);

    // Add new events periodically
    const interval = setInterval(() => {
      const randomEvent = sampleEvents[Math.floor(Math.random() * sampleEvents.length)];
      const newEvent: AgentEvent = {
        ...randomEvent,
        id: `event-${Date.now()}`,
        timestamp: new Date(),
      };

      setEvents(prev => [newEvent, ...prev].slice(0, 8));
    }, 4000);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="h-full flex flex-col">
      <div className="p-4 border-b border-gray-border/70 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-cyan-glow" />
          <h2 className="text-lg text-white">Live Agent Activity</h2>
        </div>
        <motion.div
          animate={{ opacity: [1, 0.5, 1] }}
          transition={{ duration: 2, repeat: Infinity }}
          className="flex items-center gap-2"
        >
          <div className="w-2 h-2 rounded-full bg-cyan-glow" />
          <span className="text-xs text-gray-muted">Streaming</span>
        </motion.div>
      </div>

      <div className="flex-1 overflow-hidden p-4 space-y-2">
        <AnimatePresence initial={false}>
          {events.map((event, index) => {
            const eventConfig = eventTypes[event.type];
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
                      <p className="text-sm text-gray-light leading-relaxed">{event.message}</p>
                      <span className="text-xs text-gray-muted mt-1 block">
                        {event.timestamp.toLocaleTimeString()}
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
          <span>Last updated: {new Date().toLocaleTimeString()}</span>
          <button className="text-cyan-glow hover:underline">View Full Log</button>
        </div>
      </div>
    </div>
  );
}
