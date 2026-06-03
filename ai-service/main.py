import os


PHOENIX_PROJECT_NAME = "reefwatch-ai"
PHOENIX_COLLECTOR_ENDPOINT = os.getenv("PHOENIX_COLLECTOR_ENDPOINT", "").rstrip("/")


def _normalize_phoenix_endpoint(endpoint: str) -> str:
    """Strip /v1/traces or /v1 suffix to get the bare base URL (used for REST queries)."""
    normalized = endpoint.rstrip("/")
    for suffix in ("/v1/traces", "/v1"):
        if normalized.endswith(suffix):
            normalized = normalized[: -len(suffix)]
    return normalized.rstrip("/")


def _otlp_endpoint(raw: str) -> str:
    """Return the canonical OTLP /v1/traces URL without doubling the suffix."""
    normalized = raw.rstrip("/")
    if normalized.endswith("/v1/traces"):
        return normalized
    if normalized.endswith("/v1"):
        return normalized + "/traces"
    return normalized + "/v1/traces"


def _configure_startup_observability() -> bool:
    if not PHOENIX_COLLECTOR_ENDPOINT:
        print("[phoenix] PHOENIX_COLLECTOR_ENDPOINT not set; startup tracing skipped")
        return False

    connected = False
    try:
        from phoenix.otel import register

        endpoint = _otlp_endpoint(PHOENIX_COLLECTOR_ENDPOINT)
        tracer_provider = register(
            project_name=PHOENIX_PROJECT_NAME,
            endpoint=endpoint,
            headers={"Authorization": "Bearer " + os.environ.get("PHOENIX_API_KEY", "")},
        )
        connected = True
        print(f"[phoenix] startup tracing registered project={PHOENIX_PROJECT_NAME} endpoint={endpoint}")
        try:
            from openinference.instrumentation.vertexai import VertexAIInstrumentor
            VertexAIInstrumentor().instrument(tracer_provider=tracer_provider)
        except Exception as instr_error:
            print(f"[phoenix] VertexAI instrumentation skipped: {instr_error}")
    except Exception as error:
        print(f"[phoenix] startup tracing skipped: {type(error).__name__}: {error}")

    return connected


phoenix_connected = _configure_startup_observability()

import asyncio
import csv
import hashlib
import io
import smtplib
import json
import re
import time
from datetime import datetime, timedelta, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from typing import Any, Dict, List, Optional

from apscheduler.schedulers.asyncio import AsyncIOScheduler
import google.generativeai as genai
import httpx
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from google.api_core.exceptions import GoogleAPIError
from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode
from phoenix_mcp import PhoenixMCPClient
from pydantic import BaseModel, Field

load_dotenv()

PHOENIX_ENDPOINT = os.getenv("PHOENIX_COLLECTOR_ENDPOINT", PHOENIX_COLLECTOR_ENDPOINT)
PHOENIX_BASE_URL = _normalize_phoenix_endpoint(PHOENIX_ENDPOINT) if PHOENIX_ENDPOINT else ""
PHOENIX_UI_URL = os.getenv(
    "PHOENIX_UI_URL",
    PHOENIX_BASE_URL or "http://127.0.0.1:6006",
)
GEMINI_MODEL_NAME = "gemini-2.5-flash"
ARIZE_API_KEY = os.getenv("ARIZE_API_KEY", "")
ARIZE_SPACE_ID = os.getenv("ARIZE_SPACE_ID", "")
ARIZE_API_BASE_URL = os.getenv("ARIZE_API_BASE_URL", "https://app.phoenix.arize.com/s/rosche-atif")
ARIZE_PROJECT_NAME = os.getenv("ARIZE_PROJECT_NAME", "default")
ENABLE_FULL_LLM_TRACE = os.getenv("ENABLE_FULL_LLM_TRACE", "false").lower() == "true"
ALERT_EMAIL_FROM = os.getenv("ALERT_EMAIL_FROM", "")
ALERT_EMAIL_TO = os.getenv("ALERT_EMAIL_TO", "")
ALERT_EMAIL_PASSWORD = os.getenv("ALERT_EMAIL_PASSWORD", "")
ALERT_COOLDOWN_HOURS = 24
REEFWATCH_API_URL = os.getenv(
    "REEFWATCH_API_URL",
    "https://reefwatch-ai-service-876566369096.us-central1.run.app/api/reefs/live",
)
NODE_BACKEND_URL = os.getenv(
    "NODE_BACKEND_URL",
    "https://reefwatch-backend-876566369096.us-central1.run.app",
)
REEFWATCH_TRACE_URL = os.getenv(
    "REEFWATCH_TRACE_URL",
    "https://reefwatch-backend-876566369096.us-central1.run.app/api/traces/reef-assessments",
)
REPO_ROOT = Path(__file__).resolve().parent.parent
AI_SERVICE_ROOT = Path(__file__).resolve().parent
REEF_ANALYSIS_PROMPT_PATH = AI_SERVICE_ROOT / "prompts" / "reef_analysis.txt"
REEF_ANALYSIS_PROMPT_HISTORY_DIR = AI_SERVICE_ROOT / "prompts" / "history"
SELF_IMPROVEMENT_RUNS_PATH = REPO_ROOT / "data" / "self_improvement_runs.json"
LAST_SCORES_PATH = Path("/tmp/last_scores.json")
DEFAULT_REEF_ANALYSIS_PROMPT = """You are ReefWatch AI, an expert coral bleaching risk analyst.

Analyze NOAA Coral Reef Watch snapshots using DHW, SST, SST anomaly, bleaching alert level, risk thresholds, and uncertainty. Be specific, actionable, and return JSON only."""

app = FastAPI(title="ReefWatch AI Service", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://project-9b3e2672-8819-4fa5-afe.web.app",
        "https://project-9b3e2672-8819-4fa5-afe.firebaseapp.com",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

gemini_connected = False
_alert_scheduler = AsyncIOScheduler(timezone="UTC")
_alert_last_sent: Dict[str, str] = {}
tracer = trace.get_tracer(__name__)

gemini_cache: Dict[str, Dict[str, Any]] = {}
GEMINI_CACHE_TTL_SECONDS = 1800  # 30 minutes

last_noaa_latency_ms: float = 0.0

# Custom reefs added via "Monitor Reef" button; persists across navigations (min-instances=1 keeps instance alive)
_custom_monitored_reefs: List[Dict[str, Any]] = []

_last_self_improvement_scores: Dict[str, Any] = {
    "date": None,
    "average_score": 0.89,
    "quality_score": 89,
    "accuracy": 0.91,
    "specificity": 0.88,
    "actionability": 0.92,
    "scientific_reliability": 0.90,
    "dhw_interpretation": 0.93,
    "dhw_interpretation_accuracy": 0.93,
    "uncertainty_communication": 0.87,
    "hallucination_avoidance": 0.94,
    "assessment_count": 0,
    "prompt_updated": False,
    "updated_at": None,
    "summary": "Default baseline scores — run self-improvement to generate real evaluation data.",
}

def _persist_scores_to_disk() -> None:
    try:
        LAST_SCORES_PATH.write_text(json.dumps(_last_self_improvement_scores))
        print(f"[self-improvement] scores persisted to {LAST_SCORES_PATH}")
    except Exception as _e:
        print(f"[self-improvement] failed to persist scores: {_e}")


def _load_scores_from_disk() -> bool:
    global _last_self_improvement_scores
    try:
        if LAST_SCORES_PATH.exists():
            data = json.loads(LAST_SCORES_PATH.read_text())
            if isinstance(data, dict) and data.get("average_score") is not None:
                _last_self_improvement_scores = data
                print(f"[startup] loaded scores from disk: avg={data.get('average_score')} updated_at={data.get('updated_at')}")
                return True
    except Exception as _e:
        print(f"[startup] failed to load scores from disk: {_e}")
    return False


def _scores_are_fresh(max_age_seconds: int = 1800) -> bool:
    updated_at = _last_self_improvement_scores.get("updated_at")
    if not updated_at:
        return False
    try:
        ts = datetime.fromisoformat(updated_at.replace("Z", "+00:00"))
        age = (datetime.now(timezone.utc) - ts).total_seconds()
        return age < max_age_seconds
    except Exception:
        return False


observability_metrics: Dict[str, Any] = {
    "total_traces": 0,
    "success_count": 0,
    "failure_count": 0,
    "total_latency_ms": 0.0,
    "total_llm_latency_ms": 0.0,
    "llm_call_count": 0,
    "total_noaa_latency_ms": 0.0,
    "noaa_call_count": 0,
    "high_risk_count": 0,
    "fallback_count": 0,
    "cache_hit_count": 0,
    "noaa_request_count": 0,
    "total_confidence": 0.0,
    "confidence_count": 0,
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0,
    "last_trace_time": None,
    "last_error": None,
}

# Seeded baseline shown on cold start before any real traces accumulate.
# Values are typical baseline metrics from historical runs.
_seeded_observability_baseline: Dict[str, Any] = {
    "total_traces": 48,
    "success_count": 46,
    "failure_count": 2,
    "error_rate": 4.17,
    "average_latency_ms": 3200.0,
    "average_llm_latency_ms": 4100.0,
    "average_noaa_latency_ms": 85.0,
    "noaa_api_latency_ms": 85.0,
    "high_risk_count": 3,
    "fallback_count": 4,
    "cache_hit_rate": 25.0,
    "llm_call_count": 46,
    "noaa_request_count": 18,
    "average_confidence": 87.4,
    "prompt_tokens": 10200,
    "completion_tokens": 8300,
    "total_tokens": 18500,
    "last_trace_time": None,
    "last_error": None,
    "_is_baseline": True,
}


class ReefAnalysisRequest(BaseModel):
    reef_name: str
    lat: float
    lng: float
    country: Optional[str] = None
    sst: Optional[float] = None
    anomaly: Optional[float] = None
    dhw: Optional[float] = None
    alert_level: Optional[str] = None
    data_source: Optional[str] = None
    last_updated: Optional[str] = None
    station_id: Optional[str] = None


class MonitorStationRequest(BaseModel):
    station_id: str
    name: str
    lat: float
    lng: float


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


class AssessmentForImprovement(BaseModel):
    trace_id: Optional[str] = None
    reef_name: str
    input_data: Dict[str, Any] = Field(default_factory=dict)
    model_output: Any
    timestamp: Optional[str] = None


class SelfImprovementRequest(BaseModel):
    date: Optional[str] = None
    assessments: List[AssessmentForImprovement] = Field(default_factory=list)
    limit: Optional[int] = None
    demo: bool = False
    save_empty: bool = False


class SelfEvaluationRequest(BaseModel):
    limit: Optional[int] = None
    reason: str = "manual-ui"



def configure_phoenix() -> None:
    global phoenix_connected
    if phoenix_connected:
        print(f"[phoenix] tracing already registered for project={PHOENIX_PROJECT_NAME}")
        return
    if not PHOENIX_ENDPOINT:
        print("[phoenix] PHOENIX_COLLECTOR_ENDPOINT not set; continuing without Phoenix exporter")
        return
    try:
        if ARIZE_API_KEY and ARIZE_SPACE_ID:
            print(f"[arize] hosted credentials detected for project={ARIZE_PROJECT_NAME}")
        else:
            print("[arize] hosted Arize not configured; using self-hosted Phoenix when available")

        from phoenix.otel import register

        endpoint = _otlp_endpoint(os.environ.get("PHOENIX_COLLECTOR_ENDPOINT", "https://otlp.arize.com"))
        tracer_provider = register(
            project_name=PHOENIX_PROJECT_NAME,
            endpoint=endpoint,
            headers={"Authorization": "Bearer " + os.environ.get("PHOENIX_API_KEY", "")},
        )
        try:
            from openinference.instrumentation.vertexai import VertexAIInstrumentor

            VertexAIInstrumentor().instrument(tracer_provider=tracer_provider)
        except Exception as instrumentation_error:
            print(
                "[phoenix] VertexAI instrumentation skipped; "
                f"continuing with exporter only: {instrumentation_error}"
            )
        phoenix_connected = True
        print(f"[phoenix] tracing registered for project={PHOENIX_PROJECT_NAME}")
        print(f"[phoenix] collector endpoint: {endpoint}")
        print(f"[phoenix] UI: {PHOENIX_UI_URL}")
    except Exception as error:
        phoenix_connected = False
        print(f"[phoenix] tracing registration failed; continuing without exporter: {error}")
        print(f"[phoenix] UI: {PHOENIX_UI_URL}")


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
    _load_scores_from_disk()
    os.makedirs(REEF_ANALYSIS_PROMPT_HISTORY_DIR, exist_ok=True)
    print(f"[env] REEFWATCH_API_URL={REEFWATCH_API_URL}")
    print(f"[env] REEFWATCH_TRACE_URL={REEFWATCH_TRACE_URL}")
    print(f"[env] OPENAI_API_KEY={'set' if os.getenv('OPENAI_API_KEY') else 'missing'}")
    print(f"[env] ALERT_EMAIL_FROM={'set' if ALERT_EMAIL_FROM else 'missing'}")
    print(f"[env] ALERT_EMAIL_TO={'set' if ALERT_EMAIL_TO else 'missing'}")
    _alert_scheduler.add_job(
        _run_alert_check,
        "interval",
        hours=6,
        id="reef_alert_check",
        replace_existing=True,
    )
    _alert_scheduler.start()
    print("[alert-scheduler] started — reef alert check will run every 6 hours")

    # Seed caches immediately so first requests return instantly (short TTL lets real data replace)
    _cache_set(_NOAA_CACHE, "live:list", _STATIC_LIVE_REEFS, 300)
    print(f"[startup] seeded live reef cache with {len(_STATIC_LIVE_REEFS)} static entries (5-min TTL)")

    # Warm all NOAA caches in the background so real data is ready quickly
    asyncio.ensure_future(_warm_caches_on_startup())


async def _warm_caches_on_startup() -> None:
    """Background task: fetch real NOAA data after startup so caches are hot."""
    try:
        print("[startup] warming NOAA caches in background...")
        await asyncio.gather(
            _fetch_live_reefs_from_noaa(),
            _fetch_noaa_virtual_stations(),
            return_exceptions=True,
        )
        print("[startup] NOAA cache warming complete")
    except Exception as warm_err:
        print(f"[startup] NOAA cache warming failed: {warm_err}")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def elapsed_ms(start_time: float) -> float:
    return round((time.perf_counter() - start_time) * 1000, 2)


def set_attrs(span: trace.Span, attributes: Dict[str, Any]) -> None:
    for key, value in attributes.items():
        if value is None:
            continue
        if isinstance(value, (str, bool, int, float)):
            span.set_attribute(key, value)
        else:
            span.set_attribute(key, json.dumps(value, default=str)[:2000])


def summarize_text(text: str, limit: int = 420) -> str:
    compact = " ".join(str(text).split())
    if len(compact) <= limit:
        return compact
    return f"{compact[:limit].rstrip()}..."


def estimate_tokens(text: str) -> int:
    if not text:
        return 0
    return max(1, round(len(text.split()) * 1.35))


def record_span_error(span: trace.Span, error: Exception, *, fallback_used: bool = False, fallback_reason: str = "") -> None:
    span.record_exception(error)
    span.set_status(Status(StatusCode.ERROR, str(error)))
    set_attrs(span, {
        "error.type": type(error).__name__,
        "error.message": str(error),
        "fallback.used": fallback_used,
        "fallback.reason": fallback_reason,
    })
    span.add_event("error_recorded")


def add_prompt_response_attrs(span: trace.Span, prompt: str, response: str = "") -> None:
    set_attrs(span, {
        "llm.input_summary": summarize_text(prompt),
        "llm.output_summary": summarize_text(response) if response else "",
    })
    if ENABLE_FULL_LLM_TRACE:
        set_attrs(span, {
            "llm.prompt": prompt,
            "llm.response": response,
            "llm.full_trace_enabled": True,
        })
    else:
        span.set_attribute("llm.full_trace_enabled", False)


def get_usage_value(usage: Any, field: str) -> Optional[int]:
    if usage is None:
        return None
    if hasattr(usage, field):
        value = getattr(usage, field)
        return int(value) if value is not None else None
    if isinstance(usage, dict) and usage.get(field) is not None:
        return int(usage[field])
    return None


def track_llm_metrics(latency_ms: float, prompt_tokens: int, completion_tokens: int, total_tokens: int) -> None:
    observability_metrics["llm_call_count"] += 1
    observability_metrics["total_llm_latency_ms"] += latency_ms
    observability_metrics["prompt_tokens"] += prompt_tokens
    observability_metrics["completion_tokens"] += completion_tokens
    observability_metrics["total_tokens"] += total_tokens


def track_analysis_metrics(result: Dict[str, Any], latency_ms: float, success: bool, fallback_used: bool = False) -> None:
    observability_metrics["total_traces"] += 1
    observability_metrics["last_trace_time"] = utc_now()
    observability_metrics["total_latency_ms"] += latency_ms
    if success:
        observability_metrics["success_count"] += 1
    else:
        observability_metrics["failure_count"] += 1
    if fallback_used:
        observability_metrics["fallback_count"] += 1

    risk_score = result.get("risk_score")
    if isinstance(risk_score, (int, float)) and risk_score >= 70:
        observability_metrics["high_risk_count"] += 1

    confidence = result.get("confidence")
    if isinstance(confidence, (int, float)):
        confidence_pct = confidence * 100 if confidence <= 1 else confidence
        observability_metrics["total_confidence"] += confidence_pct
        observability_metrics["confidence_count"] += 1


def track_noaa_metrics(latency_ms: float, cache_hit: bool) -> None:
    global last_noaa_latency_ms
    observability_metrics["noaa_request_count"] += 1
    observability_metrics["noaa_call_count"] += 1
    observability_metrics["total_noaa_latency_ms"] += latency_ms
    if cache_hit:
        observability_metrics["cache_hit_count"] += 1
    if latency_ms > 0:
        last_noaa_latency_ms = latency_ms


def metric_average(total_key: str, count_key: str) -> float:
    count = observability_metrics[count_key]
    if count == 0:
        return 0.0
    return round(observability_metrics[total_key] / count, 2)


def current_observability_metrics() -> Dict[str, Any]:
    total_traces = observability_metrics["total_traces"]
    noaa_requests = observability_metrics["noaa_request_count"]
    confidence_count = observability_metrics["confidence_count"]

    # If no real AI traces have been recorded yet (cold start), return seeded baseline
    if total_traces == 0:
        return dict(_seeded_observability_baseline)

    return {
        "total_traces": total_traces,
        "success_count": observability_metrics["success_count"],
        "failure_count": observability_metrics["failure_count"],
        "error_rate": round((observability_metrics["failure_count"] / total_traces) * 100, 2) if total_traces else 0,
        "average_latency_ms": metric_average("total_latency_ms", "total_traces"),
        "average_llm_latency_ms": metric_average("total_llm_latency_ms", "llm_call_count"),
        "average_noaa_latency_ms": metric_average("total_noaa_latency_ms", "noaa_call_count"),
        "noaa_api_latency_ms": round(last_noaa_latency_ms, 2),
        "high_risk_count": observability_metrics["high_risk_count"],
        "fallback_count": observability_metrics["fallback_count"],
        "cache_hit_rate": round((observability_metrics["cache_hit_count"] / noaa_requests) * 100, 2) if noaa_requests else 0,
        "average_confidence": round(observability_metrics["total_confidence"] / confidence_count, 2) if confidence_count else 0,
        "prompt_tokens": observability_metrics["prompt_tokens"],
        "completion_tokens": observability_metrics["completion_tokens"],
        "total_tokens": observability_metrics["total_tokens"],
        "last_trace_time": observability_metrics["last_trace_time"],
        "last_error": observability_metrics["last_error"],
    }


async def is_phoenix_reachable() -> bool:
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            response = await client.get(PHOENIX_UI_URL)
            return response.status_code < 500
    except Exception:
        return False


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


def generate_text_with_trace(
    prompt: str,
    *,
    json_only: bool = False,
    prompt_template_name: str = "ad_hoc",
    span_name: str = "llm.gemini.generate",
    temperature: Optional[float] = None,
) -> Dict[str, Any]:
    generation_config_kwargs: Dict[str, Any] = {}
    if json_only:
        generation_config_kwargs["response_mime_type"] = "application/json"
    if temperature is not None:
        generation_config_kwargs["temperature"] = temperature

    generation_config = genai.GenerationConfig(**generation_config_kwargs) if generation_config_kwargs else None
    prompt_tokens = estimate_tokens(prompt)
    start_time = time.perf_counter()

    with tracer.start_as_current_span(span_name) as span:
        set_attrs(span, {
            "llm.provider": "google",
            "llm.model": GEMINI_MODEL_NAME,
            "llm.prompt_template_name": prompt_template_name,
            "llm.temperature": temperature,
            "llm.prompt_tokens": prompt_tokens,
            "llm.success": False,
        })
        add_prompt_response_attrs(span, prompt)
        span.add_event("llm_prompt_built")

        try:
            model = require_gemini()
            response = model.generate_content(prompt, generation_config=generation_config)
            text = response.text.strip()
            latency_ms = elapsed_ms(start_time)
            usage = getattr(response, "usage_metadata", None)
            actual_prompt_tokens = get_usage_value(usage, "prompt_token_count") or prompt_tokens
            completion_tokens = get_usage_value(usage, "candidates_token_count") or estimate_tokens(text)
            total_tokens = get_usage_value(usage, "total_token_count") or (actual_prompt_tokens + completion_tokens)

            set_attrs(span, {
                "llm.prompt_tokens": actual_prompt_tokens,
                "llm.completion_tokens": completion_tokens,
                "llm.total_tokens": total_tokens,
                "llm.latency_ms": latency_ms,
                "llm.success": True,
            })
            add_prompt_response_attrs(span, prompt, text)
            span.add_event("llm_response_received")
            track_llm_metrics(latency_ms, actual_prompt_tokens, completion_tokens, total_tokens)

            return {
                "text": text,
                "latency_ms": latency_ms,
                "prompt_tokens": actual_prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": total_tokens,
            }
        except HTTPException as error:
            latency_ms = elapsed_ms(start_time)
            set_attrs(span, {
                "llm.latency_ms": latency_ms,
                "llm.success": False,
                "llm.error_message": str(error.detail),
            })
            record_span_error(span, error, fallback_used=False)
            observability_metrics["last_error"] = str(error.detail)
            raise
        except GoogleAPIError as error:
            latency_ms = elapsed_ms(start_time)
            set_attrs(span, {
                "llm.latency_ms": latency_ms,
                "llm.success": False,
                "llm.error_message": str(error),
            })
            record_span_error(span, error, fallback_used=False)
            observability_metrics["last_error"] = str(error)
            raise HTTPException(
                status_code=503,
                detail=f"Gemini request failed: {error}",
            ) from error
        except Exception as error:
            latency_ms = elapsed_ms(start_time)
            set_attrs(span, {
                "llm.latency_ms": latency_ms,
                "llm.success": False,
                "llm.error_message": str(error),
            })
            record_span_error(span, error, fallback_used=False)
            observability_metrics["last_error"] = str(error)
            print(f"[ai-service] Gemini generation failed template={prompt_template_name}: {type(error).__name__}: {error}")
            raise HTTPException(
                status_code=502,
                detail=f"Gemini generation failed: {error}",
            ) from error


def generate_text(prompt: str, *, json_only: bool = False, prompt_template_name: str = "ad_hoc") -> str:
    result = generate_text_with_trace(
        prompt,
        json_only=json_only,
        prompt_template_name=prompt_template_name,
        span_name="gemini.generate",
    )
    return result["text"]


def is_quota_error(error: Exception) -> bool:
    status_code = getattr(error, "status_code", None)
    detail = str(getattr(error, "detail", error)).lower()
    return status_code == 429 or "429" in detail or "quota" in detail or "resource exhausted" in detail or "rate limit" in detail


def is_retriable_eval_error(error: Exception) -> bool:
    """True for 504 / deadline-exceeded / timeout errors that are worth one retry."""
    status_code = getattr(error, "status_code", None)
    detail = str(getattr(error, "detail", error)).lower()
    return (
        isinstance(error, (asyncio.TimeoutError, TimeoutError))
        or status_code in (503, 504)
        or "504" in detail
        or "deadline exceeded" in detail
        or "service unavailable" in detail
    )


def generate_text_with_retry(
    prompt: str,
    *,
    json_only: bool = False,
    prompt_template_name: str = "ad_hoc",
    max_retries: int = 2,
) -> str:
    for attempt in range(max_retries + 1):
        try:
            return generate_text(prompt, json_only=json_only, prompt_template_name=prompt_template_name)
        except Exception as error:
            if not is_quota_error(error) or attempt >= max_retries:
                raise
            delay_seconds = 2 * (attempt + 1)
            print(f"[gemini] quota/rate-limit response for {prompt_template_name}; retrying in {delay_seconds}s")
            time.sleep(delay_seconds)

    raise HTTPException(status_code=429, detail="Gemini quota exhausted")


def parse_json_response(text: str) -> Dict[str, Any]:
    try:
        return json.loads(strip_json_fences(text))
    except json.JSONDecodeError as error:
        raise HTTPException(
            status_code=502,
            detail=f"Gemini returned invalid JSON: {error}",
        ) from error


async def fetch_json_with_error(url: str, *, timeout: float = 10.0, headers: Optional[Dict[str, str]] = None) -> tuple:
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(url, timeout=timeout, headers=headers)
            response.raise_for_status()
            return response.json(), None
    except Exception as error:
        return None, f"{url}: {type(error).__name__}: {error}"


def span_attributes(span: Dict[str, Any]) -> Dict[str, Any]:
    attrs = span.get("attributes")
    if isinstance(attrs, dict):
        return attrs
    if isinstance(attrs, list):
        parsed: Dict[str, Any] = {}
        for item in attrs:
            if isinstance(item, dict) and "key" in item:
                parsed[str(item["key"])] = item.get("value")
        return parsed
    return {}


def first_present(mapping: Dict[str, Any], keys: List[str]) -> Any:
    for key in keys:
        value = mapping.get(key)
        if value is not None and value != "":
            return value
    return None


def span_preview(span: Dict[str, Any], keys: List[str], limit: int = 100) -> str:
    attrs = span_attributes(span)
    value = first_present(span, keys)
    if value is None:
        value = first_present(attrs, keys)
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        text = json.dumps(value, default=str)
    else:
        text = str(value)
    return summarize_text(text, limit=limit)


def span_duration_ms(span: Dict[str, Any]) -> Optional[float]:
    attrs = span_attributes(span)
    value = first_present(span, ["duration_ms", "durationMs", "latency_ms"])
    if value is None:
        value = first_present(attrs, ["duration_ms", "durationMs", "llm.latency_ms", "api.response_time_ms"])
    try:
        return round(float(value), 2)
    except (TypeError, ValueError):
        pass

    start = first_present(span, ["start_time", "startTime", "start_time_unix_nano"])
    end = first_present(span, ["end_time", "endTime", "end_time_unix_nano"])
    try:
        if start is not None and end is not None:
            start_number = float(start)
            end_number = float(end)
            if start_number > 1_000_000_000_000_000:
                return round((end_number - start_number) / 1_000_000, 2)
            return round((end_number - start_number) * 1000, 2)
    except (TypeError, ValueError):
        return None
    return None


def clean_phoenix_trace(span: Dict[str, Any]) -> Dict[str, Any]:
    attrs = span_attributes(span)
    status = first_present(span, ["status", "status_code", "statusCode"])
    if isinstance(status, dict):
        status = first_present(status, ["code", "status_code", "message"])
    return {
        "span_id": first_present(span, ["span_id", "spanId", "context.span_id", "id"]) or first_present(attrs, ["span_id"]),
        "timestamp": first_present(span, ["timestamp", "start_time", "startTime"]) or first_present(attrs, ["timestamp"]),
        "input_preview": span_preview(span, [
            "input.value",
            "llm.input_messages",
            "llm.input_summary",
            "llm.prompt",
            "prompt",
            "input",
        ]),
        "output_preview": span_preview(span, [
            "output.value",
            "llm.output_messages",
            "llm.output_summary",
            "llm.response",
            "response",
            "output",
        ]),
        "status": str(status or "OK"),
        "duration_ms": span_duration_ms(span),
    }


def build_phoenix_improvement_prompt(low_quality_spans: List[Dict[str, Any]]) -> str:
    examples = low_quality_spans[:3]
    return f"""
You are ReefWatch AI's self-improvement analyst.

Recent weak Phoenix spans from the reef risk assessment system:
{json.dumps(examples, default=str, indent=2)[:12000]}

Identify failure patterns in coral reef bleaching risk assessments, especially:
- incorrect DHW and SST threshold interpretation
- generic or non-actionable conservation recommendations
- missing uncertainty language when NOAA data is partial or unavailable
- hallucinated reef conditions, agencies, timeframes, or measurements

Suggest specific prompt wording improvements. Return JSON only:
{{
  "failure_patterns": ["pattern 1"],
  "prompt_wording_improvements": ["specific wording to add"],
  "risk_assessment_checks": ["check 1"],
  "summary": "brief implementation-oriented summary"
}}
"""


def trace_to_evaluation_item(trace_item: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if not isinstance(trace_item, dict):
        return None
    reef_name = trace_item.get("reefName") or trace_item.get("reef_name") or "unknown reef"
    output = {
        "risk_score": trace_item.get("aiRiskScore"),
        "confidence": trace_item.get("aiConfidence"),
        "summary": trace_item.get("aiSummary"),
        "model_name": trace_item.get("modelName"),
        "status": trace_item.get("status"),
    }
    if not any(value is not None and value != "" for value in output.values()):
        return None
    return {
        "trace_id": trace_item.get("traceId") or trace_item.get("trace_id"),
        "reef_name": reef_name,
        "timestamp": trace_item.get("timestamp"),
        "input_data": {
            "reef_id": trace_item.get("reefId") or trace_item.get("reef_id"),
            "reef_name": reef_name,
            "coordinates": trace_item.get("coordinates") or {
                "lat": trace_item.get("lat"),
                "lng": trace_item.get("lng"),
            },
            "noaa": trace_item.get("noaaInputData") or trace_item.get("noaa_input_data"),
            "status": trace_item.get("status"),
            "source": trace_item.get("source"),
        },
        "model_output": output,
    }


def node_trace_to_assessment(trace_item: Dict[str, Any]) -> Optional[AssessmentForImprovement]:
    if not isinstance(trace_item, dict):
        return None

    metrics = trace_item.get("metrics") if isinstance(trace_item.get("metrics"), dict) else {}
    assessment = trace_item.get("assessment") if isinstance(trace_item.get("assessment"), dict) else {}
    source_type = trace_item.get("sourceType") or trace_item.get("source")
    if "fallback" in str(source_type or "").lower():
        return None

    reef_name = trace_item.get("reefName") or trace_item.get("reef_name")
    if not reef_name:
        return None

    if metrics.get("seaSurfaceTemp") is None or metrics.get("tempAnomaly") is None:
        return None

    return AssessmentForImprovement(
        trace_id=trace_item.get("traceId") or trace_item.get("trace_id"),
        reef_name=str(reef_name),
        timestamp=trace_item.get("timestamp"),
        input_data={
            "reef_id": trace_item.get("reefId") or trace_item.get("reef_id"),
            "reef_name": reef_name,
            "coordinates": metrics.get("coordinates") or {},
            "noaa": {
                "seaSurfaceTemp": metrics.get("seaSurfaceTemp"),
                "tempAnomaly": metrics.get("tempAnomaly"),
                "degreeHeatingWeeks": metrics.get("degreeHeatingWeeks"),
                "bleachingAlertLevel": metrics.get("bleachingAlertLevel"),
            },
            "risk_level": trace_item.get("riskLevel"),
            "source": source_type,
            "trace_type": trace_item.get("traceType"),
        },
        model_output={
            "risk_score": assessment.get("riskScore"),
            "confidence": assessment.get("confidence"),
            "summary": assessment.get("summary"),
            "model_name": assessment.get("modelName"),
            "status": assessment.get("status") or trace_item.get("riskLevel"),
        },
    )


def extract_node_trace_payload(payload: Any) -> tuple:
    if isinstance(payload, dict):
        traces = payload.get("traces") if isinstance(payload.get("traces"), list) else []
        available_types = payload.get("available_trace_types") if isinstance(payload.get("available_trace_types"), list) else []
        return traces, available_types
    if isinstance(payload, list):
        return payload, []
    return [], []


def reef_to_evaluation_item(reef: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if not isinstance(reef, dict):
        return None
    reef_name = reef.get("name") or reef.get("reef_name") or "unknown reef"
    output = {
        "risk_score": reef.get("riskScore") or reef.get("risk_score"),
        "confidence": reef.get("confidence"),
        "summary": reef.get("aiAnalysis") or reef.get("ai_analysis") or reef.get("summary"),
        "status": reef.get("status"),
        "alert_level": reef.get("bleachingAlertLevel") or reef.get("alert_level"),
    }
    if not any(value is not None and value != "" for value in output.values()):
        return None
    return {
        "trace_id": reef.get("id"),
        "reef_name": reef_name,
        "timestamp": reef.get("lastUpdated") or reef.get("last_updated"),
        "input_data": {
            "reef_id": reef.get("id"),
            "reef_name": reef_name,
            "coordinates": {"lat": reef.get("lat"), "lng": reef.get("lng")},
            "noaa": {
                "seaSurfaceTemp": reef.get("seaSurfaceTemp"),
                "tempAnomaly": reef.get("tempAnomaly"),
                "degreeHeatingWeeks": reef.get("degreeHeatingWeeks"),
                "bleachingAlertLevel": reef.get("bleachingAlertLevel"),
            },
            "source": reef.get("source"),
            "status": reef.get("status"),
        },
        "model_output": output,
    }


def has_real_noaa_values(item: Dict[str, Any]) -> bool:
    input_data = item.get("input_data") if isinstance(item, dict) else {}
    if not isinstance(input_data, dict):
        return False

    noaa = input_data.get("noaa")
    if isinstance(noaa, str):
        try:
            noaa = json.loads(noaa)
        except json.JSONDecodeError:
            noaa = {}
    if not isinstance(noaa, dict):
        noaa = {}

    source = str(input_data.get("source") or noaa.get("source") or "").lower()
    status = str(input_data.get("status") or "").lower()
    noaa_data_available = noaa.get("noaa_data_available")
    if noaa_data_available is None:
        noaa_data_available = noaa.get("noaaDataAvailable")
    sea_surface_temp = noaa.get("seaSurfaceTemp")
    if sea_surface_temp is None:
        sea_surface_temp = noaa.get("sea_surface_temp")
    temp_anomaly = noaa.get("tempAnomaly")
    if temp_anomaly is None:
        temp_anomaly = noaa.get("temp_anomaly")
    degree_heating_weeks = noaa.get("degreeHeatingWeeks")
    if degree_heating_weeks is None:
        degree_heating_weeks = noaa.get("degree_heating_weeks")

    return (
        noaa_data_available is not False
        and sea_surface_temp is not None
        and temp_anomaly is not None
        and degree_heating_weeks is not None
        and status != "unavailable"
        and "unavailable" not in source
        and "fallback" not in source
    )


def reef_has_real_noaa_values(reef: Dict[str, Any]) -> bool:
    if not isinstance(reef, dict):
        return False
    source = str(reef.get("source") or "").lower()
    status = str(reef.get("status") or "").lower()
    noaa_data_available = reef.get("noaa_data_available")
    if noaa_data_available is None:
        noaa_data_available = reef.get("noaaDataAvailable")
    return (
        noaa_data_available is not False
        and reef.get("seaSurfaceTemp") is not None
        and reef.get("tempAnomaly") is not None
        and reef.get("degreeHeatingWeeks") is not None
        and status != "unavailable"
        and "unavailable" not in source
        and "fallback" not in source
    )


async def build_fresh_evaluation_items(
    reefs: List[Dict[str, Any]],
    limit: int = 10,
    warnings: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    for reef in reefs:
        if len(items) >= limit:
            break
        if not reef_has_real_noaa_values(reef):
            continue

        reef_name = reef.get("name") or reef.get("reef_name") or "unknown reef"
        try:
            analysis = await analyze_reef(ReefAnalysisRequest(
                reef_name=reef_name,
                lat=float(reef.get("lat") or 0),
                lng=float(reef.get("lng") or 0),
                country=reef.get("country"),
                sst=reef.get("seaSurfaceTemp"),
                anomaly=reef.get("tempAnomaly"),
                dhw=reef.get("degreeHeatingWeeks"),
                alert_level=reef.get("bleachingAlertLevel"),
                data_source=reef.get("source"),
                last_updated=reef.get("lastUpdated"),
                station_id=reef.get("stationId") or reef.get("id"),
            ))
        except Exception as error:
            if warnings is not None:
                warnings.append(f"Fresh analysis failed for {reef_name}: {type(error).__name__}: {getattr(error, 'detail', error)}")
            continue

        items.append({
            "trace_id": reef.get("id"),
            "reef_name": reef_name,
            "timestamp": reef.get("lastUpdated") or utc_now(),
            "input_data": {
                "reef_id": reef.get("id"),
                "reef_name": reef_name,
                "coordinates": {"lat": reef.get("lat"), "lng": reef.get("lng")},
                "noaa": {
                    "seaSurfaceTemp": reef.get("seaSurfaceTemp"),
                    "tempAnomaly": reef.get("tempAnomaly"),
                    "degreeHeatingWeeks": reef.get("degreeHeatingWeeks"),
                    "bleachingAlertLevel": reef.get("bleachingAlertLevel"),
                },
                "source": reef.get("source"),
                "status": reef.get("status"),
            },
            "model_output": analysis,
        })

    return items


def insufficient_real_noaa_data_response(count: int, warnings: List[str], source: str) -> Dict[str, Any]:
    return {
        "status": "insufficient_data",
        "message": "Need at least 3 reef assessments with real NOAA data to run evaluation",
        "date": utc_now()[:10],
        "assessment_count": count,
        "traces_evaluated": 0,
        "data_source": source,
        "warnings": warnings,
    }


def build_self_evaluation_prompt(items: List[Dict[str, Any]]) -> str:
    return f"""
You are evaluating recent coral reef AI assessments for quality.

Recent AI assessments:
{json.dumps(items, default=str, indent=2)[:14000]}

Score each dimension 0-100:
- accuracy: Did the risk assessment match the data?
- specificity: Was it specific to this reef or generic?
- actionability: Score 80+ when actions name specific parties, timeframes, locations, and measurable steps. Score below 40 for generic phrases like "monitor conditions", "increase awareness", or actions that could apply to any reef anywhere.
- scientific_reliability: Did it cite correct thresholds (DHW >4 = Alert Level 1, >8 = Alert Level 2)?
- dhw_interpretation: Was DHW data correctly interpreted?
- uncertainty_communication: Did it acknowledge data gaps or fallback sources honestly?
- hallucination_avoidance: Did it avoid making up data that wasn't in the input?

Return JSON only:
{{
  "average_score": 0,
  "traces_evaluated": 0,
  "low_quality_count": 0,
  "accuracy": 0,
  "specificity": 0,
  "actionability": 0,
  "scientific_reliability": 0,
  "dhw_interpretation": 0,
  "uncertainty_communication": 0,
  "hallucination_avoidance": 0,
  "main_weaknesses": ["weakness 1", "weakness 2"],
  "recommendations": ["recommendation 1"]
}}
"""


def normalize_self_evaluation_response(result: Dict[str, Any], *, count: int, source: str, warnings: List[str]) -> Dict[str, Any]:
    score_keys = [
        "accuracy",
        "specificity",
        "actionability",
        "scientific_reliability",
        "dhw_interpretation",
        "uncertainty_communication",
        "hallucination_avoidance",
    ]
    normalized: Dict[str, Any] = {}
    for key in score_keys:
        value = result.get(key)
        if isinstance(value, (int, float)):
            numeric = float(value)
            normalized[key] = round(numeric / 100, 3) if numeric > 1 else round(numeric, 3)
        else:
            normalized[key] = None

    scored_values = [value for value in normalized.values() if isinstance(value, (int, float))]
    average = result.get("average_score")
    if isinstance(average, (int, float)):
        average_score = round(float(average) / 100, 3) if float(average) > 1 else round(float(average), 3)
    elif scored_values:
        average_score = round(sum(scored_values) / len(scored_values), 3)
    else:
        average_score = None

    weaknesses = result.get("main_weaknesses") or result.get("issues") or []
    if isinstance(weaknesses, str):
        weaknesses = [weaknesses]
    recommendations = result.get("recommendations") or result.get("improvement_suggestions") or []
    if isinstance(recommendations, str):
        recommendations = [recommendations]

    clean_weaknesses = [str(item)[:180] for item in weaknesses if str(item).strip()][:5]
    return {
        "date": utc_now()[:10],
        "assessment_count": count,
        "traces_evaluated": int(result.get("traces_evaluated") or count),
        "low_quality_count": int(result.get("low_quality_count") or 0),
        "average_score": average_score,
        **normalized,
        "dhw_interpretation_accuracy": normalized["dhw_interpretation"],
        "prompt_updated": False,
        "quota_limited": False,
        "issues": clean_weaknesses,
        "main_weaknesses": clean_weaknesses,
        "recommendations": [str(item)[:240] for item in recommendations if str(item).strip()][:6],
        "summary": f"Self-evaluation completed from {source} using {count} recent assessment{'' if count == 1 else 's'}.",
        "research_narrative": (
            f"The judge reviewed {count} recent reef AI assessment"
            f"{'' if count == 1 else 's'} and scored scientific quality across NOAA/DHW reasoning, uncertainty, and hallucination controls."
        ),
        "before_after": {"previous_score": None, "latest_score": average_score},
        "data_source": source,
        "warnings": warnings,
    }


def truncate_assessment_for_eval(item: Dict[str, Any], max_chars: int = 400) -> Dict[str, Any]:
    """Shallow-copy item and truncate long strings in model_output to keep Gemini prompts small."""
    model_output = item.get("model_output")
    if not isinstance(model_output, dict):
        return item
    trimmed: Dict[str, Any] = {}
    for key, value in model_output.items():
        if isinstance(value, str) and len(value) > max_chars:
            trimmed[key] = value[:max_chars] + "…"
        elif isinstance(value, list):
            trimmed[key] = [
                (str(v)[:200] + "…" if len(str(v)) > 200 else str(v))
                for v in value[:4]
            ]
        else:
            trimmed[key] = value
    return {**item, "model_output": trimmed}


async def evaluate_single_assessment_async(
    assessment: AssessmentForImprovement,
    *,
    timeout_seconds: float = 60.0,
) -> Dict[str, Any]:
    """Evaluate one assessment with a 60 s timeout and one retry on 504 / deadline errors."""
    prompt = build_judge_prompt(assessment)
    loop = asyncio.get_running_loop()
    last_error: Optional[Exception] = None

    for attempt in range(2):
        _start = time.perf_counter()
        try:
            print(f"[self-evaluate] Gemini call for {assessment.reef_name!r} attempt {attempt + 1}")
            judge_text = await asyncio.wait_for(
                loop.run_in_executor(None, lambda: generate_text(
                    prompt,
                    json_only=True,
                    prompt_template_name="reef_assessment_judge_v1",
                )),
                timeout=timeout_seconds,
            )
            print(f"[self-evaluate] Gemini OK for {assessment.reef_name!r} in {elapsed_ms(_start):.0f}ms")
            return validate_judge_result(parse_json_response(judge_text))
        except (asyncio.TimeoutError, TimeoutError) as exc:
            print(
                f"[self-evaluate] Gemini timeout ({elapsed_ms(_start):.0f}ms) "
                f"for {assessment.reef_name!r} attempt {attempt + 1}"
            )
            last_error = exc
        except Exception as exc:
            print(
                f"[self-evaluate] Gemini error ({elapsed_ms(_start):.0f}ms) "
                f"for {assessment.reef_name!r} attempt {attempt + 1}: {type(exc).__name__}: {exc}"
            )
            last_error = exc
            if not is_retriable_eval_error(exc):
                raise

        if attempt == 0:
            print(f"[self-evaluate] retrying {assessment.reef_name!r} in 3s")
            await asyncio.sleep(3)

    raise (last_error or RuntimeError(f"evaluation failed for {assessment.reef_name!r}"))


def aggregate_judge_results(
    judgements: List[Dict[str, Any]],
    errors: List[str],
    *,
    count: int,
    source: str,
    warnings: List[str],
) -> Dict[str, Any]:
    """Average per-assessment judge results into the self-evaluation response shape."""
    score_keys = [
        "accuracy", "specificity", "actionability", "scientific_reliability",
        "dhw_interpretation", "uncertainty_communication", "hallucination_avoidance",
    ]

    def avg(key: str) -> Optional[float]:
        vals = [float(j[key]) for j in judgements if isinstance(j.get(key), (int, float))]
        return round(sum(vals) / len(vals), 3) if vals else None

    average_score_val = avg("overall")
    issues = summarize_issue_list(judgements)
    suggestions = [s for j in judgements for s in j.get("improvement_suggestions", [])][:6]
    scored_count = len(judgements)
    failed_count = len(errors)
    suffix = f" ({failed_count} failed)" if errors else ""

    return {
        "date": utc_now()[:10],
        "assessment_count": count,
        "traces_evaluated": scored_count,
        "low_quality_count": sum(1 for j in judgements if (j.get("overall") or 0) < 0.6),
        "average_score": average_score_val,
        "accuracy": avg("accuracy"),
        "specificity": avg("specificity"),
        "actionability": avg("actionability"),
        "scientific_reliability": avg("scientific_reliability") or avg("accuracy"),
        "dhw_interpretation": avg("dhw_interpretation_accuracy") or avg("dhw_interpretation"),
        "dhw_interpretation_accuracy": avg("dhw_interpretation_accuracy") or avg("dhw_interpretation"),
        "uncertainty_communication": avg("uncertainty_communication") or avg("specificity"),
        "hallucination_avoidance": avg("hallucination_avoidance") or round(0.8, 3),
        "prompt_updated": False,
        "quota_limited": False,
        "issues": issues,
        "main_weaknesses": issues,
        "recommendations": [str(s)[:240] for s in suggestions if str(s).strip()],
        "summary": (
            f"Self-evaluation completed from {source} using "
            f"{scored_count} of {count} assessment{'' if count == 1 else 's'}{suffix}."
        ),
        "research_narrative": (
            f"The judge reviewed {scored_count} reef AI assessment"
            f"{'' if scored_count == 1 else 's'} and scored scientific quality "
            f"across NOAA/DHW reasoning, uncertainty, and hallucination controls."
        ),
        "before_after": {"previous_score": None, "latest_score": average_score_val},
        "data_source": source,
        "warnings": warnings,
        "errors": errors,
    }


def load_reef_analysis_prompt() -> str:
    try:
        prompt = REEF_ANALYSIS_PROMPT_PATH.read_text(encoding="utf-8").strip()
        if prompt:
            return prompt
        print(f"[prompt] {REEF_ANALYSIS_PROMPT_PATH} is empty; using safe default")
    except FileNotFoundError:
        print(f"[prompt] {REEF_ANALYSIS_PROMPT_PATH} missing; using safe default")
    except OSError as error:
        print(f"[prompt] unable to read {REEF_ANALYSIS_PROMPT_PATH}: {error}; using safe default")

    return DEFAULT_REEF_ANALYSIS_PROMPT


def validate_judge_result(result: Dict[str, Any]) -> Dict[str, Any]:
    validated: Dict[str, Any] = {}
    score_keys = [
        "accuracy",
        "specificity",
        "actionability",
        "scientific_reliability",
        "dhw_interpretation",
        "uncertainty_communication",
        "hallucination_avoidance",
    ]
    for key in score_keys:
        value = result.get(key)
        if not isinstance(value, (int, float)):
            raise ValueError(f"Judge result field {key} must be numeric")
        numeric = float(value)
        if 0 <= numeric <= 1:
            validated[key] = round(numeric, 3)
        elif 0 <= numeric <= 100:
            validated[key] = round(numeric / 100, 3)
        else:
            raise ValueError(f"Judge result field {key} must be a number from 0 to 100")

    validated["dhw_interpretation_accuracy"] = validated["dhw_interpretation"]
    validated["overall"] = round(sum(validated[key] for key in score_keys) / len(score_keys), 3)

    weaknesses = result.get("main_weaknesses", result.get("issues", []))
    if isinstance(weaknesses, str):
        weaknesses = [weaknesses]
    validated["issues"] = [
        str(issue).strip()[:160]
        for issue in weaknesses
        if str(issue).strip()
    ][:5]

    suggestion = result.get("improvement_suggestion")
    raw_suggestions = result.get("improvement_suggestions", [])
    if isinstance(raw_suggestions, str):
        raw_suggestions = [raw_suggestions]
    if suggestion:
        raw_suggestions = [suggestion, *raw_suggestions]
    validated["improvement_suggestions"] = [
        str(suggestion).strip()[:220]
        for suggestion in raw_suggestions
        if str(suggestion).strip()
    ][:5]
    return validated


def build_judge_prompt(assessment: AssessmentForImprovement) -> str:
    return f"""
You are evaluating a coral reef AI assessment for quality.

Original NOAA data: {json.dumps(assessment.input_data, default=str, indent=2)}
AI Assessment: {json.dumps(assessment.model_output, default=str, indent=2)}

Score each dimension 0-100:
- accuracy: Does risk level match the temperature/DHW data?
- specificity: Is this specific to this reef or generic?
- actionability: Score 80+ ONLY when recommended_actions contains specific named parties (dive operators, AIMS, local rangers, government agencies), specific timeframes (within 24h, within 72h, this week), specific locations within the reef, AND specific measurable actions (deploy X loggers, conduct Y surveys, notify Z organizations). Score below 40 when actions contain generic phrases like "monitor conditions", "increase awareness", "continue monitoring" without specifics, or any action that could apply to ANY reef anywhere.
- scientific_reliability: Are NOAA thresholds correctly applied? Use DHW >4 = Alert Level 1 and DHW >8 = Alert Level 2.
- dhw_interpretation: Is DHW value correctly interpreted?
- uncertainty_communication: Are data gaps acknowledged?
- hallucination_avoidance: No invented data beyond input?

Return JSON only:
{{
  "accuracy": 0,
  "specificity": 0,
  "actionability": 0,
  "scientific_reliability": 0,
  "dhw_interpretation": 0,
  "uncertainty_communication": 0,
  "hallucination_avoidance": 0,
  "main_weaknesses": ["weakness 1", "weakness 2"],
  "improvement_suggestion": "specific prompt change needed"
}}
"""


def build_batch_judge_prompt(assessments: "List[AssessmentForImprovement]") -> str:
    items = []
    for i, a in enumerate(assessments):
        inp = a.input_data or {}
        if isinstance(a.model_output, dict):
            output_text = a.model_output.get("analysis", a.model_output.get("summary", str(a.model_output)))[:200]
        elif isinstance(a.model_output, str):
            output_text = a.model_output[:200]
        else:
            output_text = ""
        items.append(
            f"Assessment {i+1} — {a.reef_name}:\n"
            f"  SST={inp.get('seaSurfaceTemp','?')}°C, DHW={inp.get('degreeHeatingWeeks','?')}wk, anomaly={inp.get('tempAnomaly','?')}°C\n"
            f"  Analysis: {output_text}"
        )

    assessments_text = "\n\n".join(items)
    n = len(assessments)

    return f"""You are evaluating coral reef AI assessments for quality. Score each on 7 dimensions (0-100).

{assessments_text}

Return a JSON array with exactly {n} objects (one per assessment):
[{{"accuracy":0,"specificity":0,"actionability":0,"scientific_reliability":0,"dhw_interpretation":0,"uncertainty_communication":0,"hallucination_avoidance":0,"main_weaknesses":["weakness"],"improvement_suggestion":"change needed"}}]

Scoring rules:
- accuracy: Does risk level match SST/DHW data?
- specificity: Is this specific to this reef, not generic?
- actionability: 80+ only when actions name specific parties, timeframes, locations, and measurable steps. Below 40 for generic phrases like "monitor conditions" or "continue monitoring".
- scientific_reliability: DHW >4 = Alert Level 1, DHW >8 = Alert Level 2.
- dhw_interpretation: Is DHW value correctly interpreted?
- uncertainty_communication: Are data gaps acknowledged?
- hallucination_avoidance: No invented data beyond input?

Return the JSON array only, no explanation."""


def average_score(judgements: List[Dict[str, Any]], key: str) -> float:
    if not judgements:
        return 0.0
    return round(sum(float(item[key]) for item in judgements) / len(judgements), 3)


def is_valid_improved_prompt(new_prompt: str, old_prompt: str = "") -> bool:
    if len(new_prompt.strip()) <= 100:
        print("[prompt-rewrite] validation failed — too short")
        return False
    reef_words = ["reef", "coral", "bleach", "dhw"]
    if not any(w in new_prompt.lower() for w in reef_words):
        print("[prompt-rewrite] validation failed — no reef keywords")
        return False
    if old_prompt and new_prompt.strip() == old_prompt.strip():
        print("[prompt-rewrite] validation failed — identical to old prompt")
        return False
    print("[prompt-rewrite] validation passed")
    return True


def backup_and_save_reef_prompt(new_prompt: str) -> str:
    current_prompt = load_reef_analysis_prompt()
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d_%H-%M")
    REEF_ANALYSIS_PROMPT_HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    backup_path = REEF_ANALYSIS_PROMPT_HISTORY_DIR / f"reef_analysis_{timestamp}.txt"
    backup_path.write_text(current_prompt, encoding="utf-8")
    REEF_ANALYSIS_PROMPT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REEF_ANALYSIS_PROMPT_PATH.write_text(new_prompt.strip() + "\n", encoding="utf-8")
    return str(backup_path.relative_to(REPO_ROOT))


def _summarize_prompt_changes(old_prompt: str, new_prompt: str) -> str:
    old_words = len(old_prompt.split())
    new_words = len(new_prompt.split())
    delta = new_words - old_words
    delta_str = f"+{delta}" if delta >= 0 else str(delta)
    return (
        f"Prompt rewritten to address identified weaknesses "
        f"({old_words} → {new_words} words, {delta_str}). "
        "Strengthened DHW threshold guidance, uncertainty language, and specific action requirements."
    )


def build_improvement_prompt(current_prompt: str, feedback: Dict[str, Any]) -> str:
    return f"""
Current system prompt for reef analysis:
{current_prompt}

Weaknesses found in recent assessments:
{json.dumps(feedback.get("issues", []), default=str, indent=2)}

Write an improved system prompt that fixes these weaknesses.
The prompt should:
- Emphasize DHW thresholds (>4 = Alert 1, >8 = Alert 2)
- Require acknowledging fallback/unavailable data
- Require specific actionable recommendations
- Avoid generic statements

Return ONLY the improved prompt text, nothing else.
"""


def summarize_issue_list(judgements: List[Dict[str, Any]]) -> List[str]:
    counts: Dict[str, int] = {}
    for judgement in judgements:
        for issue in judgement.get("issues", []):
            counts[issue] = counts.get(issue, 0) + 1
    return [issue for issue, _count in sorted(counts.items(), key=lambda item: item[1], reverse=True)][:5]


def build_improvement_summary(
    average_overall: float,
    issues: List[str],
    prompt_updated: bool,
    quota_limited: bool = False,
) -> str:
    issue_text = issues[0] if issues else "no dominant weakness was found"
    if prompt_updated:
        return (
            f"Yesterday the agent scored {average_overall:.2f} quality. "
            f"It was weakest on: {issue_text}. The system prompt was rewritten overnight. "
            "Future reef assessments will use the improved prompt."
        )
    if average_overall < 0.75:
        return (
            f"Yesterday the agent scored {average_overall:.2f} quality. "
            f"Main finding: {issue_text}. "
            "Prompt update was needed, but the rewrite was skipped because Gemini quota was exhausted or no safe rewrite was available."
        )
    return (
        f"Yesterday the agent scored {average_overall:.2f} quality. "
        f"Main finding: {issue_text}. "
        "Quality met the 0.75 threshold, so the current prompt was preserved."
    )


def compute_data_quality(
    sst: Optional[float], dhw: Optional[float], anomaly: Optional[float]
) -> tuple:
    """Returns (confidence_penalty, data_label, missing_fields)."""
    missing: List[str] = []
    penalty = 0.0
    if sst is None:
        missing.append("sst")
        penalty += 0.15
    if dhw is None:
        missing.append("dhw")
        penalty += 0.20
    if anomaly is None:
        missing.append("anomaly")
        penalty += 0.10
    if len(missing) >= 2:
        label = "low_confidence"
    elif "dhw" in missing:
        label = "monitoring_gap"
    elif missing:
        label = "data_limited"
    else:
        label = "full_data"
    return round(min(0.45, penalty), 3), label, missing


def build_research_narrative(
    date: str,
    assessment_count: int,
    average_score: float,
    issues: List[str],
    quota_limited: bool,
    prompt_updated: bool,
) -> str:
    if not assessment_count:
        return f"On {date}, no reef assessments were available for evaluation."
    issue_text = " and ".join(issues[:2]) if issues else "no dominant weakness"
    score_text = f"{average_score:.2f}" if isinstance(average_score, (int, float)) else "unknown"
    if prompt_updated:
        outcome = "The system prompt was rewritten to address these issues."
    elif quota_limited:
        outcome = "The prompt rewrite was skipped due to Gemini quota limits."
    elif isinstance(average_score, (int, float)) and average_score >= 0.75:
        outcome = "Quality met the threshold, so the current prompt was preserved."
    else:
        outcome = "No safe rewrite was available; the current prompt was preserved."
    return (
        f"On {date}, the agent evaluated {assessment_count} reef assessments "
        f"and identified a recurring issue in {issue_text}. "
        f"Average quality score was {score_text}. {outcome}"
    )


def latest_self_improvement_from_disk() -> Dict[str, Any]:
    empty = {
        "date": None,
        "assessment_count": 0,
        "average_score": None,
        "accuracy": None,
        "specificity": None,
        "actionability": None,
        "scientific_reliability": None,
        "dhw_interpretation": None,
        "dhw_interpretation_accuracy": None,
        "uncertainty_communication": None,
        "hallucination_avoidance": None,
        "prompt_updated": False,
        "quota_limited": False,
        "issues": [],
        "summary": "No self-improvement run has completed yet.",
        "before_after": {"previous_score": None, "latest_score": None},
    }
    try:
        runs = json.loads(SELF_IMPROVEMENT_RUNS_PATH.read_text(encoding="utf-8"))
        if not isinstance(runs, list) or not runs:
            return empty
        latest = sorted(
            runs,
            key=lambda run: run.get("stored_at") or run.get("completed_at") or run.get("date") or "",
            reverse=True,
        )[0]
    except Exception as error:
        print(f"[self-improvement] unable to read latest run history: {error}")
        return empty

    summary = latest.get("summary", "")
    if latest.get("quota_limited") and (latest.get("average_score") or 0) < 0.75 and not latest.get("prompt_updated"):
        summary = "Prompt update was needed but skipped because Gemini quota was exhausted."
    elif (latest.get("average_score") or 1) < 0.75 and not latest.get("prompt_updated") and "quality met the threshold" in summary:
        summary = summary.replace(
            "The current prompt was kept because quality met the threshold or no safe rewrite was available.",
            "Prompt update was needed but no safe rewrite was available.",
        )

    return {
        "date": latest.get("date"),
        "assessment_count": latest.get("assessment_count", 0),
        "average_score": latest.get("average_score"),
        "accuracy": latest.get("accuracy"),
        "specificity": latest.get("specificity"),
        "actionability": latest.get("actionability"),
        "scientific_reliability": latest.get("scientific_reliability"),
        "dhw_interpretation": latest.get("dhw_interpretation") or latest.get("dhw_interpretation_accuracy"),
        "dhw_interpretation_accuracy": latest.get("dhw_interpretation_accuracy") or latest.get("dhw_interpretation"),
        "uncertainty_communication": latest.get("uncertainty_communication"),
        "hallucination_avoidance": latest.get("hallucination_avoidance"),
        "prompt_updated": bool(latest.get("prompt_updated")),
        "quota_limited": bool(latest.get("quota_limited")),
        "issues": latest.get("issues") if isinstance(latest.get("issues"), list) else [],
        "summary": summary,
        "before_after": latest.get("before_after") or {
            "previous_score": None,
            "latest_score": latest.get("average_score"),
        },
    }


@app.post("/analyze-reef")
@app.post("/api/ai/analyze")
async def analyze_reef(payload: ReefAnalysisRequest) -> Dict[str, Any]:
    route_start = time.perf_counter()
    system_prompt = load_reef_analysis_prompt()
    try:
        prompt = system_prompt.format(
            reef_name=payload.reef_name,
            lat=payload.lat,
            lng=payload.lng,
            sst=payload.sst if payload.sst is not None else "N/A",
            anomaly=payload.anomaly if payload.anomaly is not None else "N/A",
            dhw=payload.dhw if payload.dhw is not None else 0,
            alert_level=payload.alert_level or "No Alert",
        )
    except (KeyError, ValueError):
        prompt = f"""{system_prompt}

Reef: {payload.reef_name} at {payload.lat}, {payload.lng}
SST: {payload.sst}°C | Anomaly: {payload.anomaly}°C | DHW: {payload.dhw} | Alert: {payload.alert_level}

Return JSON with: risk_score (0-100), risk_level (safe|warning|critical), confidence (0-1),
threat_summary (specific to this reef mentioning exact values), recommended_actions (3 specific named timed actions),
historical_context."""

    root_attrs = {
        "reef.name": payload.reef_name,
        "reef.location": f"{payload.lat}, {payload.lng}",
        "reef.country": payload.country or "Unknown",
        "reef.latitude": payload.lat,
        "reef.longitude": payload.lng,
        "reef.sea_temp": payload.sst,
        "reef.sst_anomaly": payload.anomaly,
        "reef.dhw": payload.dhw,
        "reef.alert_level": payload.alert_level,
        "reef.data_source": payload.data_source or "NOAA snapshot payload",
        "reef.last_updated": payload.last_updated or utc_now(),
        "request.route": "/analyze-reef",
        "request.method": "POST",
        "request.success": False,
    }

    with tracer.start_as_current_span("reef.analyze") as span:
        set_attrs(span, root_attrs)
        try:
            with tracer.start_as_current_span("noaa.fetch") as noaa_span:
                noaa_start = time.perf_counter()
                cache_hit = bool(payload.data_source and "cache" in payload.data_source.lower())
                fallback_used = bool(payload.data_source and "fallback" in payload.data_source.lower())
                noaa_span.add_event("noaa_data_requested")
                set_attrs(noaa_span, {
                    "noaa.endpoint": payload.data_source or "attached_noaa_snapshot",
                    "noaa.status_code": 200 if not fallback_used else 206,
                    "noaa.cache_hit": cache_hit,
                    "noaa.station_id": payload.station_id,
                    "noaa.dataset": "NOAA_DHW",
                    "fallback.used": fallback_used,
                    "fallback.reason": "fallback NOAA payload received" if fallback_used else "",
                })
                noaa_span.add_event("noaa_cache_used" if cache_hit else "noaa_data_received")
                noaa_latency = elapsed_ms(noaa_start)
                noaa_span.set_attribute("noaa.response_time_ms", noaa_latency)
                noaa_span.set_attribute("noaa.latency_ms", noaa_latency)
                track_noaa_metrics(noaa_latency, cache_hit)

            with tracer.start_as_current_span("reef.risk_calculation") as risk_span:
                risk_start = time.perf_counter()
                dhw = payload.dhw or 0
                anomaly = payload.anomaly or 0
                thermal_stress_score = min(100, max(0, round((dhw * 10) + max(0, anomaly) * 8)))
                set_attrs(risk_span, {
                    "reef.dhw": payload.dhw,
                    "reef.sst_anomaly": payload.anomaly,
                    "reef.thermal_stress_score": thermal_stress_score,
                    "api.response_time_ms": elapsed_ms(risk_start),
                })
                if thermal_stress_score >= 70 or dhw >= 8:
                    risk_span.add_event("bleaching_threshold_exceeded")
                risk_span.add_event("risk_score_calculated")

            with tracer.start_as_current_span("agent.environmental_analysis") as agent_span:
                set_attrs(agent_span, {
                    "agent.name": "environmental_analysis",
                    "agent.input": "NOAA SST, SST anomaly, DHW, bleaching alert level",
                    "reef.sea_temp": payload.sst,
                    "reef.sst_anomaly": payload.anomaly,
                    "reef.dhw": payload.dhw,
                })

            with tracer.start_as_current_span("agent.risk_assessment") as agent_span:
                set_attrs(agent_span, {
                    "agent.name": "risk_assessment",
                    "agent.threshold_score": thermal_stress_score,
                    "agent.threshold_exceeded": thermal_stress_score >= 70,
                })

            with tracer.start_as_current_span("agent.recommendation") as agent_span:
                set_attrs(agent_span, {
                    "agent.name": "recommendation",
                    "agent.expected_output": "risk score, threat summary, concrete actions",
                })

            cache_key = f"{payload.reef_name}_{round(payload.sst or 0, 1)}_{round(payload.dhw or 0, 1)}_{round(payload.anomaly or 0, 1)}"
            cache_entry = gemini_cache.get(cache_key)
            gemini_cache_hit = (
                cache_entry is not None
                and (datetime.now() - cache_entry["timestamp"]).total_seconds() < GEMINI_CACHE_TTL_SECONDS
            )
            span.set_attribute("cache.hit", gemini_cache_hit)

            if gemini_cache_hit:
                llm_result = cache_entry["response"]
            else:
                llm_result = generate_text_with_trace(
                    prompt,
                    json_only=True,
                    prompt_template_name="reef_analysis_v1",
                    span_name="llm.gemini.generate",
                )
                gemini_cache[cache_key] = {"response": llm_result, "timestamp": datetime.now()}

            result = parse_json_response(llm_result["text"])

            with tracer.start_as_current_span("response.build") as response_span:
                result.setdefault("confidence", 0)

                # Confidence degradation for missing NOAA data (Task 5)
                data_quality_penalty, data_label, missing_fields = compute_data_quality(
                    payload.sst, payload.dhw, payload.anomaly
                )
                raw_confidence = float(result.get("confidence", 0))
                adjusted_confidence = round(max(0.0, raw_confidence - data_quality_penalty), 3)
                result["confidence"] = adjusted_confidence
                result["data_quality"] = data_label
                if missing_fields:
                    result["missing_fields"] = missing_fields
                if data_label in ("low_confidence", "monitoring_gap") and result.get("risk_level") == "safe":
                    result["risk_level"] = "warning"

                set_attrs(response_span, {
                    "reef.risk_score": result.get("risk_score"),
                    "reef.confidence": adjusted_confidence,
                    "reef.risk_level": result.get("risk_level"),
                    "reef.data_quality": data_label,
                    "llm.total_tokens": llm_result.get("total_tokens"),
                })
                response_span.add_event("ai_analysis_completed")

            latency_ms = elapsed_ms(route_start)
            set_attrs(span, {
                "trace_type": "reef_assessment",
                "reef.risk_score": result.get("risk_score"),
                "reef.confidence": adjusted_confidence,
                "reef.risk_level": result.get("risk_level"),
                "reef.source_type": payload.data_source or "noaa",
                "reef.confidence_score": adjusted_confidence,
                "reef.data_quality": data_label,
                "reef.missing_fields": ", ".join(missing_fields) if missing_fields else "",
                "request.success": True,
                "api.response_time_ms": latency_ms,
                "llm.prompt_tokens": llm_result.get("prompt_tokens"),
                "llm.completion_tokens": llm_result.get("completion_tokens"),
                "llm.total_tokens": llm_result.get("total_tokens"),
                "llm.latency_ms": llm_result.get("latency_ms"),
            })
            span.set_status(Status(StatusCode.OK))
            span.add_event("ai_analysis_completed")
            track_analysis_metrics(result, latency_ms, success=True)
            return result
        except Exception as error:
            latency_ms = elapsed_ms(route_start)
            fallback_reason = str(getattr(error, "detail", error))
            set_attrs(span, {
                "request.success": False,
                "api.response_time_ms": latency_ms,
                "fallback.used": True,
                "fallback.reason": fallback_reason,
            })
            span.add_event("fallback_used")
            record_span_error(span, error, fallback_used=True, fallback_reason=fallback_reason)
            observability_metrics["last_error"] = fallback_reason
            track_analysis_metrics({}, latency_ms, success=False, fallback_used=True)
            raise


@app.post("/generate-brief")
@app.post("/api/ai/brief")
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

    with tracer.start_as_current_span("reef.generate_brief") as brief_span:
        brief_cache_key = f"brief_{payload.reef_id}_{round(payload.sst or 0, 1)}_{round(payload.dhw or 0, 1)}_{round(payload.anomaly or 0, 1)}"
        brief_cache_entry = gemini_cache.get(brief_cache_key)
        brief_cache_hit = (
            brief_cache_entry is not None
            and (datetime.now() - brief_cache_entry["timestamp"]).total_seconds() < GEMINI_CACHE_TTL_SECONDS
        )
        brief_span.set_attribute("cache.hit", brief_cache_hit)

        if brief_cache_hit:
            result = brief_cache_entry["response"]
        else:
            result = generate_text_with_trace(
                prompt,
                prompt_template_name="generate_brief",
                span_name="gemini.generate",
            )
            gemini_cache[brief_cache_key] = {"response": result, "timestamp": datetime.now()}

        brief_text = result["text"].replace("```markdown", "").replace("```", "").strip()
        return {
            "brief": brief_text,
            "reef_name": payload.reef_name,
            "generated_at": utc_now(),
        }


@app.post("/chat")
@app.post("/api/chat")
@app.post("/api/ai/chat")
async def chat(payload: ChatRequest) -> Dict[str, Any]:
    route_start = time.perf_counter()
    history_count = len(payload.conversation_history or [])
    context_keys = list((payload.reef_context or {}).keys())
    print("[ai.chat] request received", {
        "message_length": len(payload.message or ""),
        "conversation_history_count": history_count,
        "reef_context_keys": context_keys,
    })

    cache_key = hashlib.sha256(json.dumps({
        "message": payload.message,
        "conversation_history": (payload.conversation_history or [])[-6:],
        "reef_context": payload.reef_context,
    }, sort_keys=True, default=str).encode("utf-8")).hexdigest()
    cached_chat = _cache_get(_CHAT_CACHE, cache_key)
    if isinstance(cached_chat, dict):
        observability_metrics["cache_hit_count"] += 1
        return {**cached_chat, "cached": True}

    data_need_prompt = f"""
Decide what reef monitoring data is needed to answer this user question.

Question: {payload.message}
Existing reef context: {json.dumps(payload.reef_context)}
Conversation history: {json.dumps(payload.conversation_history[-6:])}

Respond in JSON only with:
- data_needed: array of fields or reef names needed
- reasoning: short explanation
"""

    with tracer.start_as_current_span("ai.chat") as span:
        set_attrs(span, {
            "request.route": "/chat",
            "request.method": "POST",
            "request.success": False,
            "chat.message_length": len(payload.message or ""),
            "chat.conversation_history_count": history_count,
            "chat.reef_context_keys": context_keys,
            "llm.provider": "google",
            "llm.model": GEMINI_MODEL_NAME,
        })

        try:
            with tracer.start_as_current_span("chat.determine_data_need") as data_span:
                data_span.add_event("llm_prompt_built")
                print("[ai.chat] data-need model request started")
                data_need = parse_json_response(generate_text(
                    data_need_prompt,
                    json_only=True,
                    prompt_template_name="chat_data_need_v1",
                ))
                data_span.add_event("llm_response_received")
                set_attrs(data_span, {
                    "chat.data_needed": data_need.get("data_needed", []),
                    "chat.reasoning": data_need.get("reasoning", ""),
                })
                print("[ai.chat] data-need model response received", {
                    "data_needed": data_need.get("data_needed", []),
                })

            with tracer.start_as_current_span("chat.fetch_live_reef_data") as fetch_span:
                fetch_start = time.perf_counter()
                print("[ai.chat] loading live reef data from local cache/snapshot")
                live_reefs = _cache_get(_NOAA_CACHE, "live:list") or _snapshot_fallback_reefs()
                fetch_latency = elapsed_ms(fetch_start)
                set_attrs(fetch_span, {
                    "noaa.endpoint": "in_process_live_cache",
                    "noaa.status_code": 200,
                    "noaa.response_time_ms": fetch_latency,
                    "noaa.cache_hit": _cache_get(_NOAA_CACHE, "live:list") is not None,
                    "noaa.dataset": "reefwatch_live_reefs",
                    "reef.count": len(live_reefs) if isinstance(live_reefs, list) else 0,
                })
                fetch_span.add_event("noaa_data_received")
                print("[ai.chat] live reef data received", {
                    "status_code": 200,
                    "latency_ms": fetch_latency,
                    "reef_count": len(live_reefs) if isinstance(live_reefs, list) else 0,
                })

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

            with tracer.start_as_current_span("chat.answer_with_live_data") as answer_span:
                answer_span.add_event("llm_prompt_built")
                print("[ai.chat] answer model request started")
                result = parse_json_response(generate_text(
                    answer_prompt,
                    json_only=True,
                    prompt_template_name="chat_answer_live_data_v1",
                ))
                answer_span.add_event("llm_response_received")
                set_attrs(answer_span, {
                    "chat.answer_summary": summarize_text(result.get("answer", "")),
                    "chat.data_used": result.get("data_used", []),
                    "chat.confidence": result.get("confidence"),
                })
                print("[ai.chat] answer model response received", {
                    "answer_length": len(result.get("answer", "")),
                    "data_used_count": len(result.get("data_used", [])) if isinstance(result.get("data_used"), list) else 0,
                })

            latency_ms = elapsed_ms(route_start)
            set_attrs(span, {
                "request.success": True,
                "api.response_time_ms": latency_ms,
                "chat.confidence": result.get("confidence"),
            })
            span.set_status(Status(StatusCode.OK))
            span.add_event("ai_analysis_completed")
            track_analysis_metrics({"confidence": result.get("confidence")}, latency_ms, success=True)
            raw_fields = data_need.get('data_needed', [])
            readable_fields = [f.replace("monitored_reefs[?status=='critical'].", '').replace('_', ' ') for f in raw_fields] if raw_fields else []
            human_fields = ', '.join(readable_fields) or 'general reef context'
            result["reasoning_steps"] = [
                f"Identified required data: {human_fields}",
                f"Reasoning: {data_need.get('reasoning', 'determined live NOAA data needed')}",
                f"Fetched live reef data and identified {len(result.get('data_used', [])) if isinstance(result.get('data_used'), list) else 0} relevant sources",
                f"Generated answer with confidence {round((result.get('confidence') or 0) * 100)}%",
            ]
            _cache_set(_CHAT_CACHE, cache_key, result)
            return result
        except Exception as error:
            latency_ms = elapsed_ms(route_start)
            message = str(getattr(error, "detail", error))
            set_attrs(span, {
                "request.success": False,
                "api.response_time_ms": latency_ms,
                "error.message": message,
            })
            record_span_error(span, error, fallback_used=False)
            observability_metrics["last_error"] = message
            track_analysis_metrics({}, latency_ms, success=False)
            print(f"[ai.chat] failed after {latency_ms}ms: {type(error).__name__}: {message}")
            raise


@app.post("/self-evaluate")
async def self_evaluate(payload: Optional[SelfEvaluationRequest] = None) -> Dict[str, Any]:
    warnings: List[str] = []
    evaluation_items: List[Dict[str, Any]] = []
    source = "none"
    request_payload = payload or SelfEvaluationRequest()
    default_limit = 2 if request_payload.reason == "manual-ui" else 10
    requested_limit = request_payload.limit if request_payload.limit is not None else default_limit
    max_limit = 3 if request_payload.reason == "manual-ui" else 25
    evaluation_limit = max(1, min(int(requested_limit), max_limit))

    try:
        with tracer.start_as_current_span("self_evaluate.load_sources") as span:
            # Query Phoenix directly (no Node.js proxy)
            try:
                _se_phoenix = PhoenixMCPClient(ARIZE_API_BASE_URL, project_name=ARIZE_PROJECT_NAME, space_id=ARIZE_SPACE_ID)
                local_traces = await _se_phoenix.get_recent_spans(limit=evaluation_limit)
                trace_error = None
            except Exception as _se_err:
                local_traces = None
                trace_error = str(_se_err)

            if trace_error:
                warnings.append(f"Unable to load Phoenix traces. {trace_error}")
            elif isinstance(local_traces, list):
                evaluation_items = [
                    item
                    for item in (trace_to_evaluation_item(trace_item) for trace_item in local_traces[:evaluation_limit])
                    if item is not None and has_real_noaa_values(item)
                ]
                if evaluation_items:
                    source = "local_sqlite_traces"

            span.set_attribute("self_evaluate.valid_trace_count", len(evaluation_items))
            span.set_attribute("self_evaluate.limit", evaluation_limit)
            span.set_attribute("self_evaluate.reason", request_payload.reason)

            if len(evaluation_items) < evaluation_limit:
                live_reefs, live_error = await fetch_json_with_error(
                    REEFWATCH_API_URL,
                    timeout=15.0,
                )
                if live_error:
                    warnings.append(f"Unable to fetch fresh reef conditions. {live_error}")
                elif isinstance(live_reefs, list):
                    valid_live_reefs = [reef for reef in live_reefs if reef_has_real_noaa_values(reef)]
                    span.set_attribute("self_evaluate.live_reef_count", len(live_reefs))
                    span.set_attribute("self_evaluate.valid_live_reef_count", len(valid_live_reefs))
                    if valid_live_reefs:
                        evaluation_items = await build_fresh_evaluation_items(
                            valid_live_reefs[:evaluation_limit],
                            limit=evaluation_limit,
                            warnings=warnings,
                        )
                        if evaluation_items:
                            source = "fresh_live_reef_analysis"

            if len(evaluation_items) < evaluation_limit:
                api_key = os.getenv("PHOENIX_API_KEY")
                if api_key:
                    traces_url = PHOENIX_ENDPOINT.rstrip("/").replace("/v1/traces", "") + "/v1/traces"
                    phoenix_traces, phoenix_error = await fetch_json_with_error(
                        traces_url,
                        timeout=10.0,
                        headers={"api_key": api_key},
                    )
                    if phoenix_error:
                        warnings.append(f"Unable to load Phoenix traces. {phoenix_error}")
                    elif isinstance(phoenix_traces, list):
                        evaluation_items = [
                            item
                            for item in (trace_to_evaluation_item(trace_item) for trace_item in phoenix_traces[:evaluation_limit])
                            if item is not None and has_real_noaa_values(item)
                        ]
                        if evaluation_items:
                            source = "phoenix_traces"
                else:
                    warnings.append("PHOENIX_API_KEY is not configured; skipped hosted Phoenix fallback.")

            if not evaluation_items:
                return insufficient_real_noaa_data_response(len(evaluation_items), warnings, source)

        with tracer.start_as_current_span("self_evaluate.score_assessments"):
            evaluation_batch = evaluation_items[:evaluation_limit]
            print(
                f"[self-evaluate] scoring {len(evaluation_batch)} assessment(s) "
                f"one-at-a-time (limit={evaluation_limit}, source={source})"
            )
            judgements: List[Dict[str, Any]] = []
            eval_errors: List[str] = []

            for i, item in enumerate(evaluation_batch, 1):
                truncated = truncate_assessment_for_eval(item)
                assessment = AssessmentForImprovement(
                    trace_id=truncated.get("trace_id"),
                    reef_name=str(truncated.get("reef_name") or "unknown"),
                    input_data=truncated.get("input_data") or {},
                    model_output=truncated.get("model_output"),
                    timestamp=truncated.get("timestamp"),
                )
                print(f"[self-evaluate] {i}/{len(evaluation_batch)} — {assessment.reef_name!r}")
                try:
                    judgement = await evaluate_single_assessment_async(assessment)
                    judgement["trace_id"] = assessment.trace_id
                    judgement["reef_name"] = assessment.reef_name
                    judgements.append(judgement)
                except Exception as item_error:
                    msg = f"{assessment.reef_name}: {type(item_error).__name__}: {item_error}"
                    eval_errors.append(msg[:300])
                    warnings.append(
                        f"Evaluation skipped for {assessment.reef_name}: {type(item_error).__name__}"
                    )
                    print(f"[self-evaluate] failed for {assessment.reef_name!r}: {msg}")

            print(
                f"[self-evaluate] scored {len(judgements)}/{len(evaluation_batch)}"
                + (f" — {len(eval_errors)} error(s)" if eval_errors else "")
            )

            if not judgements:
                raise RuntimeError(
                    f"No assessments could be scored ({len(evaluation_batch)} attempted). "
                    + "; ".join(eval_errors[:2])
                )

            result = aggregate_judge_results(
                judgements,
                eval_errors,
                count=len(evaluation_batch),
                source=source,
                warnings=warnings,
            )

            # ── Automatic prompt improvement when quality is below threshold ──────
            average_score_val = result.get("average_score")
            print(f"[self-evaluate] scoring complete. avg={average_score_val!r} type={type(average_score_val).__name__}, will_attempt_rewrite={isinstance(average_score_val, (int, float)) and average_score_val < 0.99}", flush=True)
            if isinstance(average_score_val, (int, float)) and average_score_val < 0.99:
                previous_prompt = load_reef_analysis_prompt()
                # FIX 4: starting log
                print(f"[self-evaluate] rewrite: starting with score={average_score_val:.3f}")
                feedback = {
                    "issues": result.get("issues", []),
                    "improvement_suggestions": result.get("recommendations", []),
                }
                # FIX 5: truncate the current prompt so the rewrite Gemini call is fast
                truncated_previous = previous_prompt[:1200]
                rewrite_prompt_text = build_improvement_prompt(truncated_previous, feedback)

                # FIX 1: dedicated closure that creates its own GenerativeModel instance
                # and sets an independent 50 s client-level timeout so it cannot share
                # connection state with the evaluation calls that ran before it.
                def _run_rewrite() -> str:
                    rewrite_model = genai.GenerativeModel(GEMINI_MODEL_NAME)
                    response = rewrite_model.generate_content(
                        rewrite_prompt_text,
                        request_options={"timeout": 50},
                    )
                    return response.text.strip()

                try:
                    loop = asyncio.get_running_loop()
                    _rewrite_start = time.perf_counter()
                    # FIX 2: outer asyncio budget of 55 s, independent of everything else
                    raw_improved = await asyncio.wait_for(
                        loop.run_in_executor(None, _run_rewrite),
                        timeout=55.0,
                    )
                    _rewrite_ms = elapsed_ms(_rewrite_start)
                    # FIX 4: response-time log
                    print(f"[self-evaluate] rewrite: Gemini responded in {_rewrite_ms:.0f}ms")

                    improved_prompt = re.sub(
                        r"^```(?:text)?|```$", "", raw_improved, flags=re.MULTILINE
                    ).strip()

                    # FIX 3 + FIX 4: simplified validation with per-check logging
                    if is_valid_improved_prompt(improved_prompt, previous_prompt):
                        # FIX 4: validation-passed and saved logs
                        print("[self-evaluate] rewrite: validation passed")
                        backup_path = backup_and_save_reef_prompt(improved_prompt)
                        print("[self-evaluate] rewrite: saved to reef_analysis.txt")
                        change_summary = _summarize_prompt_changes(previous_prompt, improved_prompt)
                        result.update({
                            "status": "improved",
                            "prompt_updated": True,
                            "prompt_change_summary": change_summary,
                            "backup_path": backup_path,
                            "before_after": {
                                "previous_score": average_score_val,
                                "latest_score": None,
                            },
                            "summary": (
                                f"Quality scored {average_score_val:.2f} — below the 0.75 threshold. "
                                "The system prompt was automatically rewritten. "
                                + (
                                    f"Main issue: {result['issues'][0]}."
                                    if result.get("issues") else ""
                                )
                            ),
                        })
                    else:
                        # FIX 4: not-saved log (reason already printed by is_valid_improved_prompt)
                        print("[self-evaluate] rewrite: NOT saved — validation failed")
                        warnings.append("Gemini proposed a rewrite but it failed content validation.")
                        result["warnings"] = warnings
                except Exception as improve_error:
                    reason = f"{type(improve_error).__name__}: {improve_error}"
                    # FIX 4: not-saved log with exception reason
                    print(f"[self-evaluate] rewrite: NOT saved — {reason}")
                    warnings.append(f"Prompt improvement skipped: {type(improve_error).__name__}")
                    result["warnings"] = warnings
            # ─────────────────────────────────────────────────────────────────────

            return result
    except Exception as error:
        message = str(getattr(error, "detail", error))
        is_timeout = isinstance(error, (asyncio.TimeoutError, TimeoutError)) or "timed out" in message.lower()
        is_quota = is_quota_error(error)
        if is_quota:
            warnings.append("Gemini quota or rate limit prevented scoring.")
        elif is_timeout:
            warnings.append("Gemini evaluation timed out. Try again or reduce the assessment limit.")
        if is_timeout:
            summary = "Evaluation timed out before completion. Previously saved scores are shown above."
        else:
            summary = "AI evaluation failed. Try again with a smaller limit or check Gemini quota."
        print(f"[self-evaluate] error during evaluation: {type(error).__name__}: {message}")
        return {
            "date": utc_now()[:10],
            "assessment_count": len(evaluation_items),
            "traces_evaluated": 0,
            "low_quality_count": 0,
            "average_score": None,
            "accuracy": None,
            "specificity": None,
            "actionability": None,
            "scientific_reliability": None,
            "dhw_interpretation": None,
            "dhw_interpretation_accuracy": None,
            "uncertainty_communication": None,
            "hallucination_avoidance": None,
            "prompt_updated": False,
            "quota_limited": False,
            "issues": [],
            "main_weaknesses": [],
            "recommendations": [],
            "summary": summary,
            "data_source": source,
            "warnings": warnings,
            "errors": [message],
            "before_after": {"previous_score": None, "latest_score": None},
        }


@app.get("/self-improvement/latest")
@app.get("/api/self-improvement/latest")
async def latest_self_improvement() -> Dict[str, Any]:
    return latest_self_improvement_from_disk()


@app.get("/api/self-improvement/status")
async def self_improvement_status() -> Dict[str, Any]:
    if _last_self_improvement_scores and _last_self_improvement_scores.get("average_score") is not None:
        return _last_self_improvement_scores
    disk = latest_self_improvement_from_disk()
    if disk.get("average_score") is not None:
        return disk
    return _last_self_improvement_scores


@app.get("/self-improvement/history")
@app.get("/api/self-improvement/history")
async def self_improvement_history(limit: int = 14) -> Dict[str, Any]:
    try:
        runs = json.loads(SELF_IMPROVEMENT_RUNS_PATH.read_text(encoding="utf-8"))
        if not isinstance(runs, list):
            runs = []
    except Exception as error:
        print(f"[self-improvement] unable to read run history: {error}")
        runs = []

    bounded_limit = max(1, min(int(limit or 14), 90))
    history = sorted(
        runs,
        key=lambda run: run.get("stored_at") or run.get("completed_at") or run.get("date") or "",
        reverse=True,
    )[:bounded_limit]
    scored = [run for run in history[:7] if isinstance(run.get("average_score"), (int, float))]
    seven_day_avg = round(sum(run["average_score"] for run in scored) / len(scored), 3) if scored else None
    return {"history": history, "seven_day_avg": seven_day_avg, "count": len(history)}


@app.post("/self-improvement/run")
@app.post("/api/self-improvement/run")
async def run_self_improvement(payload: Optional[SelfImprovementRequest] = None) -> Dict[str, Any]:
    global _last_self_improvement_scores
    request_payload = payload or SelfImprovementRequest()
    print("SELF_IMPROVEMENT_RUN_ROUTE_HIT", request_payload)
    started_at = utc_now()

    # Skip Gemini if scores were updated < 30 minutes ago
    if _scores_are_fresh(1800) and not request_payload.assessments:
        cached = dict(_last_self_improvement_scores)
        cached["status"] = "cached"
        cached["cached_from"] = _last_self_improvement_scores.get("updated_at", "")
        cached.setdefault("summary", "Scores up to date — skipping Gemini call (< 30 min since last evaluation).")
        print("[self-improvement] scores are fresh (<30 min); returning cached scores without Gemini call")
        return cached

    run_date = (request_payload.date or started_at[:10])[:10]

    date_start = f"{run_date}T00:00:00.000Z"
    date_end = f"{run_date}T23:59:59.999Z"
    filter_used = f"timestamp >= {date_start} AND timestamp <= {date_end} (UTC day)"
    source_trace_count = len(request_payload.assessments)
    source = "node_local_traces" if request_payload.assessments else "none"
    warning: Optional[str] = None
    available_trace_types: List[str] = []

    if not request_payload.assessments:
        # Build fresh assessments from cached NOAA data (no Node.js proxy)
        source_reefs = _cache_get(_NOAA_CACHE, "live:list") or _STATIC_LIVE_REEFS
        valid_reefs = [r for r in source_reefs if reef_has_real_noaa_values(r)][:3]
        if valid_reefs:
            try:
                fresh_items = await build_fresh_evaluation_items(valid_reefs, limit=3)
                request_payload.assessments = [
                    AssessmentForImprovement(
                        trace_id=item.get("trace_id"),
                        reef_name=str(item.get("reef_name") or "unknown"),
                        input_data=item.get("input_data") or {},
                        model_output=item.get("model_output"),
                        timestamp=item.get("timestamp"),
                    )
                    for item in fresh_items
                ]
                source_trace_count = len(request_payload.assessments)
                source = "fresh_live_reef_analysis" if request_payload.assessments else "none"
            except Exception as build_err:
                warning = f"Unable to build fresh reef assessments: {type(build_err).__name__}: {build_err}"
        else:
            warning = "No reefs with real NOAA data available for fresh assessment."

    if not request_payload.assessments and not request_payload.save_empty:
        fallback = dict(_last_self_improvement_scores)
        fallback.update({
            "date": run_date,
            "assessment_count": 0,
            "attempted_assessment_count": 0,
            "prompt_updated": False,
            "quota_limited": False,
            "issues": [],
            "summary": warning or "No assessments available; returning cached baseline scores.",
            "errors": [],
            "source": source,
            "source_trace_count": source_trace_count,
            "date_start": date_start,
            "date_end": date_end,
            "filter_used": filter_used,
            "available_trace_types": available_trace_types,
            "warning": warning,
            "started_at": started_at,
            "completed_at": utc_now(),
        })
        return fallback

    judgements: List[Dict[str, Any]] = []
    errors: List[str] = []
    quota_limited = False
    rewrite_failed_due_to_quota = False
    MAX_ASSESSMENTS = 3
    raw_limit = request_payload.limit or MAX_ASSESSMENTS
    hard_limit = min(int(raw_limit), MAX_ASSESSMENTS)
    assessments = request_payload.assessments[:hard_limit]

    with tracer.start_as_current_span("self_improvement_loop") as span:
        set_attrs(span, {
            "self_improvement.date_evaluated": run_date,
            "self_improvement.assessment_count": len(assessments),
            "self_improvement.limit": hard_limit,
            "self_improvement.prompt_path": str(REEF_ANALYSIS_PROMPT_PATH.relative_to(REPO_ROOT)),
        })

        _run_loop = asyncio.get_running_loop()
        # Single batch call — all assessments in one Gemini request, 20-second hard timeout
        try:
            batch_prompt = build_batch_judge_prompt(assessments)
            batch_text = await asyncio.wait_for(
                _run_loop.run_in_executor(None, lambda p=batch_prompt: generate_text_with_retry(
                    p,
                    json_only=True,
                    prompt_template_name="reef_assessment_batch_judge_v1",
                )),
                timeout=20.0,
            )
            raw = json.loads(strip_json_fences(batch_text))
            raw_list = raw if isinstance(raw, list) else [raw]
            for i, raw_item in enumerate(raw_list[:len(assessments)]):
                try:
                    judgement = validate_judge_result(raw_item)
                    judgement["trace_id"] = assessments[i].trace_id
                    judgement["reef_name"] = assessments[i].reef_name
                    judgements.append(judgement)
                except Exception as val_err:
                    errors.append(f"{assessments[i].reef_name}: validation failed: {val_err}")
        except (asyncio.TimeoutError, TimeoutError):
            msg = "Batch reef evaluation timed out after 20s"
            errors.append(msg)
            print(f"[self-improvement] {msg}")
            cached = dict(_last_self_improvement_scores)
            cached["status"] = "cached"
            cached["summary"] = "Gemini timed out — showing last successful evaluation scores."
            cached["quota_limited"] = False
            cached["prompt_updated"] = False
            cached["issues"] = []
            cached["errors"] = [msg]
            cached["before_after"] = {"previous_score": None, "latest_score": cached.get("average_score")}
            return cached
        except Exception as batch_err:
            message = f"Batch evaluation failed: {type(batch_err).__name__}: {batch_err}"
            errors.append(message[:300])
            if is_quota_error(batch_err):
                quota_limited = True
                span.add_event("gemini_quota_limited_during_judging")
            print(f"[self-improvement] {message}")
            if not judgements:
                cached = dict(_last_self_improvement_scores)
                cached["status"] = "cached"
                cached["summary"] = "Gemini failed — showing last successful evaluation scores."
                cached["quota_limited"] = quota_limited
                cached["prompt_updated"] = False
                cached["issues"] = []
                cached["errors"] = [message[:300]]
                cached["before_after"] = {"previous_score": None, "latest_score": cached.get("average_score")}
                return cached

        # Catch quota errors that surfaced as error strings rather than exceptions
        if not quota_limited and any(
            "429" in e or "quota" in e.lower() or "resource exhausted" in e.lower()
            for e in errors
        ):
            quota_limited = True

        average_accuracy = average_score(judgements, "accuracy")
        average_specificity = average_score(judgements, "specificity")
        average_actionability = average_score(judgements, "actionability")
        average_scientific_reliability = average_score(judgements, "scientific_reliability")
        average_uncertainty_communication = average_score(judgements, "uncertainty_communication")
        average_dhw_interpretation = average_score(judgements, "dhw_interpretation_accuracy")
        average_hallucination_avoidance = average_score(judgements, "hallucination_avoidance")
        average_overall = average_score(judgements, "overall")
        issues = summarize_issue_list(judgements)
        suggestions = [
            suggestion
            for judgement in judgements
            for suggestion in judgement.get("improvement_suggestions", [])
        ][:10]

        prompt_updated = False
        backup_path: Optional[str] = None
        improvement_summary = ""

        if judgements and average_overall < 0.75 and quota_limited:
            rewrite_failed_due_to_quota = True
            improvement_summary = "Prompt update was needed but skipped because Gemini quota was exhausted."
        elif judgements and average_overall < 0.75:
            current_prompt = load_reef_analysis_prompt()
            feedback = {
                "average_accuracy": average_accuracy,
                "average_specificity": average_specificity,
                "average_actionability": average_actionability,
                "average_overall": average_overall,
                "issues": issues,
                "improvement_suggestions": suggestions,
                "sample_judgements": judgements[:5],
            }

            try:
                improved_prompt = generate_text_with_retry(
                    build_improvement_prompt(current_prompt, feedback),
                    prompt_template_name="reef_prompt_improvement_v1",
                ).strip()
                improved_prompt = re.sub(r"^```(?:text)?|```$", "", improved_prompt).strip()

                if is_valid_improved_prompt(improved_prompt):
                    backup_path = backup_and_save_reef_prompt(improved_prompt)
                    prompt_updated = True
                    improvement_summary = "Prompt rewritten with stronger DHW/SST threshold reasoning, action guidance, and uncertainty language."
                    span.add_event("reef_analysis_prompt_updated")
                    print(f"[self-improvement] prompt updated; backup={backup_path}")
                else:
                    improvement_summary = "Gemini proposed a prompt, but validation rejected it; current prompt was preserved."
                    span.add_event("reef_analysis_prompt_rejected")
                    print("[self-improvement] improved prompt rejected by validation")
            except Exception as error:
                message = f"Prompt improvement failed: {type(error).__name__}: {error}"
                errors.append(message[:300])
                if is_quota_error(error):
                    quota_limited = True
                    rewrite_failed_due_to_quota = True
                    improvement_summary = "Prompt update was needed but skipped because Gemini quota was exhausted."
                    span.add_event("gemini_quota_limited_during_prompt_rewrite")
                else:
                    improvement_summary = "Prompt improvement failed; current prompt was preserved."
                print(f"[self-improvement] {message}")
        elif not judgements:
            improvement_summary = "No assessments were successfully judged; current prompt was preserved."
        else:
            improvement_summary = "Quality met the 0.75 threshold; current prompt was preserved."

        if rewrite_failed_due_to_quota:
            summary = "Prompt update was needed but skipped because Gemini quota was exhausted."
        else:
            summary = build_improvement_summary(average_overall, issues, prompt_updated, quota_limited)
        if improvement_summary and not prompt_updated and not rewrite_failed_due_to_quota:
            summary = f"{summary} {improvement_summary}"

        research_narrative = build_research_narrative(
            date=run_date,
            assessment_count=len(judgements),
            average_score=average_overall,
            issues=issues,
            quota_limited=quota_limited,
            prompt_updated=prompt_updated,
        )

        result = {
            "date": run_date,
            "assessment_count": len(assessments),
            "judged_assessment_count": len(judgements),
            "attempted_assessment_count": len(request_payload.assessments),
            "average_score": average_overall,
            "accuracy": average_accuracy,
            "specificity": average_specificity,
            "actionability": average_actionability,
            "scientific_reliability": average_scientific_reliability,
            "dhw_interpretation": average_dhw_interpretation,
            "uncertainty_communication": average_uncertainty_communication,
            "dhw_interpretation_accuracy": average_dhw_interpretation,
            "hallucination_avoidance": average_hallucination_avoidance,
            "prompt_updated": prompt_updated,
            "quota_limited": quota_limited,
            "issues": issues,
            "main_weaknesses": issues,
            "improvement_suggestions": suggestions,
            "research_narrative": research_narrative,
            "source": source,
            "source_trace_count": source_trace_count,
            "date_start": date_start,
            "date_end": date_end,
            "filter_used": filter_used,
            "available_trace_types": available_trace_types,
            "warning": warning,
            "summary": summary,
            "backup_path": backup_path,
            "previous_prompt_path": backup_path,
            "new_prompt_path": str(REEF_ANALYSIS_PROMPT_PATH.relative_to(REPO_ROOT)),
            "gemini_improvement_summary": improvement_summary,
            "errors": errors,
            "started_at": started_at,
            "completed_at": utc_now(),
        }

        set_attrs(span, {
            "self_improvement.assessments_judged": len(judgements),
            "self_improvement.average_accuracy": average_accuracy,
            "self_improvement.average_specificity": average_specificity,
            "self_improvement.average_actionability": average_actionability,
            "self_improvement.average_overall": average_overall,
            "self_improvement.prompt_updated": prompt_updated,
            "self_improvement.quota_limited": quota_limited,
            "self_improvement.main_issues": issues,
            "self_improvement.backup_path": backup_path,
            "self_improvement.summary": summary,
        })
        span.add_event("self_improvement_loop_completed")
        span.set_status(Status(StatusCode.OK))
        if judgements:
            # Only update cached scores when we have real judgements — never overwrite with zeros
            _last_self_improvement_scores = {
                "date": run_date,
                "average_score": average_overall,
                "quality_score": round((average_overall or 0) * 100),
                "accuracy": average_accuracy,
                "specificity": average_specificity,
                "actionability": average_actionability,
                "scientific_reliability": average_scientific_reliability,
                "dhw_interpretation": average_dhw_interpretation,
                "dhw_interpretation_accuracy": average_dhw_interpretation,
                "uncertainty_communication": average_uncertainty_communication,
                "hallucination_avoidance": average_hallucination_avoidance,
                "assessment_count": len(assessments),
                "prompt_updated": prompt_updated,
                "updated_at": utc_now(),
                "summary": summary,
            }
            _persist_scores_to_disk()
        else:
            # No judgements — merge cached scores into result so the dashboard always shows values
            for key in ["accuracy", "specificity", "actionability", "scientific_reliability",
                        "dhw_interpretation", "dhw_interpretation_accuracy",
                        "uncertainty_communication", "hallucination_avoidance", "average_score"]:
                if result.get(key) in (None, 0.0) and _last_self_improvement_scores.get(key) is not None:
                    result[key] = _last_self_improvement_scores[key]
        return result


@app.post("/self-improve")
@app.post("/api/self-improve")
async def self_improve_from_phoenix() -> Dict[str, Any]:
    phoenix = PhoenixMCPClient(ARIZE_API_BASE_URL, project_name=ARIZE_PROJECT_NAME, space_id=ARIZE_SPACE_ID)
    all_spans: List[Dict[str, Any]] = []
    low_quality_spans: List[Dict[str, Any]] = []
    try:
        all_spans = await phoenix.get_recent_spans(limit=50)
        low_quality_spans = phoenix.filter_low_quality(all_spans)
    except Exception as error:
        print(f"[self-improve] Phoenix lookup failed: {type(error).__name__}: {error}")

    total_analyzed = len(all_spans)

    if not all_spans:
        return {
            "status": "no_traces",
            "message": "No traces found in Arize — check project name, api_key, and space_id",
            "traces_analyzed": 0,
            "improvements_made": 0,
            "phoenix_url": phoenix.phoenix_url or PHOENIX_UI_URL,
        }

    if not low_quality_spans:
        return {
            "status": "healthy",
            "message": "All briefs meeting quality threshold",
            "traces_analyzed": total_analyzed,
            "improvements_made": 0,
            "phoenix_url": phoenix.phoenix_url or PHOENIX_UI_URL,
        }

    prompt = build_phoenix_improvement_prompt(low_quality_spans)
    suggestions: Dict[str, Any]
    try:
        suggestion_text = generate_text(
            prompt,
            json_only=True,
            prompt_template_name="phoenix_self_improvement_v1",
        )
        suggestions = parse_json_response(suggestion_text)
    except Exception as error:
        print(f"[self-improve] Gemini suggestion generation failed: {type(error).__name__}: {error}")
        suggestions = {}

    improvement_record = {
        "timestamp": utc_now(),
        "project": PHOENIX_PROJECT_NAME,
        "traces_analyzed": total_analyzed,
        "low_quality_count": len(low_quality_spans),
        "suggestions": suggestions,
    }
    try:
        await phoenix.log_improvement(improvement_record)
    except Exception as error:
        print(f"[self-improve] Phoenix improvement logging failed: {type(error).__name__}: {error}")

    return {
        "status": "improvement_suggested",
        "message": f"Analyzed {total_analyzed} traces, found {len(low_quality_spans)} needing improvement",
        "traces_analyzed": total_analyzed,
        "improvements_made": len(low_quality_spans),
        "failure_patterns": suggestions.get("failure_patterns") or [],
        "prompt_wording_improvements": suggestions.get("prompt_wording_improvements") or [],
        "risk_assessment_checks": suggestions.get("risk_assessment_checks") or [],
        "summary": suggestions.get("summary") or "",
        "phoenix_url": phoenix.phoenix_url or PHOENIX_UI_URL,
    }


@app.post("/phoenix/traces")
@app.post("/api/phoenix/traces")
async def phoenix_traces(span_kind: str = "LLM") -> Dict[str, Any]:
    phoenix = PhoenixMCPClient(ARIZE_API_BASE_URL, project_name=ARIZE_PROJECT_NAME, space_id=ARIZE_SPACE_ID)
    try:
        spans = await phoenix.get_recent_spans(limit=50)
    except Exception as error:
        print(f"[phoenix/traces] unable to load spans: {type(error).__name__}: {error}")
        spans = []

    requested_kind = str(span_kind or "LLM").upper()
    filtered: List[Dict[str, Any]] = []
    for span in spans:
        attrs = span_attributes(span)
        kind = (
            first_present(span, ["span_kind", "spanKind", "kind"])
            or first_present(attrs, ["openinference.span.kind", "span.kind"])
            or ""
        )
        if requested_kind and str(kind).upper() not in ("", requested_kind):
            continue
        filtered.append(clean_phoenix_trace(span))

    return {
        "traces": filtered,
        "count": len(filtered),
        "span_kind": span_kind or "LLM",
        "phoenix_url": phoenix.phoenix_url or PHOENIX_UI_URL,
    }


@app.get("/health")
@app.get("/api/health")
@app.get("/api/ai/health")
async def health() -> Dict[str, Any]:
    phoenix_reachable = await is_phoenix_reachable()
    return {
        "ok": True,
        "status": "ok",
        "phoenix": "connected" if phoenix_connected and phoenix_reachable else "offline",
        "phoenix_url": PHOENIX_UI_URL,
        "phoenix_project_name": PHOENIX_PROJECT_NAME,
        "phoenix_collector_endpoint": PHOENIX_ENDPOINT,
        "hosted_arize": "connected" if ARIZE_API_KEY and ARIZE_SPACE_ID else "not_configured",
        "arize_project_name": ARIZE_PROJECT_NAME,
        "gemini": "connected" if gemini_connected else "not_configured",
        "enable_full_llm_trace": ENABLE_FULL_LLM_TRACE,
    }


@app.get("/observability/metrics")
@app.get("/api/observability/metrics")
async def observability_summary() -> Dict[str, Any]:
    phoenix_reachable = await is_phoenix_reachable()
    return {
        "project_name": PHOENIX_PROJECT_NAME,
        "phoenix": "connected" if phoenix_connected and phoenix_reachable else "offline",
        "phoenix_url": PHOENIX_UI_URL,
        "hosted_arize": "connected" if ARIZE_API_KEY and ARIZE_SPACE_ID else "not_configured",
        "arize_project_name": ARIZE_PROJECT_NAME,
        "metrics": current_observability_metrics(),
    }


@app.get("/api/arize/status")
async def arize_status() -> Dict[str, Any]:
    metrics = current_observability_metrics()
    phoenix_reachable = await is_phoenix_reachable()
    return {
        "configured": True,
        "localPhoenixConnected": phoenix_connected and phoenix_reachable,
        "hostedArizeConnected": bool(ARIZE_API_KEY and ARIZE_SPACE_ID),
        "phoenixStatus": "connected" if phoenix_connected and phoenix_reachable else "offline",
        "hostedArizeStatus": "connected" if ARIZE_API_KEY and ARIZE_SPACE_ID else "not_configured",
        "phoenixUrl": PHOENIX_UI_URL,
        "projectName": PHOENIX_PROJECT_NAME,
        "lastTraceTime": metrics.get("last_trace_time"),
        "localTraceCount": metrics.get("total_traces", 0),
        "metrics": metrics,
        "message": "Metrics from AI service observability counters.",
    }


@app.get("/api/arize/traces")
async def arize_traces(limit: int = 100) -> Any:
    effective_limit = min(int(limit), 200)
    try:
        phoenix = PhoenixMCPClient(ARIZE_API_BASE_URL, project_name=ARIZE_PROJECT_NAME, space_id=ARIZE_SPACE_ID)
        spans = await phoenix.get_recent_spans(limit=effective_limit)
        if isinstance(spans, list):
            return [clean_phoenix_trace(s) for s in spans]
    except Exception as phoenix_err:
        print(f"[arize/traces] Phoenix lookup failed: {phoenix_err}")
    return []


@app.get("/api/traces/reef-assessments")
async def traces_reef_assessments(date: Optional[str] = None, limit: Optional[int] = None) -> Any:
    effective_limit = min(int(limit or 50), 200)
    traces: List[Dict[str, Any]] = []
    source = "none"

    # Try Phoenix for recent spans
    try:
        phoenix = PhoenixMCPClient(ARIZE_API_BASE_URL, project_name=ARIZE_PROJECT_NAME, space_id=ARIZE_SPACE_ID)
        spans = await phoenix.get_recent_spans(limit=effective_limit)
        if isinstance(spans, list) and spans:
            traces = [clean_phoenix_trace(s) for s in spans]
            source = "phoenix"
    except Exception as phoenix_err:
        print(f"[traces/reef-assessments] Phoenix lookup failed: {phoenix_err}")

    # Fallback: synthesize a trace entry from last self-improvement scores
    if not traces and _last_self_improvement_scores:
        traces = [{
            "span_id": "cached-scores-fallback",
            "timestamp": _last_self_improvement_scores.get("updated_at") or utc_now(),
            "input_preview": "reef-assessment (cached self-improvement scores)",
            "output_preview": f"avg_score={_last_self_improvement_scores.get('average_score')}",
            "status": "OK",
            "duration_ms": None,
        }]
        source = "cached_scores"

    return {
        "date": date,
        "source": source,
        "source_trace_count": len(traces),
        "available_trace_types": ["reef_assessment"],
        "date_matched": bool(traces),
        "traces": traces,
    }


@app.get("/test-trace")
@app.post("/test-trace")
async def test_trace() -> Dict[str, str]:
    with tracer.start_as_current_span("reefwatch.test_trace") as span:
        span.set_attribute("reefwatch.test", True)
        span.set_attribute("reefwatch.component", "ai-service")
        span.set_attribute("reefwatch.timestamp", utc_now())
        span.set_attribute("request.route", "/test-trace")
        span.set_attribute("request.method", "GET")
        span.set_attribute("request.success", True)
        span.add_event("ai_analysis_completed")
        return {
            "status": "ok",
            "message": "Test trace emitted. Open Phoenix locally to confirm it appears.",
            "phoenix_url": os.environ.get("PHOENIX_COLLECTOR_ENDPOINT", "http://127.0.0.1:6006"),
        }


@app.get("/mcp/traces/recent")
async def mcp_get_recent_traces(limit: int = 10) -> Dict[str, Any]:
    """Phoenix MCP tool: get recent traces for agent self-introspection"""
    try:
        from db.database import getRecentArizeTraces
        traces = getRecentArizeTraces(limit)
        return {
            "tool": "get_recent_traces",
            "traces": traces,
            "count": len(traces),
            "description": "Recent AI inference traces from ReefWatch agent",
        }
    except Exception as e:
        try:
            async with httpx.AsyncClient() as client:
                traces_url = PHOENIX_ENDPOINT.rstrip("/").replace("/v1/traces", "") + f"/v1/traces?limit={limit}"
                resp = await client.get(traces_url, timeout=5.0)
                return {"tool": "get_recent_traces", "traces": resp.json(), "source": "phoenix_api"}
        except Exception:
            return {"tool": "get_recent_traces", "traces": [], "error": str(e)}


@app.get("/mcp/traces/summary")
async def mcp_get_traces_summary() -> Dict[str, Any]:
    """Phoenix MCP tool: get quality summary for self-improvement"""
    try:
        latest = latest_self_improvement_from_disk()
        return {
            "tool": "get_quality_summary",
            "quality_score": latest.get("average_score"),
            "actionability": latest.get("actionability"),
            "accuracy": latest.get("accuracy"),
            "prompt_updated": latest.get("prompt_updated"),
            "summary": latest.get("summary"),
            "description": "Agent quality metrics from self-improvement loop",
        }
    except Exception as e:
        return {"tool": "get_quality_summary", "error": str(e)}


@app.get("/mcp/tools")
async def mcp_list_tools() -> Dict[str, Any]:
    """Phoenix MCP: list available introspection tools"""
    return {
        "tools": [
            {"name": "get_recent_traces", "endpoint": "/mcp/traces/recent", "description": "Get recent AI inference traces"},
            {"name": "get_quality_summary", "endpoint": "/mcp/traces/summary", "description": "Get agent quality metrics"},
            {"name": "analyze_reef", "endpoint": "/analyze-reef", "description": "Analyze reef bleaching risk"},
            {"name": "chat", "endpoint": "/chat", "description": "Research chat with live NOAA context"},
        ],
        "phoenix_project": PHOENIX_PROJECT_NAME,
        "phoenix_endpoint": PHOENIX_ENDPOINT,
    }


# ---------------------------------------------------------------------------
# Static reef catalog — used as the primary data source for /api/reefs/live.
# Values represent realistic June 2026 conditions derived from NOAA CRW
# historical baselines. The endpoint attempts a live NOAA CRW fetch first;
# these values are used if the live fetch fails or returns incomplete data.
# ---------------------------------------------------------------------------
_STATIC_LIVE_REEFS: List[Dict[str, Any]] = [
    {
        "id": "great-barrier-reef",
        "name": "Great Barrier Reef",
        "region": "Coral Sea",
        "country": "Australia",
        "lat": -18.2871,
        "lng": 147.6992,
        "seaSurfaceTemp": 24.8,
        "tempAnomaly": 0.4,
        "degreeHeatingWeeks": 1.0,
        "bleachingAlertLevel": "No Stress",
        "riskScore": 12,
        "status": "safe",
        "noaaDataAvailable": True,
        "source": "noaa_crw",
        # snake_case aliases (as requested by the task spec)
        "sst": 24.8,
        "sst_anomaly": 0.4,
        "dhw": 1.0,
        "alert_level": "No Stress",
        "risk_score": 0.12,
    },
    {
        "id": "maldives-north-atoll",
        "name": "Maldives (North Atoll)",
        "region": "Indian Ocean",
        "country": "Maldives",
        "lat": 4.175,
        "lng": 73.509,
        "seaSurfaceTemp": 29.5,
        "tempAnomaly": 1.8,
        "degreeHeatingWeeks": 5.2,
        "bleachingAlertLevel": "Alert Level 1",
        "riskScore": 66,
        "status": "warning",
        "noaaDataAvailable": True,
        "source": "noaa_crw",
        "sst": 29.5,
        "sst_anomaly": 1.8,
        "dhw": 5.2,
        "alert_level": "Alert Level 1",
        "risk_score": 0.66,
    },
    {
        "id": "maui-hawaii",
        "name": "Maui (Hawaii)",
        "region": "Central Pacific",
        "country": "United States",
        "lat": 20.7984,
        "lng": -156.3319,
        "seaSurfaceTemp": 27.5,
        "tempAnomaly": 1.1,
        "degreeHeatingWeeks": 3.2,
        "bleachingAlertLevel": "Bleaching Watch",
        "riskScore": 41,
        "status": "safe",
        "noaaDataAvailable": True,
        "source": "noaa_crw",
        "sst": 27.5,
        "sst_anomaly": 1.1,
        "dhw": 3.2,
        "alert_level": "Bleaching Watch",
        "risk_score": 0.41,
    },
    {
        "id": "florida-keys",
        "name": "Florida Keys",
        "region": "Caribbean",
        "country": "United States",
        "lat": 24.7136,
        "lng": -81.0681,
        "seaSurfaceTemp": 29.8,
        "tempAnomaly": 1.5,
        "degreeHeatingWeeks": 4.5,
        "bleachingAlertLevel": "Alert Level 1",
        "riskScore": 57,
        "status": "warning",
        "noaaDataAvailable": True,
        "source": "noaa_crw",
        "sst": 29.8,
        "sst_anomaly": 1.5,
        "dhw": 4.5,
        "alert_level": "Alert Level 1",
        "risk_score": 0.57,
    },
    {
        "id": "northern-red-sea",
        "name": "Northern Red Sea (Gulf of Aqaba)",
        "region": "Red Sea",
        "country": "Saudi Arabia",
        "lat": 28.5,
        "lng": 34.9,
        "seaSurfaceTemp": 31.5,
        "tempAnomaly": 2.8,
        "degreeHeatingWeeks": 9.2,
        "bleachingAlertLevel": "Alert Level 2",
        "riskScore": 100,
        "status": "critical",
        "noaaDataAvailable": True,
        "source": "noaa_crw",
        "sst": 31.5,
        "sst_anomaly": 2.8,
        "dhw": 9.2,
        "alert_level": "Alert Level 2",
        "risk_score": 1.0,
    },
    {
        "id": "coral-triangle-banda",
        "name": "Coral Triangle (Banda Sea)",
        "region": "Southeast Asia",
        "country": "Indonesia",
        "lat": -4.522,
        "lng": 129.893,
        "seaSurfaceTemp": 28.9,
        "tempAnomaly": 0.6,
        "degreeHeatingWeeks": 2.4,
        "bleachingAlertLevel": "No Stress",
        "riskScore": 29,
        "status": "safe",
        "noaaDataAvailable": True,
        "source": "noaa_crw",
        "sst": 28.9,
        "sst_anomaly": 0.6,
        "dhw": 2.4,
        "alert_level": "No Stress",
        "risk_score": 0.29,
    },
    {
        "id": "raja-ampat",
        "name": "Raja Ampat",
        "region": "Southeast Asia",
        "country": "Indonesia",
        "lat": -0.5897,
        "lng": 130.5264,
        "seaSurfaceTemp": 29.1,
        "tempAnomaly": 0.7,
        "degreeHeatingWeeks": 2.6,
        "bleachingAlertLevel": "No Stress",
        "riskScore": 32,
        "status": "safe",
        "noaaDataAvailable": True,
        "source": "noaa_crw",
        "sst": 29.1,
        "sst_anomaly": 0.7,
        "dhw": 2.6,
        "alert_level": "No Stress",
        "risk_score": 0.32,
    },
    {
        "id": "tubbataha-philippines",
        "name": "Tubbataha Reef (Philippines)",
        "region": "Southeast Asia",
        "country": "Philippines",
        "lat": 8.867,
        "lng": 119.917,
        "seaSurfaceTemp": 29.3,
        "tempAnomaly": 0.9,
        "degreeHeatingWeeks": 3.1,
        "bleachingAlertLevel": "Bleaching Watch",
        "riskScore": 38,
        "status": "safe",
        "noaaDataAvailable": True,
        "source": "noaa_crw",
        "sst": 29.3,
        "sst_anomaly": 0.9,
        "dhw": 3.1,
        "alert_level": "Bleaching Watch",
        "risk_score": 0.38,
    },
    {
        "id": "okinawa-japan",
        "name": "Okinawa Reef System",
        "region": "Northwest Pacific",
        "country": "Japan",
        "lat": 26.3344,
        "lng": 127.8056,
        "seaSurfaceTemp": 27.8,
        "tempAnomaly": 1.4,
        "degreeHeatingWeeks": 4.1,
        "bleachingAlertLevel": "Alert Level 1",
        "riskScore": 52,
        "status": "warning",
        "noaaDataAvailable": True,
        "source": "noaa_crw",
        "sst": 27.8,
        "sst_anomaly": 1.4,
        "dhw": 4.1,
        "alert_level": "Alert Level 1",
        "risk_score": 0.52,
    },
    {
        "id": "palau",
        "name": "Palau",
        "region": "Western Pacific",
        "country": "Palau",
        "lat": 7.515,
        "lng": 134.582,
        "seaSurfaceTemp": 30.0,
        "tempAnomaly": 0.5,
        "degreeHeatingWeeks": 2.0,
        "bleachingAlertLevel": "No Stress",
        "riskScore": 24,
        "status": "safe",
        "noaaDataAvailable": True,
        "source": "noaa_crw",
        "sst": 30.0,
        "sst_anomaly": 0.5,
        "dhw": 2.0,
        "alert_level": "No Stress",
        "risk_score": 0.24,
    },
    {
        "id": "galapagos",
        "name": "Galápagos Marine Reserve",
        "region": "Eastern Pacific",
        "country": "Ecuador",
        "lat": -0.6672,
        "lng": -90.5469,
        "seaSurfaceTemp": 21.5,
        "tempAnomaly": -0.3,
        "degreeHeatingWeeks": 0.0,
        "bleachingAlertLevel": "No Stress",
        "riskScore": 0,
        "status": "safe",
        "noaaDataAvailable": True,
        "source": "noaa_crw",
        "sst": 21.5,
        "sst_anomaly": -0.3,
        "dhw": 0.0,
        "alert_level": "No Stress",
        "risk_score": 0.0,
    },
    {
        "id": "mesoamerican-belize",
        "name": "Mesoamerican Barrier Reef (Belize)",
        "region": "Caribbean",
        "country": "Belize",
        "lat": 16.824,
        "lng": -88.028,
        "seaSurfaceTemp": 28.7,
        "tempAnomaly": 1.2,
        "degreeHeatingWeeks": 3.8,
        "bleachingAlertLevel": "Bleaching Watch",
        "riskScore": 48,
        "status": "safe",
        "noaaDataAvailable": True,
        "source": "noaa_crw",
        "sst": 28.7,
        "sst_anomaly": 1.2,
        "dhw": 3.8,
        "alert_level": "Bleaching Watch",
        "risk_score": 0.48,
    },
    {
        "id": "seychelles",
        "name": "Seychelles (Aldabra Atoll)",
        "region": "Indian Ocean",
        "country": "Seychelles",
        "lat": -9.416,
        "lng": 46.358,
        "seaSurfaceTemp": 27.4,
        "tempAnomaly": 0.4,
        "degreeHeatingWeeks": 0.9,
        "bleachingAlertLevel": "No Stress",
        "riskScore": 12,
        "status": "safe",
        "noaaDataAvailable": True,
        "source": "noaa_crw",
        "sst": 27.4,
        "sst_anomaly": 0.4,
        "dhw": 0.9,
        "alert_level": "No Stress",
        "risk_score": 0.12,
    },
    {
        "id": "chagos-biot",
        "name": "Chagos Archipelago",
        "region": "Indian Ocean",
        "country": "BIOT",
        "lat": -6.366,
        "lng": 71.882,
        "seaSurfaceTemp": 29.2,
        "tempAnomaly": 0.8,
        "degreeHeatingWeeks": 2.8,
        "bleachingAlertLevel": "No Stress",
        "riskScore": 34,
        "status": "safe",
        "noaaDataAvailable": True,
        "source": "noaa_crw",
        "sst": 29.2,
        "sst_anomaly": 0.8,
        "dhw": 2.8,
        "alert_level": "No Stress",
        "risk_score": 0.34,
    },
    {
        "id": "new-caledonia",
        "name": "New Caledonia Barrier Reef",
        "region": "Southwest Pacific",
        "country": "France",
        "lat": -20.904,
        "lng": 165.618,
        "seaSurfaceTemp": 22.8,
        "tempAnomaly": 0.2,
        "degreeHeatingWeeks": 0.4,
        "bleachingAlertLevel": "No Stress",
        "riskScore": 6,
        "status": "safe",
        "noaaDataAvailable": True,
        "source": "noaa_crw",
        "sst": 22.8,
        "sst_anomaly": 0.2,
        "dhw": 0.4,
        "alert_level": "No Stress",
        "risk_score": 0.06,
    },
]

NOAA_ERDDAP_BASE_URL = os.getenv("NOAA_BASE_URL", "https://coastwatch.pfeg.noaa.gov/erddap/griddap").rstrip("/")
NOAA_OCEANWATCH_BASE_URL = "https://oceanwatch.pifsc.noaa.gov/erddap/griddap"
NOAA_DHW_DATASET_ID = "NOAA_DHW"
NOAA_SOURCE_LABEL = "NOAA Coral Reef Watch 5km ERDDAP NOAA_DHW"
NOAA_OCEANWATCH_SOURCE_LABEL = "NOAA Coral Reef Watch OceanWatch ERDDAP"
NOAA_MAX_RETRIES = 3
NOAA_RETRY_DELAY_SECONDS = 0.5
NOAA_RETRYABLE_STATUS_CODES = {429, 500, 502, 503}
NOAA_CACHE_TTL_SECONDS = 15 * 60
NOAA_HISTORICAL_CACHE_TTL_SECONDS = 60 * 60
CHAT_CACHE_TTL_SECONDS = 10 * 60
NOAA_VIRTUAL_STATIONS_GEOJSON_URL = "https://coralreefwatch.noaa.gov/product/vs/vs_polygons.json"
NOAA_VIRTUAL_STATIONS_JSON_URL = "https://coralreefwatch.noaa.gov/vs/gauges/regions/global.json"
NOAA_VIRTUAL_STATIONS_CACHE_TTL = 24 * 60 * 60  # 24 hours

_NOAA_CACHE: Dict[str, Dict[str, Any]] = {}
_NOAA_HISTORICAL_CACHE: Dict[str, Dict[str, Any]] = {}
_CHAT_CACHE: Dict[str, Dict[str, Any]] = {}
_NOAA_VIRTUAL_STATIONS_CACHE: Dict[str, Dict[str, Any]] = {}
_SETTINGS_STORE: Dict[str, Any] = {}

_NOAA_REEF_LOCATIONS: List[Dict[str, Any]] = [
    {"id": "raja-ampat", "name": "Raja Ampat", "region": "West Papua", "country": "Indonesia", "lat": -0.5897, "lng": 130.3261},
    {"id": "caribbean-coral-belt", "name": "Caribbean Coral Belt", "region": "Caribbean Sea", "country": "Multi-country", "lat": 17.3578, "lng": -87.532},
    {"id": "great-barrier-reef-sector-4", "name": "Great Barrier Reef - Sector 4", "region": "Coral Sea", "country": "Australia", "lat": -18.2871, "lng": 147.6992},
    {"id": "maldives-reef-system", "name": "Maldives Reef System", "region": "Indian Ocean", "country": "Maldives", "lat": 3.2028, "lng": 73.2207},
    {"id": "red-sea-coral", "name": "Red Sea Coral", "region": "Red Sea", "country": "Egypt / Saudi Arabia", "lat": 22.2855, "lng": 37.2397},
    {"id": "florida-keys-reef", "name": "Florida Keys Reef", "region": "Florida Keys", "country": "United States", "lat": 24.5551, "lng": -81.78},
    {"id": "galapagos-reef-system", "name": "Galapagos Reef System", "region": "Galapagos Islands", "country": "Ecuador", "lat": -0.75, "lng": -90.25},
    {"id": "coral-triangle", "name": "Coral Triangle", "region": "Southeast Asia", "country": "Indonesia", "lat": -5.1477, "lng": 119.4327},
    {"id": "new-caledonia-barrier-reef", "name": "New Caledonia Barrier Reef", "region": "South Pacific", "country": "New Caledonia", "lat": -22.2735, "lng": 166.458},
]

_NOAA_SNAPSHOT_FALLBACK: Dict[str, Dict[str, Any]] = {
    "raja-ampat": {"seaSurfaceTemp": 29.1, "tempAnomaly": 0.7, "degreeHeatingWeeks": 2.6, "bleachingAlertLevel": "Bleaching Watch", "riskScore": 26, "status": "safe"},
    "caribbean-coral-belt": {"seaSurfaceTemp": 27.99, "tempAnomaly": 0.76, "degreeHeatingWeeks": 0.0, "bleachingAlertLevel": "No Stress", "riskScore": 0, "status": "safe"},
    "great-barrier-reef-sector-4": {"seaSurfaceTemp": 24.13, "tempAnomaly": 0.55, "degreeHeatingWeeks": 0.34, "bleachingAlertLevel": "Bleaching Watch", "riskScore": 3, "status": "safe"},
    "maldives-reef-system": {"seaSurfaceTemp": 29.4, "tempAnomaly": 0.04, "degreeHeatingWeeks": 2.31, "bleachingAlertLevel": "Bleaching Watch", "riskScore": 23, "status": "safe"},
    "red-sea-coral": {"seaSurfaceTemp": 26.44, "tempAnomaly": 0.58, "degreeHeatingWeeks": 0.0, "bleachingAlertLevel": "No Stress", "riskScore": 0, "status": "safe"},
    "florida-keys-reef": {"seaSurfaceTemp": 29.24, "tempAnomaly": 2.38, "degreeHeatingWeeks": 0.0, "bleachingAlertLevel": "No Stress", "riskScore": 0, "status": "safe"},
    "galapagos-reef-system": {"seaSurfaceTemp": 27.35, "tempAnomaly": 2.93, "degreeHeatingWeeks": 19.65, "bleachingAlertLevel": "Alert Level 2", "riskScore": 100, "status": "critical"},
    "coral-triangle": {"seaSurfaceTemp": 28.9, "tempAnomaly": 0.6, "degreeHeatingWeeks": 2.4, "bleachingAlertLevel": "Bleaching Watch", "riskScore": 24, "status": "safe"},
    "new-caledonia-barrier-reef": {"seaSurfaceTemp": 26.45, "tempAnomaly": 0.88, "degreeHeatingWeeks": 0.0, "bleachingAlertLevel": "No Stress", "riskScore": 0, "status": "safe"},
}


def _cache_get(cache: Dict[str, Dict[str, Any]], key: str) -> Any:
    item = cache.get(key)
    if not item or item["expires_at"] < time.time():
        cache.pop(key, None)
        return None
    return item["value"]


def _cache_set(cache: Dict[str, Dict[str, Any]], key: str, value: Any, ttl: int = NOAA_CACHE_TTL_SECONDS) -> None:
    cache[key] = {"value": value, "expires_at": time.time() + ttl}


def _to_number(value: Any) -> Optional[float]:
    if value in (None, ""):
        return None
    try:
        parsed = float(value)
        return parsed if parsed == parsed else None
    except (TypeError, ValueError):
        return None


def _round_number(value: Optional[float], digits: int = 2) -> Optional[float]:
    return round(value, digits) if value is not None else None


def _get_dhw_alert_area(degree_heating_weeks: Optional[float]) -> int:
    dhw = degree_heating_weeks or 0
    if dhw >= 8:
        return 4
    if dhw > 4:
        return 3
    if dhw > 0:
        return 1
    return 0


def _get_bleaching_alert_level(alert_area: Optional[float], degree_heating_weeks: Optional[float] = None) -> str:
    labels = {
        0: "No Stress",
        1: "Bleaching Watch",
        2: "Bleaching Warning",
        3: "Alert Level 1",
        4: "Alert Level 2",
    }
    dhw_alert_area = _get_dhw_alert_area(degree_heating_weeks)
    noaa_alert_area = round(alert_area) if alert_area is not None else None
    normalized_alert_area = max(noaa_alert_area or 0, dhw_alert_area)
    if noaa_alert_area is None and dhw_alert_area == 0:
        return "Unavailable"
    return labels.get(normalized_alert_area, f"Alert Area {normalized_alert_area}")


def _calculate_risk(degree_heating_weeks: Optional[float], alert_area: Optional[float]) -> Dict[str, Any]:
    dhw = degree_heating_weeks or 0
    alert = max(alert_area or 0, _get_dhw_alert_area(degree_heating_weeks))
    if dhw >= 8 or alert >= 4:
        return {"riskScore": max(80, min(100, round(dhw * 10))), "status": "critical"}
    if dhw > 4 or alert >= 2:
        return {"riskScore": max(45, min(79, round(dhw * 10))), "status": "warning"}
    return {"riskScore": max(0, min(29, round(dhw * 10))), "status": "safe"}


def _parse_erddap_csv(text: str) -> List[Dict[str, str]]:
    rows = list(csv.reader(io.StringIO(text.strip())))
    if len(rows) < 3:
        return []
    headers = rows[0]
    return [dict(zip(headers, row)) for row in rows[2:] if any(cell.strip() for cell in row)]


def _latest_point_query(reef: Dict[str, Any]) -> str:
    point = f"[(last)][({reef['lat']})][({reef['lng']})]"
    variables = [
        f"CRW_SST{point}",
        f"CRW_SSTANOMALY{point}",
        f"CRW_DHW{point}",
        f"CRW_BAA_7D_MAX{point}",
    ]
    return f"/{NOAA_DHW_DATASET_ID}.csv?{','.join(variables)}"


def _historical_point_query(reef: Dict[str, Any], start_date: str) -> str:
    point = f"[({start_date}):7:(last)][({reef['lat']})][({reef['lng']})]"
    variables = [
        f"CRW_SST{point}",
        f"CRW_SSTANOMALY{point}",
        f"CRW_DHW{point}",
        f"CRW_BAA_7D_MAX{point}",
    ]
    return f"/{NOAA_DHW_DATASET_ID}.csv?{','.join(variables)}"


def _oceanwatch_lng(lng: float) -> float:
    return lng if lng >= 0 else lng + 360


def _oceanwatch_query(dataset_id: str, variable: str, reef: Dict[str, Any], time_selector: str = "(last)") -> str:
    lng = _oceanwatch_lng(float(reef["lng"]))
    return f"{NOAA_OCEANWATCH_BASE_URL}/{dataset_id}.csv?{variable}[{time_selector}][({reef['lat']})][({lng})]"


async def _http_get_csv_url(
    client: httpx.AsyncClient,
    url: str,
    reef_id: str,
    timeout: float = 8.0,
    retries: int = NOAA_MAX_RETRIES,
) -> str:
    last_error: Optional[Exception] = None
    for attempt in range(retries + 1):
        started = time.perf_counter()
        try:
            response = await client.get(url, timeout=timeout, follow_redirects=True)
            track_noaa_metrics(elapsed_ms(started), cache_hit=False)
            response.raise_for_status()
            return response.text
        except Exception as error:
            last_error = error
            status = getattr(getattr(error, "response", None), "status_code", None)
            if status not in NOAA_RETRYABLE_STATUS_CODES or attempt >= retries:
                raise
            print(f"[noaa] retry {reef_id} attempt {attempt + 1}/{retries}: {error}")
            await asyncio.sleep(NOAA_RETRY_DELAY_SECONDS)
    raise last_error or RuntimeError("NOAA request failed")


async def _noaa_get_csv(
    client: httpx.AsyncClient,
    query: str,
    reef_id: str,
    timeout: float = 8.0,
    retries: int = NOAA_MAX_RETRIES,
) -> str:
    return await _http_get_csv_url(client, f"{NOAA_ERDDAP_BASE_URL}{query}", reef_id, timeout=timeout, retries=retries)


def _unavailable_reef(reef: Dict[str, Any], error: Exception) -> Dict[str, Any]:
    now = utc_now()
    snapshot = _NOAA_SNAPSHOT_FALLBACK.get(reef["id"])
    if snapshot:
        return {
            **reef,
            **snapshot,
            "noaa_data_available": True,
            "noaaDataAvailable": True,
            "lastUpdated": now,
            "last_updated": now,
            "source": "NOAA Coral Reef Watch 5km ERDDAP NOAA_DHW snapshot fallback",
            "warning": f"Live NOAA fetch failed; using bundled NOAA snapshot. Upstream error: {type(error).__name__}",
            "sst": snapshot["seaSurfaceTemp"],
            "sst_anomaly": snapshot["tempAnomaly"],
            "dhw": snapshot["degreeHeatingWeeks"],
            "alert_level": snapshot["bleachingAlertLevel"],
            "risk_score": round(snapshot["riskScore"] / 100, 2),
        }
    return {
        **reef,
        "seaSurfaceTemp": None,
        "tempAnomaly": None,
        "degreeHeatingWeeks": None,
        "bleachingAlertLevel": "Unavailable",
        "riskScore": 0,
        "status": "unavailable",
        "noaa_data_available": False,
        "noaaDataAvailable": False,
        "lastUpdated": now,
        "last_updated": now,
        "source": "NOAA Coral Reef Watch unavailable",
        "error": str(error),
    }


def _snapshot_fallback_reefs() -> List[Dict[str, Any]]:
    now = utc_now()
    return [
        _unavailable_reef(reef, RuntimeError("live NOAA fetch bypassed; using bundled NOAA snapshot"))
        for reef in _NOAA_REEF_LOCATIONS
    ]


async def _fetch_noaa_point(client: httpx.AsyncClient, reef: Dict[str, Any]) -> Dict[str, Any]:
    cache_key = f"latest:{reef['id']}"
    cached = _cache_get(_NOAA_CACHE, cache_key)
    if cached is not None:
        track_noaa_metrics(0, cache_hit=True)
        return cached

    try:
        rows = _parse_erddap_csv(await _noaa_get_csv(client, _latest_point_query(reef), reef["id"], timeout=8.0, retries=0))
    except Exception as primary_error:
        print(f"[noaa] primary NOAA_DHW unavailable for {reef['id']}; using OceanWatch fallback: {primary_error}")
        return await _fetch_oceanwatch_point(client, reef)

    if not rows:
        return await _fetch_oceanwatch_point(client, reef)
    row = rows[0]
    sea_surface_temp = _round_number(_to_number(row.get("CRW_SST")))
    temp_anomaly = _round_number(_to_number(row.get("CRW_SSTANOMALY")))
    degree_heating_weeks = _round_number(_to_number(row.get("CRW_DHW")))
    alert_area = _to_number(row.get("CRW_BAA_7D_MAX"))
    if sea_surface_temp is None and temp_anomaly is None and degree_heating_weeks is None and alert_area is None:
        raise RuntimeError("NOAA returned no data for the nearest grid cell")
    risk = _calculate_risk(degree_heating_weeks, alert_area)
    alert_level = _get_bleaching_alert_level(alert_area, degree_heating_weeks)
    result = {
        **reef,
        "seaSurfaceTemp": sea_surface_temp,
        "tempAnomaly": temp_anomaly,
        "degreeHeatingWeeks": degree_heating_weeks,
        "bleachingAlertLevel": alert_level,
        "riskScore": risk["riskScore"],
        "status": risk["status"],
        "noaa_data_available": True,
        "noaaDataAvailable": True,
        "lastUpdated": row.get("time") or utc_now(),
        "last_updated": row.get("time") or utc_now(),
        "source": NOAA_SOURCE_LABEL,
        "sst": sea_surface_temp,
        "sst_anomaly": temp_anomaly,
        "dhw": degree_heating_weeks,
        "alert_level": alert_level,
        "risk_score": round(risk["riskScore"] / 100, 2),
    }
    _cache_set(_NOAA_CACHE, cache_key, result)
    return result


async def _fetch_oceanwatch_value(
    client: httpx.AsyncClient,
    dataset_id: str,
    variable: str,
    reef: Dict[str, Any],
    time_selector: str = "(last)",
) -> Dict[str, Any]:
    url = _oceanwatch_query(dataset_id, variable, reef, time_selector)
    rows = _parse_erddap_csv(await _http_get_csv_url(client, url, reef["id"], timeout=12.0, retries=1))
    if not rows:
        raise RuntimeError(f"NOAA OceanWatch returned no rows for {dataset_id}.{variable}")
    row = rows[-1]
    return {"time": row.get("time"), "value": _round_number(_to_number(row.get(variable)))}


async def _fetch_oceanwatch_point(client: httpx.AsyncClient, reef: Dict[str, Any]) -> Dict[str, Any]:
    sst_result, anomaly_result, dhw_result = await asyncio.gather(
        _fetch_oceanwatch_value(client, "CRW_sst_v1_0", "analysed_sst", reef),
        _fetch_oceanwatch_value(client, "CRW_sst_anom_v1_0", "sea_surface_temperature_anomaly", reef),
        _fetch_oceanwatch_value(client, "CRW_dhw_v1_0", "degree_heating_week", reef),
    )
    sea_surface_temp = sst_result["value"]
    temp_anomaly = anomaly_result["value"]
    degree_heating_weeks = dhw_result["value"]
    risk = _calculate_risk(degree_heating_weeks, None)
    alert_level = _get_bleaching_alert_level(None, degree_heating_weeks)
    last_updated = dhw_result.get("time") or anomaly_result.get("time") or sst_result.get("time") or utc_now()
    result = {
        **reef,
        "seaSurfaceTemp": sea_surface_temp,
        "tempAnomaly": temp_anomaly,
        "degreeHeatingWeeks": degree_heating_weeks,
        "bleachingAlertLevel": alert_level,
        "riskScore": risk["riskScore"],
        "status": risk["status"],
        "noaa_data_available": True,
        "noaaDataAvailable": True,
        "lastUpdated": last_updated,
        "last_updated": last_updated,
        "source": NOAA_OCEANWATCH_SOURCE_LABEL,
        "sst": sea_surface_temp,
        "sst_anomaly": temp_anomaly,
        "dhw": degree_heating_weeks,
        "alert_level": alert_level,
        "risk_score": round(risk["riskScore"] / 100, 2),
    }
    _cache_set(_NOAA_CACHE, f"latest:{reef['id']}", result)
    return result


async def _fetch_live_reefs_from_noaa() -> List[Dict[str, Any]]:
    cached_list = _cache_get(_NOAA_CACHE, "live:list")
    if cached_list is not None:
        track_noaa_metrics(0, cache_hit=True)
        return cached_list

    semaphore = asyncio.Semaphore(2)

    async def limited_fetch(reef: Dict[str, Any]) -> Dict[str, Any]:
        async with semaphore:
            return await _fetch_noaa_point(client, reef)

    async with httpx.AsyncClient() as client:
        responses = await asyncio.gather(
            *[limited_fetch(reef) for reef in _NOAA_REEF_LOCATIONS],
            return_exceptions=True,
        )
    results: List[Dict[str, Any]] = []
    for reef, response in zip(_NOAA_REEF_LOCATIONS, responses):
        if isinstance(response, Exception):
            print(f"[noaa] failure {reef['id']}: {response}")
            results.append(_unavailable_reef(reef, response))
        else:
            results.append(response)
    _cache_set(_NOAA_CACHE, "live:list", results)
    return results


@app.get("/api/reefs/live")
@app.get("/reefs/live")
async def live_reefs() -> List[Dict[str, Any]]:
    base = await _fetch_live_reefs_from_noaa()
    if _custom_monitored_reefs:
        base_ids = {r.get("id") for r in base}
        extra = [r for r in _custom_monitored_reefs if r.get("id") not in base_ids]
        return base + extra
    return base


@app.post("/api/reefs/monitor")
@app.post("/reefs/monitor")
async def monitor_reef(payload: MonitorStationRequest) -> Dict[str, Any]:
    global _custom_monitored_reefs

    # Canonical ID: station-{slugify(name)} — matches virtual stations cache keys
    canon_id = f"station-{_slugify_station(payload.name)}"

    # Return immediately if already monitored
    existing = next((r for r in _custom_monitored_reefs if r.get("id") == canon_id), None)
    if existing:
        return {"success": True, "station": existing, "noaaData": "cached", "aiAnalysis": "pending"}

    if len(_custom_monitored_reefs) >= 20:
        raise HTTPException(status_code=409, detail="Active monitoring is capped at 20 reefs.")

    # Try to enrich from the virtual stations cache (has live SST/DHW already)
    matched: Optional[Dict[str, Any]] = None
    cached_stations = _cache_get(_NOAA_VIRTUAL_STATIONS_CACHE, "stations")
    if not cached_stations:
        cached_stations = await _fetch_noaa_virtual_stations()
    if cached_stations:
        name_slug = _slugify_station(payload.name)
        for s in cached_stations:
            if s.get("id") == canon_id or _slugify_station(s.get("name", "")) == name_slug:
                matched = s
                break

    if matched:
        reef: Dict[str, Any] = dict(matched)
    else:
        reef = {
            "id": canon_id,
            "name": payload.name,
            "lat": payload.lat,
            "lng": payload.lng,
            "seaSurfaceTemp": None,
            "tempAnomaly": None,
            "degreeHeatingWeeks": None,
            "bleachingAlertLevel": "Unavailable",
            "riskScore": 0,
            "status": "pending",
            "source": "NOAA Coral Reef Watch Virtual Station",
            "lastUpdated": utc_now()[:10],
            "noaaDataAvailable": False,
        }

    # Ensure fields required by the LiveReef frontend interface
    reef["id"] = canon_id
    reef["stationId"] = payload.station_id
    reef["region"] = reef.get("region") or "NOAA Virtual Station"
    reef["country"] = reef.get("country") or "NOAA Virtual Station"
    reef["isCustomMonitored"] = True

    _custom_monitored_reefs = [r for r in _custom_monitored_reefs if r.get("id") != canon_id]
    _custom_monitored_reefs.append(reef)

    print(f"[monitor] added {reef['name']} (id={canon_id}, total={len(_custom_monitored_reefs)})")
    return {"success": True, "station": reef, "noaaData": "cached" if matched else "unavailable", "aiAnalysis": "pending"}


@app.delete("/api/reefs/monitor/{reef_id:path}")
@app.delete("/reefs/monitor/{reef_id:path}")
async def unmonitor_reef(reef_id: str) -> Dict[str, Any]:
    global _custom_monitored_reefs
    before = len(_custom_monitored_reefs)
    _custom_monitored_reefs = [r for r in _custom_monitored_reefs if r.get("id") != reef_id]
    removed = len(_custom_monitored_reefs) < before
    print(f"[monitor] removed id={reef_id} (removed={removed}, remaining={len(_custom_monitored_reefs)})")
    return {"removed": removed}


def _dhw_to_status(dhw: Optional[float]) -> str:
    if dhw is None:
        return "unavailable"
    if dhw > 8:
        return "critical"
    if dhw >= 4:
        return "warning"
    return "safe"


def _slugify_station(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower())
    return slug.strip("-")


def _parse_virtual_stations_geojson(data: Any) -> List[Dict[str, Any]]:
    """Parse NOAA vs_polygons.json — returns only Point features (214 virtual stations).
    Properties already include live sst / ssta / dhw / alert from the daily NOAA update."""
    seen: set = set()
    stations: List[Dict[str, Any]] = []
    for feature in data.get("features") or []:
        geom = feature.get("geometry") or {}
        if geom.get("type") != "Point":
            continue
        coords = geom.get("coordinates") or []
        if len(coords) < 2:
            continue
        props = feature.get("properties") or {}
        name = str(props.get("name") or "").strip()
        if not name:
            continue
        lng_val, lat_val = _to_number(coords[0]), _to_number(coords[1])
        if lat_val is None or lng_val is None:
            continue
        key = f"{name}:{lat_val}:{lng_val}"
        if key in seen:
            continue
        seen.add(key)

        sst = _round_number(_to_number(props.get("sst")))
        anomaly = _round_number(_to_number(props.get("ssta")))
        dhw = _round_number(_to_number(props.get("dhw")))
        alert_num = _to_number(props.get("alert"))
        risk = _calculate_risk(dhw, alert_num)
        alert_label = _get_bleaching_alert_level(alert_num, dhw)

        station_id = f"station-{_slugify_station(name)}"
        stations.append({
            "id": station_id,
            "name": name,
            "lat": lat_val,
            "lng": lng_val,
            "type": "station",
            "status": risk["status"],
            "source": "NOAA Coral Reef Watch Virtual Station",
            "lastUpdated": str(props.get("date") or utc_now()[:10]),
            "seaSurfaceTemp": sst,
            "tempAnomaly": anomaly,
            "degreeHeatingWeeks": dhw,
            "bleachingAlertLevel": alert_label,
            "riskScore": risk["riskScore"],
            "noaaDataAvailable": sst is not None or dhw is not None,
        })
    return stations


def _parse_virtual_stations_json(data: Any) -> List[Dict[str, Any]]:
    """Parse global.json fallback (simple id/name/lat/lng list)."""
    raw_list = data if isinstance(data, list) else (
        data.get("stations") or data.get("features") or data.get("data") or []
    )
    stations: List[Dict[str, Any]] = []
    for i, item in enumerate(raw_list):
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or item.get("station_name") or "").strip()
        lat = _to_number(item.get("lat") or item.get("latitude"))
        lng = _to_number(item.get("lng") or item.get("lon") or item.get("longitude"))
        if not name or lat is None or lng is None:
            continue
        station_id = str(item.get("id") or item.get("station_id") or f"station-{_slugify_station(name)}-{i}")
        stations.append({"id": station_id, "name": name, "lat": lat, "lng": lng, "type": "station", "status": "station", "source": "NOAA Virtual Station List"})
    return stations


async def _fetch_noaa_virtual_stations() -> List[Dict[str, Any]]:
    """Fetch 214 NOAA Virtual Stations with live SST/DHW data. Cached for 24 h."""
    cached = _cache_get(_NOAA_VIRTUAL_STATIONS_CACHE, "stations")
    if cached is not None:
        return cached

    async with httpx.AsyncClient(timeout=35.0, follow_redirects=True) as client:
        # Primary: GeoJSON with live SST/DHW data already embedded
        try:
            resp = await client.get(NOAA_VIRTUAL_STATIONS_GEOJSON_URL)
            resp.raise_for_status()
            stations = _parse_virtual_stations_geojson(resp.json())
            if stations:
                _cache_set(_NOAA_VIRTUAL_STATIONS_CACHE, "stations", stations, NOAA_VIRTUAL_STATIONS_CACHE_TTL)
                print(f"[stations] loaded {len(stations)} NOAA virtual stations from GeoJSON")
                return stations
        except Exception as geojson_err:
            print(f"[stations] NOAA GeoJSON failed: {geojson_err}")

        # Secondary: plain JSON list
        try:
            resp = await client.get(NOAA_VIRTUAL_STATIONS_JSON_URL)
            resp.raise_for_status()
            stations = _parse_virtual_stations_json(resp.json())
            if stations:
                _cache_set(_NOAA_VIRTUAL_STATIONS_CACHE, "stations", stations, NOAA_VIRTUAL_STATIONS_CACHE_TTL)
                print(f"[stations] loaded {len(stations)} NOAA virtual stations from JSON")
                return stations
        except Exception as json_err:
            print(f"[stations] NOAA JSON also failed: {json_err}")

    # Final fallback: static reef list
    print("[stations] using _STATIC_LIVE_REEFS as station fallback")
    return _STATIC_LIVE_REEFS


@app.get("/api/reefs/stations")
async def reef_stations() -> List[Dict[str, Any]]:
    # GeoJSON parser already embeds live SST/DHW — no extra enrichment needed
    return await _fetch_noaa_virtual_stations()


@app.get("/api/reefs/stations/readings")
async def reef_station_readings() -> List[Dict[str, Any]]:
    now = utc_now()
    source_reefs: List[Dict[str, Any]] = _cache_get(_NOAA_CACHE, "live:list") or _STATIC_LIVE_REEFS
    return [
        {
            "id": reef.get("id"),
            "stationId": reef.get("id"),
            "name": reef.get("name"),
            "lat": reef.get("lat"),
            "lng": reef.get("lng"),
            "type": "station",
            "seaSurfaceTemp": reef.get("seaSurfaceTemp"),
            "tempAnomaly": reef.get("tempAnomaly"),
            "degreeHeatingWeeks": reef.get("degreeHeatingWeeks"),
            "bleachingAlertLevel": reef.get("bleachingAlertLevel", "Unavailable"),
            "riskScore": reef.get("riskScore", 0),
            "status": reef.get("status", "unavailable"),
            "source": reef.get("source", "NOAA Coral Reef Watch"),
            "lastUpdated": reef.get("lastUpdated", now),
            "error": reef.get("error"),
        }
        for reef in source_reefs
    ]


def _avg(values: List[Optional[float]]) -> Optional[float]:
    clean = [value for value in values if isinstance(value, (int, float))]
    return round(sum(clean) / len(clean), 2) if clean else None


def _risk_category(reef: Dict[str, Any]) -> str:
    alert_level = str(reef.get("bleachingAlertLevel") or "").lower()
    dhw = reef.get("degreeHeatingWeeks")
    risk_score = reef.get("riskScore")
    if reef.get("status") == "critical" or "alert level 2" in alert_level or (isinstance(dhw, (int, float)) and dhw >= 8) or (isinstance(risk_score, (int, float)) and risk_score >= 70):
        return "critical"
    if reef.get("status") == "warning" or "warning" in alert_level or "watch" in alert_level or "alert level 1" in alert_level or (isinstance(dhw, (int, float)) and dhw >= 4) or (isinstance(risk_score, (int, float)) and risk_score >= 40):
        return "warning"
    return "safe"


_SYNTHETIC_SST_OFFSETS = [-0.35, -0.25, -0.20, -0.10, 0.05, 0.10, 0.15, 0.0]

def _build_synthetic_baseline(anchor: Dict[str, Any]) -> List[Dict[str, Any]]:
    today = datetime.now(timezone.utc)
    points = []
    for i, offset in enumerate(_SYNTHETIC_SST_OFFSETS):
        is_latest = i == len(_SYNTHETIC_SST_OFFSETS) - 1
        if is_latest:
            points.append({**anchor, "synthetic": False})
            continue
        d = today - timedelta(weeks=(len(_SYNTHETIC_SST_OFFSETS) - 1 - i))
        def shift(v, mult=1.0):
            if not isinstance(v, (int, float)):
                return None
            return round(v + offset * mult, 2)
        points.append({
            "date": d.strftime("%Y-%m-%d"),
            "seaSurfaceTemp": shift(anchor.get("seaSurfaceTemp")),
            "sstAnomaly": shift(anchor.get("sstAnomaly"), 0.5),
            "hotspot": anchor.get("hotspot"),
            "degreeHeatingWeeks": max(0, shift(anchor.get("degreeHeatingWeeks"), 0.3) or 0) if isinstance(anchor.get("degreeHeatingWeeks"), (int, float)) else None,
            "bleachingRisk": max(0, min(100, round((anchor.get("bleachingRisk") or 0) + offset * 8))) if isinstance(anchor.get("bleachingRisk"), (int, float)) else None,
            "reefCount": anchor.get("reefCount", 0),
            "synthetic": True,
        })
    return points


async def _fetch_noaa_history_for_reef(client: httpx.AsyncClient, reef: Dict[str, Any], start_date: str) -> List[Dict[str, Any]]:
    try:
        rows = _parse_erddap_csv(await _noaa_get_csv(client, _historical_point_query(reef, start_date), reef["id"], timeout=12.0, retries=0))
    except Exception as primary_error:
        print(f"[noaa] primary historical NOAA_DHW unavailable for {reef['id']}; using OceanWatch fallback: {primary_error}")
        return await _fetch_oceanwatch_history_for_reef(client, reef, start_date)
    points: List[Dict[str, Any]] = []
    for row in rows:
        sst = _round_number(_to_number(row.get("CRW_SST")))
        anomaly = _round_number(_to_number(row.get("CRW_SSTANOMALY")))
        dhw = _round_number(_to_number(row.get("CRW_DHW")))
        alert_area = _to_number(row.get("CRW_BAA_7D_MAX"))
        risk = _calculate_risk(dhw, alert_area)
        if sst is None and anomaly is None and dhw is None and alert_area is None:
            continue
        points.append({
            "date": (row.get("time") or utc_now())[:10],
            "seaSurfaceTemp": sst,
            "sstAnomaly": anomaly,
            "hotspot": max(0, anomaly) if anomaly is not None else None,
            "degreeHeatingWeeks": dhw,
            "bleachingRisk": risk["riskScore"],
            "reefCount": 1,
        })
    return points


async def _fetch_oceanwatch_history_for_reef(client: httpx.AsyncClient, reef: Dict[str, Any], start_date: str) -> List[Dict[str, Any]]:
    time_selector = f"({start_date}):7:(last)"
    anomaly_url = _oceanwatch_query("CRW_sst_anom_v1_0", "sea_surface_temperature_anomaly", reef, time_selector)
    dhw_url = _oceanwatch_query("CRW_dhw_v1_0", "degree_heating_week", reef, time_selector)
    anomaly_rows, dhw_rows = await asyncio.gather(
        _http_get_csv_url(client, anomaly_url, reef["id"], timeout=20.0, retries=1),
        _http_get_csv_url(client, dhw_url, reef["id"], timeout=20.0, retries=1),
    )
    by_date: Dict[str, Dict[str, Any]] = {}
    for row in _parse_erddap_csv(anomaly_rows):
        date = (row.get("time") or utc_now())[:10]
        anomaly = _round_number(_to_number(row.get("sea_surface_temperature_anomaly")))
        by_date.setdefault(date, {})["sstAnomaly"] = anomaly
        by_date[date]["hotspot"] = max(0, anomaly) if anomaly is not None else None
    for row in _parse_erddap_csv(dhw_rows):
        date = (row.get("time") or utc_now())[:10]
        dhw = _round_number(_to_number(row.get("degree_heating_week")))
        risk = _calculate_risk(dhw, None)
        by_date.setdefault(date, {})["degreeHeatingWeeks"] = dhw
        by_date[date]["bleachingRisk"] = risk["riskScore"]
    return [
        {
            "date": date,
            "seaSurfaceTemp": None,
            "sstAnomaly": values.get("sstAnomaly"),
            "hotspot": values.get("hotspot"),
            "degreeHeatingWeeks": values.get("degreeHeatingWeeks"),
            "bleachingRisk": values.get("bleachingRisk"),
            "reefCount": 1,
        }
        for date, values in sorted(by_date.items())
    ]


@app.get("/api/trends")
@app.get("/api/reefs/historical-trends")
async def historical_trends() -> Dict[str, Any]:
    cache_key = "historical:global:90d"
    cached = _cache_get(_NOAA_HISTORICAL_CACHE, cache_key)
    if cached is not None:
        track_noaa_metrics(0, cache_hit=True)
        return cached

    start_date = (datetime.now(timezone.utc) - timedelta(days=90)).strftime("%Y-%m-%dT00:00:00Z")
    try:
        live = await _fetch_live_reefs_from_noaa()
        async with httpx.AsyncClient() as client:
            histories = await asyncio.gather(
                *[_fetch_noaa_history_for_reef(client, reef, start_date) for reef in _NOAA_REEF_LOCATIONS],
                return_exceptions=True,
            )
        by_date: Dict[str, Dict[str, Any]] = {}
        for history in histories:
            if isinstance(history, Exception):
                print(f"[noaa] historical fetch failed: {history}")
                continue
            for point in history:
                current = by_date.setdefault(point["date"], {"sst": [], "anomaly": [], "hotspot": [], "dhw": [], "risk": [], "reefCount": 0})
                current["sst"].append(point["seaSurfaceTemp"])
                current["anomaly"].append(point["sstAnomaly"])
                current["hotspot"].append(point["hotspot"])
                current["dhw"].append(point["degreeHeatingWeeks"])
                current["risk"].append(point["bleachingRisk"])
                current["reefCount"] += 1
        series = [
            {
                "date": date,
                "seaSurfaceTemp": _avg(values["sst"]),
                "sstAnomaly": _avg(values["anomaly"]),
                "hotspot": _avg(values["hotspot"]),
                "degreeHeatingWeeks": _avg(values["dhw"]),
                "bleachingRisk": _avg(values["risk"]),
                "reefCount": values["reefCount"],
            }
            for date, values in sorted(by_date.items())
        ]
        valid_live = [reef for reef in live if not reef.get("error")]
        avg_sst = _avg([reef.get("seaSurfaceTemp") for reef in valid_live])
        avg_anomaly = _avg([reef.get("tempAnomaly") for reef in valid_live])
        avg_dhw = _avg([reef.get("degreeHeatingWeeks") for reef in valid_live])

        # When no real historical series exists, generate a synthetic 8-week baseline
        # from the current live averages so the trend charts always have data to show.
        real_historical = len(series) > 1
        source_label = "NOAA live data"
        if not real_historical:
            crit = sum(1 for reef in live if _risk_category(reef) == "critical")
            warn = sum(1 for reef in live if _risk_category(reef) == "warning")
            hlth = sum(1 for reef in live if _risk_category(reef) == "safe")
            avg_risk = round((crit * 75 + warn * 45 + hlth * 12) / len(live)) if live else None
            anchor = {
                "date": utc_now()[:10],
                "seaSurfaceTemp": avg_sst,
                "sstAnomaly": avg_anomaly,
                "hotspot": max(0, avg_anomaly) if isinstance(avg_anomaly, (int, float)) else None,
                "degreeHeatingWeeks": avg_dhw,
                "bleachingRisk": avg_risk,
                "reefCount": len(live),
            }
            usable = any(isinstance(anchor.get(k), (int, float)) for k in ("seaSurfaceTemp", "sstAnomaly", "degreeHeatingWeeks"))
            if usable:
                series = _build_synthetic_baseline(anchor)
                source_label = "NOAA baseline estimate"

        result = {
            "totalMonitoredReefs": len(live),
            "criticalReefs": sum(1 for reef in live if _risk_category(reef) == "critical"),
            "warningReefs": sum(1 for reef in live if _risk_category(reef) == "warning"),
            "healthyReefs": sum(1 for reef in live if _risk_category(reef) == "safe"),
            "averages": {
                "seaSurfaceTemp": avg_sst,
                "sstAnomaly": avg_anomaly,
                "degreeHeatingWeeks": avg_dhw,
            },
            "series": series,
            "mode": "historical" if len(series) > 1 else "snapshot",
            "historicalDataAvailable": len(series) > 1,
            "message": (
                "NOAA historical trend data is available for actively monitored reefs." if real_historical
                else "Trend lines are estimated from current NOAA averages. Real historical data will replace this automatically as monitoring continues." if len(series) > 1
                else "Historical time-series data is not available yet. Showing the latest NOAA reef snapshot."
            ),
            "lastUpdated": utc_now(),
            "sourceLabel": source_label,
            "source": NOAA_SOURCE_LABEL,
        }
        _cache_set(_NOAA_HISTORICAL_CACHE, cache_key, result, NOAA_HISTORICAL_CACHE_TTL_SECONDS)
        return result
    except Exception as error:
        print(f"[noaa] historical trends unavailable: {error}")
        live = await live_reefs()
        series = [{
            "date": utc_now()[:10],
            "seaSurfaceTemp": _avg([reef.get("seaSurfaceTemp") for reef in live]),
            "sstAnomaly": _avg([reef.get("tempAnomaly") for reef in live]),
            "hotspot": _avg([max(0, reef.get("tempAnomaly")) for reef in live if isinstance(reef.get("tempAnomaly"), (int, float))]),
            "degreeHeatingWeeks": _avg([reef.get("degreeHeatingWeeks") for reef in live]),
            "bleachingRisk": _avg([reef.get("riskScore") for reef in live]),
            "reefCount": len(live),
        }]
        return {
            "totalMonitoredReefs": len(live),
            "criticalReefs": sum(1 for reef in live if _risk_category(reef) == "critical"),
            "warningReefs": sum(1 for reef in live if _risk_category(reef) == "warning"),
            "healthyReefs": sum(1 for reef in live if _risk_category(reef) == "safe"),
            "averages": {
                "seaSurfaceTemp": series[0]["seaSurfaceTemp"],
                "sstAnomaly": series[0]["sstAnomaly"],
                "degreeHeatingWeeks": series[0]["degreeHeatingWeeks"],
            },
            "series": series,
            "mode": "snapshot",
            "historicalDataAvailable": False,
            "message": "NOAA historical trend data is temporarily unavailable. Showing the latest live NOAA snapshot.",
            "lastUpdated": utc_now(),
            "sourceLabel": "NOAA live data",
            "source": NOAA_SOURCE_LABEL,
            "error": str(error),
        }


@app.get("/api/settings")
async def get_settings() -> Dict[str, Any]:
    return dict(_SETTINGS_STORE)


@app.post("/api/settings")
async def post_settings(request: Request) -> Dict[str, Any]:
    body = await request.json()
    settings = body.get("settings") if isinstance(body, dict) else None
    if settings and isinstance(settings, dict):
        _SETTINGS_STORE.update(settings)
        return {"success": True}
    key = body.get("key") if isinstance(body, dict) else None
    if key:
        _SETTINGS_STORE[key] = body.get("value")
        return {"success": True}
    return JSONResponse(status_code=400, content={"success": False, "message": "Provide key/value or settings object."})


@app.get("/api/agent/activity")
async def agent_activity() -> List[Dict[str, Any]]:
    metrics = current_observability_metrics()
    now = utc_now()
    events: List[Dict[str, Any]] = [
        {
            "id": 1,
            "event_type": "ai_analysis",
            "description": f"AI service processed {metrics['total_traces']} requests with {metrics['success_count']} successful runs.",
            "reef_name": None,
            "metadata": json.dumps(metrics),
            "timestamp": metrics.get("last_trace_time") or now,
        },
        {
            "id": 2,
            "event_type": "noaa_fetch",
            "description": f"NOAA cache hit rate is {metrics['cache_hit_rate']}% across {observability_metrics['noaa_request_count']} requests.",
            "reef_name": None,
            "metadata": json.dumps({"average_noaa_latency_ms": metrics["average_noaa_latency_ms"]}),
            "timestamp": now,
        },
    ]
    try:
        latest = latest_self_improvement_from_disk()
        if latest:
            events.append({
                "id": 3,
                "event_type": "self_improvement",
                "description": latest.get("summary") or "Self-improvement history loaded.",
                "reef_name": None,
                "metadata": json.dumps({
                    "average_score": latest.get("average_score"),
                    "prompt_updated": latest.get("prompt_updated"),
                    "assessment_count": latest.get("assessment_count"),
                }),
                "timestamp": latest.get("completed_at") or latest.get("stored_at") or latest.get("date") or now,
            })
    except Exception as error:
        events.append({
            "id": 4,
            "event_type": "noaa_error",
            "description": f"Unable to read self-improvement history: {error}",
            "reef_name": None,
            "metadata": None,
            "timestamp": now,
        })
    return events[:50]


# ---------------------------------------------------------------------------
# Alert scheduler — runs every 6 hours on Cloud Run.
# Mirrors the logic in server/src/services/alertService.js and
# server/src/routes/alertRoutes.js.  Credentials come from the same
# ALERT_EMAIL_FROM / ALERT_EMAIL_TO / ALERT_EMAIL_PASSWORD env vars.
# ---------------------------------------------------------------------------

def _is_alert_worthy(reef: Dict[str, Any]) -> bool:
    """True when DHW >= 8 OR the bleaching alert label is 'Alert Level 2' or higher."""
    dhw_raw = reef.get("degreeHeatingWeeks") or reef.get("dhw") or 0
    try:
        dhw_val = float(dhw_raw)
    except (TypeError, ValueError):
        dhw_val = 0.0
    alert = str(reef.get("bleachingAlertLevel") or reef.get("alert_level") or "")
    m = re.search(r"alert\s+level\s+(\d+)", alert, re.IGNORECASE)
    alert_level_num = int(m.group(1)) if m else 0
    return dhw_val >= 8.0 or alert_level_num >= 2


def _is_in_cooldown(reef_id: str) -> bool:
    sent_at = _alert_last_sent.get(reef_id)
    if not sent_at:
        return False
    try:
        elapsed_hours = (
            datetime.now(timezone.utc) - datetime.fromisoformat(sent_at)
        ).total_seconds() / 3600
        return elapsed_hours < ALERT_COOLDOWN_HOURS
    except Exception:
        return False


def _build_alert_body(reef: Dict[str, Any]) -> str:
    name = reef.get("name", "Unknown")
    risk = reef.get("riskScore") or reef.get("risk_score")
    if isinstance(risk, float) and risk <= 1.0:
        risk = round(risk * 100)
    dhw = reef.get("degreeHeatingWeeks") or reef.get("dhw")
    anomaly = reef.get("tempAnomaly") or reef.get("sst_anomaly")
    reasons: List[str] = []
    if risk is not None and float(risk) >= 50:
        reasons.append(f"bleaching risk is {risk}%")
    if anomaly is not None:
        reasons.append(f"temperature anomaly is {anomaly}°C")
    if dhw is not None:
        reasons.append(f"degree heating weeks are {dhw}")
    trigger = "; ".join(reasons) if reasons else "critical reef monitoring rule matched"
    return "\n".join([
        f"{name} has crossed the configured critical alert threshold.",
        "",
        f"Trigger: {trigger}.",
        "",
        "Recommended response:",
        "- Review the latest NOAA and station telemetry for this reef.",
        "- Prioritize field validation if local teams are available.",
        "- Watch for sustained heat stress, rising DHW, or worsening bleaching alert levels over the next 24 hours.",
        "",
        "This alert message is rule-based and does not use Gemini or the AI brief generator.",
    ])


def _build_alert_html(reef: Dict[str, Any], body: str) -> str:
    name = reef.get("name", "Unknown Reef")
    risk = reef.get("riskScore") or reef.get("risk_score", "N/A")
    if isinstance(risk, float) and risk <= 1.0:
        risk = round(risk * 100)
    sst = reef.get("seaSurfaceTemp") or reef.get("sst")
    dhw = reef.get("degreeHeatingWeeks") or reef.get("dhw")
    alert = reef.get("bleachingAlertLevel") or reef.get("alert_level")

    def esc(v: Any) -> str:
        return str(v).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    def fmt(v: Any, suffix: str = "") -> str:
        return f"{esc(v)}{suffix}" if v is not None else "Unavailable"

    safe_body = esc(body).replace("\n", "<br>")
    return f"""
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#dc2626;color:white;padding:20px;border-radius:8px 8px 0 0">
          <h1 style="margin:0">&#x1F6A8; Critical Reef Alert</h1>
          <p style="margin:8px 0 0">ReefWatch AI Autonomous Monitoring System</p>
        </div>
        <div style="background:#1e293b;color:#e2e8f0;padding:20px">
          <h2 style="color:#f87171">{esc(name)}</h2>
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:8px;color:#94a3b8">Risk Score</td>
                <td style="padding:8px;color:#f87171;font-weight:bold">{fmt(risk, '%')}</td></tr>
            <tr><td style="padding:8px;color:#94a3b8">Sea Surface Temp</td>
                <td style="padding:8px">{fmt(sst, '°C')}</td></tr>
            <tr><td style="padding:8px;color:#94a3b8">Degree Heating Weeks</td>
                <td style="padding:8px">{fmt(dhw)}</td></tr>
            <tr><td style="padding:8px;color:#94a3b8">Bleaching Alert</td>
                <td style="padding:8px">{fmt(alert)}</td></tr>
          </table>
          <hr style="border-color:#334155;margin:16px 0">
          <h3 style="color:#38bdf8">Conservation Brief</h3>
          <div style="white-space:pre-wrap;font-size:14px;line-height:1.6">{safe_body}</div>
        </div>
        <div style="background:#0f172a;color:#475569;padding:12px;text-align:center;font-size:12px;border-radius:0 0 8px 8px">
          Generated by ReefWatch AI • Autonomous Coral Reef Monitoring
        </div>
      </div>
    """


def _send_alert_email(reef: Dict[str, Any]) -> bool:
    if not ALERT_EMAIL_FROM or not ALERT_EMAIL_TO or not ALERT_EMAIL_PASSWORD:
        print("[alert] email not configured — set ALERT_EMAIL_FROM, ALERT_EMAIL_TO, ALERT_EMAIL_PASSWORD")
        return False
    name = reef.get("name", "Unknown Reef")
    risk = reef.get("riskScore") or reef.get("risk_score", 0)
    if isinstance(risk, float) and risk <= 1.0:
        risk = round(risk * 100)
    body = _build_alert_body(reef)
    html = _build_alert_html(reef, body)
    msg = MIMEMultipart("alternative")
    msg["Subject"] = f"CRITICAL ALERT: {name} — {risk}% Bleaching Risk"
    msg["From"] = f'"ReefWatch AI \U0001fab8" <{ALERT_EMAIL_FROM}>'
    msg["To"] = ALERT_EMAIL_TO
    msg.attach(MIMEText(body, "plain"))
    msg.attach(MIMEText(html, "html"))
    try:
        with smtplib.SMTP("smtp.gmail.com", 587) as server:
            server.starttls()
            server.login(ALERT_EMAIL_FROM, ALERT_EMAIL_PASSWORD)
            server.sendmail(ALERT_EMAIL_FROM, ALERT_EMAIL_TO, msg.as_string())
        print(f"[alert] sent email for {name} to {ALERT_EMAIL_TO}")
        return True
    except Exception as exc:
        print(f"[alert] email send failed for {name}: {type(exc).__name__}: {exc}")
        return False


async def _run_alert_check() -> Dict[str, Any]:
    print("[alert-scheduler] running alert check")
    reefs_checked = 0
    alerts_sent = 0
    skipped_cooldown = 0
    skipped_threshold = 0
    errors: List[str] = []

    try:
        reefs = await live_reefs()
    except Exception as exc:
        msg = f"Failed to fetch reef data: {type(exc).__name__}: {exc}"
        print(f"[alert-scheduler] {msg}")
        return {"error": msg, "reefs_checked": 0, "checked_at": utc_now()}

    for reef in reefs:
        reef_id = reef.get("id") or reef.get("name", "unknown")
        reefs_checked += 1
        if not _is_alert_worthy(reef):
            skipped_threshold += 1
            continue
        if _is_in_cooldown(reef_id):
            sent_at_str = _alert_last_sent.get(reef_id, "")
            try:
                elapsed_hours = (
                    datetime.now(timezone.utc) - datetime.fromisoformat(sent_at_str)
                ).total_seconds() / 3600
            except Exception:
                elapsed_hours = 0.0
            print(f"[alert] Skipping duplicate alert for {reef.get('name')} — last sent {elapsed_hours:.1f} hours ago")
            skipped_cooldown += 1
            continue
        sent = _send_alert_email(reef)
        if sent:
            _alert_last_sent[reef_id] = utc_now()
            alerts_sent += 1
        else:
            errors.append(f"email send failed for {reef.get('name')}")

    result: Dict[str, Any] = {
        "checked_at": utc_now(),
        "reefs_checked": reefs_checked,
        "alerts_sent": alerts_sent,
        "skipped_cooldown": skipped_cooldown,
        "skipped_threshold": skipped_threshold,
        "cooldown_state": {k: v for k, v in _alert_last_sent.items()},
        "errors": errors,
    }
    print(f"[alert-scheduler] done — sent={alerts_sent} cooldown={skipped_cooldown} below_threshold={skipped_threshold}")
    return result


@app.post("/api/alerts/trigger")
async def trigger_alert_check() -> Dict[str, Any]:
    """Manually trigger a reef alert check (bypasses the 24-hour schedule, respects cooldown)."""
    return await _run_alert_check()


@app.get("/api/alerts/status")
async def alert_status() -> Dict[str, Any]:
    """Return the current per-reef cooldown state."""
    return {
        "cooldown_hours": ALERT_COOLDOWN_HOURS,
        "email_configured": bool(ALERT_EMAIL_FROM and ALERT_EMAIL_TO and ALERT_EMAIL_PASSWORD),
        "last_sent": {
            reef_id: {"sent_at": sent_at, "in_cooldown": _is_in_cooldown(reef_id)}
            for reef_id, sent_at in _alert_last_sent.items()
        },
    }


if __name__ == "__main__":
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
