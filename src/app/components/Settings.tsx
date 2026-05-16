import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { CheckCircle2, Github, Mail, RefreshCw, Save, Settings as SettingsIcon } from 'lucide-react';
import { fetchAiHealth, fetchLiveReefs, type LiveReef } from '../services/reefApi';
import { Slider } from './ui/slider';
import { Switch } from './ui/switch';

interface AlertSettings {
  email: string;
  criticalAlerts: boolean;
  anomalyWarnings: boolean;
  weeklySummary: boolean;
  anomalyThreshold: number;
}

interface RefreshSettings {
  autoRefresh: boolean;
  interval: string;
  lastSynced: string | null;
}

const ALERT_SETTINGS_KEY = 'reefwatch:alert-settings';
const MONITORED_REEFS_KEY = 'reefwatch:monitored-reefs';
const REFRESH_SETTINGS_KEY = 'reefwatch:refresh-settings';

const defaultAlertSettings: AlertSettings = {
  email: '',
  criticalAlerts: true,
  anomalyWarnings: true,
  weeklySummary: false,
  anomalyThreshold: 1.5,
};

const defaultRefreshSettings: RefreshSettings = {
  autoRefresh: true,
  interval: '15min',
  lastSynced: null,
};

const statusStyles = {
  safe: 'text-coral-safe bg-coral-safe/10 border-coral-safe/35',
  warning: 'text-coral-warning bg-coral-warning/10 border-coral-warning/35',
  critical: 'text-coral-critical bg-coral-critical/10 border-coral-critical/35',
};

function readStorage<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) || '') || fallback;
  } catch {
    return fallback;
  }
}

function writeStorage<T>(key: string, value: T) {
  localStorage.setItem(key, JSON.stringify(value));
}

function minutesSince(timestamp: string | null) {
  if (!timestamp) return 'Not synced yet';
  const minutes = Math.max(0, Math.round((Date.now() - new Date(timestamp).getTime()) / 60000));
  if (minutes < 1) return 'Just now';
  return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
}

function HealthDot({ active }: { active: boolean }) {
  return (
    <span
      className={`h-2.5 w-2.5 rounded-full ${active ? 'bg-coral-safe' : 'bg-coral-warning'}`}
      style={{ boxShadow: active ? '0 0 12px rgba(0, 217, 163, 0.7)' : '0 0 12px rgba(255, 136, 0, 0.6)' }}
    />
  );
}

export function Settings() {
  const [reefs, setReefs] = useState<LiveReef[]>([]);
  const [alertSettings, setAlertSettings] = useState<AlertSettings>(() => readStorage(ALERT_SETTINGS_KEY, defaultAlertSettings));
  const [refreshSettings, setRefreshSettings] = useState<RefreshSettings>(() => readStorage(REFRESH_SETTINGS_KEY, defaultRefreshSettings));
  const [monitoredReefIds, setMonitoredReefIds] = useState<string[]>(() => readStorage(MONITORED_REEFS_KEY, []));
  const [alertSaved, setAlertSaved] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [noaaOnline, setNoaaOnline] = useState(false);
  const [aiOnline, setAiOnline] = useState(false);
  const [phoenixOnline, setPhoenixOnline] = useState(false);

  useEffect(() => {
    loadReefs();
    fetchAiHealth()
      .then((health) => {
        setAiOnline(health.status === 'ok');
        setPhoenixOnline(health.phoenix === 'connected');
      })
      .catch(() => {
        setAiOnline(false);
        setPhoenixOnline(false);
      });
  }, []);

  useEffect(() => {
    if (reefs.length > 0 && monitoredReefIds.length === 0) {
      const allIds = reefs.map((reef) => reef.id);
      setMonitoredReefIds(allIds);
      writeStorage(MONITORED_REEFS_KEY, allIds);
    }
  }, [reefs, monitoredReefIds.length]);

  const monitoredCount = useMemo(
    () => reefs.filter((reef) => monitoredReefIds.includes(reef.id)).length,
    [reefs, monitoredReefIds]
  );

  async function loadReefs() {
    setIsRefreshing(true);
    try {
      const liveReefs = await fetchLiveReefs();
      setReefs(liveReefs);
      setNoaaOnline(true);
      const nextRefreshSettings = { ...refreshSettings, lastSynced: new Date().toISOString() };
      setRefreshSettings(nextRefreshSettings);
      writeStorage(REFRESH_SETTINGS_KEY, nextRefreshSettings);
    } catch {
      setNoaaOnline(false);
    } finally {
      setIsRefreshing(false);
    }
  }

  function updateAlertSettings(next: Partial<AlertSettings>) {
    setAlertSettings((current) => ({ ...current, ...next }));
    setAlertSaved(false);
  }

  function saveAlertSettings() {
    writeStorage(ALERT_SETTINGS_KEY, alertSettings);
    setAlertSaved(true);
  }

  function updateRefreshSettings(next: Partial<RefreshSettings>) {
    const updated = { ...refreshSettings, ...next };
    setRefreshSettings(updated);
    writeStorage(REFRESH_SETTINGS_KEY, updated);
  }

  function setMonitored(ids: string[]) {
    setMonitoredReefIds(ids);
    writeStorage(MONITORED_REEFS_KEY, ids);
  }

  function toggleReef(id: string) {
    const nextIds = monitoredReefIds.includes(id)
      ? monitoredReefIds.filter((reefId) => reefId !== id)
      : [...monitoredReefIds, id];
    setMonitored(nextIds);
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-4xl text-white mb-2">Settings</h2>
        <p className="text-gray-muted">Configure local ReefWatch alerts, monitoring scope, and service status</p>
      </div>

      <motion.section
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        className="reef-panel-strong rounded-2xl border border-gray-border/70 bg-ocean-dark/70 p-6"
      >
        <div className="mb-6 flex items-center gap-3">
          <Mail className="h-5 w-5 text-cyan-glow" />
          <h3 className="text-2xl text-white">Alert Configuration</h3>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
          <div>
            <label className="mb-2 block text-sm text-gray-light">Notification Email</label>
            <input
              type="email"
              value={alertSettings.email}
              onChange={(event) => updateAlertSettings({ email: event.target.value })}
              placeholder="marine-team@example.com"
              className="w-full rounded-xl border border-cyan-glow/15 bg-ocean-deep/70 px-4 py-3 text-white outline-none transition placeholder:text-gray-muted/70 focus:border-cyan-glow/50"
            />
            {alertSettings.email && (
              <p className="mt-3 text-sm text-coral-safe">Alerts will be sent to: {alertSettings.email}</p>
            )}
          </div>

          <div className="space-y-4">
            {[
              ['criticalAlerts', 'Critical bleaching alerts'],
              ['anomalyWarnings', 'Temperature anomaly warnings'],
              ['weeklySummary', 'Weekly summary emails'],
            ].map(([key, label]) => (
              <div key={key} className="flex items-center justify-between rounded-xl border border-cyan-glow/10 bg-ocean-medium/25 p-4">
                <span className="text-sm text-gray-light">{label}</span>
                <Switch
                  checked={alertSettings[key as keyof AlertSettings] as boolean}
                  onCheckedChange={(checked) => updateAlertSettings({ [key]: checked } as Partial<AlertSettings>)}
                />
              </div>
            ))}
          </div>
        </div>

        <div className="mt-6 rounded-xl border border-cyan-glow/10 bg-ocean-medium/25 p-5">
          <div className="mb-4 flex items-center justify-between">
            <label className="text-sm text-gray-light">Alert when anomaly exceeds X°C</label>
            <span className="rounded-lg border border-cyan-glow/15 bg-cyan-glow/8 px-3 py-1 text-sm text-cyan-glow">
              {alertSettings.anomalyThreshold.toFixed(1)}°C
            </span>
          </div>
          <Slider
            value={[alertSettings.anomalyThreshold]}
            min={0.5}
            max={4}
            step={0.5}
            onValueChange={(value) => updateAlertSettings({ anomalyThreshold: value[0] })}
          />
        </div>

        <div className="mt-6 flex items-center gap-3">
          <button
            onClick={saveAlertSettings}
            className="inline-flex items-center gap-2 rounded-xl border border-cyan-glow/25 bg-cyan-glow/12 px-5 py-3 text-cyan-glow transition hover:bg-cyan-glow/18"
          >
            <Save className="h-4 w-4" />
            Save Alert Settings
          </button>
          {alertSaved && <span className="text-sm text-coral-safe">Saved locally</span>}
        </div>
      </motion.section>

      <section className="reef-panel rounded-2xl border border-gray-border/70 bg-ocean-dark/62 p-6">
        <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h3 className="text-2xl text-white">Monitored Reefs</h3>
            <p className="text-sm text-gray-muted">{monitoredCount} of {reefs.length || 8} reefs selected for active monitoring</p>
          </div>
          <div className="flex gap-3">
            <button onClick={() => setMonitored(reefs.map((reef) => reef.id))} className="rounded-xl border border-cyan-glow/15 px-4 py-2 text-sm text-cyan-glow transition hover:bg-cyan-glow/10">
              Select All
            </button>
            <button onClick={() => setMonitored([])} className="rounded-xl border border-cyan-glow/15 px-4 py-2 text-sm text-gray-light transition hover:bg-ocean-medium/35">
              Deselect All
            </button>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          {reefs.map((reef) => (
            <label key={reef.id} className="flex cursor-pointer items-center justify-between gap-4 rounded-xl border border-cyan-glow/10 bg-ocean-medium/25 p-4 transition hover:bg-ocean-medium/35">
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={monitoredReefIds.includes(reef.id)}
                  onChange={() => toggleReef(reef.id)}
                  className="h-4 w-4 accent-cyan-glow"
                />
                <span className="text-sm text-white">{reef.name}</span>
              </div>
              <span className={`rounded-lg border px-2 py-1 text-[11px] capitalize ${statusStyles[reef.status]}`}>
                {reef.status}
              </span>
            </label>
          ))}
          {reefs.length === 0 && (
            <div className="rounded-xl border border-cyan-glow/10 bg-ocean-medium/25 p-5 text-sm text-gray-light">
              Reef list will load when the local backend is available.
            </div>
          )}
        </div>
      </section>

      <section className="reef-panel rounded-2xl border border-gray-border/70 bg-ocean-dark/62 p-6">
        <div className="mb-6 flex items-center gap-3">
          <RefreshCw className="h-5 w-5 text-cyan-glow" />
          <h3 className="text-2xl text-white">Data Refresh Settings</h3>
        </div>

        <div className="grid gap-5 md:grid-cols-3">
          <div className="flex items-center justify-between rounded-xl border border-cyan-glow/10 bg-ocean-medium/25 p-4">
            <span className="text-sm text-gray-light">Auto-refresh live data</span>
            <Switch
              checked={refreshSettings.autoRefresh}
              onCheckedChange={(checked) => updateRefreshSettings({ autoRefresh: checked })}
            />
          </div>
          <div>
            <label className="mb-2 block text-sm text-gray-light">Refresh Interval</label>
            <select
              value={refreshSettings.interval}
              onChange={(event) => updateRefreshSettings({ interval: event.target.value })}
              className="w-full rounded-xl border border-cyan-glow/15 bg-ocean-deep/70 px-4 py-3 text-white outline-none transition focus:border-cyan-glow/50"
            >
              <option value="5min">5min</option>
              <option value="15min">15min</option>
              <option value="30min">30min</option>
              <option value="1hr">1hr</option>
            </select>
          </div>
          <div className="flex flex-col justify-end gap-2">
            <button
              onClick={loadReefs}
              disabled={isRefreshing}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-cyan-glow/25 bg-cyan-glow/12 px-5 py-3 text-cyan-glow transition hover:bg-cyan-glow/18 disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
              Manual Refresh Now
            </button>
            <p className="text-xs text-gray-muted">Last synced: {minutesSince(refreshSettings.lastSynced)}</p>
          </div>
        </div>
      </section>

      <section className="reef-panel rounded-2xl border border-gray-border/70 bg-ocean-dark/62 p-6">
        <div className="mb-6 flex items-center gap-3">
          <SettingsIcon className="h-5 w-5 text-cyan-glow" />
          <h3 className="text-2xl text-white">About ReefWatch</h3>
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="rounded-xl border border-cyan-glow/10 bg-ocean-medium/25 p-5">
            <p className="mb-2 text-sm text-gray-muted">Version</p>
            <p className="text-xl text-white">ReefWatch AI v0.1.0</p>
          </div>
          <div className="rounded-xl border border-cyan-glow/10 bg-ocean-medium/25 p-5">
            <p className="mb-2 text-sm text-gray-muted">Data Sources</p>
            <p className="text-sm leading-6 text-gray-light">NOAA Coral Reef Watch, Gemini AI, Phoenix/Arize</p>
          </div>
          <div className="rounded-xl border border-cyan-glow/10 bg-ocean-medium/25 p-5">
            <p className="mb-2 text-sm text-gray-muted">Repository</p>
            <a href="#" className="inline-flex items-center gap-2 text-sm text-cyan-glow transition hover:text-cyan-bright">
              <Github className="h-4 w-4" />
              GitHub link placeholder
            </a>
          </div>
        </div>

        <div className="mt-6 rounded-xl border border-cyan-glow/10 bg-ocean-medium/25 p-5">
          <h4 className="mb-4 text-lg text-white">System Status</h4>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="flex items-center gap-3 rounded-xl border border-cyan-glow/10 bg-ocean-deep/42 p-4">
              <HealthDot active={noaaOnline} />
              <span className="text-sm text-gray-light">NOAA Data Feed</span>
            </div>
            <div className="flex items-center gap-3 rounded-xl border border-cyan-glow/10 bg-ocean-deep/42 p-4">
              <HealthDot active={aiOnline} />
              <span className="text-sm text-gray-light">AI Service</span>
            </div>
            <div className="flex items-center gap-3 rounded-xl border border-cyan-glow/10 bg-ocean-deep/42 p-4">
              <HealthDot active={phoenixOnline} />
              <span className="text-sm text-gray-light">Phoenix Monitoring</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
