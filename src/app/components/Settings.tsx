import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Github, Mail, RefreshCw, Save, Settings as SettingsIcon } from 'lucide-react';
import { REEF_API_BASE_URL, fetchArizeStatus, fetchLiveReefs, fetchSettings, getResearcherId, saveSettings, type LiveReef } from '../services/reefApi';
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
const ANOMALY_THRESHOLD_KEY = 'anomaly_threshold';
const GITHUB_URL = 'https://github.com/MahroshAtif2005/ReefWatch-AI';
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

function readStorage<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) || '') || fallback;
  } catch {
    return fallback;
  }
}

function readNumberStorage(key: string, fallback: number) {
  const storedValue = localStorage.getItem(key);
  if (storedValue === null) return fallback;
  const value = Number(storedValue);
  return Number.isFinite(value) ? value : fallback;
}

function writeStorage<T>(key: string, value: T) {
  localStorage.setItem(key, JSON.stringify(value));
}

function parseStoredNumber(value: string | undefined, fallback: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function minutesSince(timestamp: string | null) {
  if (!timestamp) return 'Not synced yet';
  const minutes = Math.max(0, Math.round((Date.now() - new Date(timestamp).getTime()) / 60000));
  if (minutes < 1) return 'Just now';
  return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
}

function getLatestReefTimestamp(reefs: LiveReef[]) {
  const timestamps = reefs
    .map((reef) => reef.lastUpdated || (reef as LiveReef & { last_updated?: string }).last_updated)
    .filter(Boolean)
    .map((timestamp) => new Date(timestamp).getTime())
    .filter(Number.isFinite);

  if (timestamps.length === 0) return null;
  return new Date(Math.max(...timestamps)).toISOString();
}

type ServiceStatus = 'operational' | 'degraded' | 'offline';

function HealthDot({ status }: { status: ServiceStatus }) {
  const styles = {
    operational: {
      className: 'bg-coral-safe',
      shadow: '0 0 12px rgba(0, 217, 163, 0.7)',
    },
    degraded: {
      className: 'bg-coral-warning',
      shadow: '0 0 12px rgba(255, 136, 0, 0.6)',
    },
    offline: {
      className: 'bg-coral-critical',
      shadow: '0 0 12px rgba(255, 79, 112, 0.65)',
    },
  }[status];

  return (
    <span
      className={`h-2.5 w-2.5 rounded-full ${styles.className}`}
      style={{ boxShadow: styles.shadow }}
    />
  );
}

export function Settings() {
  const [alertSettings, setAlertSettings] = useState<AlertSettings>(() => {
    const storedSettings = readStorage(ALERT_SETTINGS_KEY, defaultAlertSettings);
    return {
      ...storedSettings,
      anomalyThreshold: readNumberStorage(ANOMALY_THRESHOLD_KEY, storedSettings.anomalyThreshold ?? 1.5),
    };
  });
  const [refreshSettings, setRefreshSettings] = useState<RefreshSettings>(() => readStorage(REFRESH_SETTINGS_KEY, defaultRefreshSettings));
  const [alertSaveStatus, setAlertSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [isSavingAlerts, setIsSavingAlerts] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [noaaStatus, setNoaaStatus] = useState<ServiceStatus>('offline');
  const [aiStatus, setAiStatus] = useState<ServiceStatus>('offline');
  const [phoenixStatus, setPhoenixStatus] = useState<ServiceStatus>('offline');

  useEffect(() => {
    loadReefs();
    checkSystemStatus();
    loadServerSettings();
  }, []);

  async function loadReefs() {
    setIsRefreshing(true);
    try {
      const liveReefs = await fetchLiveReefs();
      setNoaaStatus('operational');
      const lastSynced = getLatestReefTimestamp(liveReefs);
      if (lastSynced) {
        setRefreshSettings((current) => {
          const nextRefreshSettings = { ...current, lastSynced };
          writeStorage(REFRESH_SETTINGS_KEY, nextRefreshSettings);
          return nextRefreshSettings;
        });
      }
    } catch {
      setNoaaStatus('offline');
    } finally {
      setIsRefreshing(false);
    }
  }

  function isValidEmail(email: string) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function updateAlertSettings(next: Partial<AlertSettings>) {
    setAlertSettings((current) => ({ ...current, ...next }));
    setAlertSaveStatus('idle');
    if ('email' in next) {
      setEmailError(next.email && !isValidEmail(next.email) ? 'Enter a valid email address.' : null);
    }
  }

  function updateAnomalyThreshold(threshold: number) {
    setAlertSettings((current) => {
      const updated = { ...current, anomalyThreshold: threshold };
      localStorage.setItem(ANOMALY_THRESHOLD_KEY, String(threshold));
      writeStorage(ALERT_SETTINGS_KEY, updated);
      return updated;
    });
    setAlertSaveStatus('idle');
  }

  async function saveAlertSettings() {
    if (alertSettings.email && !isValidEmail(alertSettings.email)) {
      setEmailError('Enter a valid email address before saving.');
      return;
    }
    setIsSavingAlerts(true);
    setAlertSaveStatus('idle');

    try {
      await saveSettings({
        notification_email: alertSettings.email,
        anomaly_threshold: alertSettings.anomalyThreshold,
        critical_alerts_enabled: alertSettings.criticalAlerts,
        temp_anomaly_alerts_enabled: alertSettings.anomalyWarnings,
        weekly_summary_enabled: alertSettings.weeklySummary,
      }, getResearcherId());
      writeStorage(ALERT_SETTINGS_KEY, alertSettings);
      localStorage.setItem(ANOMALY_THRESHOLD_KEY, String(alertSettings.anomalyThreshold));
      setEmailError(null);
      setAlertSaveStatus('success');
    } catch {
      setAlertSaveStatus('error');
    } finally {
      setIsSavingAlerts(false);
    }
  }

  function updateRefreshSettings(next: Partial<RefreshSettings>) {
    const updated = { ...refreshSettings, ...next };
    setRefreshSettings(updated);
    writeStorage(REFRESH_SETTINGS_KEY, updated);
  }

  async function checkSystemStatus() {
    fetchLiveReefs()
      .then(() => setNoaaStatus('operational'))
      .catch(() => setNoaaStatus('offline'));

    fetch(`${REEF_API_BASE_URL}/api/ai/health`)
      .then(async (response) => {
        if (!response.ok) throw new Error('AI service offline');
        const health = await response.json();
        setAiStatus(health.gemini === 'connected' ? 'operational' : 'offline');
      })
      .catch(() => setAiStatus('offline'));

    fetchArizeStatus()
      .then((status) => setPhoenixStatus(status.configured ? 'operational' : 'degraded'))
      .catch(() => setPhoenixStatus('offline'));
  }

  async function loadServerSettings() {
    // Read the email directly from localStorage — this is the user-facing source of truth.
    // The server's _SETTINGS_STORE is shared (single Cloud Run instance) and resets on redeploy.
    // localStorage scopes the recipient to this browser/researcher session.
    const localEmail = readStorage<AlertSettings>(ALERT_SETTINGS_KEY, defaultAlertSettings).email;

    try {
      const settings = await fetchSettings(getResearcherId());
      const hasServerAlertSettings = Object.keys(settings).some((key) => [
        'notification_email',
        'anomaly_threshold',
        'critical_alerts_enabled',
        'temp_anomaly_alerts_enabled',
        'weekly_summary_enabled',
      ].includes(key));

      if (hasServerAlertSettings) {
        setAlertSettings((current) => {
          // Email is always taken from localStorage — never overwritten by server.
          const nextSettings = {
            ...current,
            anomalyThreshold: parseStoredNumber(settings.anomaly_threshold, current.anomalyThreshold),
            criticalAlerts: settings.critical_alerts_enabled === undefined
              ? current.criticalAlerts
              : settings.critical_alerts_enabled === 'true',
            anomalyWarnings: settings.temp_anomaly_alerts_enabled === undefined
              ? current.anomalyWarnings
              : settings.temp_anomaly_alerts_enabled === 'true',
            weeklySummary: settings.weekly_summary_enabled === undefined
              ? current.weeklySummary
              : settings.weekly_summary_enabled === 'true',
          };
          writeStorage(ALERT_SETTINGS_KEY, nextSettings);
          localStorage.setItem(ANOMALY_THRESHOLD_KEY, String(nextSettings.anomalyThreshold));
          return nextSettings;
        });
      }

      // Re-sync local email to server whenever it differs.
      // This handles server restarts (Cloud Run instance recycle) where _SETTINGS_STORE
      // is wiped but the researcher's localStorage still has their email.
      // Without this, the next 6-hour alert cycle would have no recipient.
      if (localEmail && localEmail !== settings.notification_email) {
        saveSettings({ notification_email: localEmail }, getResearcherId()).catch(() =>
          console.warn('[settings] silent email re-sync to server failed')
        );
      }
    } catch {
      console.warn('[settings] server settings unavailable; using localStorage fallback');
    }
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
              placeholder="researcher@example.com"
              className={`w-full rounded-xl border bg-ocean-deep/70 px-4 py-3 text-white outline-none transition placeholder:text-gray-muted/70 focus:border-cyan-glow/50 ${emailError ? 'border-coral-critical/60' : 'border-cyan-glow/15'}`}
            />
            {emailError && (
              <p className="mt-2 text-xs text-coral-critical">{emailError}</p>
            )}
            {!emailError && alertSettings.email ? (
              <p className="mt-2 text-sm text-coral-safe">Alerts will be sent to: {alertSettings.email}</p>
            ) : !emailError && (
              <p className="mt-2 text-sm text-gray-muted">Add an email address to receive alerts for reefs you actively monitor.</p>
            )}
            <p className="mt-2 text-xs text-gray-muted/70">Alerts are only sent for reefs you add to your active monitoring list.</p>
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
          <div style={{ maxWidth: '500px', width: '100%' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
              <span style={{ color: '#94a3b8', fontSize: '13px' }}>0.5°C</span>
              <span style={{ color: '#22d3ee', fontWeight: 'bold' }}>
                {alertSettings.anomalyThreshold.toFixed(1)}°C
              </span>
              <span style={{ color: '#94a3b8', fontSize: '13px' }}>4.0°C</span>
            </div>
            <input
              type="range"
              min="0.5"
              max="4.0"
              step="0.5"
              value={alertSettings.anomalyThreshold}
              onChange={(event) => updateAnomalyThreshold(parseFloat(event.target.value))}
              style={{ width: '100%', accentColor: '#22d3ee' }}
            />
            <p style={{ color: '#64748b', fontSize: '12px', marginTop: '8px' }}>
              Reefs with SST anomaly above this value will trigger alerts
            </p>
          </div>
        </div>

        <div className="mt-6 flex items-center gap-3">
          <button
            onClick={saveAlertSettings}
            disabled={isSavingAlerts}
            className="inline-flex items-center gap-2 rounded-xl border border-cyan-glow/25 bg-cyan-glow/12 px-5 py-3 text-cyan-glow transition hover:bg-cyan-glow/18 disabled:cursor-not-allowed disabled:opacity-70"
          >
            <Save className="h-4 w-4" />
            {isSavingAlerts ? 'Saving...' : 'Save Alert Settings'}
          </button>
          {alertSaveStatus === 'success' && <span className="text-sm text-coral-safe">Saved to server ✓</span>}
          {alertSaveStatus === 'error' && <span className="text-sm text-coral-critical">Save failed</span>}
        </div>
      </motion.section>

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
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-sm text-cyan-glow transition hover:text-cyan-bright">
              <Github className="h-4 w-4" />
              GitHub repository
            </a>
          </div>
        </div>

        <div className="mt-6 rounded-xl border border-cyan-glow/10 bg-ocean-medium/25 p-5">
          <h4 className="mb-4 text-lg text-white">System Status</h4>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="flex items-center gap-3 rounded-xl border border-cyan-glow/10 bg-ocean-deep/42 p-4">
              <HealthDot status={noaaStatus} />
              <span className="text-sm text-gray-light">NOAA Data Feed</span>
            </div>
            <div className="flex items-center gap-3 rounded-xl border border-cyan-glow/10 bg-ocean-deep/42 p-4">
              <HealthDot status={aiStatus} />
              <span className="text-sm text-gray-light">AI Service</span>
            </div>
            <div className="flex items-center gap-3 rounded-xl border border-cyan-glow/10 bg-ocean-deep/42 p-4">
              <HealthDot status={phoenixStatus} />
              <span className="text-sm text-gray-light">Phoenix Monitoring</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
