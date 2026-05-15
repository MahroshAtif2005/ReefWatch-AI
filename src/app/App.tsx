import { useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { LiveReefGoogleMap } from './components/LiveReefGoogleMap';
import { LiveAgentFeed } from './components/LiveAgentFeed';
import { ReefDetailPanel } from './components/ReefDetailPanel';
import { AnalyticsDashboard } from './components/AnalyticsDashboard';
import { ArizeMonitoring } from './components/ArizeMonitoring';
import { LiveActivityTicker } from './components/LiveActivityTicker';
import { DashboardOverview } from './components/DashboardOverview';
import { CoralBackground } from './components/CoralBackground';

interface ReefData {
  id: string;
  name: string;
  lat: number;
  lng: number;
  risk: 'safe' | 'warning' | 'critical';
  temperature: number;
  bleachingRisk: number;
}

export default function App() {
  const [activeView, setActiveView] = useState('dashboard');
  const [selectedReef, setSelectedReef] = useState<ReefData | null>(null);

  const handleNavigate = (view: string, reef?: any) => {
    setActiveView(view);
    if (reef) {
      setSelectedReef({
        ...reef,
        lat: reef.lat || 0,
        lng: reef.lng || 0,
        temperature: reef.temp || 0,
        bleachingRisk: reef.risk || 0,
        risk: reef.risk > 70 ? 'critical' : reef.risk > 30 ? 'warning' : 'safe',
      });
    }
  };

  return (
    <div className="size-full flex text-foreground overflow-hidden relative" style={{ background: 'linear-gradient(135deg, #082e42 0%, #0d5068 35%, #0f6674 60%, #093d58 100%)' }}>
      <CoralBackground />

      {/* App shell — sits above the fixed coral background */}
      <div className="relative z-10 flex flex-1 overflow-hidden">
      <Sidebar activeView={activeView} onViewChange={setActiveView} />

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header />

        <div className="flex-1 overflow-hidden">
          {activeView === 'dashboard' && (
            <DashboardOverview onNavigate={handleNavigate} />
          )}

          {activeView === 'map' && (
            <div className="h-full p-8">
              <div className="reef-panel-strong h-full rounded-3xl overflow-hidden border border-gray-border/70">
                <LiveReefGoogleMap onReefSelect={setSelectedReef} />
              </div>
            </div>
          )}

          {activeView === 'analysis' && (
            <div className="h-full overflow-auto p-8">
              <div className="max-w-7xl mx-auto space-y-8">
                <div>
                  <h2 className="text-4xl text-white mb-2">AI Analysis</h2>
                  <p className="text-gray-muted">Intelligent bleaching risk assessment and forecasting</p>
                </div>
                <AnalyticsDashboard />
              </div>
            </div>
          )}

          {activeView === 'monitoring' && (
            <div className="h-full overflow-auto p-8">
              <div className="max-w-7xl mx-auto">
                <ArizeMonitoring />
              </div>
            </div>
          )}

          {activeView === 'agents' && (
            <div className="h-full overflow-auto p-8">
              <div className="max-w-5xl mx-auto space-y-6">
                <div>
                  <h2 className="text-4xl text-white mb-2">Agent Activity</h2>
                  <p className="text-gray-muted">Real-time autonomous AI operations</p>
                </div>
                <div className="reef-panel-soft rounded-2xl bg-ocean-dark/70 border border-gray-border/70 overflow-hidden">
                  <LiveAgentFeed />
                </div>
              </div>
            </div>
          )}

          {activeView === 'trends' && (
            <div className="h-full overflow-auto p-8">
              <div className="max-w-7xl mx-auto space-y-8">
                <div>
                  <h2 className="text-4xl text-white mb-2">Historical Trends</h2>
                  <p className="text-gray-muted">Long-term reef health patterns and environmental changes</p>
                </div>
                <AnalyticsDashboard />
              </div>
            </div>
          )}

          {(activeView === 'reports' || activeView === 'workspace' || activeView === 'settings') && (
            <div className="h-full flex items-center justify-center">
              <div className="text-center">
                <h2 className="text-2xl text-white mb-2 capitalize">{activeView}</h2>
                <p className="text-gray-muted">Coming soon...</p>
              </div>
            </div>
          )}
        </div>
      </div>
      </div>

      {/* Reef Detail Slide Panel */}
      <AnimatePresence>
        {selectedReef && (
          <ReefDetailPanel
            reef={selectedReef}
            onClose={() => setSelectedReef(null)}
          />
        )}
      </AnimatePresence>

      {/* Live Activity Ticker - Show on Map Views */}
      {activeView === 'map' && <LiveActivityTicker />}
    </div>
  );
}
