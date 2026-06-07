# 🌊 ReefWatch AI

### The ocean is dying. We built an AI that never stops watching.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Powered by Gemini](https://img.shields.io/badge/Powered%20by-Gemini%202.5%20Flash-blue)](https://deepmind.google/technologies/gemini/)
[![Arize Phoenix](https://img.shields.io/badge/Observability-Arize%20Phoenix-purple)](https://phoenix.arize.com)
[![NOAA Data](https://img.shields.io/badge/Data-NOAA%20Live-green)](https://coralreefwatch.noaa.gov)
[![Cloud Run](https://img.shields.io/badge/Deployed-Google%20Cloud%20Run-orange)](https://cloud.google.com/run)

**Live demo:** https://project-9b3e2672-8819-4fa5-afe.web.app

---

## The Crisis

Coral reefs cover less than 1% of the ocean floor. They support **25% of all marine life**. Over **1 billion people** depend on them for food, income, and coastal protection.

Since 1950, we have lost half of them.

The primary killer is thermal stress, when ocean temperatures rise even 1°C above seasonal norms for several weeks, corals expel the algae living in their tissues, turn ghostly white, and begin to starve. This is bleaching. If the heat persists, they die.

The 2016 bleaching event destroyed **67% of coral in the northern Great Barrier Reef in a single year**. The 2023 global bleaching event, the fourth mass bleaching in recorded history, affected reefs across every ocean simultaneously.

The cruelest part: **we usually find out too late.**

NOAA satellites monitor sea surface temperatures globally, 24 hours a day. The data exists. But translating thousands of data points into actionable intelligence, for hundreds of reef sites, every single day, requires more human hours than the entire global conservation community can provide.

**ReefWatch AI was built to close that gap.**

![ReefWatch AI Dashboard](./reefwatch-dashboard.png)

---

## What It Does

ReefWatch AI is a fully autonomous coral reef intelligence agent running 24/7 on Google Cloud. It monitors 221 live NOAA reef stations worldwide, reasons over thermal stress data using Gemini 2.5 Flash, fires real email alerts when bleaching thresholds are crossed, and crucially **evaluates and improves its own AI outputs over time** using Arize Phoenix observability.

It does not replace marine biologists. It gives them superpowers.

---

## Key Features

### 🗺️ Live Global Reef Map
Interactive Google Maps visualization of 221 NOAA monitoring stations worldwide. Color-coded by real-time bleaching risk. Click any station to see live sea surface temperature, SST anomaly, Degree Heating Weeks, and AI-generated risk assessment. Stations actively monitored by AI are highlighted in real time.

### 🤖 Gemini AI Risk Analysis
Every active reef is analyzed by Gemini 2.5 Flash using live NOAA data. The AI produces a structured assessment including risk score (0–100), confidence level, threat summary, recommended actions, and historical context — automatically, on every data refresh.

### 🔁 Self-Improvement Loop
ReefWatch AI includes an autonomous self-improvement pipeline powered by Arize Phoenix observability and Gemini LLM-as-a-Judge evaluations. The system continuously analyzes real production traces, builds benchmark datasets from historical reef assessments, identifies recurring failure patterns, and generates candidate prompt improvements. Every candidate is tested against the production prompt in controlled benchmark experiments and is only promoted if it demonstrably outperforms the current version. Failed candidates are automatically rejected, and every decision—evaluations, experiments, promotions, and rejections—is recorded in a persistent audit trail. This creates a measurable, accountable feedback loop where improvements are earned through evidence rather than assumed.

### 🔍 Phoenix MCP Runtime Introspection
The Gemini agent is configured with **Arize Phoenix MCP as a callable function tool**. At runtime, when the agent needs to reason about its own performance, it calls `query_phoenix_traces` and `query_phoenix_quality_metrics` directly — retrieving its own operational data mid-inference. Every MCP tool call is logged with timestamp, tool name, and retrieved data, visible in the Arize Monitoring dashboard. This is not just observability. This is **self-awareness**.

### 📋 Conservation Brief Generator
Select any monitored reef and generate a full scientific conservation brief in seconds — executive summary, conditions analysis, risk assessment, recommended actions, and urgency level for funding bodies. Downloadable as PDF.

### 💬 Researcher Workspace
A natural language AI agent that answers complex research questions using live NOAA data. Ask "Which reefs in Southeast Asia are approaching critical thresholds?" — the agent fetches live data, reasons over it in multiple steps, calls Phoenix MCP tools if performance data is needed, and responds with specific findings and confidence scores.

### 📡 Arize Monitoring Dashboard
Full AI observability powered by Phoenix. 3,392+ traces logged. LLM latency, token usage, cache hit rate, error rate, and MCP tool call timeline — all visible in real time. Every Gemini inference is inspectable.

### 🚨 Autonomous Alert System
Running 24/7 on Cloud Run. When a reef crosses a critical bleaching threshold, ReefWatch AI sends automated email alerts with pre-generated conservation briefs. Active alerts firing now: Southern Tonga 90% · Nauru 92% · Galapagos 98%.

---

## Architecture

```mermaid
graph TD
    A[React Frontend<br/>Vite + TypeScript + Tailwind + Google Maps] -->|HTTPS| ADK[Google Cloud ADK Agent<br/>reefwatch_agent · Agent Platform Registry]
    ADK -->|routes queries| B[FastAPI AI Service<br/>Python + Gemini 2.5 Flash + Cloud Run]
    B -->|NOAA Coral Reef Watch API| C[NOAA Data<br/>221 stations · SST · DHW · Anomaly]
    B -->|OpenTelemetry traces| D[Arize Phoenix Cloud<br/>Traces · Evals · MCP Server]
    D -->|Phoenix MCP tools at runtime| B
    B --> E[SQLite<br/>Station cache · Historical readings]
    A -->|Firebase Hosting| F[Users / Researchers]
```
---

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Frontend | React + Vite + TypeScript | Interactive reef map, dashboards, researcher workspace |
| AI Service | FastAPI + Gemini 2.5 Flash | Risk analysis, conservation briefs, chat agent, self-evaluation |
| Observability | Arize Phoenix + OpenInference | Trace logging, LLM-as-a-Judge evals, MCP runtime introspection |
| Data | NOAA Coral Reef Watch | Live SST, DHW, bleaching alert levels for 221 stations |
| Infrastructure | Google Cloud Run + Firebase | 24/7 deployment, min-instances=1, cold start protection |
| Database | SQLite | Station cache, historical readings, event log. Chosen deliberately 
for zero-dependency portability; architected to swap to Cloud SQL for 
multi-instance scale without data layer changes.|
| Agent Framework | Google Cloud ADK (google-adk) | Official ADK Agent class, registered in Google Cloud Agent Platform Registry |
## How The Agent Works

ReefWatch AI operates as a true multi-step autonomous agent:

**1. Continuous Data Ingestion**
Every night at 2am, the agent fetches fresh NOAA data for all 221 stations with a 200ms throttle between requests. Sea surface temperature, SST anomaly, and Degree Heating Weeks are cached locally.

**2. AI Risk Analysis**
For each actively monitored reef, Gemini 2.5 Flash receives structured NOAA data and produces a risk assessment with confidence score (0–100), threat classification, and recommended conservation actions.

**3. Full Observability**
Every Gemini call is automatically traced by OpenInference instrumentation and logged to Arize Phoenix with input, output, latency, and token usage metadata. 3,392+ traces logged.

**4. Phoenix MCP Runtime Introspection**
The agent is configured with the Phoenix MCP server as callable function tools. When the self-improvement loop runs — or when a researcher asks about system performance — the agent calls `query_phoenix_traces` and `query_phoenix_quality_metrics` at runtime, retrieving its own operational data to inform its reasoning. This closes the loop: the agent doesn't just produce data for observability. It reads that data back and uses it.

**5. Self-Improvement Loop

ReefWatch AI includes a production-grade autonomous improvement pipeline.

Instead of blindly rewriting prompts, the system:

- Evaluates real reef assessments using Gemini as an LLM-as-a-Judge

- Builds benchmark datasets from production traces

- Diagnoses weaknesses using Phoenix observability data

- Generates candidate prompt improvements

- Runs controlled benchmark experiments

- Promotes only improvements that outperform production

- Rejects regressions automatically

- Records every decision in a persistent audit trail

This creates a safe, measurable feedback loop where improvements must be earned through evaluation rather than assumed.

**6. Autonomous Alerting**
A Cloud Scheduler health ping keeps the service warm every 4 minutes. When bleaching thresholds are crossed, email alerts fire automatically with pre-generated conservation briefs attached.

---
## Arize Phoenix Integration

ReefWatch AI uses Arize Phoenix as the observability and evaluation backbone of the system.

### Production Tracing

Every Gemini-powered reef assessment is traced through OpenInference and sent to Phoenix Cloud. This provides:

- End-to-end LLM observability
- Latency monitoring
- Token usage tracking
- Error rate monitoring
- Runtime tool call visibility
- Historical performance analysis

More than 3,000 production traces have been collected and analyzed.

### Phoenix MCP Runtime Introspection

Phoenix is not used only for monitoring.

The Researcher Workspace can query Phoenix at runtime through Phoenix MCP tools.

When researchers ask operational questions such as:

> "What is the current error rate?"
>
> "How has model quality changed recently?"

The agent calls Phoenix MCP tools directly and reasons over its own operational data.

This allows the agent to inspect its own behavior while generating responses.

### LLM-as-a-Judge Evaluation

Phoenix evaluation data powers ReefWatch AI's quality scoring pipeline.

Recent reef assessments are evaluated across:

- Accuracy
- Specificity
- Actionability
- Scientific Reliability
- DHW Interpretation
- Uncertainty Communication
- Hallucination Avoidance

These scores are stored and tracked over time, allowing the system to detect regressions automatically.

### Autonomous Improvement Pipeline

Phoenix traces are converted into benchmark cases built from real production activity.

The improvement cycle:

1. Observe production traces
2. Extract benchmark datasets
3. Diagnose failure patterns
4. Generate candidate prompt improvements
5. Run controlled benchmark experiments
6. Compare candidate vs production prompt
7. Promote only if performance improves
8. Record the decision in an audit trail

Candidate prompts must outperform the production prompt by more than 1% while exceeding quality thresholds before promotion is allowed.

Poor-performing candidates are automatically rejected.

### Auditability

Every improvement cycle creates a persistent audit record containing:

- Benchmark results
- Experiment outcomes
- Promotion decisions
- Rejection reasons
- Quality metrics
- Timestamped evaluation history

This ensures every change the system makes to itself is fully traceable.

---

## Judging Criteria Alignment (Arize Track)

| Criterion | How ReefWatch AI Addresses It |
|-----------|------------------------------|
| **Gemini Agent** | Built with Google Cloud ADK — official ADK Agent class registered in Agent Platform Registry. Researcher Workspace routes through ADK natively. Multi-step reasoning, autonomous alerting, 24/7 operation |
| **Phoenix Observability** | 3,392+ traces, LLM latency tracked, token usage visible, input/output logged, cache hit rate monitored |
| **MCP Integration** | Phoenix MCP wired as callable Gemini function tools. Agent queries its own traces at runtime. Every call logged with retrieved data |
| **Self-Improvement Loop** | LLM-as-a-Judge evaluates output quality nightly, rewrites prompts automatically when scores drop. Scores visible on dashboard |
| **Real-World Impact** | Live NOAA data, real email alerts firing for critical reefs, conservation briefs downloadable as PDF |

---

## Tech Stack

**Frontend**
- React 18 + TypeScript
- Vite
- Tailwind CSS
- @vis.gl/react-google-maps
- Custom glassmorphism design system

**AI Service**
- FastAPI (Python)
- Gemini 2.5 Flash
- google-generativeai SDK
- openinference-instrumentation-google-genai
- arize-phoenix-otel
- google-adk (Google Cloud Agent Development Kit)

**Observability**
- Arize Phoenix Cloud
- OpenInference (OpenTelemetry-compatible)
- Phoenix MCP Server (`@arizeai/phoenix-mcp`)

**Infrastructure**
- Google Cloud Run (AI service, min-instances=1)
- Firebase Hosting (frontend)
- Cloud Scheduler (health pings + nightly refresh)
- SQLite (local station cache)

**Data**
- NOAA Coral Reef Watch CoralTemp API
- NOAA Virtual Station Network (221 stations)

---

## Getting Started

### Prerequisites
- Node.js 18+
- Python 3.9+
- Google Maps API key
- Gemini API key (Google AI Studio)
- Arize Phoenix Cloud account (free at phoenix.arize.com)

### 1. Clone the repository
```bash
git clone https://github.com/MahroshAtif2005/ReefWatch-AI.git
cd ReefWatch-AI
```

### 2. Install frontend dependencies
```bash
npm install
```

### 3. Set up Python AI service
```bash
cd ai-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

### 4. Configure environment variables

Root `.env`:
VITE_GOOGLE_MAPS_KEY=your_google_maps_api_key

`ai-service/.env`:
GEMINI_API_KEY=your_gemini_api_key
PHOENIX_COLLECTOR_ENDPOINT=https://app.phoenix.arize.com/v1/traces
PHOENIX_API_KEY=your_phoenix_api_key

### 5. Start the AI service
```bash
cd ai-service
source .venv/bin/activate
uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

### 6. Start the frontend
```bash
npm run dev
```

### 7. Open the app
http://localhost:5173

---

## Environment Variables

| Variable | Service | Description |
|----------|---------|-------------|
| `VITE_GOOGLE_MAPS_KEY` | Frontend | Google Maps JavaScript API key |
| `GEMINI_API_KEY` | AI Service | Google AI Studio API key |
| `PHOENIX_COLLECTOR_ENDPOINT` | AI Service | Phoenix trace ingestion endpoint |
| `PHOENIX_API_KEY` | AI Service | Phoenix Cloud API key |

---

## Live Deployment

- **Frontend:** Firebase Hosting — https://project-9b3e2672-8819-4fa5-afe.web.app
- **AI Service:** Google Cloud Run — us-central1, min-instances=1
- **Observability:** Arize Phoenix Cloud — project reefwatch-ai

---

## Why Arize Phoenix Is Core, Not a Checkbox

Most agents use observability passively — emit traces, read them in a dashboard later.

ReefWatch AI uses Phoenix differently.

The agent calls query_phoenix_traces and query_phoenix_quality_metrics 
at runtime, mid-inference. It reads its own operational history and uses 
that data to inform its current reasoning. This is bidirectional:

Agent → Phoenix (traces logged)
Phoenix → Agent (traces queried as tool calls at runtime)

Without Phoenix, ReefWatch AI could generate reef assessments but would 
have no reliable way to know if those assessments were good, detect when 
they degraded, or improve them autonomously. Phoenix is not the monitoring 
layer. Phoenix is part of the decision-making layer.

Every MCP tool call is logged with timestamp, tool name, and retrieved data — 
visible in the Arize dashboard. Every self-improvement decision has a 
full audit trail. Every quality score is tracked over time.

This is what production-grade autonomous AI observability looks like 
when it's built in from the start, not bolted on at the end.

---

## License

MIT License — see [LICENSE](LICENSE) for details.

---

## Acknowledgments

- [NOAA Coral Reef Watch](https://coralreefwatch.noaa.gov) — for free, public global reef monitoring data
- [Google Gemini](https://deepmind.google/technologies/gemini/) — for AI reasoning capabilities  
- [Arize Phoenix](https://phoenix.arize.com) — for AI observability infrastructure
- Every marine biologist and conservation researcher working to protect what remains

---

*Coral reefs took thousands of years to build. ReefWatch AI exists to make sure we don't lose them in decades.*
