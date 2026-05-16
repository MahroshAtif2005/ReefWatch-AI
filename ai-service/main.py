import json
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import google.generativeai as genai
import httpx
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from google.api_core.exceptions import GoogleAPIError
from opentelemetry import trace
from phoenix.otel import register
from pydantic import BaseModel, Field

load_dotenv()

PHOENIX_PROJECT_NAME = "reefwatch-ai"
PHOENIX_ENDPOINT = os.getenv(
    "PHOENIX_COLLECTOR_ENDPOINT",
    "https://app.phoenix.arize.com/v1/traces",
)
GEMINI_MODEL_NAME = "gemini-2.5-flash"
REEFWATCH_API_URL = os.getenv(
    "REEFWATCH_API_URL",
    "http://localhost:4000/api/reefs/live",
)

app = FastAPI(title="ReefWatch AI Service", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:4000",
        "http://127.0.0.1:4000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

phoenix_connected = False
gemini_connected = False
tracer = trace.get_tracer(__name__)


class ReefAnalysisRequest(BaseModel):
    reef_name: str
    lat: float
    lng: float
    sst: Optional[float] = None
    anomaly: Optional[float] = None
    dhw: Optional[float] = None
    alert_level: Optional[str] = None


class BriefRequest(BaseModel):
    reef_id: str
    reef_name: str
    sst: Optional[float] = None
    anomaly: Optional[float] = None
    dhw: Optional[float] = None
    alert_level: Optional[str] = None
    risk_score: Optional[int] = None


class ChatRequest(BaseModel):
    message: str
    conversation_history: List[Dict[str, Any]] = Field(default_factory=list)
    reef_context: Optional[Dict[str, Any]] = None


def configure_phoenix() -> None:
    global phoenix_connected
    api_key = os.getenv("PHOENIX_API_KEY")

    if not api_key:
        print("[phoenix] PHOENIX_API_KEY missing; tracing is disabled locally")
        return

    register(
        project_name=PHOENIX_PROJECT_NAME,
        endpoint=PHOENIX_ENDPOINT,
        headers={"api_key": api_key},
    )
    phoenix_connected = True
    print(f"[phoenix] tracing enabled for project {PHOENIX_PROJECT_NAME}")


def configure_gemini() -> None:
    global gemini_connected
    try:
        genai.configure(api_key=os.environ["GEMINI_API_KEY"])
        gemini_connected = True
        print(f"[gemini] configured model={GEMINI_MODEL_NAME}")
    except KeyError:
        gemini_connected = False
        print("[gemini] GEMINI_API_KEY missing from environment")


@app.on_event("startup")
async def startup() -> None:
    configure_phoenix()
    configure_gemini()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def require_gemini() -> genai.GenerativeModel:
    if not gemini_connected:
        raise HTTPException(
            status_code=503,
            detail="Gemini is not configured. Set GEMINI_API_KEY in ai-service/.env",
        )
    return genai.GenerativeModel(GEMINI_MODEL_NAME)


def strip_json_fences(text: str) -> str:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.removeprefix("```json").removeprefix("```").strip()
    if cleaned.endswith("```"):
        cleaned = cleaned[:-3].strip()
    return cleaned


def generate_text(prompt: str, *, json_only: bool = False) -> str:
    model = require_gemini()
    generation_config = None
    if json_only:
        generation_config = genai.GenerationConfig(response_mime_type="application/json")
    try:
        response = model.generate_content(prompt, generation_config=generation_config)
        return response.text.strip()
    except GoogleAPIError as error:
        raise HTTPException(
            status_code=503,
            detail=f"Gemini request failed: {error}",
        ) from error


def parse_json_response(text: str) -> Dict[str, Any]:
    try:
        return json.loads(strip_json_fences(text))
    except json.JSONDecodeError as error:
        raise HTTPException(
            status_code=502,
            detail=f"Gemini returned invalid JSON: {error}",
        ) from error


@app.post("/analyze-reef")
async def analyze_reef(payload: ReefAnalysisRequest) -> Dict[str, Any]:
    prompt = f"""
You are ReefWatch AI, an expert coral bleaching risk analyst.

Analyze this NOAA Coral Reef Watch condition snapshot and respond in JSON only.

Reef:
- name: {payload.reef_name}
- coordinates: {payload.lat}, {payload.lng}
- sea surface temperature: {payload.sst}
- SST anomaly: {payload.anomaly}
- degree heating weeks: {payload.dhw}
- bleaching alert level: {payload.alert_level}

Return exactly these JSON fields:
- risk_score: integer from 0 to 100
- risk_level: one of safe, warning, critical
- confidence: number from 0 to 1
- threat_summary: concise paragraph
- recommended_actions: array of exactly 3 concrete actions
- historical_context: concise paragraph
"""

    with tracer.start_as_current_span("reef.analyze"):
        result = parse_json_response(generate_text(prompt, json_only=True))
        return result


@app.post("/generate-brief")
async def generate_brief(payload: BriefRequest) -> Dict[str, Any]:
    prompt = f"""
Write a full conservation brief in markdown for this reef.

Use these exact sections:
## Executive Summary
## Current Conditions
## Risk Assessment
## Recommended Actions
## Urgency Level

Reef ID: {payload.reef_id}
Reef name: {payload.reef_name}
SST: {payload.sst}
SST anomaly: {payload.anomaly}
DHW: {payload.dhw}
Bleaching alert level: {payload.alert_level}
Risk score: {payload.risk_score}

Keep the brief practical for reef managers and conservation teams.
"""

    with tracer.start_as_current_span("reef.generate_brief"):
        brief = generate_text(prompt)
        return {
            "brief": brief,
            "reef_name": payload.reef_name,
            "generated_at": utc_now(),
        }


@app.post("/chat")
async def chat(payload: ChatRequest) -> Dict[str, Any]:
    data_need_prompt = f"""
Decide what reef monitoring data is needed to answer this user question.

Question: {payload.message}
Existing reef context: {json.dumps(payload.reef_context)}
Conversation history: {json.dumps(payload.conversation_history[-6:])}

Respond in JSON only with:
- data_needed: array of fields or reef names needed
- reasoning: short explanation
"""

    with tracer.start_as_current_span("chat.determine_data_need"):
        data_need = parse_json_response(generate_text(data_need_prompt, json_only=True))

    with tracer.start_as_current_span("chat.fetch_live_reef_data"):
        async with httpx.AsyncClient(timeout=35.0) as client:
            response = await client.get(REEFWATCH_API_URL)
            response.raise_for_status()
            live_reefs = response.json()

    answer_prompt = f"""
You are ReefWatch AI. Answer the user's question using the latest backend reef data.

Question: {payload.message}
Conversation history: {json.dumps(payload.conversation_history[-6:])}
Reef context: {json.dumps(payload.reef_context)}
Data need analysis: {json.dumps(data_need)}
Live reef data: {json.dumps(live_reefs)}

Respond in JSON only with:
- answer: helpful plain-language answer
- data_used: array of reef names or metrics used
- confidence: number from 0 to 1
- follow_up_suggestions: array of 3 short follow-up questions
"""

    with tracer.start_as_current_span("chat.answer_with_live_data"):
        return parse_json_response(generate_text(answer_prompt, json_only=True))


@app.post("/self-evaluate")
async def self_evaluate() -> Dict[str, Any]:
    api_key = os.getenv("PHOENIX_API_KEY")
    if not api_key:
        return {
            "average_score": 0,
            "traces_evaluated": 0,
            "low_quality_count": 0,
            "recommendations": [
                "Add PHOENIX_API_KEY to ai-service/.env to enable trace evaluation."
            ],
        }

    traces_url = PHOENIX_ENDPOINT.rstrip("/").replace("/v1/traces", "") + "/v1/traces"

    with tracer.start_as_current_span("self_evaluate.fetch_phoenix_traces"):
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(traces_url, headers={"api_key": api_key})
                response.raise_for_status()
                traces = response.json()
        except httpx.HTTPError as error:
            return {
                "average_score": 0,
                "traces_evaluated": 0,
                "low_quality_count": 0,
                "recommendations": [f"Unable to fetch Phoenix traces: {error}"],
            }

    evaluation_prompt = f"""
Evaluate these recent ReefWatch AI traces for accuracy, specificity, and actionability.

Traces:
{json.dumps(traces)[:12000]}

Respond in JSON only with:
- average_score: number from 0 to 100
- traces_evaluated: integer
- low_quality_count: integer
- recommendations: array of concise improvement recommendations
"""

    with tracer.start_as_current_span("self_evaluate.score_traces"):
        return parse_json_response(generate_text(evaluation_prompt, json_only=True))


@app.get("/health")
async def health() -> Dict[str, str]:
    return {
        "status": "ok",
        "phoenix": "connected" if phoenix_connected else "not_configured",
        "gemini": "connected" if gemini_connected else "not_configured",
    }


if __name__ == "__main__":
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
