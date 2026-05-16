import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Bot, FileText, Loader2, Send, Sparkles, Zap } from 'lucide-react';
import { fetchLiveReefs, generateConservationBrief, sendResearchChat, type LiveReef, type ReefChatMessage } from '../services/reefApi';

interface ChatEntry {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  dataUsed?: string[];
  confidence?: number;
  suggestions?: string[];
  report?: string;
}

const GREETING = "Hello, I'm your ReefWatch AI assistant. I have live data from 8 monitored reefs and 57 NOAA stations. What would you like to analyze today?";

const statusStyles = {
  safe: 'text-coral-safe bg-coral-safe/10 border-coral-safe/35',
  warning: 'text-coral-warning bg-coral-warning/10 border-coral-warning/35',
  critical: 'text-coral-critical bg-coral-critical/10 border-coral-critical/35',
};

const isTransientErrorMessage = (message: ChatEntry) => message.id.startsWith('assistant-error-');

function formatNumber(value: number | null, suffix = '') {
  return value === null || Number.isNaN(value) ? 'Unavailable' : `${value.toFixed(2)}${suffix}`;
}

function messageToHistory(message: ChatEntry): ReefChatMessage {
  return {
    role: message.role,
    content: message.content,
  };
}

function renderMessageContent(content: string) {
  const lines = content.split('\n');
  const tableStart = lines.findIndex((line) => line.trim().startsWith('|'));

  if (tableStart === -1) {
    return <p className="whitespace-pre-wrap leading-7">{content}</p>;
  }

  const before = lines.slice(0, tableStart).join('\n').trim();
  const tableLines = lines.slice(tableStart).filter((line) => line.includes('|'));
  const rows = tableLines
    .filter((line) => !/^\s*\|?\s*-+/.test(line.replace(/\|/g, '')))
    .map((line) => line.split('|').map((cell) => cell.trim()).filter(Boolean));

  return (
    <div className="space-y-4">
      {before && <p className="whitespace-pre-wrap leading-7">{before}</p>}
      {rows.length > 1 && (
        <div className="overflow-hidden rounded-xl border border-cyan-glow/12">
          <table className="w-full text-left text-xs">
            <thead className="bg-ocean-deep/70 text-gray-muted">
              <tr>
                {rows[0].map((cell) => <th key={cell} className="px-3 py-2">{cell}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.slice(1).map((row, index) => (
                <tr key={index} className="border-t border-cyan-glow/10">
                  {row.map((cell, cellIndex) => <td key={`${cell}-${cellIndex}`} className="px-3 py-2 text-gray-light">{cell}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function ResearcherWorkspace() {
  const [reefs, setReefs] = useState<LiveReef[]>([]);
  const [messages, setMessages] = useState<ChatEntry[]>([
    {
      id: 'greeting',
      role: 'assistant',
      content: GREETING,
      suggestions: ['Analyze Most At-Risk Reef', 'Compare All Regions', 'Generate Weekly Summary'],
    },
  ]);
  const [input, setInput] = useState('');
  const [agentStatus, setAgentStatus] = useState<'ready' | 'thinking' | 'fetching data'>('ready');
  const [reefError, setReefError] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetchLiveReefs()
      .then(setReefs)
      .catch(() => setReefError('Live reef context is unavailable. Start the local backend on port 4000.'));
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, agentStatus]);

  const activeAlerts = useMemo(
    () => reefs.filter((reef) => reef.status === 'critical' || reef.status === 'warning'),
    [reefs]
  );
  const mostAtRisk = useMemo(
    () => [...reefs].sort((a, b) => b.riskScore - a.riskScore)[0],
    [reefs]
  );

  async function sendMessage(text = input) {
    const trimmed = text.trim();
    if (!trimmed || agentStatus !== 'ready') return;

    const userMessage: ChatEntry = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: trimmed,
    };
    const cleanMessages = messages.filter((message) => !isTransientErrorMessage(message));
    const nextMessages = [...cleanMessages, userMessage];
    setMessages(nextMessages);
    setInput('');
    setAgentStatus('thinking');

    try {
      setAgentStatus('fetching data');
      const response = await sendResearchChat({
        message: String(trimmed),
        conversation_history: Array.isArray(nextMessages) ? nextMessages.map(messageToHistory) : [],
        reef_context: {
          monitored_reefs: reefs,
          active_alerts: activeAlerts,
          most_at_risk: mostAtRisk ?? null,
        },
      });
      setMessages((current) => [
        ...current.filter((message) => !isTransientErrorMessage(message)),
        {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          content: response.answer,
          dataUsed: response.data_used || [],
          confidence: response.confidence,
          suggestions: response.follow_up_suggestions || [],
        },
      ]);
    } catch (error) {
      console.error('[ResearcherWorkspace] AI chat request failed', {
        error,
        endpoint: 'http://localhost:4000/api/ai/chat',
        message: trimmed,
      });
      setMessages((current) => [
        ...current.filter((message) => !isTransientErrorMessage(message)),
        {
          id: `assistant-error-${Date.now()}`,
          role: 'assistant',
          content: 'The AI chat request failed. I logged the backend response in the console so we can see whether it came from the Node proxy, Python service, or model call.',
          dataUsed: ['Local app state'],
          confidence: 0,
        },
      ]);
    } finally {
      setAgentStatus('ready');
    }
  }

  function applyQuickPrompt(kind: 'risk' | 'compare' | 'weekly') {
    if (kind === 'risk') {
      setInput(mostAtRisk ? `Analyze the current bleaching threat for ${mostAtRisk.name} and recommend immediate actions.` : 'Analyze the most at-risk reef and recommend immediate actions.');
    } else if (kind === 'compare') {
      setInput('Compare all monitored reef regions by SST anomaly, DHW, alert level, and conservation urgency.');
    } else {
      setInput('Generate a weekly executive summary for all monitored reefs, including active alerts and next actions.');
    }
  }

  async function handleGenerateReport(messageId: string) {
    const reef = mostAtRisk;
    if (!reef) return;

    setAgentStatus('thinking');
    try {
      const response = await generateConservationBrief({
        reef_id: reef.id,
        reef_name: reef.name,
        sst: reef.seaSurfaceTemp,
        anomaly: reef.tempAnomaly,
        dhw: reef.degreeHeatingWeeks,
        alert_level: reef.bleachingAlertLevel,
        risk_score: reef.riskScore,
      });
      setMessages((current) => current.map((message) => (
        message.id === messageId ? { ...message, report: response.brief } : message
      )));
    } finally {
      setAgentStatus('ready');
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-4xl text-white mb-2">Researcher Workspace</h2>
        <p className="text-gray-muted">AI-assisted coral risk exploration using live NOAA context</p>
      </div>

      <div className="grid h-[calc(100vh-220px)] min-h-[680px] grid-cols-1 gap-6 xl:grid-cols-[35fr_65fr]">
        <motion.aside
          initial={{ opacity: 0, x: -14 }}
          animate={{ opacity: 1, x: 0 }}
          className="reef-panel-strong overflow-hidden rounded-2xl border border-gray-border/70 bg-ocean-dark/68"
        >
          <div className="border-b border-cyan-glow/10 p-6">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-2xl text-white">Live Context</h3>
              <span className="inline-flex items-center gap-2 rounded-lg border border-cyan-glow/15 bg-cyan-glow/8 px-3 py-1 text-xs text-cyan-glow capitalize">
                <span className={`h-2 w-2 rounded-full ${agentStatus === 'ready' ? 'bg-coral-safe' : 'bg-coral-warning animate-pulse'}`} />
                {agentStatus}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-xl border border-cyan-glow/10 bg-ocean-medium/30 p-3">
                <p className="text-2xl text-white">{reefs.length || '...'}</p>
                <p className="text-xs text-gray-muted">Live reefs</p>
              </div>
              <div className="rounded-xl border border-coral-critical/18 bg-coral-critical/7 p-3">
                <p className="text-2xl text-coral-critical">{reefs.filter((reef) => reef.status === 'critical').length}</p>
                <p className="text-xs text-gray-muted">Critical</p>
              </div>
              <div className="rounded-xl border border-coral-warning/18 bg-coral-warning/7 p-3">
                <p className="text-2xl text-coral-warning">{reefs.filter((reef) => reef.status === 'warning').length}</p>
                <p className="text-xs text-gray-muted">Warning</p>
              </div>
            </div>
            {reefError && <p className="mt-4 text-sm text-coral-warning">{reefError}</p>}
          </div>

          <div className="space-y-6 overflow-auto p-6">
            <section>
              <h4 className="mb-3 text-sm uppercase tracking-wide text-gray-muted">Active Alerts</h4>
              <div className="space-y-3">
                {activeAlerts.length === 0 && (
                  <div className="rounded-xl border border-cyan-glow/10 bg-ocean-medium/25 p-4 text-sm text-gray-light">
                    No warning or critical alerts detected.
                  </div>
                )}
                {activeAlerts.map((reef) => (
                  <div key={reef.id} className="rounded-xl border border-cyan-glow/10 bg-ocean-medium/25 p-4">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <p className="text-sm text-white">{reef.name}</p>
                      <span className={`rounded-lg border px-2 py-1 text-[11px] capitalize ${statusStyles[reef.status]}`}>
                        {reef.status}
                      </span>
                    </div>
                    <p className="text-xs text-gray-muted">
                      DHW {formatNumber(reef.degreeHeatingWeeks)} · Anomaly {formatNumber(reef.tempAnomaly, '°C')}
                    </p>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <h4 className="mb-3 text-sm uppercase tracking-wide text-gray-muted">Quick Actions</h4>
              <div className="grid gap-3">
                <button onClick={() => applyQuickPrompt('risk')} className="flex items-center gap-3 rounded-xl border border-cyan-glow/12 bg-cyan-glow/7 px-4 py-3 text-left text-sm text-cyan-glow transition hover:bg-cyan-glow/12">
                  <Zap className="h-4 w-4" />
                  Analyze Most At-Risk Reef
                </button>
                <button onClick={() => applyQuickPrompt('compare')} className="flex items-center gap-3 rounded-xl border border-cyan-glow/12 bg-ocean-medium/25 px-4 py-3 text-left text-sm text-gray-light transition hover:bg-ocean-medium/40">
                  <Sparkles className="h-4 w-4 text-cyan-glow" />
                  Compare All Regions
                </button>
                <button onClick={() => applyQuickPrompt('weekly')} className="flex items-center gap-3 rounded-xl border border-cyan-glow/12 bg-ocean-medium/25 px-4 py-3 text-left text-sm text-gray-light transition hover:bg-ocean-medium/40">
                  <FileText className="h-4 w-4 text-cyan-glow" />
                  Generate Weekly Summary
                </button>
              </div>
            </section>
          </div>
        </motion.aside>

        <motion.section
          initial={{ opacity: 0, x: 14 }}
          animate={{ opacity: 1, x: 0 }}
          className="reef-panel-strong flex min-h-0 flex-col overflow-hidden rounded-2xl border border-gray-border/70 bg-ocean-dark/68"
        >
          <div className="border-b border-cyan-glow/10 p-5">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-glow/12 text-cyan-glow">
                <Bot className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-xl text-white">ReefWatch AI Assistant</h3>
                <p className="text-sm text-gray-muted">Live NOAA context · Gemini reasoning · Phoenix trace-ready</p>
              </div>
            </div>
          </div>

          <div className="flex-1 space-y-8 overflow-auto p-6">
            {messages.map((message) => (
              <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[82%] border px-5 py-4 shadow-[0_16px_36px_rgba(2,11,20,0.2)] ${
                  message.role === 'user'
                    ? 'rounded-2xl rounded-br-md border-cyan-glow/45 bg-gradient-to-br from-ocean-light/58 via-ocean-medium/62 to-blue-deep/44 text-white shadow-[0_18px_42px_rgba(0,84,112,0.28),inset_0_1px_0_rgba(191,253,255,0.08)]'
                    : 'rounded-2xl rounded-bl-md border-cyan-glow/18 bg-gradient-to-br from-ocean-medium/52 via-ocean-dark/46 to-ocean-deep/58 text-gray-light shadow-[0_14px_34px_rgba(2,11,20,0.2),inset_0_1px_0_rgba(191,253,255,0.045)]'
                }`}>
                  {renderMessageContent(message.content)}

                  {message.report && (
                    <div className="mt-4 rounded-xl border border-cyan-glow/12 bg-ocean-deep/60 p-4 text-sm text-gray-light">
                      <p className="mb-2 text-white">Generated conservation report</p>
                      <p className="max-h-32 overflow-auto whitespace-pre-wrap">{message.report}</p>
                    </div>
                  )}

                  {message.role === 'assistant' && (
                    <div className="mt-4 space-y-3">
                      {(message.content.toLowerCase().includes('report') || message.content.toLowerCase().includes('brief')) && (
                        <button
                          onClick={() => handleGenerateReport(message.id)}
                          className="rounded-lg border border-cyan-glow/16 bg-cyan-glow/8 px-3 py-2 text-xs text-cyan-glow transition hover:bg-cyan-glow/12"
                        >
                          Generate Full Report
                        </button>
                      )}

                      {message.suggestions && message.suggestions.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {message.suggestions.map((suggestion) => (
                            <button
                              key={suggestion}
                              onClick={() => sendMessage(suggestion)}
                              className="rounded-full border border-cyan-glow/18 bg-ocean-deep/55 px-3 py-1.5 text-xs text-cyan-glow transition hover:border-cyan-glow/35 hover:bg-cyan-glow/12"
                            >
                              {suggestion}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {agentStatus !== 'ready' && (
              <div className="flex justify-start">
                <div className="flex items-center gap-3 rounded-2xl rounded-bl-md border border-cyan-glow/10 bg-ocean-medium/36 px-4 py-3 text-sm text-gray-light">
                  <Loader2 className="h-4 w-4 animate-spin text-cyan-glow" />
                  ReefWatch AI is {agentStatus}...
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          <div className="border-t border-cyan-glow/10 p-5">
            <div className="flex gap-3">
              <input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    sendMessage();
                  }
                }}
                placeholder="Ask about reef risk, regional comparisons, conservation actions..."
                className="min-w-0 flex-1 rounded-xl border border-cyan-glow/15 bg-ocean-deep/70 px-4 py-3 text-white outline-none transition placeholder:text-gray-muted/70 focus:border-cyan-glow/50"
              />
              <button
                onClick={() => sendMessage()}
                disabled={!input.trim() || agentStatus !== 'ready'}
                className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-cyan-glow/55 bg-cyan-glow px-5 py-3 text-ocean-deep shadow-[0_0_22px_rgba(0,229,255,0.28)] transition-all duration-200 hover:-translate-y-0.5 hover:scale-[1.02] hover:border-cyan-bright hover:bg-cyan-bright hover:shadow-[0_0_34px_rgba(0,229,255,0.48)] active:translate-y-0 active:scale-[0.97] disabled:cursor-not-allowed disabled:translate-y-0 disabled:scale-100 disabled:border-cyan-glow/15 disabled:bg-ocean-medium/45 disabled:text-gray-muted disabled:shadow-none"
              >
                <Send className="h-4 w-4" />
                Send
              </button>
            </div>
          </div>
        </motion.section>
      </div>
    </div>
  );
}
