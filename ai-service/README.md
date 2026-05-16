# ReefWatch AI Service

Local FastAPI service for Vertex AI Gemini-powered reef analysis and Phoenix tracing.

## Setup

```bash
cd ai-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Authenticate Vertex AI with your local Google Cloud credentials:

```bash
gcloud auth application-default login
gcloud config set project project-9b3e2672-8819-4fa5-afe
```

Add Phoenix tracing credentials to `ai-service/.env` when you are ready:

```bash
PHOENIX_API_KEY=your_phoenix_key
PHOENIX_COLLECTOR_ENDPOINT=https://app.phoenix.arize.com/v1/traces
```

## Run

```bash
uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

The Node backend proxies AI requests through:

- `POST http://localhost:4000/api/ai/analyze`
- `POST http://localhost:4000/api/ai/brief`
- `POST http://localhost:4000/api/ai/chat`
- `POST http://localhost:4000/api/ai/evaluate`

Phoenix is optional at startup. Vertex AI uses `gcloud` application-default credentials; if local Google Cloud auth is unavailable, Gemini endpoints return a clean setup error instead of crashing.
