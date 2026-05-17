# 🌊 ReefWatch AI
### Autonomous Coral Reef Intelligence Platform

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Powered by Gemini](https://img.shields.io/badge/Powered%20by-Gemini%202.5%20Flash-blue)](https://ai.google.dev)
[![NOAA Data](https://img.shields.io/badge/Data-NOAA%20Coral%20Reef%20Watch-green)](https://coralreefwatch.noaa.gov)
[![Arize Phoenix](https://img.shields.io/badge/Observability-Arize%20Phoenix-purple)](https://phoenix.arize.com)

---

## The Problem

Coral reefs cover less than 1% of the ocean floor — yet they support **25% of all marine life** and provide food, income, and coastal protection for over **1 billion people** worldwide. They are the rainforests of the sea: irreplaceable, ancient, and dying faster than we can understand why.

Since 1950, the world has lost **half of its coral reefs**. The primary killer is thermal stress — when ocean temperatures rise even 1°C above seasonal norms for several weeks, corals expel the algae living in their tissues, turn ghostly white, and begin to starve. This is bleaching. If the heat persists, they die.

The 2016 bleaching event destroyed **67% of coral in the northern Great Barrier Reef** in a single year. The 2023 global bleaching event — the fourth mass bleaching in recorded history — affected reefs across every ocean simultaneously.

Here is what makes this crisis particularly heartbreaking: **we often find out too late.**

Marine biologists and conservation teams are stretched impossibly thin. A researcher studying the Coral Triangle may not learn about a critical bleaching threshold being crossed in Raja Ampat until weeks after the damage becomes irreversible. The data exists — NOAA satellites monitor sea surface temperatures globally, 24 hours a day — but translating thousands of data points into actionable intelligence, for hundreds of reef sites, every single day, requires more human hours than the entire global conservation community can provide.

**ReefWatch AI was built to change that.**

---

## What ReefWatch AI Does

ReefWatch AI is an autonomous environmental intelligence agent that monitors coral reef health globally, analyzes thermal stress in real time using Gemini AI, and delivers actionable conservation briefings to researchers — automatically, continuously, and without requiring a single manual query.

It does not replace marine biologists. It gives them superpowers.

While a researcher sleeps, ReefWatch AI scans 214 NOAA monitoring stations across every ocean, identifies reefs approaching critical bleaching thresholds, reasons over the data using Gemini 2.5 Flash, and builds a prioritized list of which reefs need human attention today. When a threshold is crossed, it generates a full scientific conservation brief — complete with historical context, risk assessment, and recommended actions — ready to send to a funding body or conservation team.

Every AI decision is logged, monitored for quality, and evaluated using Arize Phoenix, ensuring the assessments the system produces are trustworthy, consistent, and improving over time.

---

## Key Features

### 🗺️ Live Global Reef Map
Interactive Google Maps visualization of 214 NOAA monitoring stations worldwide. Color-coded by real-time risk level (safe / warning / critical). Click any station to see live sea surface temperature, SST anomaly, Degree Heating Weeks, and AI-generated risk assessment. Researchers can promote any station to active AI monitoring with one click.

### 🤖 Gemini AI Risk Analysis
Every active reef is analyzed by Gemini 2.5 Flash using live NOAA data. The AI produces a structured assessment including risk score (0–100), confidence level, threat summary, recommended actions, and historical context — automatically, on every data refresh.

### 📋 Conservation Brief Generator
Select any monitored reef and generate a full scientific conservation brief in seconds. Gemini writes a multi-section document including executive summary, current conditions analysis, risk assessment with scientific context, recommended immediate actions, long-term conservation recommendations, and urgency level for funding bodies. Downloadable as PDF.

### 💬 Researcher Workspace
A natural language AI agent that answers complex research questions using live data. Ask "Which reefs in Southeast Asia are approaching critical thresholds?" or "Compare current conditions in the Coral Triangle to the 2016 bleaching event" — the agent fetches live data, reasons over it in multiple steps, and responds with specific findings, confidence scores, and suggested follow-up questions.

### 📊 Arize Phoenix Observability
Every AI inference is traced and logged to Arize Phoenix. Monitor LLM latency, token usage, confidence score distributions, and error rates in real time. The self-evaluation pipeline runs nightly, scoring past assessments for accuracy and specificity, and adjusts system prompts when quality drops below threshold.

### ⚡ Agent Activity Feed
Real-time log of all autonomous operations: NOAA data fetches, AI analyses, conservation briefs generated, batch refresh completions, and anomaly detections. Full operational transparency.

### 🔔 Custom Alert Configuration
Researchers configure temperature anomaly thresholds, select which reefs to monitor, and set email notification preferences. When a reef crosses a critical threshold, ReefWatch AI sends an automated alert with a pre-generated conservation brief attached.

### 📈 Historical Trends
Temperature trend charts for each monitored reef, powered by cached NOAA readings stored in SQLite. Track how conditions have evolved over days, weeks, and months.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    React Frontend                        │
│         (Vite + TypeScript + Tailwind + Google Maps)    │
└─────────────────────┬───────────────────────────────────┘
                      │ HTTP
┌─────────────────────▼───────────────────────────────────┐
│                 Node.js Backend                          │
│              (Express + SQLite + node-cron)             │
│                                                         │
│  • NOAA Coral Reef Watch API integration                │
│  • 214 station nightly batch refresh                    │
│  • SQLite: reefs, stations, traces, events              │
│  • Proxy layer to Python AI service                     │
└─────────────────────┬───────────────────────────────────┘
                      │ HTTP
┌─────────────────────▼───────────────────────────────────┐
│               Python AI Service                          │
│            (FastAPI + Gemini 2.5 Flash)                 │
│                                                         │
│  • /analyze-reef   → AI risk assessment                 │
│  • /generate-brief → Conservation report               │
│  • /chat           → Multi-step research agent         │
│  • /self-evaluate  → LLM-as-a-Judge quality pipeline   │
└─────────────────────┬───────────────────────────────────┘
                      │ OpenTelemetry traces
┌─────────────────────▼───────────────────────────────────┐
│               Arize Phoenix                              │
│         (AI Observability + Evaluation)                 │
│                                                         │
│  • Trace logging for every Gemini call                  │
│  • LLM latency, token usage, confidence tracking       │
│  • LLM-as-a-Judge evaluation pipeline                  │
│  • Self-improvement loop (nightly prompt refinement)   │
└─────────────────────────────────────────────────────────┘
```

---

## Data Sources

| Source | What It Provides | Update Frequency |
|--------|-----------------|-----------------|
| NOAA Coral Reef Watch CoralTemp | Sea surface temperature, SST anomaly, Degree Heating Weeks, bleaching alert level | Daily |
| NOAA Virtual Station Network | 214 global reef monitoring coordinates | Static |
| Gemini 2.5 Flash | AI risk assessment, conservation briefs, natural language Q&A | On demand |
| Arize Phoenix | AI trace logs, evaluation scores, performance metrics | Real-time |

---

## File Structure

```
ReefWatch AI/
│
├── src/                          # React frontend
│   ├── app/
│   │   ├── components/
│   │   │   ├── Dashboard/
│   │   │   │   └── DashboardOverview.tsx     # Global stats dashboard
│   │   │   ├── LiveReefGoogleMap.tsx         # Interactive map component
│   │   │   ├── ReefDetailPanel.tsx           # Reef click panel with AI analysis
│   │   │   ├── ConservationReports.tsx       # Report generator page
│   │   │   ├── ResearcherWorkspace.tsx       # AI chat agent page
│   │   │   ├── AgentActivity.tsx             # Real-time operations log
│   │   │   ├── ArizeMonitoring.tsx           # AI observability dashboard
│   │   │   ├── HistoricalTrends.tsx          # Temperature trend charts
│   │   │   ├── Settings.tsx                  # Alert configuration
│   │   │   ├── Header.tsx                    # Top navigation
│   │   │   └── Sidebar.tsx                   # Navigation sidebar
│   │   └── App.tsx
│   └── styles/
│       └── index.css                         # Global styles + glassmorphism
│
├── server/                       # Node.js backend
│   └── src/
│       ├── index.js              # Express app entry point
│       ├── database.js           # SQLite setup + schema
│       ├── routes/
│       │   ├── reefRoutes.js     # /api/reefs/* endpoints
│       │   ├── aiRoutes.js       # /api/ai/* proxy to Python
│       │   ├── arizeRoutes.js    # /api/arize/* trace endpoints
│       │   └── agentRoutes.js    # /api/agent/* activity log
│       ├── services/
│       │   ├── noaaService.js    # NOAA API integration
│       │   ├── stationService.js # 214-station cache management
│       │   ├── stationRefreshService.js  # Nightly batch refresh
│       │   └── arizeService.js   # Local trace logging
│       └── reefwatch.db          # SQLite database
│
├── ai-service/                   # Python AI service
│   ├── main.py                   # FastAPI app with all AI endpoints
│   ├── requirements.txt          # Python dependencies
│   ├── .env.example              # Environment variable template
│   └── prompts/
│       └── reef_analysis.txt     # Self-improving system prompt
│
├── .env                          # Root environment variables
├── package.json                  # Frontend dependencies
├── vite.config.ts                # Vite configuration
└── README.md
```

---

## Tech Stack

### Frontend
- **React 18** + **TypeScript** — component architecture
- **Vite** — build tooling
- **Tailwind CSS** — utility styling
- **@vis.gl/react-google-maps** — Google Maps integration
- **Custom glassmorphism design system** — dark teal ocean aesthetic

### Backend
- **Node.js** + **Express** — REST API server
- **better-sqlite3** — embedded database
- **node-cron** — scheduled nightly refresh
- **httpx** — HTTP client for NOAA API

### AI Service
- **FastAPI** — Python REST API
- **Gemini 2.5 Flash** — AI reasoning and generation
- **google-generativeai** — Gemini SDK
- **arize-phoenix-otel** — OpenTelemetry tracing
- **openinference-instrumentation-google-genai** — auto-instrumentation

### Observability
- **Arize Phoenix** — AI trace storage and evaluation
- **OpenInference** — OpenTelemetry-compatible instrumentation

### Data
- **NOAA Coral Reef Watch** — CoralTemp satellite data
- **NOAA Virtual Station Network** — 214 global monitoring points
- **SQLite** — local persistence for stations, traces, events

---

## Getting Started

### Prerequisites

- Node.js 18+
- Python 3.9+
- Google Cloud account (for Maps API)
- Gemini API key (Google AI Studio)

### 1. Clone the repository

```bash
git clone https://github.com/yourusername/reefwatch-ai.git
cd reefwatch-ai
```

### 2. Install frontend dependencies

```bash
npm install
```

### 3. Install backend dependencies

```bash
cd server
npm install
```

### 4. Set up Python AI service

```bash
cd ai-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

### 5. Configure environment variables

**Root `.env`:**
```env
VITE_GOOGLE_MAPS_KEY=your_google_maps_api_key
```

**`server/.env`:**
```env
PORT=4000
STATION_REFRESH_ON_STARTUP=true
```

**`ai-service/.env`:**
```env
GEMINI_API_KEY=your_gemini_api_key
PHOENIX_COLLECTOR_ENDPOINT=http://localhost:6006/v1/traces
```

### 6. Start Arize Phoenix (AI observability)

```bash
pip install arize-phoenix
python3 -m phoenix.server.main serve
# Dashboard available at http://localhost:6006
```

### 7. Start all services

Open four terminal tabs:

```bash
# Terminal 1 — Frontend
npm run dev

# Terminal 2 — Backend
cd server && npm run dev

# Terminal 3 — Python AI service
cd ai-service && source .venv/bin/activate && uvicorn main:app --host 127.0.0.1 --port 8000 --reload

# Terminal 4 — Phoenix (if not already running)
python3 -m phoenix.server.main serve
```

### 8. Open the app

```
http://localhost:5173
```

---

## Environment Variables Reference

| Variable | Service | Description |
|----------|---------|-------------|
| `VITE_GOOGLE_MAPS_KEY` | Frontend | Google Maps JavaScript API key |
| `GEMINI_API_KEY` | AI Service | Google AI Studio API key |
| `PHOENIX_COLLECTOR_ENDPOINT` | AI Service | Phoenix trace endpoint |
| `PHOENIX_API_KEY` | AI Service | Phoenix Cloud API key (optional) |
| `STATION_REFRESH_ON_STARTUP` | Backend | Auto-refresh stations on server start |
| `PORT` | Backend | Backend server port (default: 4000) |

---

## API Reference

### Backend (Node.js — port 4000)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/reefs/live` | Fetch 8 actively monitored reefs with live NOAA data |
| GET | `/api/reefs/stations` | Fetch all 214 NOAA station metadata |
| GET | `/api/reefs/stations/readings` | Fetch cached NOAA readings for all stations |
| POST | `/api/reefs/stations/refresh` | Trigger manual station data refresh |
| POST | `/api/reefs/monitor` | Add a station to active AI monitoring |
| POST | `/api/ai/analyze` | Run Gemini risk analysis on a reef |
| POST | `/api/ai/brief` | Generate full conservation brief |
| POST | `/api/ai/chat` | Multi-step research agent query |
| POST | `/api/ai/evaluate` | Run self-evaluation on recent traces |
| GET | `/api/arize/status` | Phoenix connection status |
| GET | `/api/arize/traces` | Recent AI inference traces |
| GET | `/api/agent/activity` | Real-time agent operations log |

### AI Service (Python — port 8000)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Service health check |
| POST | `/analyze-reef` | Gemini risk assessment |
| POST | `/generate-brief` | Full conservation brief generation |
| POST | `/chat` | Multi-step research agent |
| POST | `/self-evaluate` | LLM-as-a-Judge evaluation pipeline |

---

## How The AI Agent Works

ReefWatch AI operates as a true multi-step agent, not a single-call chatbot:

**1. Data Ingestion**
Every night at 2am, the backend fetches fresh NOAA data for all 214 stations with a 200ms throttle between requests to respect NOAA's servers.

**2. AI Analysis**
For each actively monitored reef, Gemini 2.5 Flash receives structured NOAA data and produces a risk assessment with confidence score, threat summary, and recommended actions.

**3. Observability**
Every Gemini call is automatically traced by OpenInference instrumentation and logged to Arize Phoenix with full input/output/latency metadata.

**4. Self-Evaluation**
Nightly, the self-evaluation pipeline queries Phoenix for recent traces, uses Gemini as an LLM-as-a-Judge to score each assessment on accuracy, specificity, and actionability, and refines the system prompt if average quality drops below 0.75.

**5. Conservation Briefs**
On demand, Gemini generates a full multi-section scientific brief for any reef, incorporating live NOAA data, historical context, and specific conservation recommendations.

**6. Research Chat**
The chat agent follows a multi-step reasoning chain: determine what data is needed → fetch live data → analyze with Gemini → synthesize response with citations.

---

## Judging Criteria Alignment

| Criterion | How ReefWatch AI Addresses It |
|-----------|-------------------------------|
| **Move Beyond Chat** | Autonomous nightly monitoring, alert generation, PDF report creation, email notifications |
| **Multi-Step Mission** | Chat agent executes 4-step reasoning chains; nightly pipeline chains NOAA fetch → AI analysis → Phoenix logging → self-evaluation |
| **Partner Power** | Deep Arize Phoenix integration: auto-instrumented traces, LLM-as-a-Judge evals, self-improvement loop, Phoenix MCP server |
| **Real-World Impact** | Addresses actual coral reef conservation crisis with real NOAA data |

---

## Screenshots

| Dashboard | Live Reef Map | Conservation Brief |
|-----------|--------------|-------------------|
| Global stats with live reef counts | 214 NOAA stations color-coded by risk | AI-generated scientific brief |

---

## Contributing

Contributions are welcome. Please open an issue first to discuss what you would like to change.

---

## License

MIT License — see [LICENSE](LICENSE) for details.

---

## Acknowledgments

- **NOAA Coral Reef Watch** for providing free, public global reef monitoring data
- **Google Gemini** for AI reasoning capabilities
- **Arize Phoenix** for AI observability infrastructure
- Every marine biologist and conservation researcher working to protect what remains of our coral reefs

---

<p align="center">
  Built for the Google Cloud Rapid Agent Hackathon 2026 — Arize Track<br>
  <em>"The ocean is the lifeblood of our planet. ReefWatch AI exists to protect it."</em>
</p>
