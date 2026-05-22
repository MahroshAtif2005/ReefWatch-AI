# ReefWatch AI Service

Local FastAPI service for Gemini-powered reef analysis and Phoenix tracing.

## Setup

```bash
cd ai-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Add your Gemini key to `ai-service/.env` when you are ready:

```bash
GEMINI_API_KEY=your_gemini_key
PHOENIX_PROJECT_NAME=reefwatch-ai
PHOENIX_COLLECTOR_ENDPOINT=http://127.0.0.1:6006/v1/traces
PHOENIX_UI_URL=http://127.0.0.1:6006
ARIZE_API_KEY=
ARIZE_SPACE_ID=
ARIZE_PROJECT_NAME=reefwatch-ai
ENABLE_FULL_LLM_TRACE=false
```

`ENABLE_FULL_LLM_TRACE` defaults to `false`. Keep it false for normal use so Phoenix stores prompt and response summaries only. Set it to `true` only during local development when you explicitly want full prompt/response payloads in spans.

## Run Phoenix Locally

Install Phoenix:

```bash
cd ai-service
source .venv/bin/activate
pip install arize-phoenix
```

Start the local Phoenix UI and collector:

```bash
phoenix start
```

Open Phoenix at:

```bash
http://127.0.0.1:6006
```

## Run AI Service

In a second terminal:

```bash
cd ai-service
source .venv/bin/activate
uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

The Node backend proxies AI requests through:

- `POST http://localhost:4000/api/ai/analyze`
- `POST http://localhost:4000/api/ai/brief`
- `POST http://localhost:4000/api/ai/chat`
- `POST http://localhost:4000/api/ai/evaluate`

Phoenix is optional at startup. `/health` reports Phoenix as `connected` only when `http://127.0.0.1:6006` is reachable.

To emit a simple test span:

```bash
curl http://127.0.0.1:8000/test-trace
```

Refresh Phoenix and look for the `reefwatch.test_trace` span in the `reefwatch-ai` project.

## Observability

`POST /analyze-reef` emits a parent `reef.analyze` span with nested spans for:

- `noaa.fetch`
- `reef.risk_calculation`
- `agent.environmental_analysis`
- `agent.risk_assessment`
- `agent.recommendation`
- `llm.gemini.generate`
- `response.build`

The service records reef attributes, NOAA payload metadata, LLM summaries, token counts when available, latency, success/failure state, fallback details, and exceptions via `span.record_exception`.

Runtime metrics for the frontend monitoring page are available at:

```bash
curl http://127.0.0.1:8000/observability/metrics
```

The Node backend proxies that through:

```bash
curl http://127.0.0.1:4000/api/ai/observability/metrics
```
