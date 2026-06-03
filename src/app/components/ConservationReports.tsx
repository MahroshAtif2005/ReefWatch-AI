import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { Download, FileText, Loader2, Printer, RefreshCw } from 'lucide-react';
import { fetchLiveReefs, generateConservationBrief, type LiveReef, type ReefBriefResponse } from '../services/reefApi';

interface StoredReport {
  id: string;
  reefId: string;
  reefName: string;
  riskLevel: LiveReef['status'];
  markdown: string;
  generatedAt: string;
}

interface PersistedReport {
  id: string;
  reef_name: string;
  reef_id?: string;
  risk_level: LiveReef['status'];
  generated_at: string;
  brief_text: string;
}

const REPORT_STORAGE_KEY = 'reefwatch:conservation-reports';

const statusStyles = {
  safe: 'text-coral-safe bg-coral-safe/10 border-coral-safe/35',
  warning: 'text-coral-warning bg-coral-warning/10 border-coral-warning/35',
  critical: 'text-coral-critical bg-coral-critical/10 border-coral-critical/35',
};

const rowStyles = {
  safe: 'border-coral-safe/20 bg-coral-safe/5',
  warning: 'border-coral-warning/24 bg-coral-warning/7',
  critical: 'border-coral-critical/26 bg-coral-critical/8',
};

function loadStoredReports(): StoredReport[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(REPORT_STORAGE_KEY) || '[]') as Array<StoredReport | PersistedReport>;
    return parsed.map((report) => {
      if ('reef_name' in report) {
        return {
          id: report.id,
          reefId: report.reef_id || report.id,
          reefName: report.reef_name,
          riskLevel: report.risk_level,
          markdown: report.brief_text,
          generatedAt: report.generated_at,
        };
      }

      return report;
    });
  } catch {
    return [];
  }
}

function saveStoredReports(reports: StoredReport[]) {
  const persisted: PersistedReport[] = reports.slice(0, 5).map((report) => ({
    id: report.id,
    reef_id: report.reefId,
    reef_name: report.reefName,
    risk_level: report.riskLevel,
    generated_at: report.generatedAt,
    brief_text: report.markdown,
  }));
  localStorage.setItem(REPORT_STORAGE_KEY, JSON.stringify(persisted));
}

function formatNumber(value: number | null, suffix = '') {
  return value === null || Number.isNaN(value) ? 'Unavailable' : `${value.toFixed(2)}${suffix}`;
}

function renderInlineMarkdown(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);

  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={`${part}-${index}`} className="font-semibold text-cyan-glow">
          {part.slice(2, -2)}
        </strong>
      );
    }

    return part;
  });
}

function renderMarkdown(markdown: string) {
  const lines = markdown.split('\n');
  const nodes = [];
  let listItems: string[] = [];

  const flushList = () => {
    if (listItems.length > 0) {
      nodes.push(
        <ul key={`list-${nodes.length}`} className="my-5 space-y-2 pl-1 text-gray-light">
          {listItems.map((item, index) => (
            <li key={`${item}-${index}`} className="flex gap-3 leading-7">
              <span className="mt-3 h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-glow shadow-[0_0_10px_rgba(0,229,255,0.65)]" />
              <span>{renderInlineMarkdown(item.replace(/^[-*]\s*/, ''))}</span>
            </li>
          ))}
        </ul>
      );
      listItems = [];
    }
  };

  lines.forEach((line, index) => {
    const trimmed = line.trim();

    if (!trimmed) {
      flushList();
      return;
    }

    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      listItems.push(trimmed);
      return;
    }

    flushList();

    if (trimmed.startsWith('## ')) {
      nodes.push(
        <div key={`divider-${index}`} className="mt-8 border-t border-cyan-glow/10 pt-6">
          <h2 className="mb-3 text-2xl text-cyan-glow">
          {trimmed.replace(/^##\s*/, '')}
          </h2>
        </div>
      );
    } else if (trimmed.startsWith('# ')) {
      nodes.push(
        <h1 key={index} className="mb-4 text-3xl text-white">
          {trimmed.replace(/^#\s*/, '')}
        </h1>
      );
    } else {
      nodes.push(
        <p key={index} className="mb-3 leading-7 text-gray-light">
          {renderInlineMarkdown(trimmed)}
        </p>
      );
    }
  });

  flushList();
  return nodes;
}

function stripMarkdownCodeFence(brief: string) {
  return brief
    .replace(/^```markdown\n?/, '')
    .replace(/^```\n?/, '')
    .replace(/```$/, '')
    .trim();
}

function downloadCsv(reefs: LiveReef[]) {
  const headers = ['Reef Name', 'Region', 'Country', 'Temperature', 'Anomaly', 'DHW', 'Risk Level'];
  const rows = reefs.map((reef) => [
    reef.name,
    reef.region,
    reef.country,
    reef.seaSurfaceTemp ?? '',
    reef.tempAnomaly ?? '',
    reef.degreeHeatingWeeks ?? '',
    reef.status,
  ]);
  const csv = [headers, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `reefwatch-risk-summary-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export function ConservationReports() {
  const [reefs, setReefs] = useState<LiveReef[]>([]);
  const [selectedReefId, setSelectedReefId] = useState('');
  const [reports, setReports] = useState<StoredReport[]>(() => loadStoredReports());
  const [activeReport, setActiveReport] = useState<StoredReport | null>(null);
  const [isLoadingReefs, setIsLoadingReefs] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    fetchLiveReefs()
      .then((liveReefs) => {
        if (!isMounted) return;
        setReefs(liveReefs);
        setSelectedReefId(liveReefs[0]?.id || '');
      })
      .catch(() => {
        if (isMounted) {
          setError('Live reef data is unavailable from the deployed ReefWatch backend.');
        }
      })
      .finally(() => {
        if (isMounted) setIsLoadingReefs(false);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const selectedReef = useMemo(
    () => reefs.find((reef) => reef.id === selectedReefId) || null,
    [reefs, selectedReefId]
  );

  async function handleGenerateReport() {
    if (!selectedReef) return;

    setIsGenerating(true);
    setError(null);
    let timeoutId: number | undefined;

    try {
      const timeout = new Promise<never>((_, reject) => {
        timeoutId = window.setTimeout(() => reject(new Error('timeout')), 30000);
      });
      const response: ReefBriefResponse = await Promise.race([
        generateConservationBrief({
          reef_id: selectedReef.id,
          reef_name: selectedReef.name,
          sst: selectedReef.seaSurfaceTemp,
          anomaly: selectedReef.tempAnomaly,
          dhw: selectedReef.degreeHeatingWeeks,
          alert_level: selectedReef.bleachingAlertLevel,
          risk_score: selectedReef.riskScore,
        }),
        timeout,
      ]);
      const cleanBrief = stripMarkdownCodeFence(response.brief);
      const report: StoredReport = {
        id: `${selectedReef.id}-${Date.now()}`,
        reefId: selectedReef.id,
        reefName: response.reef_name || selectedReef.name,
        riskLevel: selectedReef.status,
        markdown: cleanBrief,
        generatedAt: response.generated_at || new Date().toISOString(),
      };
      const nextReports = [report, ...reports].slice(0, 5);
      setReports(nextReports);
      setActiveReport(report);
      saveStoredReports(nextReports);
    } catch (requestError) {
      if (requestError instanceof Error && requestError.message === 'timeout') {
        setError('Report generation timed out after 30 seconds. Please try again.');
      } else {
        setError(requestError instanceof Error ? requestError.message : 'Failed to generate report. Please try again.');
      }
    } finally {
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
      setIsGenerating(false);
    }
  }

  function handleGenerateNewReport() {
    setActiveReport(null);
    setError(null);
  }

  return (
    <div className="space-y-8">
      <style>{`
        @media print {
          body * { visibility: hidden; }
          #reefwatch-print-report, #reefwatch-print-report * { visibility: visible; }
          #reefwatch-print-report {
            position: absolute;
            inset: 0;
            width: 100%;
            padding: 32px;
            color: #0b3d52;
            background: white;
          }
          #reefwatch-print-report h1,
          #reefwatch-print-report h2,
          #reefwatch-print-report p,
          #reefwatch-print-report li { color: #0b3d52 !important; }
          .print-hidden { display: none !important; }
        }
      `}</style>

      <div>
        <h2 className="text-4xl text-white mb-2">Conservation Reports</h2>
        <p className="text-gray-muted">Generate AI conservation briefs from live NOAA reef conditions</p>
      </div>

      <motion.section
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        className="reef-panel-strong rounded-2xl border border-gray-border/70 bg-ocean-dark/70 p-6"
      >
        {!activeReport && (
          <>
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div className="flex-1">
                <label className="mb-2 block text-sm text-gray-light">Monitored Reef</label>
                <select
                  value={selectedReefId}
                  onChange={(event) => setSelectedReefId(event.target.value)}
                  className="w-full rounded-xl border border-cyan-glow/15 bg-ocean-deep/70 px-4 py-3 text-white outline-none transition focus:border-cyan-glow/50"
                  disabled={isLoadingReefs || reefs.length === 0}
                >
                  {reefs.map((reef) => (
                    <option key={reef.id} value={reef.id}>
                      {reef.name} - {reef.country}
                    </option>
                  ))}
                </select>
              </div>

              <button
                onClick={handleGenerateReport}
                disabled={!selectedReef || isGenerating}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-cyan-glow/30 bg-ocean-medium/85 px-5 py-3 text-white shadow-[0_0_18px_rgba(0,229,255,0.08)] transition-all hover:border-cyan-glow/70 hover:bg-ocean-medium hover:text-cyan-glow hover:shadow-[0_0_22px_rgba(0,229,255,0.18)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                {isGenerating ? 'Gemini is analyzing reef conditions...' : 'Generate Report'}
              </button>
            </div>

            {selectedReef && (
              <div className="mt-5 grid gap-3 text-sm text-gray-light md:grid-cols-4">
                <span>SST: {formatNumber(selectedReef.seaSurfaceTemp, '°C')}</span>
                <span>Anomaly: {formatNumber(selectedReef.tempAnomaly, '°C')}</span>
                <span>DHW: {formatNumber(selectedReef.degreeHeatingWeeks)}</span>
                <span className={`w-fit rounded-lg border px-2 py-1 capitalize ${statusStyles[selectedReef.status]}`}>
                  {selectedReef.status}
                </span>
              </div>
            )}
          </>
        )}

        {activeReport && (
          <div>
            <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="mb-3 flex flex-wrap items-center gap-3">
                  <h3 className="text-2xl text-white">{activeReport.reefName}</h3>
                  <span className={`rounded-lg border px-3 py-1 text-xs capitalize ${statusStyles[activeReport.riskLevel]}`}>
                    {activeReport.riskLevel}
                  </span>
                </div>
                <p className="text-sm text-gray-muted">
                  Generated {new Date(activeReport.generatedAt).toLocaleString()}
                </p>
              </div>
              <div className="print-hidden flex flex-wrap gap-3">
                <button
                  onClick={() => window.print()}
                  className="inline-flex items-center gap-2 rounded-xl border border-cyan-glow/25 bg-ocean-medium/50 px-4 py-2 text-sm text-cyan-glow transition hover:bg-cyan-glow/10"
                >
                  <Printer className="h-4 w-4" />
                  Download PDF
                </button>
                <button
                  onClick={handleGenerateNewReport}
                  className="inline-flex items-center gap-2 rounded-xl border border-gray-border/70 bg-ocean-medium/45 px-4 py-2 text-sm text-gray-light transition hover:border-cyan-glow/40 hover:text-white"
                >
                  <RefreshCw className="h-4 w-4" />
                  Generate New Report
                </button>
              </div>
            </div>
            <article
              id="reefwatch-print-report"
              className="rounded-2xl border border-cyan-glow/20 bg-ocean-deep/58 p-8 shadow-[0_0_40px_rgba(0,229,255,0.08)]"
            >
              <div className="mb-7 border-b border-cyan-glow/12 pb-5">
                <p className="text-xs uppercase tracking-wider text-gray-muted">Conservation Brief</p>
                <h1 className="mt-2 text-3xl text-white">{activeReport.reefName}</h1>
                <p className="mt-2 text-sm text-gray-muted">Generated {new Date(activeReport.generatedAt).toLocaleString()}</p>
              </div>
              {renderMarkdown(activeReport.markdown)}
            </article>
          </div>
        )}

        {isGenerating && (
          <div className="mt-6 flex items-center gap-3 rounded-xl border border-cyan-glow/15 bg-ocean-medium/32 p-5 text-sm text-gray-light">
            <Loader2 className="h-4 w-4 animate-spin text-cyan-glow" />
            Gemini is analyzing reef conditions...
          </div>
        )}

        {error && (
          <div className="mt-6 rounded-xl border border-coral-critical/35 bg-coral-critical/10 p-4 text-sm text-coral-critical">
            {error}
          </div>
        )}
      </motion.section>

      <section className="reef-panel rounded-2xl border border-gray-border/70 bg-ocean-dark/62 p-6">
        <div className="mb-5 flex items-center justify-between">
          <h3 className="text-2xl text-white">Recent Reports</h3>
          <span className="text-sm text-gray-muted">Last 5 generated</span>
        </div>
        <div className="grid gap-4 md:grid-cols-5">
          {reports.length === 0 && (
            <div className="col-span-full rounded-xl border border-cyan-glow/10 bg-ocean-medium/25 p-5 text-sm text-gray-light">
              Generated reports will appear here.
            </div>
          )}
          {reports.map((report) => (
            <div key={report.id} className="rounded-xl border border-cyan-glow/12 bg-ocean-medium/28 p-4">
              <div className="mb-3 flex items-start justify-between gap-2">
                <h4 className="text-sm text-white">{report.reefName}</h4>
                <span className={`rounded-lg border px-2 py-1 text-[11px] capitalize ${statusStyles[report.riskLevel]}`}>
                  {report.riskLevel}
                </span>
              </div>
              <p className="mb-4 text-xs text-gray-muted">{new Date(report.generatedAt).toLocaleDateString()}</p>
              <button
                onClick={() => setActiveReport(report)}
                className="w-full rounded-lg border border-cyan-glow/15 px-3 py-2 text-xs text-cyan-glow transition hover:bg-cyan-glow/10"
              >
                View Report
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="reef-panel rounded-2xl border border-gray-border/70 bg-ocean-dark/62 p-6">
        <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h3 className="text-2xl text-white">Global Risk Summary</h3>
            <p className="text-sm text-gray-muted">Live NOAA-backed conditions across active monitored reefs</p>
          </div>
          <button
            onClick={() => downloadCsv(reefs)}
            disabled={reefs.length === 0}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-cyan-glow/20 bg-ocean-medium/35 px-4 py-2 text-sm text-cyan-glow transition hover:bg-cyan-glow/10 disabled:opacity-50"
          >
            <Download className="h-4 w-4" />
            Export All Data
          </button>
        </div>

        {isLoadingReefs ? (
          <div className="rounded-xl border border-cyan-glow/10 bg-ocean-medium/25 p-5 text-sm text-gray-light">
            Loading reef summary...
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-cyan-glow/12">
            <table className="w-full text-left text-sm">
              <thead className="bg-ocean-deep/70 text-gray-muted">
                <tr>
                  <th className="px-4 py-3">Reef Name</th>
                  <th className="px-4 py-3">Region</th>
                  <th className="px-4 py-3">Temperature</th>
                  <th className="px-4 py-3">Anomaly</th>
                  <th className="px-4 py-3">DHW</th>
                  <th className="px-4 py-3">Risk Level</th>
                </tr>
              </thead>
              <tbody>
                {reefs.map((reef) => (
                  <tr key={reef.id} className={`border-t ${rowStyles[reef.status]}`}>
                    <td className="px-4 py-3 text-white">{reef.name}</td>
                    <td className="px-4 py-3 text-gray-light">{reef.region}</td>
                    <td className="px-4 py-3 text-gray-light">{formatNumber(reef.seaSurfaceTemp, '°C')}</td>
                    <td className="px-4 py-3 text-gray-light">{formatNumber(reef.tempAnomaly, '°C')}</td>
                    <td className="px-4 py-3 text-gray-light">{formatNumber(reef.degreeHeatingWeeks)}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-lg border px-2 py-1 text-xs capitalize ${statusStyles[reef.status]}`}>
                        {reef.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
