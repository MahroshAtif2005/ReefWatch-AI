import os
from typing import Any, Dict, List, Optional

import httpx


PHOENIX_PROJECT_NAME = "reefwatch"


def _normalize_base_url(base_url: Optional[str]) -> str:
    if not base_url:
        return ""
    normalized = base_url.rstrip("/")
    for suffix in ("/v1/traces", "/v1"):
        if normalized.endswith(suffix):
            normalized = normalized[: -len(suffix)]
    return normalized.rstrip("/")


def _as_list(payload: Any) -> List[Dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict):
        return []

    # Flat list under a known key (self-hosted Phoenix / most REST responses)
    for key in ("spans", "data", "items", "traces", "results", "records"):
        value = payload.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]

    # GraphQL-style relay edges: {"data": {"edges": [{"node": {...}}]}}
    data = payload.get("data")
    if isinstance(data, dict):
        edges = data.get("edges") or []
        if isinstance(edges, list):
            return [e["node"] for e in edges if isinstance(e, dict) and isinstance(e.get("node"), dict)]

    return []


def _attributes(span: Dict[str, Any]) -> Dict[str, Any]:
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


def _quality_score(span: Dict[str, Any]) -> Optional[float]:
    attrs = _attributes(span)
    value = attrs.get("eval.quality_score")
    if value is None:
        value = span.get("eval.quality_score")
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


class PhoenixMCPClient:
    def __init__(
        self,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        space_id: Optional[str] = None,
        project_name: Optional[str] = None,
    ) -> None:
        self.api_key = api_key or os.getenv("PHOENIX_API_KEY", "")
        self.space_id = space_id or os.getenv("ARIZE_SPACE_ID", "")
        self.project_name = project_name or os.getenv("ARIZE_PROJECT_NAME") or PHOENIX_PROJECT_NAME
        self.base_url = _normalize_base_url(base_url or os.getenv("PHOENIX_COLLECTOR_ENDPOINT")) or "https://app.arize.com"

    @property
    def phoenix_url(self) -> str:
        return self.base_url

    def _auth_headers(self) -> Dict[str, str]:
        if self.api_key:
            return {"Authorization": f"Bearer {self.api_key}"}
        return {}

    async def get_recent_spans(self, limit: int = 20) -> List[Dict[str, Any]]:
        if not self.base_url:
            print("[phoenix-mcp] get_recent_spans skipped: no base_url configured")
            return []

        bounded_limit = max(1, min(int(limit or 20), 100))
        url = f"{self.base_url}/v1/projects/{self.project_name}/spans"
        params: Dict[str, Any] = {"limit": bounded_limit}
        key_preview = (self.api_key[:6] + "…") if self.api_key else "(none)"
        print(f"[phoenix-mcp] GET {url}  project={self.project_name}  api_key={key_preview}")
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                response = await client.get(url, params=params, headers=self._auth_headers())
                print(f"[phoenix-mcp] response status={response.status_code}")
                response.raise_for_status()
                body = response.json()
                shape = list(body.keys()) if isinstance(body, dict) else type(body).__name__
                spans = _as_list(body)
                print(f"[phoenix-mcp] response shape={shape}  spans_found={len(spans)}")
                return spans[:bounded_limit]
        except Exception as error:
            print(f"[phoenix-mcp] get_recent_spans failed: {type(error).__name__}: {error}")
            return []

    def filter_low_quality(self, spans: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        low_quality: List[Dict[str, Any]] = []
        for span in spans:
            status = span.get("status") or span.get("status_code") or span.get("statusCode")
            if isinstance(status, dict):
                status = status.get("code") or status.get("status_code")
            quality_score = _quality_score(span)
            if str(status or "").upper() == "ERROR" or (
                quality_score is not None and quality_score < 0.7
            ):
                low_quality.append(span)
        return low_quality

    async def get_low_quality_spans(self) -> List[Dict[str, Any]]:
        return self.filter_low_quality(await self.get_recent_spans(limit=50))

    async def log_improvement(self, data: Dict[str, Any]) -> Dict[str, Any]:
        if not self.base_url:
            return {}

        url = f"{self.base_url}/v1/datasets"
        payload = {
            "name": "reefwatch-self-improvements",
            "description": "Self-improvement decisions from ReefWatch AI",
            "metadata": data,
        }
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                response = await client.post(url, json=payload, headers=self._auth_headers())
                response.raise_for_status()
                result = response.json()
                return result if isinstance(result, dict) else {"status": "logged"}
        except Exception as error:
            print(f"[phoenix-mcp] log_improvement failed: {type(error).__name__}: {error}")
            return {}
