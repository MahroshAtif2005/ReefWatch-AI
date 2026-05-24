import nodemailer from 'nodemailer';
import { getSetting, upsertSetting, insertAgentEvent } from '../db/database.js';

const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const sentAlerts = new Map();

const getReefAlertKey = (reef) => reef?.id || reef?.stationId || reef?.station_id || reef?.name;
const getAlertCooldownSettingKey = (reef) => `alert_cooldown_${getReefAlertKey(reef)}`;

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const formatMetric = (value, suffix = '') => (
  value === null || value === undefined ? 'Unavailable' : `${escapeHtml(value)}${suffix}`
);

async function getEmailConfig() {
  const from = process.env.ALERT_EMAIL_FROM;
  const to = await getAlertEmail();
  const password = process.env.ALERT_EMAIL_PASSWORD;

  if (!from || !to || !password || password === '<gmail_app_password>') {
    const error = new Error('Alert email is not configured. Set Settings notification email or ALERT_EMAIL_TO, plus ALERT_EMAIL_FROM and ALERT_EMAIL_PASSWORD.');
    error.statusCode = 503;
    throw error;
  }

  return { from, password, to };
}

async function getAlertEmail() {
  return await getSetting('notification_email') || process.env.ALERT_EMAIL_TO;
}

async function getAlertThreshold() {
  const val = await getSetting('anomaly_threshold');
  const threshold = val ? parseFloat(val) : 1.5;
  return Number.isFinite(threshold) ? threshold : 1.5;
}

const isCriticalReef = (reef, threshold = 1.5) => (
  Number(reef?.riskScore) >= 50
  || (reef?.tempAnomaly !== null && reef?.tempAnomaly !== undefined && Number(reef.tempAnomaly) >= threshold)
  || (reef?.degreeHeatingWeeks !== null && reef?.degreeHeatingWeeks !== undefined && Number(reef.degreeHeatingWeeks) >= 4)
);

async function getLastAlertSentAt(reef) {
  const reefKey = getReefAlertKey(reef);
  const storedAt = await getSetting(getAlertCooldownSettingKey(reef));
  if (storedAt) {
    const cached = sentAlerts.get(reefKey) || {};
    sentAlerts.set(reefKey, {
      reefName: reef.name,
      riskScore: reef.riskScore,
      sentTo: cached.sentTo,
      sentAt: storedAt,
    });
  }
  return storedAt;
}

function isWithinCooldown(sentAt) {
  const elapsed = sentAt ? Date.now() - new Date(sentAt).getTime() : Number.POSITIVE_INFINITY;
  return Number.isFinite(elapsed) && elapsed < ALERT_COOLDOWN_MS;
}

async function rememberAlert(reef, sentTo) {
  const sentAt = new Date().toISOString();
  const reefKey = getReefAlertKey(reef);
  sentAlerts.set(reefKey, {
    reefName: reef.name,
    riskScore: reef.riskScore,
    sentTo,
    sentAt,
  });
  await upsertSetting(getAlertCooldownSettingKey(reef), sentAt);
}

function buildRuleBasedAlertMessage(reef) {
  const reasons = [];
  if (Number(reef?.riskScore) >= 50) reasons.push(`bleaching risk is ${reef.riskScore}%`);
  if (reef?.tempAnomaly !== null && reef?.tempAnomaly !== undefined) {
    reasons.push(`temperature anomaly is ${reef.tempAnomaly}°C`);
  }
  if (reef?.degreeHeatingWeeks !== null && reef?.degreeHeatingWeeks !== undefined) {
    reasons.push(`degree heating weeks are ${reef.degreeHeatingWeeks}`);
  }

  return [
    `${reef.name} has crossed the configured critical alert threshold.`,
    '',
    `Trigger: ${reasons.length ? reasons.join('; ') : 'critical reef monitoring rule matched'}.`,
    '',
    'Recommended response:',
    '- Review the latest NOAA and station telemetry for this reef.',
    '- Prioritize field validation if local teams are available.',
    '- Watch for sustained heat stress, rising DHW, or worsening bleaching alert levels over the next 24 hours.',
    '',
    'This alert message is rule-based and does not use Gemini or the AI brief generator.',
  ].join('\n');
}

export function getAlertStatus() {
  return [...sentAlerts.values()].map((alert) => ({
    reefName: alert.reefName,
    sentAt: alert.sentAt,
    riskScore: alert.riskScore,
    sentTo: alert.sentTo,
  }));
}

export async function checkAndSendAlerts(reefs) {
  const threshold = await getAlertThreshold();
  const criticalReefs = reefs.filter((reef) => isCriticalReef(reef, threshold));

  for (const reef of criticalReefs) {
    const storedAt = await getLastAlertSentAt(reef);
    if (isWithinCooldown(storedAt)) continue;

    try {
      await sendReefAlert(reef);
    } catch (err) {
      console.error(`[alert] failed for ${reef.name}:`, err.message);
    }
  }
}

export async function sendReefAlert(reef, options = {}) {
  const threshold = await getAlertThreshold();
  if (!isCriticalReef(reef, threshold)) {
    const error = new Error(`${reef?.name || 'Selected reef'} is not currently critical.`);
    error.statusCode = 400;
    throw error;
  }

  if (!options.bypassCooldown) {
    const storedAt = await getLastAlertSentAt(reef);
    if (isWithinCooldown(storedAt)) {
      const inMemory = sentAlerts.get(getReefAlertKey(reef));
      return { emailSent: false, skipped: true, reason: 'cooldown', reef: reef.name, sentTo: inMemory?.sentTo };
    }
  }

  const emailConfig = await getEmailConfig();
  const brief = buildRuleBasedAlertMessage(reef);
  await sendAlertEmail(reef, brief, emailConfig);
  logAlertActivity(reef);
  await rememberAlert(reef, emailConfig.to);
  console.log(`[alert] sent email alert for ${reef.name}`);

  return { emailSent: true, skipped: false, reef: reef.name, sentTo: emailConfig.to };
}

async function sendAlertEmail(reef, brief, emailConfig) {
  const { from, password, to } = emailConfig;
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: from,
      pass: password,
    },
  });

  const safeBrief = escapeHtml(brief).replace(/\n/g, '<br>');
  const safeName = escapeHtml(reef.name);

  await transporter.sendMail({
    from: `"ReefWatch AI 🪸" <${from}>`,
    to,
    subject: `🚨 CRITICAL ALERT: ${reef.name} — ${reef.riskScore}% Bleaching Risk`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#dc2626;color:white;padding:20px;border-radius:8px 8px 0 0">
          <h1 style="margin:0">🚨 Critical Reef Alert</h1>
          <p style="margin:8px 0 0">ReefWatch AI Autonomous Monitoring System</p>
        </div>
        <div style="background:#1e293b;color:#e2e8f0;padding:20px">
          <h2 style="color:#f87171">${safeName}</h2>
          <table style="width:100%;border-collapse:collapse">
            <tr>
              <td style="padding:8px;color:#94a3b8">Risk Score</td>
              <td style="padding:8px;color:#f87171;font-weight:bold">${formatMetric(reef.riskScore, '%')}</td>
            </tr>
            <tr>
              <td style="padding:8px;color:#94a3b8">Sea Surface Temp</td>
              <td style="padding:8px">${formatMetric(reef.seaSurfaceTemp, '°C')}</td>
            </tr>
            <tr>
              <td style="padding:8px;color:#94a3b8">Degree Heating Weeks</td>
              <td style="padding:8px">${formatMetric(reef.degreeHeatingWeeks)}</td>
            </tr>
            <tr>
              <td style="padding:8px;color:#94a3b8">Bleaching Alert</td>
              <td style="padding:8px">${formatMetric(reef.bleachingAlertLevel)}</td>
            </tr>
          </table>
          <hr style="border-color:#334155;margin:16px 0">
          <h3 style="color:#38bdf8">Conservation Brief</h3>
          <div style="white-space:pre-wrap;font-size:14px;line-height:1.6">
            ${safeBrief}
          </div>
        </div>
        <div style="background:#0f172a;color:#475569;padding:12px;text-align:center;font-size:12px;border-radius:0 0 8px 8px">
          Generated by ReefWatch AI • Autonomous Coral Reef Monitoring
        </div>
      </div>
    `,
  });
}

function logAlertActivity(reef) {
  insertAgentEvent(
    'alert',
    `Autonomous alert triggered for ${reef.name} — ${reef.riskScore}% bleaching risk`,
    reef.name,
    JSON.stringify({
      reef_name: reef.name,
      trace_type: 'alert',
      risk_level: 'critical',
      risk_score: reef.riskScore,
      alert_sent: true,
    }),
    new Date().toISOString(),
  );
}
