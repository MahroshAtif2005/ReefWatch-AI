"""
ReefWatch ADK Agent

Wraps the existing reef analysis and Phoenix MCP capabilities as an official
Google Agent Development Kit (google-adk) agent. The Agent class handles
model routing, tool dispatch, and multi-turn conversation — the FastAPI
endpoints in main.py remain unchanged and are used by the tools below.
"""
import os

import httpx
from google.adk.agents import Agent

# ---------------------------------------------------------------------------
# Base URL — resolves to the Cloud Run service or localhost in dev
# ---------------------------------------------------------------------------

def _base_url() -> str:
    raw = os.getenv(
        "REEFWATCH_API_URL",
        "http://localhost:8000/api/reefs/live",
    )
    # Strip everything from /api/ onwards to get the service root
    idx = raw.find("/api/")
    return raw[:idx] if idx != -1 else raw.rstrip("/")


_phoenix_cache: dict = {}


# ---------------------------------------------------------------------------
# ADK Tool functions
# ---------------------------------------------------------------------------

def get_reef_analysis(
    reef_name: str,
    sst: float,
    dhw: float,
    sst_anomaly: float,
    alert_level: str = "Unknown",
    lat: float = 0.0,
    lng: float = 0.0,
) -> dict:
    """Analyze coral reef bleaching risk using NOAA thermal stress data.

    Args:
        reef_name: Name of the coral reef location.
        sst: Sea surface temperature in degrees Celsius.
        dhw: Degree Heating Weeks — accumulated thermal stress.
             DHW > 4 triggers Alert Level 1; DHW > 8 triggers Alert Level 2.
        sst_anomaly: Temperature deviation from the long-term average (°C).
        alert_level: NOAA bleaching alert level string, e.g. "No Stress" or
                     "Alert Level 1". Defaults to "Unknown".
        lat: Latitude of the reef (decimal degrees). Defaults to 0.0.
        lng: Longitude of the reef (decimal degrees). Defaults to 0.0.

    Returns:
        A reef risk assessment with risk_score, status, analysis summary,
        and conservation recommendations.
    """
    url = f"{_base_url()}/api/ai/analyze"
    payload = {
        "reef_name": reef_name,
        "lat": lat,
        "lng": lng,
        "sst": sst,
        "anomaly": sst_anomaly,
        "dhw": dhw,
        "alert_level": alert_level,
    }
    try:
        response = httpx.post(url, json=payload, timeout=30.0)
        if response.status_code == 200:
            return response.json()
        return {"error": f"Analysis failed with HTTP {response.status_code}", "detail": response.text[:200]}
    except Exception as exc:
        return {"error": str(exc)}


async def query_phoenix_traces(limit: int = 5) -> dict:
    """Retrieve recent ReefWatch AI inference traces from the Phoenix observability platform.

    Use this tool when the user asks about past analyses, model performance,
    latency history, or trace-level debugging information.

    Args:
        limit: Number of recent traces to retrieve. Must be between 1 and 20.
               Defaults to 5.

    Returns:
        A dictionary with a ``traces`` list and a ``count`` field.
    """
    effective_limit = max(1, min(int(limit), 20))
    url = f"{_base_url()}/api/arize/traces?limit={effective_limit}"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(url)
        data = response.json() if response.status_code == 200 else []
        traces = data[:effective_limit] if isinstance(data, list) else []
        result = {"traces": traces, "count": len(traces), "source": "phoenix"}
        _phoenix_cache["traces"] = result
        return result
    except httpx.TimeoutException:
        cached = _phoenix_cache.get("traces")
        if cached:
            return {**cached, "source": "cached", "warning": "Phoenix timed out; showing last known traces"}
        return {"traces": [], "count": 0, "warning": "Phoenix timed out and no cached traces are available yet"}
    except Exception as exc:
        return {"traces": [], "count": 0, "error": str(exc)}


async def get_quality_metrics() -> dict:
    """Return real-time AI quality metrics for the ReefWatch inference pipeline.

    Metrics include total traces, average latency, error rate, cache hit rate,
    token usage, and model confidence scores.

    Returns:
        A dictionary of observability metrics from the AI service.
    """
    url = f"{_base_url()}/api/arize/status"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(url)
        if response.status_code == 200:
            data = response.json()
            metrics = data.get("metrics") or {"error": "No metrics available"}
            if "error" not in metrics:
                _phoenix_cache["metrics"] = metrics
            return metrics
        return {"error": f"Metrics fetch failed with HTTP {response.status_code}"}
    except httpx.TimeoutException:
        cached = _phoenix_cache.get("metrics")
        if cached:
            return {**cached, "source": "cached", "warning": "Phoenix timed out; showing last known metrics"}
        return {"warning": "Phoenix timed out and no cached metrics are available yet"}
    except Exception as exc:
        return {"error": str(exc)}


# ---------------------------------------------------------------------------
# ADK Agent definition
# ---------------------------------------------------------------------------

_INSTRUCTION = """\
You are ReefWatch AI, an expert coral reef bleaching risk analyst. You assist
marine scientists and conservationists in understanding reef health using
NOAA Coral Reef Watch thermal stress data.

Scientific thresholds to always apply:
- Degree Heating Weeks (DHW) > 4  → Alert Level 1 (bleaching likely)
- Degree Heating Weeks (DHW) > 8  → Alert Level 2 (severe bleaching and mortality likely)
- SST anomaly > 1 °C sustained over weeks drives thermal stress accumulation

When a user asks about reef conditions or risk:
1. Call get_reef_analysis with the reef name and available NOAA data to run a risk assessment.
2. Call query_phoenix_traces to surface recent inference history when the user asks about
   past analyses, trends, or model performance.
3. Call get_quality_metrics when the user asks about system performance, error rates,
   latency, or token usage.

Always provide specific, actionable conservation recommendations that name concrete parties
(e.g., dive operators, AIMS, local rangers), timeframes (within 24h, this week), and
measurable actions. Acknowledge data gaps honestly rather than extrapolating.
"""

reef_agent = Agent(
    name="reefwatch_agent",
    model="gemini-2.5-flash",
    description=(
        "ReefWatch AI — coral reef bleaching risk analyst powered by NOAA Coral Reef Watch data, "
        "Gemini 2.5 Flash, and Phoenix observability."
    ),
    instruction=_INSTRUCTION,
    tools=[get_reef_analysis, query_phoenix_traces, get_quality_metrics],
)
