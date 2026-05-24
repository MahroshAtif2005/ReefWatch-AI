import asyncio
import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import google.generativeai as genai
import httpx
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from google.api_core.exceptions import GoogleAPIError
from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode
from phoenix.otel import register
from pydantic import BaseModel, Field

load_dotenv()

PHOENIX_PROJECT_NAME = os.getenv("PHOENIX_PROJECT_NAME", "reefwatch-ai")
PHOENIX_ENDPOINT = os.getenv(
    "PHOENIX_COLLECTOR_ENDPOINT",
    "http://127.0.0.1:6006/v1/traces",
)
PHOENIX_UI_URL = os.getenv(
    "PHOENIX_UI_URL",
    "http://127.0.0.1:6006",
)
GEMINI_MODEL_NAME = "gemini-2.5-flash"
ARIZE_API_KEY = os.getenv("ARIZE_API_KEY", "")
ARIZE_SPACE_ID = os.getenv("ARIZE_SPACE_ID", "")
ARIZE_PROJECT_NAME = os.getenv("ARIZE_PROJECT_NAME", PHOENIX_PROJECT_NAME)
ENABLE_FULL_LLM_TRACE = os.getenv("ENABLE_FULL_LLM_TRACE", "false").lower() == "true"
REEFWATCH_API_URL = os.getenv(
    "REEFWATCH_API_URL",
    "http://127.0.0.1:4000/api/reefs/live",
)
REEFWATCH_TRACE_URL = os.getenv(
    "REEFWATCH_TRACE_URL",
    "http://127.0.0.1:4000/api/traces/reef-assessments",
)
REPO_ROOT = Path(__file__).resolve().parent.parent
AI_SERVICE_ROOT = Path(__file__).resolve().parent
REEF_ANALYSIS_PROMPT_PATH = AI_SERVICE_ROOT / "prompts" / "reef_analysis.txt"
REEF_ANALYSIS_PROMPT_HISTORY_DIR = AI_SERVICE_ROOT / "prompts" / "history"
SELF_IMPROVEMENT_RUNS_PATH = REPO_ROOT / "data" / "self_improvement_runs.json"
DEFAULT_REEF_ANALYSIS_PROMPT = """You are ReefWatch AI, an expert coral bleaching risk analyst.

Analyze NOAA Coral Reef Watch snapshots using DHW, SST, SST anomaly, bleaching alert level, risk thresholds, and uncertainty. Be specific, actionable, and return JSON only."""

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
    try:
        if ARIZE_API_KEY and ARIZE_SPACE_ID:
            print(f"[arize] hosted credentials detected for project={ARIZE_PROJECT_NAME}")
        else:
            print("[arize] hosted Arize not configured; using local Phoenix when available")

        register(
            project_name=PHOENIX_PROJECT_NAME,
            endpoint=PHOENIX_ENDPOINT,
        )
        phoenix_connected = True
        print(f"[phoenix] tracing registered for project={PHOENIX_PROJECT_NAME}")
        print(f"[phoenix] collector endpoint: {PHOENIX_ENDPOINT}")
        print(f"[phoenix] local UI: {PHOENIX_UI_URL}")
    except Exception as error:
        phoenix_connected = False
        print(f"[phoenix] tracing registration failed; continuing without exporter: {error}")
        print(f"[phoenix] start local Phoenix with: phoenix start")
        print(f"[phoenix] local UI: {PHOENIX_UI_URL}")


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
    os.makedirs(REEF_ANALYSIS_PROMPT_HISTORY_DIR, exist_ok=True)
    print(f"[env] REEFWATCH_API_URL={REEFWATCH_API_URL}")
    print(f"[env] REEFWATCH_TRACE_URL={REEFWATCH_TRACE_URL}")
    print(f"[env] OPENAI_API_KEY={'set' if os.getenv('OPENAI_API_KEY') else 'missing'}")


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
    observability_metrics["noaa_request_count"] += 1
    observability_metrics["noaa_call_count"] += 1
    observability_metrics["total_noaa_latency_ms"] += latency_ms
    if cache_hit:
        observability_metrics["cache_hit_count"] += 1


def metric_average(total_key: str, count_key: str) -> float:
    count = observability_metrics[count_key]
    if count == 0:
        return 0.0
    return round(observability_metrics[total_key] / count, 2)


def current_observability_metrics() -> Dict[str, Any]:
    total_traces = observability_metrics["total_traces"]
    noaa_requests = observability_metrics["noaa_request_count"]
    confidence_count = observability_metrics["confidence_count"]
    return {
        "total_traces": total_traces,
        "success_count": observability_metrics["success_count"],
        "failure_count": observability_metrics["failure_count"],
        "error_rate": round((observability_metrics["failure_count"] / total_traces) * 100, 2) if total_traces else 0,
        "average_latency_ms": metric_average("total_latency_ms", "total_traces"),
        "average_llm_latency_ms": metric_average("total_llm_latency_ms", "llm_call_count"),
        "average_noaa_latency_ms": metric_average("total_noaa_latency_ms", "noaa_call_count"),
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
        async with httpx.AsyncClient(timeout=2.5) as client:
            response = await client.get(PHOENIX_UI_URL)
            return response.status_code < 500
    except httpx.HTTPError:
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
    return generate_text_with_trace(
        prompt,
        json_only=json_only,
        prompt_template_name=prompt_template_name,
    )["text"]


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

            llm_result = generate_text_with_trace(
                prompt,
                json_only=True,
                prompt_template_name="reef_analysis_v1",
                span_name="llm.gemini.generate",
            )
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
        brief_text = generate_text(prompt, prompt_template_name="conservation_brief_v1")
        brief_text = brief_text.replace("```markdown", "").replace("```", "").strip()
        return {
            "brief": brief_text,
            "reef_name": payload.reef_name,
            "generated_at": utc_now(),
        }


@app.post("/chat")
async def chat(payload: ChatRequest) -> Dict[str, Any]:
    route_start = time.perf_counter()
    history_count = len(payload.conversation_history or [])
    context_keys = list((payload.reef_context or {}).keys())
    print("[ai.chat] request received", {
        "message_length": len(payload.message or ""),
        "conversation_history_count": history_count,
        "reef_context_keys": context_keys,
    })

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
                print(f"[ai.chat] fetching live reef data from {REEFWATCH_API_URL}")
                async with httpx.AsyncClient(timeout=35.0) as client:
                    response = await client.get(REEFWATCH_API_URL)
                    response.raise_for_status()
                    live_reefs = response.json()
                fetch_latency = elapsed_ms(fetch_start)
                set_attrs(fetch_span, {
                    "noaa.endpoint": REEFWATCH_API_URL,
                    "noaa.status_code": response.status_code,
                    "noaa.response_time_ms": fetch_latency,
                    "noaa.cache_hit": False,
                    "noaa.dataset": "reefwatch_live_reefs",
                    "reef.count": len(live_reefs) if isinstance(live_reefs, list) else 0,
                })
                fetch_span.add_event("noaa_data_received")
                print("[ai.chat] live reef data received", {
                    "status_code": response.status_code,
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
            local_traces, trace_error = await fetch_json_with_error(
                f"http://localhost:4000/api/arize/traces?limit={evaluation_limit}",
                timeout=10.0,
            )
            if trace_error:
                warnings.append(f"Unable to load local traces from SQLite. {trace_error}")
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
                    "http://localhost:4000/api/reefs/live",
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
    request_payload = payload or SelfImprovementRequest()
    print("SELF_IMPROVEMENT_RUN_ROUTE_HIT", request_payload)
    started_at = utc_now()
    run_date = (request_payload.date or started_at[:10])[:10]

    date_start = f"{run_date}T00:00:00.000Z"
    date_end = f"{run_date}T23:59:59.999Z"
    filter_used = f"timestamp >= {date_start} AND timestamp <= {date_end} (UTC day)"
    source_trace_count = len(request_payload.assessments)
    source = "node_local_traces" if request_payload.assessments else "none"
    warning: Optional[str] = None
    available_trace_types: List[str] = []

    if not request_payload.assessments:
        node_trace_url = f"{REEFWATCH_TRACE_URL}?date={run_date}"
        if request_payload.limit:
            node_trace_url = f"{node_trace_url}&limit={max(1, min(int(request_payload.limit), 500))}"
        node_payload, node_error = await fetch_json_with_error(node_trace_url, timeout=20.0)
        if node_error:
            warning = f"Unable to load Node local reef assessment traces. {node_error}"
        else:
            node_traces, available_trace_types = extract_node_trace_payload(node_payload)
            node_assessments = [
                assessment
                for assessment in (node_trace_to_assessment(trace_item) for trace_item in node_traces)
                if assessment is not None
            ]
            request_payload.assessments = node_assessments
            source_trace_count = len(node_traces)
            source = "node_local_traces" if node_assessments else "none"
            if not node_assessments:
                warning = "No real Node local reef assessment traces were found for the requested UTC date."

    if not request_payload.assessments and not request_payload.save_empty:
        return {
            "date": run_date,
            "assessment_count": 0,
            "attempted_assessment_count": 0,
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
            "summary": warning or "No assessments provided; pass save_empty=true to persist empty runs.",
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
        }

    judgements: List[Dict[str, Any]] = []
    errors: List[str] = []
    quota_limited = False
    rewrite_failed_due_to_quota = False
    assessments = request_payload.assessments[:request_payload.limit] if request_payload.limit else request_payload.assessments

    with tracer.start_as_current_span("self_improvement_loop") as span:
        set_attrs(span, {
            "self_improvement.date_evaluated": run_date,
            "self_improvement.assessment_count": len(assessments),
            "self_improvement.limit": request_payload.limit,
            "self_improvement.prompt_path": str(REEF_ANALYSIS_PROMPT_PATH.relative_to(REPO_ROOT)),
        })

        for assessment in assessments:
            try:
                judge_text = generate_text_with_retry(
                    build_judge_prompt(assessment),
                    json_only=True,
                    prompt_template_name="reef_assessment_judge_v1",
                )
                judgement = validate_judge_result(parse_json_response(judge_text))
                judgement["trace_id"] = assessment.trace_id
                judgement["reef_name"] = assessment.reef_name
                judgements.append(judgement)
            except Exception as error:
                message = f"{assessment.reef_name}: {type(error).__name__}: {error}"
                errors.append(message[:300])
                if is_quota_error(error):
                    quota_limited = True
                    span.add_event("gemini_quota_limited_during_judging")
                    print(f"[self-improvement] quota limited during judging; preserving {len(judgements)} partial judgements")
                    break
                print(f"[self-improvement] judge skipped {message}")

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
        return result


@app.get("/health")
async def health() -> Dict[str, Any]:
    phoenix_reachable = await is_phoenix_reachable()
    return {
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


@app.get("/test-trace")
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
            "phoenix_url": PHOENIX_UI_URL,
        }


@app.get("/mcp/traces/recent")
async def mcp_get_recent_traces(limit: int = 10) -> Dict[str, Any]:
    """Phoenix MCP tool: get recent traces for agent self-introspection"""
    try:
        from src.db.database import getRecentArizeTraces
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


if __name__ == "__main__":
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
