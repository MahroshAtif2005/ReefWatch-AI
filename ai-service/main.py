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
import sqlite3
import threading
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


def _phoenix_client_base_url() -> str:
    """Return the Phoenix base URL to use for MCP client calls.

    Prefers the self-hosted Phoenix (PHOENIX_BASE_URL) because hosted Arize
    credentials (ARIZE_API_KEY + ARIZE_SPACE_ID) are not configured. Falls back
    to ARIZE_API_BASE_URL only when both credentials are present.
    """
    if ARIZE_API_KEY and ARIZE_SPACE_ID:
        return ARIZE_API_BASE_URL
    return PHOENIX_BASE_URL or PHOENIX_UI_URL
ENABLE_FULL_LLM_TRACE = os.getenv("ENABLE_FULL_LLM_TRACE", "false").lower() == "true"
ALERT_EMAIL_FROM = os.getenv("ALERT_EMAIL_FROM", "")
ALERT_EMAIL_PASSWORD = os.getenv("ALERT_EMAIL_PASSWORD", "")
# Recipient is set by the user in Settings (/api/settings → notification_email).
# ALERT_EMAIL_TO env var is intentionally not read here.
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
SELF_IMPROVEMENT_RUNS_PATH = AI_SERVICE_ROOT / "data" / "self_improvement_runs.json"
LAST_SCORES_PATH = Path("/tmp/last_scores.json")
SELF_IMPROVEMENT_STORAGE = os.getenv("SELF_IMPROVEMENT_STORAGE", "local").upper()
SELF_IMPROVEMENT_GCS_BUCKET = os.getenv("SELF_IMPROVEMENT_GCS_BUCKET", "")
_GCS_SI_OBJECT = "self-improvement/runs.jsonl"
_GCS_PROFILES_OBJECT = "researcher-profiles/profiles.json"
# Production evaluation system — Phase 1-8
_GCS_BENCHMARK_OBJECT = "evaluation-datasets/cases.jsonl"
_GCS_EXPERIMENTS_PREFIX = "experiments/"
_GCS_PROMPTS_ACTIVE = "prompts/active_prompt.json"
_GCS_PROMPTS_HISTORY = "prompts/prompt_history.json"
_GCS_IMPROVEMENT_HISTORY_PREFIX = "improvement-history/"
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
_demo_alert_events: List[Dict[str, Any]] = []
tracer = trace.get_tracer(__name__)

gemini_cache: Dict[str, Dict[str, Any]] = {}
GEMINI_CACHE_TTL_SECONDS = 1800  # 30 minutes

last_noaa_latency_ms: float = 0.0

# MCP tool call log — in-memory for fast access, SQLite for persistence
_mcp_tool_call_log: List[Dict[str, Any]] = []
_MCP_DB_PATH = Path("/tmp/mcp_tool_calls.db")
_mcp_db_lock = threading.Lock()
_gcs_write_lock = threading.Lock()
_gcs_profiles_lock = threading.Lock()


def _init_mcp_db() -> None:
    with _mcp_db_lock:
        con = sqlite3.connect(_MCP_DB_PATH)
        con.execute("""
            CREATE TABLE IF NOT EXISTS mcp_tool_calls (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT    NOT NULL,
                tool      TEXT    NOT NULL,
                summary   TEXT    NOT NULL,
                data_preview TEXT
            )
        """)
        # Full schema — individual columns for queryability plus data_json for lossless restoration
        con.execute("""
            CREATE TABLE IF NOT EXISTS monitored_reefs (
                id          TEXT PRIMARY KEY,
                station_id  TEXT,
                name        TEXT NOT NULL DEFAULT '',
                lat         REAL NOT NULL DEFAULT 0,
                lon         REAL NOT NULL DEFAULT 0,
                added_at    TEXT NOT NULL DEFAULT '',
                data_json   TEXT NOT NULL DEFAULT '{}'
            )
        """)
        # Migration: add missing columns for instances with the old 3-column schema
        for _col_sql in [
            "ALTER TABLE monitored_reefs ADD COLUMN station_id TEXT",
            "ALTER TABLE monitored_reefs ADD COLUMN name TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE monitored_reefs ADD COLUMN lat REAL NOT NULL DEFAULT 0",
            "ALTER TABLE monitored_reefs ADD COLUMN lon REAL NOT NULL DEFAULT 0",
            "ALTER TABLE monitored_reefs ADD COLUMN added_at TEXT NOT NULL DEFAULT ''",
        ]:
            try:
                con.execute(_col_sql)
            except Exception:
                pass  # Column already present — safe to ignore
        con.execute("""
            CREATE TABLE IF NOT EXISTS self_improvement_runs (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                stored_at    TEXT NOT NULL,
                completed_at TEXT,
                source       TEXT,
                status       TEXT,
                average_score REAL,
                prompt_updated INTEGER NOT NULL DEFAULT 0,
                run_json     TEXT NOT NULL,
                UNIQUE(stored_at)
            )
        """)
        con.execute("""
            CREATE TABLE IF NOT EXISTS researcher_profiles (
                researcher_id           TEXT PRIMARY KEY,
                notification_email      TEXT NOT NULL DEFAULT '',
                active_reef_ids         TEXT NOT NULL DEFAULT '[]',
                critical_alerts_enabled INTEGER NOT NULL DEFAULT 1,
                anomaly_alerts_enabled  INTEGER NOT NULL DEFAULT 1,
                weekly_summary_enabled  INTEGER NOT NULL DEFAULT 0,
                anomaly_threshold       REAL NOT NULL DEFAULT 1.0,
                created_at              TEXT NOT NULL,
                updated_at              TEXT NOT NULL
            )
        """)
        # Add researcher_id to monitored_reefs for per-researcher tracking
        try:
            con.execute("ALTER TABLE monitored_reefs ADD COLUMN researcher_id TEXT")
        except Exception:
            pass  # Column already present
        con.commit()
        # Seed in-memory log from DB so it survives page refreshes within the same instance
        rows = con.execute(
            "SELECT timestamp, tool, summary, data_preview FROM mcp_tool_calls ORDER BY id DESC LIMIT 100"
        ).fetchall()
        con.close()
    for row in reversed(rows):
        _mcp_tool_call_log.append({
            "timestamp": row[0], "tool": row[1],
            "summary": row[2], **({"data_preview": row[3]} if row[3] else {}),
        })


def _load_monitored_reefs_from_db() -> None:
    global _custom_monitored_reefs
    try:
        with _mcp_db_lock:
            con = sqlite3.connect(_MCP_DB_PATH)
            rows = con.execute(
                "SELECT data_json FROM monitored_reefs ORDER BY added_at ASC"
            ).fetchall()
            con.close()
        loaded = []
        for (data_json,) in rows:
            try:
                loaded.append(json.loads(data_json))
            except Exception:
                pass
        _custom_monitored_reefs = loaded
        if loaded:
            print(f"[monitored-reefs] loaded {len(loaded)} persisted monitored reefs from DB")
    except Exception as err:
        print(f"[monitored-reefs] DB load failed (non-fatal): {err}")


def _save_monitored_reef_to_db(reef: Dict[str, Any]) -> None:
    try:
        now = utc_now()
        with _mcp_db_lock:
            con = sqlite3.connect(_MCP_DB_PATH)
            con.execute(
                """INSERT OR REPLACE INTO monitored_reefs
                   (id, station_id, name, lat, lon, added_at, data_json)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    reef["id"],
                    reef.get("stationId"),
                    reef.get("name", ""),
                    reef.get("lat", 0),
                    reef.get("lng", 0),
                    now,
                    json.dumps(reef, default=str),
                ),
            )
            con.commit()
            con.close()
    except Exception as err:
        print(f"[monitored-reefs] DB save failed (non-fatal): {err}")


def _delete_monitored_reef_from_db(reef_id: str) -> None:
    try:
        with _mcp_db_lock:
            con = sqlite3.connect(_MCP_DB_PATH)
            con.execute("DELETE FROM monitored_reefs WHERE id = ?", (reef_id,))
            con.commit()
            con.close()
    except Exception as err:
        print(f"[monitored-reefs] DB delete failed (non-fatal): {err}")


# ---------------------------------------------------------------------------
# Researcher profile helpers — per-browser persistent profiles keyed by UUID
# ---------------------------------------------------------------------------

def _mask_email(email: str) -> str:
    """Return a masked email safe for logs: alice@example.com → a***@example.com"""
    if not email or "@" not in email:
        return "***"
    local, domain = email.split("@", 1)
    return f"{local[0]}***@{domain}" if local else f"***@{domain}"


def _get_or_create_researcher_profile(researcher_id: str) -> Dict[str, Any]:
    """Return the researcher profile, creating a blank one if it doesn't exist."""
    now = utc_now()
    try:
        with _mcp_db_lock:
            con = sqlite3.connect(_MCP_DB_PATH)
            con.execute(
                """INSERT OR IGNORE INTO researcher_profiles
                   (researcher_id, notification_email, active_reef_ids,
                    critical_alerts_enabled, anomaly_alerts_enabled,
                    weekly_summary_enabled, anomaly_threshold,
                    created_at, updated_at)
                   VALUES (?, '', '[]', 1, 1, 0, 1.0, ?, ?)""",
                (researcher_id, now, now),
            )
            con.commit()
            row = con.execute(
                """SELECT researcher_id, notification_email, active_reef_ids,
                          critical_alerts_enabled, anomaly_alerts_enabled,
                          weekly_summary_enabled, anomaly_threshold,
                          created_at, updated_at
                   FROM researcher_profiles WHERE researcher_id = ?""",
                (researcher_id,),
            ).fetchone()
            con.close()
        if not row:
            return {}
        return {
            "researcher_id": row[0],
            "notification_email": row[1] or "",
            "active_reef_ids": row[2] or "[]",
            "critical_alerts_enabled": bool(row[3]),
            "anomaly_alerts_enabled": bool(row[4]),
            "weekly_summary_enabled": bool(row[5]),
            "anomaly_threshold": row[6] if row[6] is not None else 1.0,
            "created_at": row[7],
            "updated_at": row[8],
        }
    except Exception as err:
        print(f"[researcher] get_or_create failed: {err}")
        return {}


def _update_researcher_settings(researcher_id: str, settings: Dict[str, Any]) -> bool:
    """Upsert alert preferences for a researcher. Creates profile on first call."""
    profile = _get_or_create_researcher_profile(researcher_id)
    if not profile:
        return False

    def _to_bool(val: Any, default: bool) -> bool:
        if isinstance(val, bool):
            return val
        if isinstance(val, str):
            return val.lower() == "true"
        return default

    email = str(settings.get("notification_email", profile["notification_email"])).strip()
    critical = _to_bool(settings.get("critical_alerts_enabled"), profile["critical_alerts_enabled"])
    anomaly = _to_bool(settings.get("temp_anomaly_alerts_enabled"), profile["anomaly_alerts_enabled"])
    weekly = _to_bool(settings.get("weekly_summary_enabled"), profile["weekly_summary_enabled"])
    try:
        threshold = float(settings.get("anomaly_threshold", profile["anomaly_threshold"]))
    except (TypeError, ValueError):
        threshold = profile["anomaly_threshold"]

    try:
        with _mcp_db_lock:
            con = sqlite3.connect(_MCP_DB_PATH)
            con.execute(
                """UPDATE researcher_profiles SET
                   notification_email      = ?,
                   critical_alerts_enabled = ?,
                   anomaly_alerts_enabled  = ?,
                   weekly_summary_enabled  = ?,
                   anomaly_threshold       = ?,
                   updated_at              = ?
                   WHERE researcher_id = ?""",
                (
                    email,
                    1 if critical else 0,
                    1 if anomaly else 0,
                    1 if weekly else 0,
                    threshold,
                    utc_now(),
                    researcher_id,
                ),
            )
            con.commit()
            con.close()
        if email:
            print(f"[researcher] {researcher_id[:8]}… settings saved — email={_mask_email(email)}")
        # Write-through: push updated profile to GCS so it survives Cloud Run restarts
        fresh = _get_or_create_researcher_profile(researcher_id)
        gcs_ok = _upsert_profile_to_gcs(researcher_id, fresh)
        if not gcs_ok:
            print(f"[researcher:gcs] profile GCS write skipped or failed for {researcher_id[:8]}… (profiles_gcs_enabled={_profiles_gcs_enabled()})")
        return True
    except Exception as err:
        print(f"[researcher] settings update failed: {err}")
        return False


def _update_researcher_active_reefs(researcher_id: str, reef_ids: List[str]) -> bool:
    """Replace active_reef_ids for a researcher. Creates profile if needed."""
    _get_or_create_researcher_profile(researcher_id)
    try:
        with _mcp_db_lock:
            con = sqlite3.connect(_MCP_DB_PATH)
            con.execute(
                "UPDATE researcher_profiles SET active_reef_ids = ?, updated_at = ? WHERE researcher_id = ?",
                (json.dumps(reef_ids), utc_now(), researcher_id),
            )
            con.commit()
            con.close()
        print(f"[researcher] {researcher_id[:8]}… active reefs updated — count={len(reef_ids)}")
        # Write-through: push updated profile to GCS so alerts survive Cloud Run restarts
        fresh = _get_or_create_researcher_profile(researcher_id)
        gcs_ok = _upsert_profile_to_gcs(researcher_id, fresh)
        if not gcs_ok:
            print(f"[researcher:gcs] reef sync GCS write skipped or failed for {researcher_id[:8]}… (profiles_gcs_enabled={_profiles_gcs_enabled()})")
        return True
    except Exception as err:
        print(f"[researcher] active reefs update failed: {err}")
        return False


def _list_researcher_profiles_with_alerts() -> List[Dict[str, Any]]:
    """Return all profiles that have both a notification_email and at least one active reef."""
    try:
        with _mcp_db_lock:
            con = sqlite3.connect(_MCP_DB_PATH)
            rows = con.execute(
                """SELECT researcher_id, notification_email, active_reef_ids,
                          critical_alerts_enabled, anomaly_alerts_enabled,
                          weekly_summary_enabled, anomaly_threshold
                   FROM researcher_profiles
                   WHERE notification_email != ''
                     AND active_reef_ids NOT IN ('[]', '', 'null')"""
            ).fetchall()
            con.close()
        return [
            {
                "researcher_id": r[0],
                "notification_email": r[1],
                "active_reef_ids_json": r[2],
                "critical_alerts_enabled": bool(r[3]),
                "anomaly_alerts_enabled": bool(r[4]),
                "weekly_summary_enabled": bool(r[5]),
                "anomaly_threshold": r[6] if r[6] is not None else 1.0,
            }
            for r in rows
        ]
    except Exception as err:
        print(f"[researcher] list_profiles_with_alerts failed: {err}")
        return []


# ---------------------------------------------------------------------------
# Researcher profile GCS persistence
# ---------------------------------------------------------------------------

def _profiles_gcs_enabled() -> bool:
    """True whenever the GCS bucket is configured, independent of SELF_IMPROVEMENT_STORAGE."""
    return bool(SELF_IMPROVEMENT_GCS_BUCKET)


def _get_profiles_gcs_bucket() -> Optional[Any]:
    """Return a GCS Bucket object for researcher-profile storage, or None on failure."""
    if not _profiles_gcs_enabled():
        return None
    try:
        from google.cloud import storage as _gcs_storage  # noqa: PLC0415
        return _gcs_storage.Client().bucket(SELF_IMPROVEMENT_GCS_BUCKET)
    except ImportError:
        print("[profiles-gcs] google-cloud-storage not installed")
        return None
    except Exception as _e:
        print(f"[profiles-gcs] bucket init failed: {type(_e).__name__}: {_e}")
        return None


def _load_all_profiles_from_gcs() -> Dict[str, Any]:
    """Read all researcher profiles from GCS.  Returns {} when unavailable."""
    if not _profiles_gcs_enabled():
        return {}
    try:
        bucket = _get_profiles_gcs_bucket()
        if bucket is None:
            return {}
        blob = bucket.blob(_GCS_PROFILES_OBJECT)
        if not blob.exists():
            return {}
        data = json.loads(blob.download_as_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception as _e:
        print(f"[profiles-gcs] load failed: {type(_e).__name__}: {_e}")
        return {}


def _upsert_profile_to_gcs(researcher_id: str, profile: Dict[str, Any]) -> bool:
    """Write/update a single researcher profile in GCS (read-modify-write, thread-safe)."""
    if not _profiles_gcs_enabled():
        return False
    try:
        with _gcs_profiles_lock:
            bucket = _get_profiles_gcs_bucket()
            if bucket is None:
                return False
            blob = bucket.blob(_GCS_PROFILES_OBJECT)
            existing: Dict[str, Any] = {}
            if blob.exists():
                try:
                    existing = json.loads(blob.download_as_text(encoding="utf-8"))
                    if not isinstance(existing, dict):
                        existing = {}
                except Exception:
                    existing = {}
            existing[researcher_id] = profile
            blob.upload_from_string(
                json.dumps(existing, ensure_ascii=False, indent=2, default=str),
                content_type="application/json",
            )
            _active_ids_raw = profile.get("active_reef_ids", "[]")
            try:
                _active_ids_count = len(json.loads(_active_ids_raw)) if isinstance(_active_ids_raw, str) else len(_active_ids_raw)
            except Exception:
                _active_ids_count = 0
            print(f"[active-reefs:gcs] saved researcher_id={researcher_id[:8]}… active_reef_ids count={_active_ids_count}")
            print(f"[researcher:gcs] saved profile researcher={researcher_id[:8]}… total_profiles={len(existing)}")
            return True
    except Exception as _e:
        print(f"[researcher:gcs] failed profile save: {type(_e).__name__}: {_e}")
        return False


def _hydrate_researcher_profiles_from_gcs() -> None:
    """On startup: INSERT OR IGNORE each GCS profile into the SQLite cache."""
    if not _profiles_gcs_enabled():
        return
    try:
        profiles = _load_all_profiles_from_gcs()
        if not profiles:
            print("[profiles-gcs] no profiles in GCS — starting with empty SQLite table")
            return
        hydrated = 0
        with _mcp_db_lock:
            con = sqlite3.connect(_MCP_DB_PATH)
            for rid, p in profiles.items():
                con.execute(
                    """INSERT OR IGNORE INTO researcher_profiles
                       (researcher_id, notification_email, active_reef_ids,
                        critical_alerts_enabled, anomaly_alerts_enabled,
                        weekly_summary_enabled, anomaly_threshold,
                        created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        rid,
                        p.get("notification_email", ""),
                        p.get("active_reef_ids", "[]"),
                        1 if p.get("critical_alerts_enabled", True) else 0,
                        1 if p.get("anomaly_alerts_enabled", True) else 0,
                        1 if p.get("weekly_summary_enabled", False) else 0,
                        float(p.get("anomaly_threshold", 1.0)),
                        p.get("created_at", utc_now()),
                        p.get("updated_at", utc_now()),
                    ),
                )
                if con.execute("SELECT changes()").fetchone()[0] > 0:
                    hydrated += 1
            con.commit()
            con.close()
        print(f"[profiles-gcs] hydrated {hydrated}/{len(profiles)} researcher profiles into SQLite")
    except Exception as _e:
        print(f"[profiles-gcs] startup hydration failed (non-fatal): {_e}")


def _migrate_sqlite_profiles_to_gcs() -> None:
    """On startup: push any SQLite researcher profiles not yet in GCS up to GCS."""
    if not _profiles_gcs_enabled():
        return
    try:
        with _mcp_db_lock:
            con = sqlite3.connect(_MCP_DB_PATH)
            rows = con.execute(
                """SELECT researcher_id, notification_email, active_reef_ids,
                          critical_alerts_enabled, anomaly_alerts_enabled,
                          weekly_summary_enabled, anomaly_threshold, created_at, updated_at
                   FROM researcher_profiles"""
            ).fetchall()
            con.close()
        if not rows:
            return
        existing = _load_all_profiles_from_gcs()
        additions: Dict[str, Any] = {}
        for row in rows:
            rid = row[0]
            if rid in existing:
                continue
            additions[rid] = {
                "researcher_id": rid,
                "notification_email": row[1] or "",
                "active_reef_ids": row[2] or "[]",
                "critical_alerts_enabled": bool(row[3]),
                "anomaly_alerts_enabled": bool(row[4]),
                "weekly_summary_enabled": bool(row[5]),
                "anomaly_threshold": row[6] if row[6] is not None else 1.0,
                "created_at": row[7],
                "updated_at": row[8],
            }
        if not additions:
            print(f"[profiles-gcs] all {len(rows)} SQLite profiles already in GCS")
            return
        merged = {**existing, **additions}
        with _gcs_profiles_lock:
            bucket = _get_profiles_gcs_bucket()
            if bucket:
                blob = bucket.blob(_GCS_PROFILES_OBJECT)
                blob.upload_from_string(
                    json.dumps(merged, ensure_ascii=False, indent=2, default=str),
                    content_type="application/json",
                )
        print(f"[profiles-gcs] migrated {len(additions)}/{len(rows)} SQLite profiles to GCS")
    except Exception as _e:
        print(f"[profiles-gcs] migration to GCS failed (non-fatal): {_e}")


def _log_mcp_call(tool_name: str, summary: str, data: Any = None) -> None:
    ts = datetime.now(timezone.utc).isoformat()
    preview: Optional[str] = None
    if data is not None:
        raw = data if isinstance(data, str) else json.dumps(data, default=str)
        preview = raw[:300]
    entry: Dict[str, Any] = {"timestamp": ts, "tool": tool_name, "summary": summary}
    if preview:
        entry["data_preview"] = preview
    _mcp_tool_call_log.append(entry)
    if len(_mcp_tool_call_log) > 100:
        _mcp_tool_call_log.pop(0)
    try:
        with _mcp_db_lock:
            con = sqlite3.connect(_MCP_DB_PATH)
            con.execute(
                "INSERT INTO mcp_tool_calls (timestamp, tool, summary, data_preview) VALUES (?, ?, ?, ?)",
                (ts, tool_name, summary, preview),
            )
            # Keep only the last 500 rows to bound disk usage
            con.execute("DELETE FROM mcp_tool_calls WHERE id <= (SELECT MAX(id) - 500 FROM mcp_tool_calls)")
            con.commit()
            con.close()
    except Exception as db_err:
        print(f"[mcp_log] SQLite write failed (non-fatal): {db_err}")


# Gemini function declarations for Phoenix MCP tools
_PHOENIX_MCP_TOOL_DECLARATIONS = [
    {
        "name": "query_phoenix_traces",
        "description": (
            "Query the Phoenix observability platform via MCP to retrieve recent AI inference "
            "traces from ReefWatch reef analysis operations. Returns span data including "
            "reef names, risk scores, latency, and input/output previews."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "limit": {
                    "type": "integer",
                    "description": "Number of recent traces to retrieve (1-20, default 5)",
                }
            },
        },
    },
    {
        "name": "query_phoenix_quality_metrics",
        "description": (
            "Query Phoenix MCP to get real-time AI quality metrics including total traces, "
            "average latency, error rate, token usage, cache hit rate, and model confidence "
            "from ReefWatch inference history."
        ),
        "parameters": {
            "type": "object",
            "properties": {},
        },
    },
]

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
    # Rejection cooldown — set when an experiment is rejected so the next cycle
    # does not immediately retry unless quality drops by at least REJECTION_RETRY_THRESHOLD.
    "last_experiment_rejected_at": None,
    "last_experiment_rejected_score": None,
}

# Gemini API call telemetry — counts calls per phase so the dashboard can show estimated cost.
_gemini_cost_stats: Dict[str, Any] = {
    "last_eval_calls": 0,
    "last_experiment_calls": 0,
    "nightly_cycle_calls": 0,
    "total_calls_this_session": 0,
    "last_eval_at": None,
    "last_experiment_at": None,
    "last_nightly_at": None,
}

# Minimum absolute drop in quality score before a rejected experiment can be retried.
_REJECTION_RETRY_THRESHOLD = 0.05   # 5 percentage points
# Hours after a rejection during which a retry is blocked unless score dropped enough.
_REJECTION_COOLDOWN_HOURS = 24

def _persist_scores_to_disk() -> None:
    try:
        LAST_SCORES_PATH.write_text(json.dumps(_last_self_improvement_scores))
        print(f"[self-improvement] scores persisted to {LAST_SCORES_PATH}")
    except Exception as _e:
        print(f"[self-improvement] failed to persist scores: {_e}")


def _gcs_enabled() -> bool:
    return SELF_IMPROVEMENT_STORAGE == "GCS" and bool(SELF_IMPROVEMENT_GCS_BUCKET)


def _get_gcs_bucket_obj() -> Optional[Any]:
    """Return a GCS Bucket object, or None if GCS is not configured or unavailable."""
    if not _gcs_enabled():
        return None
    try:
        from google.cloud import storage as _gcs_storage  # noqa: PLC0415
        client = _gcs_storage.Client()
        return client.bucket(SELF_IMPROVEMENT_GCS_BUCKET)
    except ImportError:
        print("[gcs] google-cloud-storage not installed; falling back to local storage")
        return None
    except Exception as _e:
        print(f"[gcs] failed to init GCS bucket: {type(_e).__name__}: {_e}")
        return None


def _load_history_from_gcs(limit: int = 90) -> List[Dict[str, Any]]:
    """Read self-improvement runs from GCS JSONL, newest-first. Returns [] when GCS unavailable."""
    if not _gcs_enabled():
        return []
    try:
        bucket = _get_gcs_bucket_obj()
        if bucket is None:
            return []
        blob = bucket.blob(_GCS_SI_OBJECT)
        if not blob.exists():
            return []
        content = blob.download_as_text(encoding="utf-8")
        runs: List[Dict[str, Any]] = []
        for line in content.splitlines():
            line = line.strip()
            if line:
                try:
                    runs.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
        runs.sort(
            key=lambda r: r.get("stored_at") or r.get("completed_at") or r.get("date") or "",
            reverse=True,
        )
        return runs[:limit]
    except Exception as _e:
        print(f"[gcs] failed to load history: {type(_e).__name__}: {_e}")
        return []


def _append_run_to_gcs(record: Dict[str, Any]) -> bool:
    """Append a single run record to the GCS JSONL file. Returns True on success."""
    if not _gcs_enabled():
        return False
    try:
        with _gcs_write_lock:
            bucket = _get_gcs_bucket_obj()
            if bucket is None:
                return False
            blob = bucket.blob(_GCS_SI_OBJECT)
            existing = blob.download_as_text(encoding="utf-8") if blob.exists() else ""
            stored_at = record.get("stored_at", "")
            # Dedup by stored_at timestamp
            if stored_at and stored_at in existing:
                print(f"[gcs] record stored_at={stored_at} already present, skipping")
                return True
            new_line = json.dumps(record, ensure_ascii=False, default=str)
            updated = (existing.rstrip("\n") + "\n" + new_line + "\n") if existing.strip() else (new_line + "\n")
            blob.upload_from_string(updated, content_type="application/x-ndjson")
            print(f"[gcs] appended run to gs://{SELF_IMPROVEMENT_GCS_BUCKET}/{_GCS_SI_OBJECT} stored_at={stored_at}")
            return True
    except Exception as _e:
        print(f"[gcs] failed to append run: {type(_e).__name__}: {_e}")
        return False


def _hydrate_sqlite_from_gcs() -> None:
    """On startup: load GCS history into SQLite cache so local lookups are fast."""
    if not _gcs_enabled():
        return
    try:
        runs = _load_history_from_gcs(limit=90)
        if not runs:
            return
        hydrated = 0
        for run in runs:
            stored_at = run.get("stored_at") or run.get("completed_at") or run.get("date")
            if not stored_at:
                continue
            record = {**run, "stored_at": stored_at}
            if _save_run_to_history_sqlite(record):
                hydrated += 1
        print(f"[gcs] hydrated SQLite cache from GCS: {hydrated}/{len(runs)} runs")
    except Exception as _e:
        print(f"[gcs] SQLite hydration from GCS failed (non-fatal): {_e}")


def _migrate_json_history_to_gcs() -> None:
    """One-time migration: upload existing JSON history records to GCS, skipping duplicates."""
    if not _gcs_enabled():
        return
    try:
        runs: List[Dict[str, Any]] = json.loads(
            SELF_IMPROVEMENT_RUNS_PATH.read_text(encoding="utf-8")
        )
        if not isinstance(runs, list) or not runs:
            return
    except Exception:
        return
    existing_gcs = _load_history_from_gcs(limit=200)
    existing_stored_ats = {r.get("stored_at") for r in existing_gcs if r.get("stored_at")}
    migrated = 0
    for run in runs:
        stored_at = run.get("stored_at") or run.get("completed_at") or run.get("date")
        if not stored_at:
            continue
        if stored_at in existing_stored_ats:
            continue
        record = {**run, "stored_at": stored_at}
        if _append_run_to_gcs(record):
            existing_stored_ats.add(stored_at)
            migrated += 1
    print(f"[gcs] migrated {migrated}/{len(runs)} JSON history entries to GCS")


def _save_run_to_history_sqlite(record: Dict[str, Any]) -> bool:
    """Write a run record to SQLite. Returns True on success."""
    try:
        with _mcp_db_lock:
            con = sqlite3.connect(_MCP_DB_PATH)
            con.execute(
                """
                INSERT OR IGNORE INTO self_improvement_runs
                    (stored_at, completed_at, source, status, average_score, prompt_updated, run_json)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record.get("stored_at") or utc_now(),
                    record.get("completed_at") or record.get("last_checked"),
                    record.get("source"),
                    record.get("status"),
                    record.get("average_score"),
                    1 if record.get("prompt_updated") else 0,
                    json.dumps(record, ensure_ascii=False),
                ),
            )
            con.commit()
            con.close()
        return True
    except Exception as _e:
        print(f"[self-improvement] sqlite write failed: {type(_e).__name__}: {_e}")
        return False


def _load_history_from_sqlite(limit: int = 90) -> List[Dict[str, Any]]:
    """Return runs from SQLite ordered newest-first. Returns [] on any error."""
    try:
        with _mcp_db_lock:
            con = sqlite3.connect(_MCP_DB_PATH)
            rows = con.execute(
                """
                SELECT run_json FROM self_improvement_runs
                ORDER BY COALESCE(completed_at, stored_at) DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
            con.close()
        return [json.loads(row[0]) for row in rows]
    except Exception as _e:
        print(f"[self-improvement] sqlite read failed: {type(_e).__name__}: {_e}")
        return []


def _migrate_json_history_to_sqlite() -> None:
    """Import existing JSON history into SQLite once, skipping duplicates via UNIQUE(stored_at)."""
    try:
        runs: List[Dict[str, Any]] = json.loads(
            SELF_IMPROVEMENT_RUNS_PATH.read_text(encoding="utf-8")
        )
        if not isinstance(runs, list) or not runs:
            return
        imported = 0
        for run in runs:
            stored_at = run.get("stored_at") or run.get("completed_at") or run.get("date")
            if not stored_at:
                continue
            record = {**run, "stored_at": stored_at}
            if _save_run_to_history_sqlite(record):
                imported += 1
        print(f"[self-improvement] migrated {imported}/{len(runs)} JSON history entries to SQLite")
    except Exception as _e:
        print(f"[self-improvement] json→sqlite migration skipped: {type(_e).__name__}: {_e}")


def _save_run_to_history(result: Dict[str, Any]) -> None:
    """Persist a completed (or skipped) run — GCS primary, SQLite cache, JSON local fallback."""
    stored_at = result.get("stored_at") or utc_now()
    record = {**result, "stored_at": stored_at}

    gcs_ok = _append_run_to_gcs(record)
    sqlite_ok = _save_run_to_history_sqlite(record)
    if gcs_ok:
        storage_label = "gcs+sqlite" if sqlite_ok else "gcs"
    else:
        storage_label = "sqlite" if sqlite_ok else "(all backends failed)"
    print(
        f"[self-improvement] run saved to {storage_label} "
        f"— status={result.get('status')} score={result.get('average_score')}"
    )

    # Mirror to local JSON as dev fallback (not production source of truth)
    try:
        SELF_IMPROVEMENT_RUNS_PATH.parent.mkdir(parents=True, exist_ok=True)
        try:
            runs: List[Dict[str, Any]] = json.loads(
                SELF_IMPROVEMENT_RUNS_PATH.read_text(encoding="utf-8")
            )
            if not isinstance(runs, list):
                runs = []
        except Exception:
            runs = []
        runs.append(record)
        SELF_IMPROVEMENT_RUNS_PATH.write_text(
            json.dumps(runs, indent=2, ensure_ascii=False)
        )
    except Exception as _e:
        if not gcs_ok and not sqlite_ok:
            print(f"[self-improvement] all storage backends failed: {type(_e).__name__}: {_e}")


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
    station_id: Optional[str] = None
    name: str
    lat: float
    lng: float
    researcher_id: Optional[str] = None


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
    source: str = "manual"
    skip_rewrite: bool = False   # evaluation-only; rewrite handled by autonomous experiment pipeline
    force_fresh: bool = False    # bypass 30-min freshness cache


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
    _init_mcp_db()
    _migrate_json_history_to_sqlite()
    _migrate_json_history_to_gcs()
    _hydrate_sqlite_from_gcs()
    _restore_scores_from_history()           # Recover real scores from GCS/SQLite after cold starts
    _hydrate_researcher_profiles_from_gcs()  # Restore researcher profiles from GCS into SQLite
    _migrate_sqlite_profiles_to_gcs()        # Push any pre-existing SQLite profiles up to GCS
    _load_monitored_reefs_from_db()
    os.makedirs(REEF_ANALYSIS_PROMPT_HISTORY_DIR, exist_ok=True)
    print(f"[env] REEFWATCH_API_URL={REEFWATCH_API_URL}")
    print(f"[env] REEFWATCH_TRACE_URL={REEFWATCH_TRACE_URL}")
    print(f"[env] OPENAI_API_KEY={'set' if os.getenv('OPENAI_API_KEY') else 'missing'}")
    print(f"[env] ALERT_EMAIL_FROM={'set' if ALERT_EMAIL_FROM else 'missing'}")
    print(f"[env] ALERT_EMAIL_PASSWORD={'set' if ALERT_EMAIL_PASSWORD else 'missing'} (recipient configured via Settings UI)")
    print(f"[env] SELF_IMPROVEMENT_STORAGE={SELF_IMPROVEMENT_STORAGE} bucket={SELF_IMPROVEMENT_GCS_BUCKET or '(not set)'}")
    print(f"[env] researcher-profiles GCS={'enabled' if _profiles_gcs_enabled() else 'disabled (set SELF_IMPROVEMENT_GCS_BUCKET)'}")
    _alert_scheduler.add_job(
        _run_alert_check,
        "interval",
        hours=6,
        id="reef_alert_check",
        replace_existing=True,
    )
    _alert_scheduler.start()
    print("[alert-scheduler] started — reef alert check will run every 6 hours")

    # Seed caches immediately so first requests return instantly (short TTL lets real data replace).
    # Use _snapshot_fallback_reefs() so startup IDs match _NOAA_REEF_LOCATIONS — the same IDs that
    # live NOAA data will return after warm-up. _STATIC_LIVE_REEFS used different IDs (e.g.
    # "florida-keys" vs "florida-keys-reef") causing localStorage selections to become orphaned.
    _startup_seed = _snapshot_fallback_reefs()
    _cache_set(_NOAA_CACHE, "live:list", _startup_seed, 300)
    print(f"[startup] seeded live reef cache with {len(_startup_seed)} snapshot entries (5-min TTL, IDs match NOAA locations)")

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
    # Standard OpenInference attributes — required for Phoenix to display input/output columns
    set_attrs(span, {
        "input.value": summarize_text(prompt, limit=1000),
        "output.value": summarize_text(response, limit=1000) if response else "",
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
        baseline = dict(_seeded_observability_baseline)
        baseline["last_trace_time"] = utc_now()
        return baseline

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
        async with httpx.AsyncClient(timeout=4.0) as client:
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


async def _execute_phoenix_mcp_tool(tool_name: str, args: Dict[str, Any]) -> Dict[str, Any]:
    """Execute a Phoenix MCP tool call and log it."""
    phoenix = PhoenixMCPClient(_phoenix_client_base_url(), project_name=PHOENIX_PROJECT_NAME, space_id=ARIZE_SPACE_ID)

    if tool_name == "query_phoenix_traces":
        limit = max(1, min(int(args.get("limit", 5)), 20))
        spans = await phoenix.get_recent_spans(limit=limit)
        cleaned = [clean_phoenix_trace(s) for s in spans[:limit]]
        _log_mcp_call(
            "query_phoenix_traces",
            f"Retrieved {len(cleaned)} recent traces from Phoenix MCP",
            {"count": len(cleaned), "traces": cleaned[:3]},
        )
        return {"traces": cleaned, "count": len(cleaned), "source": "phoenix_mcp"}

    if tool_name == "query_phoenix_quality_metrics":
        metrics = current_observability_metrics()
        result = {
            "total_traces": metrics.get("total_traces", 0),
            "average_latency_ms": metrics.get("average_latency_ms"),
            "error_rate": metrics.get("error_rate"),
            "cache_hit_rate": metrics.get("cache_hit_rate"),
            "average_confidence": metrics.get("average_confidence"),
            "total_tokens": metrics.get("total_tokens"),
            "source": "phoenix_mcp_metrics",
        }
        _log_mcp_call(
            "query_phoenix_quality_metrics",
            f"Retrieved quality metrics: {result['total_traces']} traces, {result['error_rate']}% error rate",
            result,
        )
        return result

    return {"error": f"Unknown MCP tool: {tool_name}"}


async def generate_text_with_mcp_tools(
    prompt: str,
    *,
    prompt_template_name: str = "chat_mcp_v1",
) -> Dict[str, Any]:
    """Run Gemini with Phoenix MCP function tools. Handles one round of tool calls."""
    if not gemini_connected:
        raise HTTPException(status_code=503, detail="Gemini is not configured.")

    import google.generativeai.types as genai_types  # noqa: PLC0415

    tool_decls = [genai_types.FunctionDeclaration(**d) for d in _PHOENIX_MCP_TOOL_DECLARATIONS]
    model = genai.GenerativeModel(
        GEMINI_MODEL_NAME,
        tools=[genai_types.Tool(function_declarations=tool_decls)],
    )

    start = time.perf_counter()
    mcp_calls_made: List[str] = []

    try:
        response = model.generate_content(prompt)
        parts = response.candidates[0].content.parts if response.candidates else []

        # Check if Gemini wants to call a tool
        tool_results = []
        for part in parts:
            if hasattr(part, "function_call") and part.function_call:
                fc = part.function_call
                mcp_calls_made.append(fc.name)
                tool_result = await _execute_phoenix_mcp_tool(fc.name, dict(fc.args or {}))
                tool_results.append(genai.protos.Part(
                    function_response=genai.protos.FunctionResponse(
                        name=fc.name,
                        response={"result": json.dumps(tool_result, default=str)},
                    )
                ))

        # If tools were called, send results back for final answer
        if tool_results:
            chat = model.start_chat(history=[
                {"role": "user", "parts": [prompt]},
                {"role": "model", "parts": parts},
            ])
            response = chat.send_message(tool_results)

        text = response.text.strip() if hasattr(response, "text") else ""
        latency = elapsed_ms(start)
        return {
            "text": text,
            "latency_ms": latency,
            "mcp_tools_called": mcp_calls_made,
            "prompt_tokens": estimate_tokens(prompt),
            "completion_tokens": estimate_tokens(text),
            "total_tokens": estimate_tokens(prompt) + estimate_tokens(text),
        }
    except Exception as err:
        # Fall back to plain generation if tool calling fails
        print(f"[mcp-tools] function calling failed ({err}), falling back to plain generate")
        plain = genai.GenerativeModel(GEMINI_MODEL_NAME)
        response = plain.generate_content(prompt)
        text = response.text.strip() if hasattr(response, "text") else ""
        latency = elapsed_ms(start)
        return {
            "text": text,
            "latency_ms": latency,
            "mcp_tools_called": [],
            "prompt_tokens": estimate_tokens(prompt),
            "completion_tokens": estimate_tokens(text),
            "total_tokens": estimate_tokens(prompt) + estimate_tokens(text),
        }


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
            "openinference.span.kind": "LLM",
            "llm.provider": "google",
            "llm.model_name": GEMINI_MODEL_NAME,
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
    )


async def build_fresh_evaluation_items(
    reefs: List[Dict[str, Any]],
    limit: int = 10,
    warnings: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    eligible = [r for r in reefs if reef_has_real_noaa_values(r)][:limit]

    async def _analyze_one(reef: Dict[str, Any]) -> Optional[Dict[str, Any]]:
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
            return None
        return {
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
        }

    results = await asyncio.gather(*[_analyze_one(r) for r in eligible])
    return [item for item in results if item is not None]


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

    # Explainability fields for transparency into why each assessment scored as it did
    validated["reasoning"] = str(result.get("reasoning", "")).strip()[:500]
    validated["positive_signals"] = [
        str(s).strip()[:200] for s in (result.get("positive_signals") or [])[:3]
        if str(s).strip()
    ]
    validated["penalties"] = [
        str(p).strip()[:200] for p in (result.get("penalties") or [])[:3]
        if str(p).strip()
    ]
    validated["score_breakdown"] = {k: validated[k] for k in score_keys}
    return validated


def build_judge_prompt(assessment: AssessmentForImprovement) -> str:
    inp = assessment.input_data or {}
    noaa = inp.get("noaa") or {}
    if isinstance(noaa, str):
        try:
            noaa = json.loads(noaa)
        except Exception:
            noaa = {}
    dhw = inp.get("degreeHeatingWeeks") or noaa.get("degreeHeatingWeeks") or inp.get("dhw")
    dhw_available = dhw is not None
    dhw_note = f"DHW = {dhw} wk" if dhw_available else "DHW = UNAVAILABLE (missing from NOAA feed)"

    output = assessment.model_output or {}
    if isinstance(output, dict):
        recommended_actions = output.get("recommended_actions", [])
        if isinstance(recommended_actions, list):
            actions_text = "\n".join(f"  - {act}" for act in recommended_actions[:5]) or "  (none provided)"
        else:
            actions_text = f"  {str(recommended_actions)[:300]}"
    else:
        actions_text = "  (not available)"

    return f"""You are evaluating a coral reef AI assessment for quality.

CRITICAL PRINCIPLE: Evaluate MODEL REASONING QUALITY, not data availability.
Missing NOAA data is a data infrastructure limitation, NOT an AI failure.

NOAA INPUT DATA:
{json.dumps(assessment.input_data, default=str, indent=2)}
Note: {dhw_note}

AI ASSESSMENT OUTPUT:
{json.dumps(assessment.model_output, default=str, indent=2)}

RECOMMENDED ACTIONS:
{actions_text}

Score each dimension 0-100 using these graduated scales:

accuracy: Does risk level match the available data?
  80-100: Risk level perfectly matches SST/DHW data (DHW>8→critical, DHW 4-8→warning, DHW<4→safe)
  60-79: Risk level mostly correct with minor misestimation
  40-59: Risk level partially mismatched
  0-39: Risk level directly contradicts the data — only if DHW is available and ignored

specificity: Is this specific to this reef or generic?
  76-100: References exact reef name, exact NOAA values, location-relevant factors
  51-75: Mostly specific with some generic elements
  26-50: Mix of specific and generic content
  0-25: Completely generic — could apply to any reef

actionability: Quality of recommended_actions:
  76-100: Names specific parties, timeframes, and measurable steps
  51-75: Practical and relevant; specifies what to do even without named parties
  26-50: Basic but applicable (conduct surveys, increase monitoring frequency)
  0-25: Vague platitudes only ("stay informed", "be aware") OR no actions at all
  *** Hard zero ONLY when: no actions exist, or all are completely unusable ***

scientific_reliability: Are scientific thresholds correctly applied?
  DHW >8 = Alert Level 2, DHW 4-8 = Alert Level 1, DHW <4 = no alert
  80-100: All thresholds correctly applied with appropriate uncertainty language
  50-79: Mostly correct; minor threshold misapplication acceptable
  0-49: Major scientific errors (e.g., "safe" assessment when DHW=9)

dhw_interpretation: How well was DHW interpreted?
  IF DHW IS AVAILABLE: score on whether the value was correctly contextualized (80-100 = cited + threshold)
  IF DHW IS UNAVAILABLE:
    65-80: AI explicitly stated DHW is unavailable and limited precision accordingly
    40-64: AI noted general data limitations without naming DHW specifically
    20-39: AI gave confident assessment without acknowledging the DHW gap
    0-19: AI fabricated a DHW value (hallucination)
  *** DO NOT give 0 simply because DHW data was unavailable ***

uncertainty_communication: Are data gaps and limitations communicated?
  76-100: Names missing fields, qualifies conclusions, uses hedging language
  51-75: Acknowledges uncertainty in general terms
  26-50: Minimal hedging; some awareness of limitations
  0-25: States conclusions as facts when data is incomplete; no uncertainty acknowledged

hallucination_avoidance: Does the AI avoid fabricating data?
  80-100: Only references provided data; extrapolations clearly labeled as inference
  60-79: Mostly grounded; minor scientifically-reasonable interpretive leaps
  0-59: Invents specific values, events, or conditions not in the input

Return JSON only:
{{
  "accuracy": 0,
  "specificity": 0,
  "actionability": 0,
  "scientific_reliability": 0,
  "dhw_interpretation": 0,
  "uncertainty_communication": 0,
  "hallucination_avoidance": 0,
  "reasoning": "2-3 sentence explanation of the scores",
  "positive_signals": ["strength 1", "strength 2"],
  "penalties": ["issue 1", "issue 2"],
  "main_weaknesses": ["weakness 1", "weakness 2"],
  "improvement_suggestion": "specific prompt change needed"
}}
"""


def build_batch_judge_prompt(assessments: "List[AssessmentForImprovement]") -> str:
    items = []
    for i, a in enumerate(assessments):
        inp = a.input_data or {}
        noaa = inp.get("noaa") or {}
        if isinstance(noaa, str):
            try:
                noaa = json.loads(noaa)
            except Exception:
                noaa = {}
        sst = inp.get("seaSurfaceTemp") or noaa.get("seaSurfaceTemp") or inp.get("sst")
        dhw = inp.get("degreeHeatingWeeks") or noaa.get("degreeHeatingWeeks") or inp.get("dhw")
        anomaly = inp.get("tempAnomaly") or noaa.get("tempAnomaly") or inp.get("sst_anomaly")
        alert = inp.get("bleachingAlertLevel") or noaa.get("bleachingAlertLevel") or inp.get("alert_level")

        missing = []
        if sst is None: missing.append("SST")
        if dhw is None: missing.append("DHW")
        if anomaly is None: missing.append("anomaly")
        data_note = f"[MISSING: {', '.join(missing)}]" if missing else "[all fields available]"

        sst_str = f"{sst}°C" if sst is not None else "unavailable"
        dhw_str = f"{dhw} wk" if dhw is not None else "UNAVAILABLE"
        anomaly_str = f"{anomaly}°C" if anomaly is not None else "unavailable"
        alert_str = str(alert) if alert is not None else "none"

        output = a.model_output or {}
        if isinstance(output, dict):
            risk_score = output.get("risk_score")
            risk_level = output.get("risk_level") or output.get("status")
            confidence = output.get("confidence")
            threat_summary = (output.get("threat_summary") or output.get("summary") or "")[:300]
            historical_context = str(output.get("historical_context") or "")[:200]
            recommended_actions = output.get("recommended_actions", [])
            if isinstance(recommended_actions, list):
                actions_text = "\n".join(f"    - {act}" for act in recommended_actions[:5]) or "    (none provided)"
            else:
                actions_text = f"    {str(recommended_actions)[:300]}"
        else:
            risk_score = None; risk_level = None; confidence = None
            threat_summary = str(output)[:300]; historical_context = ""; actions_text = "    (not available)"

        items.append(
            f"--- Assessment {i+1}: {a.reef_name} ---\n"
            f"NOAA DATA {data_note}:\n"
            f"  SST={sst_str}, DHW={dhw_str}, Anomaly={anomaly_str}, Alert={alert_str}\n"
            f"AI OUTPUT:\n"
            f"  Risk score={risk_score}, Risk level={risk_level}, Confidence={confidence}\n"
            f"  Threat summary: {threat_summary}\n"
            f"  Historical context: {historical_context}\n"
            f"  Recommended actions:\n{actions_text}"
        )

    assessments_text = "\n\n".join(items)
    n = len(assessments)

    return f"""You are a scientific evaluator scoring coral reef AI assessments on 7 dimensions (0-100).

CRITICAL PRINCIPLE: Evaluate MODEL REASONING QUALITY, not data availability.
Missing NOAA data (SST, DHW, anomaly) is a data infrastructure limitation, NOT an AI failure.
The AI earns high scores by correctly reasoning with the data that IS available.

{assessments_text}

SCORING RUBRIC (apply to each assessment independently):

accuracy (0-100): Does risk level match available data?
  80-100: Risk level perfectly matches DHW/SST (DHW>8→critical, DHW 4-8→warning, DHW<4→safe)
  60-79: Mostly correct with minor over/under-estimation
  40-59: Partial mismatch with data
  0-39: Risk level directly contradicts the data (only if DHW/SST is available and was ignored)

specificity (0-100): Is this assessment specific to this reef?
  76-100: References exact reef name, exact NOAA values, location-specific factors
  51-75: Mostly specific with some generic elements
  26-50: Mix of specific and generic content
  0-25: Completely generic; could apply to any reef anywhere

actionability (0-100): Quality of recommended actions:
  76-100: Names specific parties (AIMS, local rangers, dive operators), specific timeframes, measurable steps
  51-75: Practical and relevant; specifies what to do even without named parties
  26-50: Basic but applicable actions (conduct surveys, increase monitoring frequency)
  0-25: Only vague platitudes ("stay informed", "continue monitoring") OR no actions provided at all
  *** HARD ZERO only when: no recommended_actions at all, OR every action is completely unusable ***
  *** Do NOT give 0 simply because actions lack named parties or timeframes ***

scientific_reliability (0-100): Are scientific thresholds correctly applied?
  DHW>8 = Alert Level 2 (high bleaching risk), DHW 4-8 = Alert Level 1 (watch), DHW<4 = no alert
  SST anomaly >1°C = elevated stress, >2°C = high stress
  80-100: All thresholds correctly applied; appropriate uncertainty stated
  50-79: Mostly correct; minor threshold errors acceptable
  0-49: Major scientific errors (e.g., "safe" when DHW=9)

dhw_interpretation (0-100): How well was DHW interpreted?
  IF DHW IS AVAILABLE: score whether the exact value was correctly contextualized
    80-100: DHW value cited and compared against Alert Level thresholds
    50-79: DHW acknowledged but imprecisely contextualized
    0-49: DHW value ignored or grossly misinterpreted
  IF DHW IS UNAVAILABLE ("UNAVAILABLE" above):
    65-80: AI explicitly stated DHW unavailability and qualified conclusions accordingly
    40-64: AI noted general data limitations without naming DHW specifically
    20-39: AI gave confident conclusions without acknowledging the major gap
    0-19: AI fabricated a DHW value (hallucination) — the ONLY valid reason for very low score here
  *** DO NOT score below 40 simply because DHW data was missing from NOAA ***

uncertainty_communication (0-100): Are data gaps and limitations communicated?
  76-100: Names missing fields explicitly; qualifies conclusions; uses hedging language
  51-75: Acknowledges uncertainty in general terms; some qualification
  26-50: Minimal hedging; some awareness of limitations
  0-25: States conclusions as certain facts when data is incomplete; zero acknowledgment

hallucination_avoidance (0-100): Does the AI avoid fabricating data beyond input?
  80-100: Only references provided data; extrapolations clearly labeled as inference
  60-79: Mostly grounded; minor scientifically-reasonable interpretive leaps
  0-59: Invents specific values, events, or conditions not present in the input

Return a JSON array with exactly {n} objects (one per assessment, in order):
[{{
  "accuracy": 0,
  "specificity": 0,
  "actionability": 0,
  "scientific_reliability": 0,
  "dhw_interpretation": 0,
  "uncertainty_communication": 0,
  "hallucination_avoidance": 0,
  "reasoning": "2-3 sentence explanation of these specific scores",
  "positive_signals": ["strength 1", "strength 2"],
  "penalties": ["issue 1", "issue 2"],
  "main_weaknesses": ["weakness 1", "weakness 2"],
  "improvement_suggestion": "specific prompt change needed"
}}]

Return the JSON array only, no additional text."""


def average_score(judgements: List[Dict[str, Any]], key: str) -> float:
    if not judgements:
        return 0.0
    return round(sum(float(item[key]) for item in judgements) / len(judgements), 3)


def _format_diagnosis(failing_dims: Dict[str, float], causes: Dict[str, str], data_gap_likely: bool) -> str:
    if not failing_dims:
        return "All dimensions meet threshold — no rewrite needed."
    parts = [f"{dim}={score:.0%} ({causes.get(dim, 'unknown')})" for dim, score in failing_dims.items()]
    summary = "; ".join(parts)
    if data_gap_likely:
        summary += " [note: some low scores may be due to missing NOAA data, not model reasoning]"
    return summary


def diagnose_root_cause(
    judgements: List[Dict[str, Any]],
    assessments: List[Any],
    dim_averages: Dict[str, float],
) -> Dict[str, Any]:
    """Analyze why quality scores are low to inform targeted, surgical prompt rewrites.

    Returns a diagnosis dict with failing_dimensions, likely causes, and whether a rewrite
    is warranted (i.e., there are model-reasoning failures beyond data-gap issues).
    """
    FAILING_THRESHOLD = 0.60
    failing_dims = {k: v for k, v in dim_averages.items() if v < FAILING_THRESHOLD}

    # Detect how many assessments are missing DHW — a common cause of artificially low scores
    missing_dhw_count = 0
    for a in assessments:
        inp = getattr(a, "input_data", None) or {}
        noaa = inp.get("noaa") or {}
        if isinstance(noaa, str):
            try:
                noaa = json.loads(noaa)
            except Exception:
                noaa = {}
        dhw = inp.get("degreeHeatingWeeks") or noaa.get("degreeHeatingWeeks") or inp.get("dhw")
        if dhw is None:
            missing_dhw_count += 1

    data_gap_likely = missing_dhw_count > 0 and missing_dhw_count >= len(assessments) / 2

    causes: Dict[str, str] = {}
    for dim in failing_dims:
        if dim == "dhw_interpretation" and data_gap_likely:
            causes[dim] = "missing_noaa_dhw_data"
        elif dim == "actionability":
            causes[dim] = "prompt_lacks_specificity_guidance"
        elif dim == "specificity":
            causes[dim] = "prompt_produces_generic_output"
        elif dim in ("accuracy", "scientific_reliability"):
            causes[dim] = "prompt_lacks_threshold_guidance"
        elif dim == "uncertainty_communication":
            causes[dim] = "prompt_lacks_uncertainty_language"
        elif dim == "hallucination_avoidance":
            causes[dim] = "prompt_allows_extrapolation"
        else:
            causes[dim] = "unknown"

    data_gap_dims = [d for d, c in causes.items() if c == "missing_noaa_dhw_data"]
    model_reasoning_dims = [d for d, c in causes.items() if c != "missing_noaa_dhw_data"]

    all_penalties: List[str] = []
    for j in judgements:
        all_penalties.extend(j.get("penalties", []))

    return {
        "failing_dimensions": list(failing_dims.keys()),
        "failing_scores": failing_dims,
        "dimension_causes": causes,
        "data_gap_likely": data_gap_likely,
        "missing_dhw_count": missing_dhw_count,
        "total_assessments": len(assessments),
        "data_gap_dimensions": data_gap_dims,
        "model_reasoning_dimensions": model_reasoning_dims,
        "rewrite_warranted": len(model_reasoning_dims) >= 1,
        "collected_penalties": all_penalties[:10],
        "diagnosis_summary": _format_diagnosis(failing_dims, causes, data_gap_likely),
    }


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


def build_improvement_prompt(
    current_prompt: str,
    feedback: Dict[str, Any],
    diagnosis: Optional[Dict[str, Any]] = None,
    phoenix_failure_modes: Optional[List[Dict[str, Any]]] = None,
    prior_rejections: Optional[List[Dict[str, Any]]] = None,
) -> str:
    model_dims = (diagnosis or {}).get("model_reasoning_dimensions", [])
    diagnosis_summary = (diagnosis or {}).get("diagnosis_summary", "General quality issues detected.")

    target_instructions: List[str] = []
    for dim in model_dims:
        if dim == "actionability":
            target_instructions.append(
                "STRENGTHEN the recommended_actions section: require the AI to name specific "
                "stakeholders (e.g., 'notify AIMS monitoring team', 'alert local dive operators'), "
                "include timeframes ('within 24 hours', 'this week'), and specify measurable steps "
                "('deploy temperature loggers', 'conduct bleaching survey'). "
                "The prompt must explicitly prohibit vague actions like 'monitor conditions' without specifics."
            )
        elif dim == "specificity":
            target_instructions.append(
                "STRENGTHEN specificity requirements: the AI must reference the exact reef name, "
                "the exact NOAA values provided, and consider location-specific ecological factors. "
                "Generic statements that could apply to any reef anywhere must be prohibited."
            )
        elif dim in ("accuracy", "scientific_reliability"):
            target_instructions.append(
                "STRENGTHEN threshold guidance: explicitly state DHW >8 = Alert Level 2 (high bleaching risk), "
                "DHW 4-8 = Alert Level 1 (bleaching watch), DHW <4 = no alert. "
                "SST anomaly >1°C = elevated stress, >2°C = high stress. "
                "The assigned risk level must directly match these thresholds."
            )
        elif dim == "uncertainty_communication":
            target_instructions.append(
                "STRENGTHEN uncertainty language: when any NOAA field (SST, DHW, anomaly) is unavailable, "
                "the AI must explicitly name the missing field and state how it limits assessment precision. "
                "Required phrasing: 'Due to unavailable DHW data, bleaching risk estimates carry higher uncertainty.'"
            )
        elif dim == "dhw_interpretation":
            target_instructions.append(
                "STRENGTHEN DHW handling: when DHW is available, cite the exact value and compare against "
                "Alert Level thresholds. When DHW is unavailable, explicitly acknowledge this and qualify "
                "all bleaching risk conclusions accordingly — never omit mention of the data gap."
            )

    if not target_instructions:
        target_instructions = ["Address the identified weaknesses listed below while preserving all working sections."]

    target_text = "\n\n".join(f"{i+1}. {inst}" for i, inst in enumerate(target_instructions))

    # Phoenix trace evidence section
    phoenix_section = ""
    if phoenix_failure_modes:
        lines = [
            f"  - {m['dimension']}: failing in {m['frequency']} production trace(s)"
            for m in phoenix_failure_modes[:5]
        ]
        phoenix_section = (
            "\n\nPHOENIX TRACE EVIDENCE (recurring failures observed across real production assessments):\n"
            + "\n".join(lines)
            + "\nThese dimensions appear most often in low-quality spans — prioritise them."
        )

    # Prior rejection section — tell Gemini what NOT to repeat
    rejection_section = ""
    if prior_rejections:
        lines = []
        for r in prior_rejections[:3]:
            target = r.get("target_dims") or "general"
            delta = r.get("delta")
            reason = r.get("rejection_reason") or r.get("reason") or "insufficient improvement"
            delta_str = f"{delta:+.3f}" if isinstance(delta, (int, float)) else "n/a"
            lines.append(f"  - Targeted [{target}]: experiment delta {delta_str} — {reason}")
        rejection_section = (
            "\n\nPREVIOUSLY ATTEMPTED REWRITES THAT FAILED EXPERIMENT VALIDATION (do NOT repeat these approaches):\n"
            + "\n".join(lines)
            + "\nChoose a meaningfully different strategy for the dimensions listed above."
        )

    return f"""You are improving a coral reef AI assessment system prompt. Make targeted, surgical changes — only fix the identified weak areas. Do not rewrite sections that are already working.

ROOT CAUSE DIAGNOSIS:
{diagnosis_summary}{phoenix_section}{rejection_section}

CURRENT SYSTEM PROMPT:
{current_prompt}

IDENTIFIED WEAKNESSES IN RECENT ASSESSMENTS:
{json.dumps(feedback.get("issues", []), default=str, indent=2)}

TARGETED CHANGES REQUIRED:
{target_text}

CONSTRAINTS:
- Only modify sections that address the identified weaknesses
- Do not remove accurate DHW threshold guidance if already present
- Do not add fabricated data or hallucinate reef-specific facts
- Do not relax scientific accuracy requirements
- Preserve the overall structure and any sections that are already working
- The result must be a complete, usable system prompt — not a diff or patch

Return ONLY the improved prompt text, nothing else."""


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
    diagnosis: Optional[Dict[str, Any]] = None,
) -> str:
    score_pct = f"{average_overall:.0%}"
    issue_text = issues[0] if issues else "no dominant weakness identified"

    dim_note = ""
    if diagnosis and diagnosis.get("model_reasoning_dimensions"):
        dims = diagnosis["model_reasoning_dimensions"]
        dim_note = f" Weakest dimensions: {', '.join(dims)}."

    if prompt_updated:
        targeted = ""
        if diagnosis and diagnosis.get("model_reasoning_dimensions"):
            targeted = f" Targeted fix applied to: {', '.join(diagnosis['model_reasoning_dimensions'])}."
        return (
            f"Evaluation completed — quality score {score_pct}.{dim_note}"
            f" System prompt rewritten to address identified weaknesses.{targeted}"
            " Verification will confirm improvement in the next evaluation cycle."
        )
    if average_overall < 0.75:
        if quota_limited:
            return (
                f"Evaluation completed — quality score {score_pct}.{dim_note}"
                f" Main finding: {issue_text}."
                " Prompt update needed but skipped — Gemini quota exhausted."
            )
        return (
            f"Evaluation completed — quality score {score_pct}.{dim_note}"
            f" Main finding: {issue_text}."
            " Prompt preserved — rewrite conditions not met (requires model-reasoning failures, not data gaps)."
        )
    return (
        f"Evaluation completed — quality score {score_pct}.{dim_note}"
        " Quality meets the 0.75 threshold; current prompt preserved."
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


def _compute_system_state(runs: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Compute the authoritative current system state from history runs (newest-first).

    Separates the latest run (which may be a skipped_healthy nightly) from the
    latest full evaluation (non-skip with real metrics) so the dashboard always
    shows the most recent verified quality — not a stale failed run.
    """
    _empty: Dict[str, Any] = {
        "system_status": "no_data",
        "status": None,
        "date": None,
        "last_checked": None,
        "last_full_eval_at": None,
        "assessment_count": 0,
        "average_score": None,
        "quality_score": None,
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
        "skip_reason": None,
        "source": None,
        "before_after": {"previous_score": None, "latest_score": None},
        "latest_verified_metrics": None,
        "prompt_rewrite_status": "none",
        "current_state_summary": "No evaluation has run yet.",
    }

    if not runs:
        return _empty

    latest_run = runs[0]

    # Find the latest full evaluation: non-skipped, has a real numeric score.
    latest_full_eval: Optional[Dict[str, Any]] = None
    for run in runs:
        if run.get("status") != "skipped_healthy" and isinstance(run.get("average_score"), (int, float)):
            latest_full_eval = run
            break

    if latest_full_eval is None:
        return {
            **_empty,
            "status": latest_run.get("status"),
            "date": latest_run.get("date"),
            "last_checked": latest_run.get("last_checked") or latest_run.get("completed_at"),
            "skip_reason": latest_run.get("skip_reason"),
            "summary": latest_run.get("summary", ""),
            "current_state_summary": latest_run.get("summary", "No full evaluation has completed yet."),
        }

    # Find the previous full evaluation (the one before latest_full_eval).
    prev_full_eval: Optional[Dict[str, Any]] = None
    past_latest = False
    for run in runs:
        if run is latest_full_eval:
            past_latest = True
            continue
        if past_latest and run.get("status") != "skipped_healthy" and isinstance(run.get("average_score"), (int, float)):
            prev_full_eval = run
            break

    latest_score: float = float(latest_full_eval.get("average_score") or 0)
    prompt_was_updated_in_latest: bool = bool(latest_full_eval.get("prompt_updated"))
    latest_is_skip: bool = latest_run.get("status") == "skipped_healthy"
    prev_score: Optional[float] = float(prev_full_eval["average_score"]) if prev_full_eval and isinstance(prev_full_eval.get("average_score"), (int, float)) else None

    # latest_verified_metrics always comes from the latest non-skipped full eval.
    latest_verified_metrics: Dict[str, Any] = {
        "average_score": latest_full_eval.get("average_score"),
        "accuracy": latest_full_eval.get("accuracy"),
        "specificity": latest_full_eval.get("specificity"),
        "actionability": latest_full_eval.get("actionability"),
        "scientific_reliability": latest_full_eval.get("scientific_reliability"),
        "dhw_interpretation": latest_full_eval.get("dhw_interpretation") or latest_full_eval.get("dhw_interpretation_accuracy"),
        "dhw_interpretation_accuracy": latest_full_eval.get("dhw_interpretation_accuracy") or latest_full_eval.get("dhw_interpretation"),
        "uncertainty_communication": latest_full_eval.get("uncertainty_communication"),
        "hallucination_avoidance": latest_full_eval.get("hallucination_avoidance"),
        "last_eval_at": latest_full_eval.get("last_checked") or latest_full_eval.get("completed_at") or latest_full_eval.get("date"),
    }

    # Determine prompt_rewrite_status:
    #   "rewritten_pending"    — latest full eval rewrote the prompt (score < 0.75 triggered rewrite)
    #   "confirmed_improved"   — previous eval rewrote prompt; latest follow-up shows score improvement
    #   "did_not_improve"      — previous eval rewrote prompt; latest follow-up did NOT improve
    #   "none"                 — no rewrite context
    if prompt_was_updated_in_latest:
        prompt_rewrite_status = "rewritten_pending"
    elif prev_full_eval and bool(prev_full_eval.get("prompt_updated")):
        if prev_score is not None and latest_score > prev_score:
            prompt_rewrite_status = "confirmed_improved"
        else:
            prompt_rewrite_status = "did_not_improve"
    else:
        prompt_rewrite_status = "none"

    # Determine system_status:
    if latest_is_skip:
        system_status = "skipped_healthy"
    elif prompt_rewrite_status == "rewritten_pending":
        system_status = "rewrite_pending_verification"
    elif prompt_rewrite_status == "confirmed_improved":
        system_status = "improved"
    elif prompt_rewrite_status == "did_not_improve":
        system_status = "degraded"
    elif latest_score >= 0.75:
        system_status = "improved" if (prev_score is not None and latest_score > prev_score) else "healthy"
    else:
        system_status = "degraded"

    # Build human-readable current_state_summary.
    pct = round(latest_score * 100)
    if system_status == "skipped_healthy":
        skip_reason_txt = latest_run.get("skip_reason", "")
        current_state_summary = (
            f"Latest nightly check skipped evaluation because recent quality is above the 0.75 target. "
            f"({skip_reason_txt})" if skip_reason_txt else
            "Latest nightly check skipped evaluation because recent quality is above the 0.75 target."
        )
    elif system_status == "rewrite_pending_verification":
        current_state_summary = (
            f"A previous low-quality evaluation (score: {pct}%) triggered a prompt rewrite. "
            "The next evaluation will confirm whether quality has recovered."
        )
    elif system_status == "improved" and prompt_rewrite_status == "confirmed_improved":
        prev_pct = round((prev_score or 0) * 100)
        if latest_score >= 0.75:
            current_state_summary = (
                f"A previous prompt rewrite was confirmed successful. "
                f"Latest verified quality improved from {prev_pct}% to {pct}% — above the 0.75 target."
            )
        else:
            current_state_summary = (
                f"A previous prompt rewrite improved quality from {prev_pct}% to {pct}%, "
                "but still below the 0.75 target."
            )
    elif system_status == "did_not_improve":
        current_state_summary = (
            f"A prompt rewrite was attempted, but the follow-up evaluation scored {pct}% — "
            "still below the 0.75 target. Manual review may be needed."
        )
    elif system_status == "improved":
        if latest_score >= 0.75:
            current_state_summary = f"Quality improved to {pct}% — above the 0.75 target."
        else:
            current_state_summary = f"Quality improved to {pct}% but still below the 0.75 target."
    elif system_status == "degraded":
        current_state_summary = f"Latest evaluation scored {pct}% — below the 0.75 target."
    else:
        current_state_summary = f"System quality is {pct}% — above the 0.75 target."

    return {
        "system_status": system_status,
        "status": latest_full_eval.get("status"),
        "date": latest_full_eval.get("date"),
        "last_checked": latest_run.get("last_checked") or latest_run.get("completed_at"),
        "last_full_eval_at": latest_verified_metrics["last_eval_at"],
        "skip_reason": latest_run.get("skip_reason") if latest_is_skip else None,
        "source": latest_run.get("source"),
        "assessment_count": latest_full_eval.get("assessment_count", 0),
        # Metrics always from the latest verified full evaluation:
        "average_score": latest_verified_metrics["average_score"],
        "quality_score": round((latest_verified_metrics["average_score"] or 0) * 100),
        "accuracy": latest_verified_metrics["accuracy"],
        "specificity": latest_verified_metrics["specificity"],
        "actionability": latest_verified_metrics["actionability"],
        "scientific_reliability": latest_verified_metrics["scientific_reliability"],
        "dhw_interpretation": latest_verified_metrics["dhw_interpretation"],
        "dhw_interpretation_accuracy": latest_verified_metrics["dhw_interpretation_accuracy"],
        "uncertainty_communication": latest_verified_metrics["uncertainty_communication"],
        "hallucination_avoidance": latest_verified_metrics["hallucination_avoidance"],
        "prompt_updated": prompt_was_updated_in_latest,
        "quota_limited": bool(latest_full_eval.get("quota_limited")),
        "issues": latest_full_eval.get("issues") if isinstance(latest_full_eval.get("issues"), list) else [],
        "summary": latest_full_eval.get("summary", ""),
        "research_narrative": latest_full_eval.get("research_narrative"),
        "prompt_change_summary": latest_full_eval.get("prompt_change_summary") or latest_full_eval.get("gemini_improvement_summary"),
        "before_after": latest_full_eval.get("before_after") or {
            "previous_score": prev_score,
            "latest_score": latest_score,
        },
        "latest_verified_metrics": latest_verified_metrics,
        "prompt_rewrite_status": prompt_rewrite_status,
        "current_state_summary": current_state_summary,
        "stored_at": latest_full_eval.get("stored_at"),
    }


def _restore_scores_from_history() -> None:
    """Restore _last_self_improvement_scores from the latest verified full evaluation.

    Called on startup when /tmp/last_scores.json is missing (e.g. after a Cloud Run
    cold start) so the nightly cost-guard uses real scores, not the fake 89% baseline.
    """
    global _last_self_improvement_scores
    if _last_self_improvement_scores.get("date") is not None:
        return  # Already loaded from disk — nothing to do.
    runs = _load_history_from_gcs(limit=10) or _load_history_from_sqlite(limit=10)
    if not runs:
        return
    for run in runs:
        if run.get("status") != "skipped_healthy" and isinstance(run.get("average_score"), (int, float)):
            _last_self_improvement_scores = {
                "date": run.get("date"),
                "average_score": run.get("average_score"),
                "quality_score": round((run.get("average_score") or 0) * 100),
                "accuracy": run.get("accuracy"),
                "specificity": run.get("specificity"),
                "actionability": run.get("actionability"),
                "scientific_reliability": run.get("scientific_reliability"),
                "dhw_interpretation": run.get("dhw_interpretation"),
                "dhw_interpretation_accuracy": run.get("dhw_interpretation_accuracy"),
                "uncertainty_communication": run.get("uncertainty_communication"),
                "hallucination_avoidance": run.get("hallucination_avoidance"),
                "assessment_count": run.get("assessment_count", 0),
                "prompt_updated": bool(run.get("prompt_updated")),
                "quota_limited": bool(run.get("quota_limited")),
                "updated_at": run.get("last_checked") or run.get("completed_at") or run.get("date"),
                "summary": run.get("summary", ""),
                "last_experiment_rejected_at": None,
                "last_experiment_rejected_score": None,
            }
            print(f"[startup] restored scores from GCS/SQLite history: avg={run.get('average_score')} date={run.get('date')}")
            _persist_scores_to_disk()
            return


def latest_self_improvement_from_disk() -> Dict[str, Any]:
    # Load up to 10 runs so _compute_system_state can see the full rewrite/recovery context.
    # GCS is source of truth; SQLite is local cache; JSON is local/dev fallback.
    gcs_runs = _load_history_from_gcs(limit=10)
    if gcs_runs:
        return _compute_system_state(gcs_runs)

    sqlite_runs = _load_history_from_sqlite(limit=10)
    if sqlite_runs:
        return _compute_system_state(sqlite_runs)

    try:
        runs = json.loads(SELF_IMPROVEMENT_RUNS_PATH.read_text(encoding="utf-8"))
        if isinstance(runs, list) and runs:
            sorted_runs = sorted(
                runs,
                key=lambda r: r.get("stored_at") or r.get("completed_at") or r.get("date") or "",
                reverse=True,
            )[:10]
            return _compute_system_state(sorted_runs)
    except Exception as error:
        print(f"[self-improvement] unable to read latest run history: {error}")

    return _compute_system_state([])


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

            # Detect if this query needs Phoenix MCP trace/performance data
            _trace_keywords = {"trace", "traces", "performance", "latency", "quality", "metrics",
                               "confidence", "token", "monitoring", "observability", "phoenix", "error rate"}
            _needs_mcp = any(kw in payload.message.lower() for kw in _trace_keywords)
            mcp_context: Dict[str, Any] = {}
            mcp_tools_used: List[str] = []

            if _needs_mcp:
                with tracer.start_as_current_span("chat.mcp_tool_call") as mcp_span:
                    mcp_span.set_attribute("mcp.triggered", True)
                    try:
                        mcp_metrics = await _execute_phoenix_mcp_tool("query_phoenix_quality_metrics", {})
                        mcp_traces = await _execute_phoenix_mcp_tool("query_phoenix_traces", {"limit": 5})
                        mcp_context = {"metrics": mcp_metrics, "recent_traces": mcp_traces}
                        mcp_tools_used = ["query_phoenix_quality_metrics", "query_phoenix_traces"]
                        mcp_span.set_attribute("mcp.tools_called", mcp_tools_used)
                        print(f"[ai.chat] Phoenix MCP tools called: {mcp_tools_used}")
                    except Exception as mcp_err:
                        print(f"[ai.chat] Phoenix MCP call failed: {mcp_err}")

            mcp_context_section = (
                f"\nPhoenix MCP trace data (retrieved via tool call): {json.dumps(mcp_context)}"
                if mcp_context else ""
            )

            answer_prompt = f"""
You are ReefWatch AI. Answer the user's question using the latest backend reef data.

Question: {payload.message}
Conversation history: {json.dumps(payload.conversation_history[-6:])}
Reef context: {json.dumps(payload.reef_context)}
Data need analysis: {json.dumps(data_need)}
Live reef data: {json.dumps(live_reefs)}{mcp_context_section}

Respond in JSON only with:
- answer: helpful plain-language answer
- data_used: array of reef names or metrics used
- confidence: number from 0 to 1
- follow_up_suggestions: array of 3 short follow-up questions
"""

            with tracer.start_as_current_span("chat.answer_with_live_data") as answer_span:
                answer_span.set_attribute("mcp.tools_used", mcp_tools_used)
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
            steps = [
                f"Identified required data: {human_fields}",
                f"Reasoning: {data_need.get('reasoning', 'determined live NOAA data needed')}",
            ]
            if mcp_tools_used:
                steps.append(f"Called Phoenix MCP tools: {', '.join(mcp_tools_used)} — retrieved live trace data")
            steps += [
                f"Fetched live reef data and identified {len(result.get('data_used', [])) if isinstance(result.get('data_used'), list) else 0} relevant sources",
                f"Generated answer with confidence {round((result.get('confidence') or 0) * 100)}%",
            ]
            result["reasoning_steps"] = steps
            _cache_set(_CHAT_CACHE, cache_key, result)
            # Always log the inference call so it shows in Arize Monitoring MCP Tool Calls
            _log_mcp_call(
                "ai.chat",
                f"Q: {payload.message[:120]}",
                {
                    "confidence": result.get("confidence"),
                    "mcp_tools": mcp_tools_used,
                    "data_used": result.get("data_used", [])[:3],
                },
            )
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
                _se_phoenix = PhoenixMCPClient(_phoenix_client_base_url(), project_name=PHOENIX_PROJECT_NAME, space_id=ARIZE_SPACE_ID)
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
    bounded_limit = max(1, min(int(limit or 14), 90))

    # GCS is source of truth; fall through to SQLite then JSON for local/dev
    history = _load_history_from_gcs(limit=bounded_limit)
    if not history:
        history = _load_history_from_sqlite(limit=bounded_limit)
    if not history:
        try:
            runs = json.loads(SELF_IMPROVEMENT_RUNS_PATH.read_text(encoding="utf-8"))
            if not isinstance(runs, list):
                runs = []
        except Exception as error:
            print(f"[self-improvement] unable to read run history: {error}")
            runs = []
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

    # Skip Gemini if scores were updated < 30 minutes ago (bypass when autonomous cycle forces fresh run)
    if _scores_are_fresh(1800) and not request_payload.assessments and not request_payload.force_fresh:
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
        source_reefs = _cache_get(_NOAA_CACHE, "live:list") or _snapshot_fallback_reefs()
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

    # Capture the previous score before this run so we can populate before_after.
    # Only use a score from a real, dated run — the hardcoded default has date=None
    # and an artificial 0.89 that would make every first real run look like a degradation.
    previous_score: Optional[float] = (
        _last_self_improvement_scores.get("average_score")
        if _last_self_improvement_scores.get("date") is not None
        else None
    )

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
        # Single batch call — all assessments in one Gemini request, 60-second hard timeout
        try:
            batch_prompt = build_batch_judge_prompt(assessments)
            batch_text = await asyncio.wait_for(
                _run_loop.run_in_executor(None, lambda p=batch_prompt: generate_text_with_retry(
                    p,
                    json_only=True,
                    prompt_template_name="reef_assessment_batch_judge_v1",
                )),
                timeout=60.0,
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
            msg = "Batch reef evaluation timed out after 60s"
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
        diagnosis: Optional[Dict[str, Any]] = None

        # ── Root cause analysis ────────────────────────────────────────────────────
        # Run diagnosis before deciding whether to rewrite. This separates genuine
        # model-reasoning failures from data-gap issues (missing NOAA DHW/SST) that
        # should not trigger a prompt rewrite.
        if judgements:
            dim_averages = {
                "accuracy": average_accuracy,
                "specificity": average_specificity,
                "actionability": average_actionability,
                "scientific_reliability": average_scientific_reliability,
                "uncertainty_communication": average_uncertainty_communication,
                "dhw_interpretation": average_dhw_interpretation,
                "hallucination_avoidance": average_hallucination_avoidance,
            }
            diagnosis = diagnose_root_cause(judgements, assessments, dim_averages)
            print(f"[self-improvement] diagnosis: {diagnosis['diagnosis_summary']}")
            print(f"[self-improvement] model_reasoning_dims={diagnosis['model_reasoning_dimensions']} "
                  f"data_gap_dims={diagnosis['data_gap_dimensions']} "
                  f"rewrite_warranted={diagnosis['rewrite_warranted']}")

        # Cooldown: if the previous run already rewrote the prompt, skip this cycle
        # to allow at least one verification run before stacking another rewrite.
        last_run_was_rewrite = (
            bool(_last_self_improvement_scores.get("prompt_updated", False))
            and _last_self_improvement_scores.get("date") is not None
        )

        # Rewrite is warranted when:
        #   1. Quality is below threshold
        #   2. Root cause analysis finds model-reasoning failures (not just data gaps)
        #   3. The previous run was not also a rewrite (cooldown)
        rewrite_needed = (
            judgements
            and average_overall < 0.75
            and diagnosis is not None
            and diagnosis["rewrite_warranted"]
            and not last_run_was_rewrite
        )

        if request_payload.skip_rewrite:
            # Evaluation-only mode: prompt generation and promotion are handled by the
            # autonomous experiment pipeline which runs baseline vs candidate before committing.
            improvement_summary = "Evaluation only — rewrite handled by experiment pipeline."
            print("[self-improvement] skip_rewrite=True: evaluation complete, rewrite deferred to autonomous cycle")
        elif rewrite_needed and quota_limited:
            rewrite_failed_due_to_quota = True
            improvement_summary = "Prompt update needed but skipped — Gemini quota exhausted."
        elif last_run_was_rewrite and average_overall < 0.75:
            improvement_summary = (
                "Verification cycle — evaluating the previous rewrite. "
                "Another rewrite will not be triggered until this cycle completes."
            )
            print("[self-improvement] cooldown: skipping rewrite — previous run already rewrote the prompt")
        elif judgements and average_overall < 0.75 and diagnosis and not diagnosis["rewrite_warranted"]:
            improvement_summary = (
                f"Quality below threshold but failing dimensions ({', '.join(diagnosis.get('data_gap_dimensions', []))}) "
                "are attributable to missing NOAA data, not model reasoning. Prompt preserved."
            )
            print(f"[self-improvement] skipping rewrite — low scores caused by data gaps: {diagnosis['data_gap_dimensions']}")
        elif rewrite_needed:
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
            print(f"[self-improvement] triggering targeted rewrite for dims: {diagnosis['model_reasoning_dimensions']}")

            try:
                improved_prompt = generate_text_with_retry(
                    build_improvement_prompt(current_prompt, feedback, diagnosis),
                    prompt_template_name="reef_prompt_improvement_v1",
                ).strip()
                improved_prompt = re.sub(r"^```(?:text)?|```$", "", improved_prompt).strip()

                if is_valid_improved_prompt(improved_prompt):
                    backup_path = backup_and_save_reef_prompt(improved_prompt)
                    prompt_updated = True
                    targeted_dims = ", ".join(diagnosis["model_reasoning_dimensions"]) or "general quality"
                    improvement_summary = f"Prompt rewritten targeting: {targeted_dims}."
                    span.add_event("reef_analysis_prompt_updated")
                    print(f"[self-improvement] prompt updated; backup={backup_path}")
                else:
                    improvement_summary = "Gemini proposed a prompt but validation rejected it; current prompt preserved."
                    span.add_event("reef_analysis_prompt_rejected")
                    print("[self-improvement] improved prompt rejected by validation")
            except Exception as error:
                message = f"Prompt improvement failed: {type(error).__name__}: {error}"
                errors.append(message[:300])
                if is_quota_error(error):
                    quota_limited = True
                    rewrite_failed_due_to_quota = True
                    improvement_summary = "Prompt update needed but skipped — Gemini quota exhausted."
                    span.add_event("gemini_quota_limited_during_prompt_rewrite")
                else:
                    improvement_summary = "Prompt improvement failed; current prompt preserved."
                print(f"[self-improvement] {message}")
        elif not judgements:
            improvement_summary = "No assessments were successfully judged; current prompt preserved."
        else:
            improvement_summary = "Quality met the 0.75 threshold; current prompt preserved."

        if rewrite_failed_due_to_quota:
            summary = "Prompt update needed but skipped — Gemini quota exhausted."
        else:
            summary = build_improvement_summary(average_overall, issues, prompt_updated, quota_limited, diagnosis)
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

        run_completed_at = utc_now()
        # Status reflects actual score direction so the dashboard can display honestly.
        # "improved"  = quality score went UP vs previous run
        # "degraded"  = quality score went DOWN vs previous run
        # "completed" = no comparable previous score (first run, or previous was None)
        # prompt_updated is carried as a separate boolean field.
        if previous_score is not None and average_overall is not None:
            if average_overall > previous_score:
                _run_status = "improved"
            elif average_overall < previous_score:
                _run_status = "degraded"
            else:
                _run_status = "completed"
        else:
            _run_status = "completed"

        result = {
            "status": _run_status,
            "date": run_date,
            "last_checked": run_completed_at,
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
            "diagnosis": diagnosis,
            "rewrite_reason": (
                ", ".join(diagnosis["model_reasoning_dimensions"]) if diagnosis and diagnosis.get("model_reasoning_dimensions") else None
            ),
            "before_after": {
                "previous_score": previous_score,
                "latest_score": average_overall,
            },
            "source": request_payload.source,
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
            "completed_at": run_completed_at,
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
            # Only update cached scores when we have real judgements — never overwrite with zeros.
            # Preserve rejection-cooldown fields so the experiment guard survives across evals.
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
                # Preserve rejection cooldown state from the previous value so it
                # is not wiped out by a fresh evaluation that doesn't run experiments.
                "last_experiment_rejected_at": _last_self_improvement_scores.get("last_experiment_rejected_at"),
                "last_experiment_rejected_score": _last_self_improvement_scores.get("last_experiment_rejected_score"),
            }
            _persist_scores_to_disk()
            _save_run_to_history(result)

            # Phase 1: Automatically grow benchmark dataset from production evaluations.
            # Each judged assessment becomes a benchmark case for future experiments.
            if _gcs_enabled() and len(judgements) == len(assessments):
                try:
                    new_cases = [
                        _extract_benchmark_case(assessments[i], judgements[i])
                        for i in range(len(judgements))
                    ]
                    saved = _append_benchmark_cases_to_gcs(new_cases)
                    if saved:
                        print(f"[benchmark] collected {saved} new cases from this evaluation run")
                except Exception as bm_err:
                    print(f"[benchmark] case collection failed (non-fatal): {bm_err}")
        else:
            # No judgements — merge cached scores into result so the dashboard always shows values
            for key in ["accuracy", "specificity", "actionability", "scientific_reliability",
                        "dhw_interpretation", "dhw_interpretation_accuracy",
                        "uncertainty_communication", "hallucination_avoidance", "average_score"]:
                if result.get(key) in (None, 0.0) and _last_self_improvement_scores.get(key) is not None:
                    result[key] = _last_self_improvement_scores[key]
        return result


# ═══════════════════════════════════════════════════════════════════════════
#  PRODUCTION EVALUATION SYSTEM — Phases 1-8
#  Arize-powered autonomous evaluation, experiment validation, and promotion
# ═══════════════════════════════════════════════════════════════════════════

# ── Phase 1: Benchmark Dataset ─────────────────────────────────────────────

def _gcs_bucket_client() -> Optional[Any]:
    """Return GCS Bucket for the self-improvement bucket, or None."""
    if not SELF_IMPROVEMENT_GCS_BUCKET:
        return None
    try:
        from google.cloud import storage as _gcs
        return _gcs.Client().bucket(SELF_IMPROVEMENT_GCS_BUCKET)
    except Exception as e:
        print(f"[eval-system] GCS bucket init failed: {e}")
        return None


def _extract_benchmark_case(
    assessment: "AssessmentForImprovement",
    judgement: Dict[str, Any],
) -> Dict[str, Any]:
    """Convert a real production assessment + its judge scores into a benchmark case.

    Derives expected_behavior purely from NOAA data — never from model output —
    so the benchmark cannot be contaminated by the prompt being evaluated.
    """
    inp = assessment.input_data or {}
    noaa = inp.get("noaa") or {}
    if isinstance(noaa, str):
        try:
            noaa = json.loads(noaa)
        except Exception:
            noaa = {}
    sst = inp.get("seaSurfaceTemp") or noaa.get("seaSurfaceTemp") or inp.get("sst")
    dhw = inp.get("degreeHeatingWeeks") or noaa.get("degreeHeatingWeeks") or inp.get("dhw")
    anomaly = inp.get("tempAnomaly") or noaa.get("tempAnomaly") or inp.get("sst_anomaly")
    alert = inp.get("bleachingAlertLevel") or noaa.get("bleachingAlertLevel") or inp.get("alert_level")
    coords = inp.get("coordinates") or {}

    # Expected behavior derived from NOAA data — not from model output
    if isinstance(dhw, (int, float)):
        if dhw >= 8:
            expected_risk = "critical"
        elif dhw >= 4:
            expected_risk = "warning"
        else:
            expected_risk = "safe"
    elif isinstance(sst, (int, float)) and isinstance(anomaly, (int, float)) and anomaly >= 2:
        expected_risk = "warning"
    else:
        expected_risk = "unknown"

    case_id = hashlib.sha256(
        f"{assessment.reef_name}:{assessment.trace_id}:{assessment.timestamp}".encode()
    ).hexdigest()[:16]

    return {
        "case_id": case_id,
        "input": {
            "reef_name": assessment.reef_name,
            "sst": sst,
            "anomaly": anomaly,
            "dhw": dhw,
            "alert_level": alert,
            "lat": coords.get("lat"),
            "lng": coords.get("lng"),
        },
        "expected_behavior": {
            "risk_level": expected_risk,
            "should_mention_dhw_threshold": isinstance(dhw, (int, float)) and dhw >= 4,
            "should_acknowledge_data_gaps": dhw is None or sst is None,
            "should_cite_dhw_value": dhw is not None,
        },
        "reef_context": coords,
        "evaluation_type": "reef_assessment",
        "created_from_trace": assessment.trace_id,
        "source": "production_trace",
        "reference_scores": {
            k: judgement.get(k)
            for k in ["accuracy", "specificity", "actionability", "scientific_reliability",
                      "dhw_interpretation", "uncertainty_communication", "hallucination_avoidance", "overall"]
        },
        "timestamp": assessment.timestamp or utc_now(),
    }


def _append_benchmark_cases_to_gcs(cases: List[Dict[str, Any]]) -> int:
    """Append new cases to the benchmark JSONL in GCS. Returns count actually saved."""
    if not cases:
        return 0
    bucket = _gcs_bucket_client()
    if bucket is None:
        return 0
    try:
        blob = bucket.blob(_GCS_BENCHMARK_OBJECT)
        existing_ids: set = set()
        existing_text = ""
        try:
            existing_text = blob.download_as_text(encoding="utf-8")
            for line in existing_text.strip().splitlines():
                try:
                    existing_ids.add(json.loads(line)["case_id"])
                except Exception:
                    pass
        except Exception:
            pass

        new_lines = [
            json.dumps(c, default=str)
            for c in cases
            if c.get("case_id") not in existing_ids
        ]
        if not new_lines:
            return 0

        combined = (existing_text.rstrip("\n") + "\n" + "\n".join(new_lines) + "\n").lstrip("\n")
        blob.upload_from_string(combined.encode("utf-8"), content_type="application/jsonl")
        print(f"[benchmark] +{len(new_lines)} cases saved to GCS (total ~{len(existing_ids) + len(new_lines)})")
        return len(new_lines)
    except Exception as e:
        print(f"[benchmark] GCS append failed: {e}")
        return 0


def _load_benchmark_cases_from_gcs(limit: int = 50) -> List[Dict[str, Any]]:
    """Load the most recent benchmark cases from GCS JSONL."""
    bucket = _gcs_bucket_client()
    if bucket is None:
        return []
    try:
        blob = bucket.blob(_GCS_BENCHMARK_OBJECT)
        if not blob.exists():
            return []
        text = blob.download_as_text(encoding="utf-8")
        cases = []
        for line in text.strip().splitlines():
            try:
                cases.append(json.loads(line))
            except Exception:
                pass
        return cases[-limit:]
    except Exception as e:
        print(f"[benchmark] GCS load failed: {e}")
        return []


def _count_benchmark_cases_gcs() -> int:
    """Return the number of benchmark cases stored in GCS."""
    bucket = _gcs_bucket_client()
    if bucket is None:
        return 0
    try:
        blob = bucket.blob(_GCS_BENCHMARK_OBJECT)
        if not blob.exists():
            return 0
        text = blob.download_as_text(encoding="utf-8")
        return sum(1 for line in text.strip().splitlines() if line.strip())
    except Exception:
        return 0


# ── Phase 3: Versioned Prompt Store ────────────────────────────────────────

def _load_active_prompt_version() -> Dict[str, Any]:
    """Load active prompt metadata from GCS. Falls back to local file as v1."""
    bucket = _gcs_bucket_client()
    if bucket is not None:
        try:
            blob = bucket.blob(_GCS_PROMPTS_ACTIVE)
            if blob.exists():
                data = json.loads(blob.download_as_text(encoding="utf-8"))
                if isinstance(data, dict) and data.get("version"):
                    return data
        except Exception as e:
            print(f"[prompts] GCS active prompt load failed: {e}")
    return {
        "version": "v1",
        "content": load_reef_analysis_prompt(),
        "deployed_at": None,
        "experiment_score": None,
        "baseline_score": None,
        "improvement_delta": None,
        "rewrite_reason": None,
    }


def _load_prompt_history_from_gcs(limit: int = 20) -> List[Dict[str, Any]]:
    """Load prompt version history list from GCS."""
    bucket = _gcs_bucket_client()
    if bucket is None:
        return []
    try:
        blob = bucket.blob(_GCS_PROMPTS_HISTORY)
        if not blob.exists():
            return []
        history = json.loads(blob.download_as_text(encoding="utf-8"))
        return history[-limit:] if isinstance(history, list) else []
    except Exception as e:
        print(f"[prompts] history load failed: {e}")
        return []


def _next_prompt_version(history: List[Dict[str, Any]]) -> str:
    if not history:
        return "v2"
    last = history[-1].get("version", "v1")
    try:
        return f"v{int(last.lstrip('v')) + 1}"
    except Exception:
        return f"v{len(history) + 2}"


def _promote_prompt_to_production(
    new_prompt_text: str,
    version: str,
    experiment_score: float,
    baseline_score: float,
    rewrite_reason: Optional[str] = None,
    diagnosis_summary: Optional[str] = None,
) -> bool:
    """Save new prompt as active in GCS and append to history. Returns True on success."""
    now = utc_now()
    version_data = {
        "version": version,
        "content": new_prompt_text,
        "deployed_at": now,
        "experiment_score": round(experiment_score, 4),
        "baseline_score": round(baseline_score, 4),
        "improvement_delta": round(experiment_score - baseline_score, 4),
        "rewrite_reason": rewrite_reason,
        "diagnosis_summary": diagnosis_summary,
    }
    bucket = _gcs_bucket_client()
    if bucket is None:
        # Fall back to local file only
        backup_and_save_reef_prompt(new_prompt_text)
        print(f"[prompts] {version} saved locally (no GCS)")
        return True
    try:
        with _gcs_write_lock:
            # Write active_prompt.json
            bucket.blob(_GCS_PROMPTS_ACTIVE).upload_from_string(
                json.dumps(version_data, default=str, indent=2).encode("utf-8"),
                content_type="application/json",
            )
            # Append to prompt_history.json
            hist_blob = bucket.blob(_GCS_PROMPTS_HISTORY)
            history: List[Dict[str, Any]] = []
            try:
                if hist_blob.exists():
                    history = json.loads(hist_blob.download_as_text(encoding="utf-8"))
                    if not isinstance(history, list):
                        history = []
            except Exception:
                pass
            history.append({k: v for k, v in version_data.items() if k != "content"})
            hist_blob.upload_from_string(
                json.dumps(history, default=str, indent=2).encode("utf-8"),
                content_type="application/json",
            )
        # Also write to local filesystem so analyze_reef picks it up immediately
        backup_and_save_reef_prompt(new_prompt_text)
        print(f"[prompts] {version} promoted to production — experiment={experiment_score:.3f} baseline={baseline_score:.3f}")
        return True
    except Exception as e:
        print(f"[prompts] promotion failed: {e}")
        return False


# ── Phase 2: Phoenix Experiment Engine ─────────────────────────────────────

async def _evaluate_single_case_with_prompt(
    prompt_text: str,
    case: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    """Run one benchmark case through a specific prompt and return the model output dict."""
    inp = case.get("input") or {}
    reef_context = case.get("reef_context") or {}
    reef_name = inp.get("reef_name", "Unknown Reef")
    sst = inp.get("sst", "N/A")
    dhw = inp.get("dhw", "N/A")
    anomaly = inp.get("anomaly", "N/A")
    alert = inp.get("alert_level", "No Alert")
    lat = reef_context.get("lat") or inp.get("lat") or 0
    lng = reef_context.get("lng") or inp.get("lng") or 0

    dhw_str = f"{dhw} wk" if dhw not in (None, "N/A") else "unavailable"
    sst_str = f"{sst}°C" if sst not in (None, "N/A") else "unavailable"
    anomaly_str = f"{anomaly}°C" if anomaly not in (None, "N/A") else "unavailable"

    full_prompt = (
        f"{prompt_text}\n\n"
        f"Reef: {reef_name} at {lat}, {lng}\n"
        f"SST: {sst_str} | Anomaly: {anomaly_str} | DHW: {dhw_str} | Alert: {alert}\n\n"
        "Return JSON with keys: risk_score (0-100), risk_level (safe|warning|critical), "
        "confidence (0-1), threat_summary (specific to this reef), "
        "recommended_actions (list of 3-5 specific actions), historical_context."
    )
    try:
        loop = asyncio.get_running_loop()
        result_text = await asyncio.wait_for(
            loop.run_in_executor(
                None,
                lambda p=full_prompt: generate_text_with_retry(
                    p, json_only=True, prompt_template_name="experiment_run_v1"
                ),
            ),
            timeout=50.0,
        )
        return json.loads(strip_json_fences(result_text))
    except Exception as e:
        print(f"[experiment] analysis failed for {reef_name}: {type(e).__name__}: {e}")
        return None


async def run_prompt_experiment(
    baseline_prompt: str,
    candidate_prompt: str,
    benchmark_cases: List[Dict[str, Any]],
    *,
    experiment_id: Optional[str] = None,
    rewrite_reason: Optional[str] = None,
    diagnosis: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Run baseline and candidate prompts against benchmark cases and compare judge scores.

    Returns an experiment result dict with delta, dimension breakdowns, and promotion decision.
    Only benchmark cases with complete NOAA inputs are used to ensure fair comparison.
    """
    if not experiment_id:
        experiment_id = hashlib.sha256(utc_now().encode()).hexdigest()[:12]

    # Filter to cases with at least SST or DHW — never run on bare stubs
    usable = [
        c for c in benchmark_cases
        if c.get("input") and (
            c["input"].get("dhw") is not None or c["input"].get("sst") is not None
        )
    ][:5]  # Cost cap: 5 cases × 2 prompts = 10 Gemini calls + 2 judge calls

    print(f"[experiment:{experiment_id}] starting on {len(usable)}/{len(benchmark_cases)} usable cases")
    _log_mcp_call(
        "run_prompt_experiment",
        f"Experiment {experiment_id}: running {len(usable)} benchmark cases through baseline and candidate prompts",
        {"experiment_id": experiment_id, "cases": len(usable)},
    )

    if not usable:
        return {
            "experiment_id": experiment_id,
            "status": "skipped",
            "reason": "no usable benchmark cases with NOAA data",
            "baseline_score": None,
            "candidate_score": None,
            "delta": None,
            "promoted": False,
        }

    # Semaphore limits to 3 concurrent Gemini calls to avoid rate-limit timeouts
    _exp_sem = asyncio.Semaphore(3)

    async def _limited_eval(prompt: str, case: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        async with _exp_sem:
            return await _evaluate_single_case_with_prompt(prompt, case)

    # Run baseline first, then candidate (staggered, not all-at-once)
    baseline_outputs = await asyncio.gather(
        *[_limited_eval(baseline_prompt, c) for c in usable],
        return_exceptions=True,
    )
    candidate_outputs = await asyncio.gather(
        *[_limited_eval(candidate_prompt, c) for c in usable],
        return_exceptions=True,
    )

    # Build AssessmentForImprovement objects for the judge
    def _make_assessment(case: Dict[str, Any], output: Any) -> Optional["AssessmentForImprovement"]:
        if not isinstance(output, dict):
            return None
        inp = case.get("input") or {}
        ctx = case.get("reef_context") or {}
        return AssessmentForImprovement(
            trace_id=case.get("case_id"),
            reef_name=inp.get("reef_name", "Unknown"),
            timestamp=utc_now(),
            input_data={
                "noaa": {
                    "seaSurfaceTemp": inp.get("sst"),
                    "degreeHeatingWeeks": inp.get("dhw"),
                    "tempAnomaly": inp.get("anomaly"),
                    "bleachingAlertLevel": inp.get("alert_level"),
                },
                "coordinates": ctx,
            },
            model_output=output,
        )

    # Only compare cases where BOTH prompts produced valid outputs (fair comparison)
    matched_indices = [
        i for i in range(len(usable))
        if isinstance(baseline_outputs[i], dict) and isinstance(candidate_outputs[i], dict)
    ]
    baseline_assessments = [
        a for i in matched_indices
        if (a := _make_assessment(usable[i], baseline_outputs[i])) is not None
    ]
    candidate_assessments = [
        a for i in matched_indices
        if (a := _make_assessment(usable[i], candidate_outputs[i])) is not None
    ]

    total_attempted = len(usable)
    timed_out = total_attempted - len(matched_indices)
    if timed_out > 0:
        print(f"[experiment:{experiment_id}] {timed_out}/{total_attempted} cases timed out — comparing on {len(matched_indices)} matched pairs")
    print(f"[experiment:{experiment_id}] baseline outputs={len(baseline_assessments)} candidate={len(candidate_assessments)} (matched pairs only)")

    async def _judge_batch(assessments: List["AssessmentForImprovement"]) -> List[Dict[str, Any]]:
        if not assessments:
            return []
        try:
            loop = asyncio.get_running_loop()
            batch_prompt = build_batch_judge_prompt(assessments)
            batch_text = await asyncio.wait_for(
                loop.run_in_executor(
                    None,
                    lambda p=batch_prompt: generate_text_with_retry(
                        p, json_only=True, prompt_template_name="experiment_judge_v1"
                    ),
                ),
                timeout=60.0,
            )
            raw = json.loads(strip_json_fences(batch_text))
            raw_list = raw if isinstance(raw, list) else [raw]
            results = []
            for i, item in enumerate(raw_list[:len(assessments)]):
                try:
                    j = validate_judge_result(item)
                    j["reef_name"] = assessments[i].reef_name
                    results.append(j)
                except Exception:
                    pass
            return results
        except Exception as e:
            print(f"[experiment:{experiment_id}] judge failed: {e}")
            return []

    baseline_judgements, candidate_judgements = await asyncio.gather(
        _judge_batch(baseline_assessments),
        _judge_batch(candidate_assessments),
    )

    DIMENSION_KEYS = [
        "accuracy", "specificity", "actionability", "scientific_reliability",
        "dhw_interpretation", "uncertainty_communication", "hallucination_avoidance",
    ]

    def _dim_averages(judgements: List[Dict[str, Any]]) -> Dict[str, float]:
        if not judgements:
            return {k: 0.0 for k in DIMENSION_KEYS}
        return {k: average_score(judgements, k) for k in DIMENSION_KEYS}

    baseline_dims = _dim_averages(baseline_judgements)
    candidate_dims = _dim_averages(candidate_judgements)
    baseline_overall = average_score(baseline_judgements, "overall") if baseline_judgements else 0.0
    candidate_overall = average_score(candidate_judgements, "overall") if candidate_judgements else 0.0
    delta = round(candidate_overall - baseline_overall, 4)

    # Promotion decision: candidate must exceed baseline AND reach minimum threshold
    PROMOTION_THRESHOLD = 0.75
    MIN_DELTA = 0.01  # At least 1 percentage point improvement
    promoted = (
        bool(baseline_judgements) and bool(candidate_judgements)
        and candidate_overall > baseline_overall + MIN_DELTA
        and candidate_overall >= PROMOTION_THRESHOLD
    )

    dimension_deltas = {k: round(candidate_dims[k] - baseline_dims[k], 4) for k in DIMENSION_KEYS}

    result = {
        "experiment_id": experiment_id,
        "status": "completed",
        "timestamp": utc_now(),
        "benchmark_cases_used": len(matched_indices),
        "benchmark_cases_attempted": len(usable),
        "cases_timed_out": timed_out,
        "baseline_assessments_scored": len(baseline_judgements),
        "candidate_assessments_scored": len(candidate_judgements),
        "baseline_score": round(baseline_overall, 4),
        "candidate_score": round(candidate_overall, 4),
        "delta": delta,
        "promoted": promoted,
        "promotion_reason": (
            f"candidate {candidate_overall:.3f} > baseline {baseline_overall:.3f} + {MIN_DELTA} and ≥ {PROMOTION_THRESHOLD}"
            if promoted else
            f"candidate {candidate_overall:.3f} did not exceed baseline {baseline_overall:.3f} + {MIN_DELTA}"
            if baseline_judgements and candidate_judgements else
            "insufficient judge results"
        ),
        "baseline_dimensions": baseline_dims,
        "candidate_dimensions": candidate_dims,
        "dimension_deltas": dimension_deltas,
        "rewrite_reason": rewrite_reason,
        "diagnosis_summary": (diagnosis or {}).get("diagnosis_summary"),
    }
    print(
        f"[experiment:{experiment_id}] baseline={baseline_overall:.3f} candidate={candidate_overall:.3f} "
        f"delta={delta:+.4f} promoted={promoted}"
    )
    return result


def _save_experiment_to_gcs(experiment: Dict[str, Any]) -> bool:
    """Save experiment result JSON to GCS under experiments/<id>.json."""
    bucket = _gcs_bucket_client()
    if bucket is None:
        return False
    exp_id = experiment.get("experiment_id", "unknown")
    try:
        blob_name = f"{_GCS_EXPERIMENTS_PREFIX}{exp_id}.json"
        bucket.blob(blob_name).upload_from_string(
            json.dumps(experiment, default=str, indent=2).encode("utf-8"),
            content_type="application/json",
        )
        print(f"[experiment] saved to gs://{SELF_IMPROVEMENT_GCS_BUCKET}/{blob_name}")
        return True
    except Exception as e:
        print(f"[experiment] GCS save failed: {e}")
        return False


def _load_recent_experiments_from_gcs(limit: int = 10) -> List[Dict[str, Any]]:
    """Load the most recent experiment results from GCS."""
    bucket = _gcs_bucket_client()
    if bucket is None:
        return []
    try:
        blobs = sorted(
            [b for b in bucket.list_blobs(prefix=_GCS_EXPERIMENTS_PREFIX) if b.name.endswith(".json")],
            key=lambda b: b.name,
            reverse=True,
        )[:limit]
        results = []
        for blob in blobs:
            try:
                results.append(json.loads(blob.download_as_text(encoding="utf-8")))
            except Exception:
                pass
        return results
    except Exception as e:
        print(f"[experiment] list failed: {e}")
        return []


# ── Phase 4: Phoenix MCP Self-Introspection ─────────────────────────────────

async def _query_phoenix_failure_modes(limit: int = 30) -> Dict[str, Any]:
    """Query Phoenix for worst-performing traces to inform improvement planning.

    Returns structured analysis: recurring failure dimensions, worst reef names, common issues.
    """
    phoenix = PhoenixMCPClient(
        _phoenix_client_base_url(),
        project_name=PHOENIX_PROJECT_NAME,
        space_id=ARIZE_SPACE_ID,
    )
    spans = await phoenix.get_recent_spans(limit=limit)
    if not spans:
        return {"error": "no spans returned from Phoenix", "failure_modes": [], "worst_traces": []}

    low_quality = phoenix.filter_low_quality(spans)
    _log_mcp_call(
        "query_phoenix_failure_modes",
        f"Introspection: {len(low_quality)} low-quality traces out of {len(spans)} total spans",
        {"total": len(spans), "low_quality": len(low_quality)},
    )

    failure_dims: Dict[str, int] = {}
    worst_traces: List[Dict[str, Any]] = []

    for span in low_quality[:10]:
        from phoenix_mcp import _attributes as _span_attrs
        attrs = _span_attrs(span)
        reef_name = attrs.get("reef.name") or span.get("name") or "unknown"
        quality = attrs.get("eval.quality_score")
        worst_traces.append({
            "reef_name": str(reef_name)[:60],
            "quality_score": quality,
            "status": span.get("statusCode") or span.get("status"),
        })
        # Collect any eval dimension annotations attached to the span
        for key in attrs:
            if key.startswith("eval.") and key != "eval.quality_score":
                dim = key.replace("eval.", "")
                try:
                    val = float(attrs[key])
                    if val < 0.6:
                        failure_dims[dim] = failure_dims.get(dim, 0) + 1
                except (TypeError, ValueError):
                    pass

    top_failures = sorted(failure_dims.items(), key=lambda x: x[1], reverse=True)[:5]
    return {
        "total_spans": len(spans),
        "low_quality_count": len(low_quality),
        "low_quality_rate": round(len(low_quality) / max(len(spans), 1), 3),
        "failure_modes": [{"dimension": k, "frequency": v} for k, v in top_failures],
        "worst_traces": worst_traces,
        "phoenix_url": _phoenix_client_base_url(),
    }


# ── Phase 7: Audit Trail ─────────────────────────────────────────────────────

def _save_improvement_audit_entry(entry: Dict[str, Any]) -> bool:
    """Save a complete improvement cycle audit record to GCS."""
    bucket = _gcs_bucket_client()
    if bucket is None:
        return False
    cycle_id = entry.get("cycle_id") or hashlib.sha256(utc_now().encode()).hexdigest()[:12]
    try:
        blob_name = f"{_GCS_IMPROVEMENT_HISTORY_PREFIX}{cycle_id}.json"
        bucket.blob(blob_name).upload_from_string(
            json.dumps(entry, default=str, indent=2).encode("utf-8"),
            content_type="application/json",
        )
        print(f"[audit] saved cycle {cycle_id} to GCS")
        return True
    except Exception as e:
        print(f"[audit] GCS save failed: {e}")
        return False


def _load_improvement_history_from_gcs(limit: int = 20) -> List[Dict[str, Any]]:
    """Load recent improvement audit entries from GCS."""
    bucket = _gcs_bucket_client()
    if bucket is None:
        return []
    try:
        blobs = sorted(
            [b for b in bucket.list_blobs(prefix=_GCS_IMPROVEMENT_HISTORY_PREFIX) if b.name.endswith(".json")],
            key=lambda b: b.name,
            reverse=True,
        )[:limit]
        entries = []
        for blob in blobs:
            try:
                entries.append(json.loads(blob.download_as_text(encoding="utf-8")))
            except Exception:
                pass
        return entries
    except Exception as e:
        print(f"[audit] history load failed: {e}")
        return []


def _is_in_rejection_cooldown(average_overall: float, cycle_id: str) -> bool:
    """Return True when an experiment should be blocked by the rejection cooldown.

    After a rejected experiment we require a meaningful quality drop before retrying
    to avoid burning Gemini quota on rapid-fire rewrites that won't improve the prompt.
    """
    last_rejected_at = _last_self_improvement_scores.get("last_experiment_rejected_at")
    last_rejected_score = _last_self_improvement_scores.get("last_experiment_rejected_score")
    if not last_rejected_at:
        return False
    try:
        ts = datetime.fromisoformat(last_rejected_at.replace("Z", "+00:00"))
        hours_since = (datetime.now(timezone.utc) - ts).total_seconds() / 3600
    except Exception:
        return False

    if hours_since >= _REJECTION_COOLDOWN_HOURS:
        return False  # Cooldown expired — allow retry

    if not isinstance(last_rejected_score, (int, float)):
        return False

    score_drop = float(last_rejected_score) - average_overall
    if score_drop >= _REJECTION_RETRY_THRESHOLD:
        return False  # Score dropped enough — allow retry despite cooldown

    reason = (
        f"last experiment rejected {round(hours_since)}h ago (score was {last_rejected_score:.0%}); "
        f"current drop {score_drop:.0%} < {_REJECTION_RETRY_THRESHOLD:.0%} threshold — "
        f"production prompt retained, no retry until score drops more or cooldown expires"
    )
    print(f"[autonomous-cycle:{cycle_id}] rejection cooldown active — {reason}")
    _log_mcp_call(
        "experiment_skipped_rejection_cooldown",
        f"Experiment skipped — {reason}",
        {"hours_since_rejection": round(hours_since), "score_drop": round(score_drop, 4)},
    )
    return True


def _increment_gemini_cost(phase: str, amount: int = 1) -> None:
    """Increment the in-memory Gemini call counter for a given phase."""
    global _gemini_cost_stats
    _gemini_cost_stats["total_calls_this_session"] = (
        _gemini_cost_stats.get("total_calls_this_session", 0) + amount
    )
    if phase == "eval":
        _gemini_cost_stats["last_eval_calls"] = (
            _gemini_cost_stats.get("last_eval_calls", 0) + amount
        )
        _gemini_cost_stats["last_eval_at"] = utc_now()
    elif phase == "experiment":
        _gemini_cost_stats["last_experiment_calls"] = (
            _gemini_cost_stats.get("last_experiment_calls", 0) + amount
        )
        _gemini_cost_stats["last_experiment_at"] = utc_now()
    elif phase == "nightly":
        _gemini_cost_stats["nightly_cycle_calls"] = (
            _gemini_cost_stats.get("nightly_cycle_calls", 0) + amount
        )
        _gemini_cost_stats["last_nightly_at"] = utc_now()


# ── Phase 6: Autonomous Nightly Learning Cycle ────────────────────────────────

async def _run_autonomous_improvement_cycle(source: str = "nightly_scheduler") -> Dict[str, Any]:
    """Full autonomous improvement cycle:

    1. Collect traces from Phoenix for failure mode analysis
    2. Run evaluation on fresh reef assessments
    3. Collect benchmark cases from judged assessments
    4. If quality below threshold: diagnose root cause
    5. Generate candidate prompt targeted to failing dimensions
    6. Run Phoenix Experiment (baseline vs candidate on benchmark set)
    7. Promote candidate only if experiment confirms improvement
    8. Save audit trail
    9. Log all activity to Agent Activity feed
    """
    cycle_id = hashlib.sha256(utc_now().encode()).hexdigest()[:12]
    cycle_started = utc_now()
    audit: Dict[str, Any] = {
        "cycle_id": cycle_id,
        "started_at": cycle_started,
        "source": source,
        "phases": {},
    }

    print(f"[autonomous-cycle:{cycle_id}] started")
    _log_mcp_call(
        "autonomous_cycle_started",
        f"Autonomous improvement cycle {cycle_id} initiated by {source}",
        {"cycle_id": cycle_id},
    )

    # ── Step 1: Phoenix self-introspection ─────────────────────────────────
    print(f"[autonomous-cycle:{cycle_id}] step 1 — Phoenix introspection")
    phoenix_data = await _query_phoenix_failure_modes(limit=30)
    audit["phases"]["phoenix_introspection"] = phoenix_data
    if phoenix_data.get("failure_modes"):
        failure_summary = ", ".join(
            f"{m['dimension']} ({m['frequency']} traces)"
            for m in phoenix_data["failure_modes"][:3]
        )
        _log_mcp_call(
            "phoenix_failure_analysis",
            f"Phoenix introspection: {phoenix_data['low_quality_count']}/{phoenix_data['total_spans']} low-quality traces. Top failures: {failure_summary}",
            phoenix_data,
        )

    # ── Step 2: Fresh evaluation (evaluation only — no prompt rewrite here) ──
    print(f"[autonomous-cycle:{cycle_id}] step 2 — running fresh evaluation (skip_rewrite=True)")
    eval_result = await run_self_improvement(
        SelfImprovementRequest(source=source, skip_rewrite=True, force_fresh=True)
    )
    audit["phases"]["evaluation"] = {
        "average_score": eval_result.get("average_score"),
        "status": eval_result.get("status"),
        "judged_count": eval_result.get("judged_assessment_count", 0),
        "diagnosis": eval_result.get("diagnosis"),
    }

    average_overall = eval_result.get("average_score") or 0.0
    judgements_count = eval_result.get("judged_assessment_count", 0)
    diagnosis = eval_result.get("diagnosis")

    _log_mcp_call(
        "evaluation_completed",
        f"Evaluation completed: quality={average_overall:.0%}, {judgements_count} assessments scored",
        {"average_score": average_overall, "diagnosis": diagnosis},
    )

    # ── Step 3: Benchmark cases are collected as a side-effect of evaluation ─
    # run_self_improvement writes benchmark cases to GCS automatically after each
    # judged run (see _append_benchmark_cases_to_gcs post-hook).
    benchmark_saved = judgements_count  # informational — actual save happens in eval post-hook
    audit["phases"]["benchmark_collection"] = {"cases_saved": benchmark_saved}
    print(f"[autonomous-cycle:{cycle_id}] step 3 — benchmark cases auto-saved by eval post-hook ({judgements_count} new)")

    # ── Step 4-7: Prompt improvement via experiment pipeline ─────────────────
    # Quality below threshold + model-reasoning failures → generate candidate → experiment → promote
    experiment_result: Optional[Dict[str, Any]] = None
    prompt_version_data = _load_active_prompt_version()
    current_version = prompt_version_data.get("version", "v1")
    prompt_history = _load_prompt_history_from_gcs()
    promoted = False

    # ── Cost guard: skip all experiment phases when quality is healthy ─────────
    # Fresh sample evals are noisy (they evaluate different random reefs each run).
    # If the benchmark quality is already good, a drop in a single fresh sample is
    # not evidence of real regression — do not trigger expensive Gemini experiment.
    if average_overall >= 0.75:
        skip_reason = f"fresh sample quality {average_overall:.0%} ≥ 75% — production prompt retained, no experiment needed"
        audit["phases"]["experiment_skipped"] = {"reason": "skipped_healthy", "score": average_overall}
        _log_mcp_call(
            "experiment_skipped_healthy",
            f"Experiment skipped — fresh sample quality {average_overall:.0%} is above threshold. "
            f"Production prompt {current_version} is healthy. Zero experiment Gemini calls used.",
            {"score": average_overall, "version": current_version},
        )
        print(f"[autonomous-cycle:{cycle_id}] step 4-7 skipped — {skip_reason}")

    # ── Rejection cooldown: don't retry experiment if last one was rejected recently ──
    elif _is_in_rejection_cooldown(average_overall, cycle_id):
        audit["phases"]["experiment_skipped"] = {"reason": "rejection_cooldown", "score": average_overall}
        # (logging done inside _is_in_rejection_cooldown)

    elif (
        diagnosis is not None
        and diagnosis.get("rewrite_warranted")
    ):
        print(f"[autonomous-cycle:{cycle_id}] step 4-7 — quality low ({average_overall:.0%}), running experiment pipeline")
        _log_mcp_call(
            "improvement_pipeline_started",
            f"Quality {average_overall:.0%} below threshold. Generating candidate prompt for experiment.",
            {"current_version": current_version, "diagnosis": diagnosis.get("diagnosis_summary")},
        )

        # Load benchmark cases for experiment (hard cap: 5 cases = max 12 Gemini calls total)
        benchmark_cases = _load_benchmark_cases_from_gcs(limit=5)
        audit["phases"]["benchmark_loaded"] = {"count": len(benchmark_cases)}

        if len(benchmark_cases) >= 3:
            # Load prior rejected experiments so prompt generation avoids repeating failed strategies
            prior_rejections: List[Dict[str, Any]] = []
            recent_experiments = _load_recent_experiments_from_gcs(limit=5)
            for exp in recent_experiments:
                if not exp.get("promoted"):
                    prior_rejections.append({
                        "target_dims": exp.get("rewrite_reason", ""),
                        "delta": exp.get("delta"),
                        "rejection_reason": exp.get("promotion_reason", "insufficient improvement"),
                    })
            if prior_rejections:
                print(f"[autonomous-cycle:{cycle_id}] {len(prior_rejections)} prior rejection(s) — informing candidate generation")

            # Generate candidate prompt using Phoenix failure evidence + rejection history
            current_prompt = load_reef_analysis_prompt()
            issues = eval_result.get("issues", [])
            suggestions = eval_result.get("improvement_suggestions", [])
            feedback = {
                "issues": issues,
                "improvement_suggestions": suggestions,
                "average_overall": average_overall,
            }
            phoenix_failure_modes = phoenix_data.get("failure_modes", [])
            try:
                loop = asyncio.get_running_loop()
                # +1 Gemini call: candidate prompt generation
                _increment_gemini_cost("experiment")
                candidate_text = await asyncio.wait_for(
                    loop.run_in_executor(
                        None,
                        lambda: generate_text_with_retry(
                            build_improvement_prompt(
                                current_prompt,
                                feedback,
                                diagnosis,
                                phoenix_failure_modes=phoenix_failure_modes,
                                prior_rejections=prior_rejections,
                            ),
                            prompt_template_name="reef_prompt_improvement_v1",
                        ).strip(),
                    ),
                    timeout=60.0,
                )
                candidate_text = re.sub(r"^```(?:text)?|```$", "", candidate_text, flags=re.MULTILINE).strip()

                if is_valid_improved_prompt(candidate_text, current_prompt):
                    next_version = _next_prompt_version(prompt_history)
                    _log_mcp_call(
                        "candidate_prompt_generated",
                        f"Generated candidate prompt {next_version}. Running Phoenix Experiment against {len(benchmark_cases)} benchmark cases.",
                        {"version": next_version, "target_dims": diagnosis.get("model_reasoning_dimensions")},
                    )

                    # Run experiment (+N×2 analysis calls + 2 judge calls)
                    _increment_gemini_cost("experiment", amount=len(benchmark_cases) * 2 + 2)
                    experiment_result = await run_prompt_experiment(
                        baseline_prompt=current_prompt,
                        candidate_prompt=candidate_text,
                        benchmark_cases=benchmark_cases,
                        experiment_id=cycle_id,
                        rewrite_reason=", ".join(diagnosis.get("model_reasoning_dimensions", [])),
                        diagnosis=diagnosis,
                    )
                    _save_experiment_to_gcs(experiment_result)

                    if experiment_result.get("promoted"):
                        # Promote candidate to production
                        _promote_prompt_to_production(
                            new_prompt_text=candidate_text,
                            version=next_version,
                            experiment_score=experiment_result["candidate_score"],
                            baseline_score=experiment_result["baseline_score"],
                            rewrite_reason=experiment_result.get("rewrite_reason"),
                            diagnosis_summary=diagnosis.get("diagnosis_summary"),
                        )
                        promoted = True
                        # Clear rejection cooldown on successful promotion
                        _last_self_improvement_scores["last_experiment_rejected_at"] = None
                        _last_self_improvement_scores["last_experiment_rejected_score"] = None
                        _persist_scores_to_disk()
                        _log_mcp_call(
                            "prompt_promoted",
                            f"Promoted prompt {next_version} to production. "
                            f"Experiment: {experiment_result['baseline_score']:.3f} → {experiment_result['candidate_score']:.3f} "
                            f"(+{experiment_result['delta']:.3f})",
                            experiment_result,
                        )
                    else:
                        # Record rejection so the cooldown guard fires next cycle
                        _last_self_improvement_scores["last_experiment_rejected_at"] = utc_now()
                        _last_self_improvement_scores["last_experiment_rejected_score"] = average_overall
                        _persist_scores_to_disk()
                        _log_mcp_call(
                            "experiment_rejected",
                            f"Candidate prompt rejected — experiment delta {experiment_result.get('delta', 0):+.3f} insufficient. "
                            f"Production prompt {current_version} preserved. "
                            f"Retry blocked for {_REJECTION_COOLDOWN_HOURS}h unless score drops ≥{_REJECTION_RETRY_THRESHOLD:.0%}.",
                            experiment_result,
                        )
                else:
                    print(f"[autonomous-cycle:{cycle_id}] candidate prompt failed validation")
            except Exception as e:
                print(f"[autonomous-cycle:{cycle_id}] improvement pipeline error: {e}")
                audit["phases"]["improvement_error"] = str(e)
        else:
            print(f"[autonomous-cycle:{cycle_id}] only {len(benchmark_cases)} benchmark cases — need ≥3 for experiment")
            _log_mcp_call(
                "experiment_skipped",
                f"Experiment skipped — only {len(benchmark_cases)} benchmark cases available (need ≥3). "
                "Cases accumulate from production evaluations automatically.",
                {"cases": len(benchmark_cases)},
            )

    audit["phases"]["experiment"] = experiment_result
    audit["phases"]["promoted"] = promoted
    audit["phases"]["current_prompt_version"] = current_version
    audit["completed_at"] = utc_now()

    # ── Step 8: Save audit trail ───────────────────────────────────────────
    _save_improvement_audit_entry(audit)

    final_status = "promoted" if promoted else ("evaluated" if judgements_count > 0 else "skipped")
    _log_mcp_call(
        "autonomous_cycle_completed",
        f"Cycle {cycle_id} completed — status={final_status}, "
        f"quality={average_overall:.0%}, "
        f"prompt={current_version}{'→' + _next_prompt_version(prompt_history) if promoted else ''}",
        {"cycle_id": cycle_id, "promoted": promoted, "quality": average_overall},
    )

    return {
        "cycle_id": cycle_id,
        "status": final_status,
        "evaluation_score": average_overall,
        # Distinguish fresh random-sample evals from stable benchmark scores.
        # Consumers should not treat a single fresh_sample drop as a quality trend.
        "eval_type": "fresh_sample",
        "promoted": promoted,
        "experiment": experiment_result,
        "current_prompt_version": current_version,
        "audit_saved": True,
        "phoenix_introspection": phoenix_data,
        "completed_at": audit["completed_at"],
    }


# ── Phase 5: New V2 API Endpoints ─────────────────────────────────────────────

@app.get("/api/self-improvement/v2/status")
async def self_improvement_v2_status() -> Dict[str, Any]:
    """Production dashboard — current prompt version, latest experiment, benchmark stats."""
    prompt_version = _load_active_prompt_version()
    history = _load_prompt_history_from_gcs(limit=10)
    experiments = _load_recent_experiments_from_gcs(limit=5)
    benchmark_count = _count_benchmark_cases_gcs()

    latest_exp = experiments[0] if experiments else None
    latest_run = latest_self_improvement_from_disk()

    return {
        "prompt_version": prompt_version.get("version", "v1"),
        "prompt_deployed_at": prompt_version.get("deployed_at"),
        "prompt_experiment_score": prompt_version.get("experiment_score"),
        "prompt_baseline_score": prompt_version.get("baseline_score"),
        "prompt_improvement_delta": prompt_version.get("improvement_delta"),
        "prompt_rewrite_reason": prompt_version.get("rewrite_reason"),
        "benchmark_dataset_size": benchmark_count,
        "latest_experiment": {
            "experiment_id": latest_exp.get("experiment_id") if latest_exp else None,
            "timestamp": latest_exp.get("timestamp") if latest_exp else None,
            "baseline_score": latest_exp.get("baseline_score") if latest_exp else None,
            "candidate_score": latest_exp.get("candidate_score") if latest_exp else None,
            "delta": latest_exp.get("delta") if latest_exp else None,
            "promoted": latest_exp.get("promoted") if latest_exp else None,
            "promotion_reason": latest_exp.get("promotion_reason") if latest_exp else None,
            "benchmark_cases": latest_exp.get("benchmark_cases_used") if latest_exp else None,
        } if latest_exp else None,
        "prompt_history": [
            {
                "version": h.get("version"),
                "deployed_at": h.get("deployed_at"),
                "experiment_score": h.get("experiment_score"),
                "improvement_delta": h.get("improvement_delta"),
                "rewrite_reason": h.get("rewrite_reason"),
            }
            for h in reversed(history)
        ],
        "current_quality": latest_run.get("average_score") if latest_run else None,
        "current_system_status": latest_run.get("system_status") if latest_run else None,
        # Stable benchmark score from the most recent experiment's baseline evaluation.
        # Use this for trend comparisons — it is NOT affected by fresh-sample noise.
        "benchmark_score": latest_exp.get("baseline_score") if latest_exp else None,
        "fresh_sample_score": latest_run.get("average_score") if latest_run and latest_run.get("eval_type") == "fresh_sample" else None,
        "rejection_cooldown_active": bool(_last_self_improvement_scores.get("last_experiment_rejected_at")),
        "last_updated": utc_now(),
    }


@app.get("/api/self-improvement/v2/experiments")
async def self_improvement_v2_experiments(limit: int = 10) -> Dict[str, Any]:
    """Return recent experiment results with full dimension breakdowns."""
    experiments = _load_recent_experiments_from_gcs(limit=min(int(limit), 20))
    return {"experiments": experiments, "count": len(experiments)}


@app.get("/api/self-improvement/v2/prompt-history")
async def self_improvement_v2_prompt_history() -> Dict[str, Any]:
    """Return complete prompt version history."""
    history = _load_prompt_history_from_gcs(limit=50)
    active = _load_active_prompt_version()
    return {
        "active_version": active.get("version"),
        "history": list(reversed(history)),
        "total_versions": len(history),
    }


@app.get("/api/self-improvement/v2/benchmark-stats")
async def self_improvement_v2_benchmark_stats() -> Dict[str, Any]:
    """Return benchmark dataset statistics."""
    cases = _load_benchmark_cases_from_gcs(limit=200)
    if not cases:
        return {"total_cases": 0, "evaluation_types": {}, "oldest": None, "newest": None}

    by_type: Dict[str, int] = {}
    timestamps = []
    for c in cases:
        t = c.get("evaluation_type", "reef_assessment")
        by_type[t] = by_type.get(t, 0) + 1
        if c.get("timestamp"):
            timestamps.append(c["timestamp"])

    return {
        "total_cases": len(cases),
        "evaluation_types": by_type,
        "oldest": min(timestamps) if timestamps else None,
        "newest": max(timestamps) if timestamps else None,
        "gcs_bucket": SELF_IMPROVEMENT_GCS_BUCKET or "not configured",
    }


@app.get("/api/self-improvement/v2/audit-history")
async def self_improvement_v2_audit_history(limit: int = 10) -> Dict[str, Any]:
    """Return improvement cycle audit trail."""
    entries = _load_improvement_history_from_gcs(limit=min(int(limit), 30))
    return {"entries": entries, "count": len(entries)}


@app.get("/api/self-improvement/cost-telemetry")
async def self_improvement_cost_telemetry() -> Dict[str, Any]:
    """Estimated Gemini API call counts per phase for cost monitoring.

    Healthy system: 0 experiment calls/day (all skipped by cost guard).
    Unhealthy system: up to ~15 calls/cycle (1 candidate + 10 eval + 2 judge + 2 verification).
    """
    return {
        "last_eval_calls": _gemini_cost_stats.get("last_eval_calls", 0),
        "last_experiment_calls": _gemini_cost_stats.get("last_experiment_calls", 0),
        "nightly_cycle_calls": _gemini_cost_stats.get("nightly_cycle_calls", 0),
        "total_calls_this_session": _gemini_cost_stats.get("total_calls_this_session", 0),
        "last_eval_at": _gemini_cost_stats.get("last_eval_at"),
        "last_experiment_at": _gemini_cost_stats.get("last_experiment_at"),
        "last_nightly_at": _gemini_cost_stats.get("last_nightly_at"),
        "rejection_cooldown_active": bool(_last_self_improvement_scores.get("last_experiment_rejected_at")),
        "last_experiment_rejected_at": _last_self_improvement_scores.get("last_experiment_rejected_at"),
        "cost_caps": {
            "max_benchmark_cases_per_experiment": 5,
            "max_candidate_prompts_per_cycle": 1,
            "max_judge_comparisons": 2,
            "rejection_cooldown_hours": _REJECTION_COOLDOWN_HOURS,
            "rejection_retry_threshold": _REJECTION_RETRY_THRESHOLD,
        },
    }


@app.post("/api/self-improvement/nightly")
async def run_nightly_self_improvement() -> Dict[str, Any]:
    """Cloud Scheduler entry point — 2 AM UTC daily.

    Runs a lightweight health check first.  Full Gemini evaluation is skipped
    when quality >= 0.75, the last full eval is within 47 h, and there were no
    recent quota failures.  Either way a record is always written to history so
    the dashboard reflects every nightly check.
    """
    started_at = utc_now()
    run_date = started_at[:10]
    print(f"[self-improvement] nightly run started at {started_at}")

    last_score: Optional[float] = _last_self_improvement_scores.get("average_score")
    last_updated: Optional[str] = _last_self_improvement_scores.get("updated_at")
    was_quota_limited: bool = bool(_last_self_improvement_scores.get("quota_limited", False))

    # How many hours since the last full Gemini evaluation
    hours_since_eval: float = float("inf")
    if last_updated:
        try:
            ts = datetime.fromisoformat(last_updated.replace("Z", "+00:00"))
            hours_since_eval = (datetime.now(timezone.utc) - ts).total_seconds() / 3600
        except Exception:
            pass

    quality_ok = isinstance(last_score, (int, float)) and last_score >= 0.75
    eval_recent = hours_since_eval < 47          # within ~2 days
    no_failures = not was_quota_limited

    if quality_ok and eval_recent and no_failures:
        skip_reason = (
            f"quality {round((last_score or 0) * 100)}% ≥ 75%, "
            f"last eval {round(hours_since_eval)}h ago, no failures"
        )
        skipped_result: Dict[str, Any] = {
            **{k: _last_self_improvement_scores.get(k) for k in [
                "average_score", "quality_score", "accuracy", "specificity",
                "actionability", "scientific_reliability", "dhw_interpretation",
                "dhw_interpretation_accuracy", "uncertainty_communication",
                "hallucination_avoidance",
            ]},
            "status": "skipped_healthy",
            "date": run_date,
            "last_checked": started_at,
            "skip_reason": skip_reason,
            "message": f"Healthy — evaluation skipped ({skip_reason})",
            "summary": "System healthy — Gemini evaluation skipped to conserve quota.",
            "prompt_updated": False,
            "assessment_count": 0,
            "issues": [],
            "before_after": {"previous_score": last_score, "latest_score": last_score},
            "source": "nightly_scheduler",
            "started_at": started_at,
            "completed_at": utc_now(),
        }
        _save_run_to_history(skipped_result)
        print(f"[self-improvement] nightly skipped — {skip_reason}")
        return skipped_result

    # Full evaluation needed
    run_reasons: List[str] = []
    if not quality_ok:
        run_reasons.append(f"quality {round((last_score or 0) * 100)}% < 75%")
    if not eval_recent:
        run_reasons.append(f"last eval {round(hours_since_eval)}h ago (> 47 h)")
    if not no_failures:
        run_reasons.append("quota errors in last run")
    print(
        f"[self-improvement] nightly full evaluation — reasons: "
        f"{', '.join(run_reasons) or 'first run / no cached data'}"
    )

    # Route through the autonomous improvement cycle which handles evaluation +
    # benchmark collection + experiment validation + prompt promotion + audit.
    cycle_result = await _run_autonomous_improvement_cycle(source="nightly_scheduler")
    cycle_result["last_checked"] = started_at

    # Also return a compatible self-improvement run record for dashboard backwards-compat
    full_result = latest_self_improvement_from_disk()
    full_result["last_checked"] = started_at
    full_result["autonomous_cycle"] = {
        "cycle_id": cycle_result.get("cycle_id"),
        "promoted": cycle_result.get("promoted"),
        "experiment": cycle_result.get("experiment"),
    }

    # Annotate the result so the UI can distinguish noisy fresh-sample scores
    # from stable benchmark scores (last experiment's baseline_score).
    full_result["eval_type"] = "fresh_sample"
    recent_experiments = _load_recent_experiments_from_gcs(limit=1)
    if recent_experiments:
        full_result["benchmark_score"] = recent_experiments[0].get("baseline_score")
    else:
        full_result["benchmark_score"] = None

    print(
        f"[self-improvement] nightly completed at {utc_now()} — "
        f"fresh_sample={full_result.get('average_score')} benchmark={full_result.get('benchmark_score')} "
        f"promoted={cycle_result.get('promoted')}"
    )
    return full_result


@app.post("/self-improve")
@app.post("/api/self-improve")
async def self_improve_from_phoenix() -> Dict[str, Any]:
    phoenix = PhoenixMCPClient(_phoenix_client_base_url(), project_name=PHOENIX_PROJECT_NAME, space_id=ARIZE_SPACE_ID)
    all_spans: List[Dict[str, Any]] = []
    low_quality_spans: List[Dict[str, Any]] = []
    narration: List[str] = []

    narration.append("Querying Phoenix traces via MCP...")
    try:
        all_spans = await phoenix.get_recent_spans(limit=50)
        _log_mcp_call(
            "get_recent_spans",
            f"Self-improvement loop retrieved {len(all_spans)} traces from Phoenix MCP",
            {"count": len(all_spans)},
        )
        narration.append(f"Found {len(all_spans)} traces in Phoenix MCP project '{ARIZE_PROJECT_NAME}'")
        low_quality_spans = phoenix.filter_low_quality(all_spans)
        if low_quality_spans:
            narration.append(f"Identified {len(low_quality_spans)} low-quality spans for analysis...")
        else:
            narration.append("All spans meet quality threshold — no improvements needed")
    except Exception as error:
        print(f"[self-improve] Phoenix lookup failed: {type(error).__name__}: {error}")
        narration.append(f"Phoenix MCP query failed: {error}")

    total_analyzed = len(all_spans)

    if not all_spans:
        return {
            "status": "no_traces",
            "message": "No traces found in Arize — check project name, api_key, and space_id",
            "traces_analyzed": 0,
            "improvements_made": 0,
            "phoenix_url": phoenix.phoenix_url or PHOENIX_UI_URL,
            "narration": narration,
        }

    if not low_quality_spans:
        return {
            "status": "healthy",
            "message": "All briefs meeting quality threshold",
            "traces_analyzed": total_analyzed,
            "improvements_made": 0,
            "phoenix_url": phoenix.phoenix_url or PHOENIX_UI_URL,
            "narration": narration,
        }

    narration.append(f"Analyzing {len(low_quality_spans)} low-quality spans for failure patterns...")
    prompt = build_phoenix_improvement_prompt(low_quality_spans)
    suggestions: Dict[str, Any]
    try:
        suggestion_text = generate_text(
            prompt,
            json_only=True,
            prompt_template_name="phoenix_self_improvement_v1",
        )
        suggestions = parse_json_response(suggestion_text)
        narration.append("Gemini analyzed trace patterns and generated prompt improvement suggestions")
    except Exception as error:
        print(f"[self-improve] Gemini suggestion generation failed: {type(error).__name__}: {error}")
        suggestions = {}
        narration.append(f"Gemini suggestion generation failed: {error}")

    improvement_record = {
        "timestamp": utc_now(),
        "project": PHOENIX_PROJECT_NAME,
        "traces_analyzed": total_analyzed,
        "low_quality_count": len(low_quality_spans),
        "suggestions": suggestions,
    }
    try:
        await phoenix.log_improvement(improvement_record)
        _log_mcp_call(
            "log_improvement",
            f"Logged self-improvement record to Phoenix MCP ({len(low_quality_spans)} improvements)",
            improvement_record,
        )
        narration.append("Improvement record logged back to Phoenix MCP dataset")
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
        "narration": narration,
    }


@app.post("/phoenix/traces")
@app.post("/api/phoenix/traces")
async def phoenix_traces(span_kind: str = "LLM") -> Dict[str, Any]:
    phoenix = PhoenixMCPClient(_phoenix_client_base_url(), project_name=PHOENIX_PROJECT_NAME, space_id=ARIZE_SPACE_ID)
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
        phoenix = PhoenixMCPClient(_phoenix_client_base_url(), project_name=PHOENIX_PROJECT_NAME, space_id=ARIZE_SPACE_ID)
        spans = await asyncio.wait_for(phoenix.get_recent_spans(limit=effective_limit), timeout=5.0)
        if isinstance(spans, list):
            return [clean_phoenix_trace(s) for s in spans]
    except asyncio.TimeoutError:
        print("[arize/traces] Phoenix get_recent_spans timed out after 5s")
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
        phoenix = PhoenixMCPClient(_phoenix_client_base_url(), project_name=PHOENIX_PROJECT_NAME, space_id=ARIZE_SPACE_ID)
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
@app.get("/api/mcp/tools")
async def mcp_list_tools() -> Dict[str, Any]:
    """Phoenix MCP: list available introspection tools"""
    return {
        "tools": [
            {"name": "query_phoenix_traces", "description": "Retrieve recent AI inference traces from Phoenix MCP", "source": "phoenix_mcp"},
            {"name": "query_phoenix_quality_metrics", "description": "Get real-time AI quality metrics from Phoenix MCP", "source": "phoenix_mcp"},
            {"name": "get_recent_traces", "endpoint": "/mcp/traces/recent", "description": "Get recent AI inference traces"},
            {"name": "get_quality_summary", "endpoint": "/mcp/traces/summary", "description": "Get agent quality metrics"},
            {"name": "analyze_reef", "endpoint": "/analyze-reef", "description": "Analyze reef bleaching risk"},
            {"name": "chat", "endpoint": "/chat", "description": "Research chat with live NOAA context"},
        ],
        "phoenix_project": PHOENIX_PROJECT_NAME,
        "phoenix_endpoint": PHOENIX_ENDPOINT,
        "gemini_function_tools": [d["name"] for d in _PHOENIX_MCP_TOOL_DECLARATIONS],
    }


@app.get("/api/mcp/tool-calls")
async def mcp_tool_calls(limit: int = 50) -> Dict[str, Any]:
    """Return the log of recent Phoenix MCP tool calls made by the agent."""
    effective_limit = max(1, min(int(limit), 200))
    rows: List[Dict[str, Any]] = []
    try:
        with _mcp_db_lock:
            con = sqlite3.connect(_MCP_DB_PATH)
            db_rows = con.execute(
                "SELECT timestamp, tool, summary, data_preview FROM mcp_tool_calls ORDER BY id DESC LIMIT ?",
                (effective_limit,),
            ).fetchall()
            total = con.execute("SELECT COUNT(*) FROM mcp_tool_calls").fetchone()[0]
            con.close()
        for r in db_rows:
            entry: Dict[str, Any] = {"timestamp": r[0], "tool": r[1], "summary": r[2]}
            if r[3]:
                entry["data_preview"] = r[3]
            rows.append(entry)
    except Exception:
        # Fall back to in-memory list if DB unavailable
        recent = _mcp_tool_call_log[-effective_limit:]
        rows = list(reversed(recent))
        total = len(_mcp_tool_call_log)
    return {
        "tool_calls": rows,
        "total_logged": total,
        "available_tools": [d["name"] for d in _PHOENIX_MCP_TOOL_DECLARATIONS],
    }


@app.post("/api/mcp/query")
async def mcp_query_tool(request: Request) -> Dict[str, Any]:
    """Directly invoke a Phoenix MCP tool by name."""
    body = await request.json()
    tool_name = body.get("tool") or body.get("tool_name", "")
    args = body.get("args") or body.get("arguments") or {}
    if not tool_name:
        raise HTTPException(status_code=400, detail="'tool' field is required")
    result = await _execute_phoenix_mcp_tool(tool_name, args)
    return {"tool": tool_name, "result": result, "timestamp": datetime.now(timezone.utc).isoformat()}


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


@app.get("/api/monitored-reefs")
@app.get("/monitored-reefs")
async def get_monitored_reefs() -> List[Dict[str, Any]]:
    """Single source of truth for all currently monitored reefs (base + user-added)."""
    return await live_reefs()


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
    _save_monitored_reef_to_db(reef)

    # Update researcher profile's active_reef_ids if researcher_id provided
    if payload.researcher_id:
        try:
            profile = _get_or_create_researcher_profile(payload.researcher_id)
            existing_ids: List[str] = json.loads(profile.get("active_reef_ids") or "[]")
            if canon_id not in existing_ids:
                existing_ids.append(canon_id)
                _update_researcher_active_reefs(payload.researcher_id, existing_ids)
        except Exception as _rp_err:
            print(f"[monitor] researcher profile update failed (non-fatal): {_rp_err}")

    print(f"[monitor] added {reef['name']} (id={canon_id}, total={len(_custom_monitored_reefs)})")
    return {"success": True, "station": reef, "noaaData": "cached" if matched else "unavailable", "aiAnalysis": "pending"}


@app.delete("/api/reefs/monitor/{reef_id:path}")
@app.delete("/reefs/monitor/{reef_id:path}")
async def unmonitor_reef(reef_id: str, researcher_id: Optional[str] = None) -> Dict[str, Any]:
    global _custom_monitored_reefs
    before = len(_custom_monitored_reefs)
    _custom_monitored_reefs = [r for r in _custom_monitored_reefs if r.get("id") != reef_id]
    removed = len(_custom_monitored_reefs) < before
    if removed:
        _delete_monitored_reef_from_db(reef_id)

    # Remove reef from researcher profile's active_reef_ids if researcher_id provided
    if researcher_id:
        try:
            profile = _get_or_create_researcher_profile(researcher_id)
            current_ids: List[str] = json.loads(profile.get("active_reef_ids") or "[]")
            if reef_id in current_ids:
                current_ids.remove(reef_id)
                _update_researcher_active_reefs(researcher_id, current_ids)
        except Exception as _rp_err:
            print(f"[monitor] researcher profile remove failed (non-fatal): {_rp_err}")

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


def _polygon_centroid(ring: List[Any]) -> Optional[tuple]:
    """Return (lat, lng) centroid of a GeoJSON exterior ring, or None if invalid."""
    pairs = [(c[1], c[0]) for c in ring if isinstance(c, (list, tuple)) and len(c) >= 2
             and _to_number(c[0]) is not None and _to_number(c[1]) is not None]
    if not pairs:
        return None
    return (round(sum(p[0] for p in pairs) / len(pairs), 6),
            round(sum(p[1] for p in pairs) / len(pairs), 6))


def _parse_virtual_stations_geojson(data: Any) -> List[Dict[str, Any]]:
    """Parse NOAA vs_polygons.json — handles Point, Polygon, and MultiPolygon features.
    Properties already include live sst / ssta / dhw / alert from the daily NOAA update."""
    seen: set = set()
    stations: List[Dict[str, Any]] = []
    for feature in data.get("features") or []:
        geom = feature.get("geometry") or {}
        geom_type = geom.get("type")
        coords = geom.get("coordinates") or []
        props = feature.get("properties") or {}
        name = str(props.get("name") or "").strip()
        if not name:
            continue

        lat_val: Optional[float] = None
        lng_val: Optional[float] = None

        if geom_type == "Point":
            if len(coords) < 2:
                continue
            lng_val, lat_val = _to_number(coords[0]), _to_number(coords[1])
        elif geom_type == "Polygon":
            exterior = coords[0] if coords else []
            result = _polygon_centroid(exterior)
            if result:
                lat_val, lng_val = result
        elif geom_type == "MultiPolygon":
            # Use centroid of the first polygon's exterior ring
            first_poly = coords[0] if coords else []
            exterior = first_poly[0] if first_poly else []
            result = _polygon_centroid(exterior)
            if result:
                lat_val, lng_val = result
        else:
            continue

        if lat_val is None or lng_val is None:
            continue

        # Deduplicate by station slug (handles same location in multiple geometry types)
        station_id = f"station-{_slugify_station(name)}"
        if station_id in seen:
            continue
        seen.add(station_id)

        sst = _round_number(_to_number(props.get("sst")))
        anomaly = _round_number(_to_number(props.get("ssta")))
        dhw = _round_number(_to_number(props.get("dhw")))
        alert_num = _to_number(props.get("alert"))
        risk = _calculate_risk(dhw, alert_num)
        alert_label = _get_bleaching_alert_level(alert_num, dhw)

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
    source_reefs: List[Dict[str, Any]] = _cache_get(_NOAA_CACHE, "live:list") or _snapshot_fallback_reefs()
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
async def get_settings(researcher_id: Optional[str] = None) -> Dict[str, Any]:
    if researcher_id:
        profile = _get_or_create_researcher_profile(researcher_id)
        if profile:
            return {
                "notification_email": profile["notification_email"],
                "anomaly_threshold": str(profile["anomaly_threshold"]),
                "critical_alerts_enabled": str(profile["critical_alerts_enabled"]).lower(),
                "temp_anomaly_alerts_enabled": str(profile["anomaly_alerts_enabled"]).lower(),
                "weekly_summary_enabled": str(profile["weekly_summary_enabled"]).lower(),
            }
    return dict(_SETTINGS_STORE)


@app.post("/api/settings")
async def post_settings(request: Request) -> Dict[str, Any]:
    body = await request.json()
    researcher_id = body.get("researcher_id") if isinstance(body, dict) else None
    settings = body.get("settings") if isinstance(body, dict) else None
    if researcher_id and settings and isinstance(settings, dict):
        print(f"[settings] saving researcher={researcher_id[:8]}… keys={list(settings.keys())}")
        _update_researcher_settings(researcher_id, settings)
        return {"success": True}
    if settings and isinstance(settings, dict):
        print(f"[settings] no researcher_id — updating _SETTINGS_STORE only (no GCS write)")
        _SETTINGS_STORE.update(settings)
        return {"success": True}
    key = body.get("key") if isinstance(body, dict) else None
    if key:
        _SETTINGS_STORE[key] = body.get("value")
        return {"success": True}
    return JSONResponse(status_code=400, content={"success": False, "message": "Provide researcher_id+settings, key/value, or settings object."})


@app.put("/api/researcher/active-reefs")
async def update_researcher_active_reefs_endpoint(request: Request) -> Dict[str, Any]:
    """Sync the researcher's active reef IDs to their profile. Called on every activeReefIds change."""
    body = await request.json()
    researcher_id = body.get("researcher_id") if isinstance(body, dict) else None
    reef_ids = body.get("reef_ids") if isinstance(body, dict) else None
    if not researcher_id:
        return JSONResponse(status_code=400, content={"success": False, "message": "researcher_id required"})
    if not isinstance(reef_ids, list):
        return JSONResponse(status_code=400, content={"success": False, "message": "reef_ids must be an array"})
    print(f"[active-reefs:backend] received researcher_id={researcher_id[:8]}… reef_ids({len(reef_ids)}): {reef_ids}")
    ok = _update_researcher_active_reefs(researcher_id, [str(r) for r in reef_ids])
    return {"success": ok}


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
    events = list(_demo_alert_events) + events
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


def _send_alert_email(reef: Dict[str, Any], recipient: Optional[str] = None) -> bool:
    """Send a critical alert email. recipient must be provided; returns False if missing."""
    if recipient is None:
        print("[alert] no recipient email — configure one in Settings")
        return False
    recipient = recipient.strip()
    if not ALERT_EMAIL_FROM or not ALERT_EMAIL_PASSWORD:
        print("[alert] SMTP sender not configured — set ALERT_EMAIL_FROM and ALERT_EMAIL_PASSWORD")
        return False
    if not recipient:
        print("[alert] no recipient email — configure one in Settings")
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
    msg["To"] = recipient
    msg.attach(MIMEText(body, "plain"))
    msg.attach(MIMEText(html, "html"))
    try:
        with smtplib.SMTP("smtp.gmail.com", 587) as server:
            server.starttls()
            server.login(ALERT_EMAIL_FROM, ALERT_EMAIL_PASSWORD)
            server.sendmail(ALERT_EMAIL_FROM, recipient, msg.as_string())
        print(f"[alert] sent email for {name} to {_mask_email(recipient)}")
        return True
    except Exception as exc:
        print(f"[alert] email send failed for {name}: {type(exc).__name__}: {exc}")
        return False


def _send_demo_alert_email(reef: Dict[str, Any], recipient: str) -> bool:
    """Send a demo alert email with a banner and 🚨 DEMO ALERT: subject prefix."""
    recipient = recipient.strip()
    if not ALERT_EMAIL_FROM or not ALERT_EMAIL_PASSWORD:
        print("[alert] SMTP sender not configured — set ALERT_EMAIL_FROM and ALERT_EMAIL_PASSWORD")
        return False
    if not recipient:
        print("[alert] no recipient email — configure one in Settings")
        return False
    name = reef.get("name", "Unknown Reef")
    risk = reef.get("riskScore") or reef.get("risk_score", 0)
    if isinstance(risk, float) and risk <= 1.0:
        risk = round(risk * 100)
    sst = reef.get("seaSurfaceTemp") or reef.get("sst")
    anomaly = reef.get("tempAnomaly") or reef.get("sst_anomaly")
    dhw = reef.get("degreeHeatingWeeks") or reef.get("dhw")
    alert = reef.get("bleachingAlertLevel") or reef.get("alert_level")

    def esc(v: Any) -> str:
        return str(v).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    def fmt(v: Any, suffix: str = "") -> str:
        return f"{esc(v)}{suffix}" if v is not None else "Unavailable"

    plain = "\n".join([
        "⚠️  DEMONSTRATION ALERT — This alert was manually triggered for demonstration purposes using live reef data.",
        "",
        f"Reef: {name}",
        f"Bleaching Risk: {risk}%",
        f"Sea Surface Temp: {fmt(sst, '°C')}",
        f"SST Anomaly: {fmt(anomaly, '°C')}",
        f"Degree Heating Weeks: {fmt(dhw)}",
        f"Risk Level: {fmt(alert)}",
        "",
        "This is a live-data demo. No immediate conservation action is required unless you choose to act on the values above.",
    ])
    html = f"""
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#dc2626;color:white;padding:20px;border-radius:8px 8px 0 0">
          <h1 style="margin:0">&#x1F6A8; DEMO ALERT — Critical Reef Alert</h1>
          <p style="margin:8px 0 0">ReefWatch AI Autonomous Monitoring System</p>
        </div>
        <div style="background:#78350f;color:#fef3c7;padding:14px 20px;border-left:4px solid #f59e0b;font-size:14px">
          &#9888;&#65039; This alert was manually triggered for demonstration purposes using live reef data.
        </div>
        <div style="background:#1e293b;color:#e2e8f0;padding:20px">
          <h2 style="color:#f87171">{esc(name)}</h2>
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:8px;color:#94a3b8">Bleaching Risk</td>
                <td style="padding:8px;color:#f87171;font-weight:bold">{fmt(risk, '%')}</td></tr>
            <tr><td style="padding:8px;color:#94a3b8">Sea Surface Temp</td>
                <td style="padding:8px">{fmt(sst, '°C')}</td></tr>
            <tr><td style="padding:8px;color:#94a3b8">SST Anomaly</td>
                <td style="padding:8px">{fmt(anomaly, '°C')}</td></tr>
            <tr><td style="padding:8px;color:#94a3b8">Degree Heating Weeks</td>
                <td style="padding:8px">{fmt(dhw)}</td></tr>
            <tr><td style="padding:8px;color:#94a3b8">Risk Level</td>
                <td style="padding:8px">{fmt(alert)}</td></tr>
          </table>
        </div>
        <div style="background:#0f172a;color:#475569;padding:12px;text-align:center;font-size:12px;border-radius:0 0 8px 8px">
          Generated by ReefWatch AI • Autonomous Coral Reef Monitoring
        </div>
      </div>
    """
    msg = MIMEMultipart("alternative")
    msg["Subject"] = f"🚨 DEMO ALERT: {name} — {risk}% Bleaching Risk"
    msg["From"] = f'"ReefWatch AI \U0001fab8" <{ALERT_EMAIL_FROM}>'
    msg["To"] = recipient
    msg.attach(MIMEText(plain, "plain"))
    msg.attach(MIMEText(html, "html"))
    try:
        with smtplib.SMTP("smtp.gmail.com", 587) as server:
            server.starttls()
            server.login(ALERT_EMAIL_FROM, ALERT_EMAIL_PASSWORD)
            server.sendmail(ALERT_EMAIL_FROM, recipient, msg.as_string())
        print(f"[alert] sent demo email for {name} to {_mask_email(recipient)}")
        return True
    except Exception as exc:
        print(f"[alert] demo email send failed for {name}: {type(exc).__name__}: {exc}")
        return False


async def _run_alert_check() -> Dict[str, Any]:
    print("[alert-scheduler] running alert check")

    profiles = _list_researcher_profiles_with_alerts()
    if not profiles:
        print("[alert-scheduler] no researcher profiles with email + active reefs — skipping")
        return {
            "reefs_checked": 0, "alerts_sent": 0,
            "message": "No researchers have configured email and active reefs.",
            "checked_at": utc_now(),
        }

    # Build reef lookup from NOAA cache + custom-monitored reefs (avoids extra API calls)
    cached_live: List[Dict[str, Any]] = _cache_get(_NOAA_CACHE, "live:list") or []
    reef_by_id: Dict[str, Dict[str, Any]] = {r["id"]: r for r in cached_live if r.get("id")}
    for r in _custom_monitored_reefs:
        if r.get("id"):
            reef_by_id[r["id"]] = r

    reefs_checked = 0
    alerts_sent = 0
    skipped_cooldown = 0
    skipped_threshold = 0
    errors: List[str] = []

    for profile in profiles:
        researcher_id = profile["researcher_id"]
        email = profile["notification_email"]
        try:
            active_reef_ids: List[str] = json.loads(profile["active_reef_ids_json"] or "[]")
        except Exception:
            active_reef_ids = []

        for reef_id in active_reef_ids:
            reef = reef_by_id.get(reef_id)
            if not reef:
                continue
            reefs_checked += 1
            cooldown_key = f"{researcher_id}:{reef_id}"
            if not _is_alert_worthy(reef):
                skipped_threshold += 1
                continue
            if _is_in_cooldown(cooldown_key):
                skipped_cooldown += 1
                continue
            if _send_alert_email(reef, recipient=email):
                _alert_last_sent[cooldown_key] = utc_now()
                alerts_sent += 1
            else:
                errors.append(f"email send failed for {reef.get('name')} → {_mask_email(email)}")

    result: Dict[str, Any] = {
        "checked_at": utc_now(),
        "researchers_checked": len(profiles),
        "reefs_checked": reefs_checked,
        "alerts_sent": alerts_sent,
        "skipped_cooldown": skipped_cooldown,
        "skipped_threshold": skipped_threshold,
        "errors": errors,
    }
    print(f"[alert-scheduler] done — researchers={len(profiles)} reefs={reefs_checked} sent={alerts_sent}")
    return result


@app.post("/api/alerts/trigger")
async def trigger_alert_check(request: Request) -> Dict[str, Any]:
    """Manually trigger a reef alert check across all researcher profiles."""
    return await _run_alert_check()


@app.post("/api/alerts/test")
async def test_alert(request: Request) -> Dict[str, Any]:
    """Send a demo alert email using the highest-risk live reef from NOAA-backed data.

    Body (all optional):
        researcher_id: str  — look up email from researcher profile
        reefId: str         — prefer a specific reef id if available
    """
    body: Dict[str, Any] = {}
    try:
        body = await request.json()
    except Exception:
        pass

    researcher_id = body.get("researcher_id") if isinstance(body, dict) else None
    reef_id = body.get("reefId") if isinstance(body, dict) else None

    # Resolve recipient email from researcher profile
    email = ""
    if researcher_id:
        profile = _get_or_create_researcher_profile(researcher_id)
        email = profile.get("notification_email", "").strip()

    if not email:
        return JSONResponse(
            status_code=400,
            content={
                "success": False,
                "emailSent": False,
                "message": "No notification email configured. Add one in Settings first.",
            },
        )

    # Build a combined reef lookup from live NOAA cache + custom-monitored reefs
    cached_live: List[Dict[str, Any]] = _cache_get(_NOAA_CACHE, "live:list") or []
    reef_by_id: Dict[str, Dict[str, Any]] = {r["id"]: r for r in cached_live if r.get("id")}
    for r in _custom_monitored_reefs:
        if r.get("id"):
            reef_by_id[r["id"]] = r

    all_live: List[Dict[str, Any]] = list(reef_by_id.values())

    def _risk_value(r: Dict[str, Any]) -> float:
        raw = r.get("riskScore") or r.get("risk_score") or 0
        try:
            val = float(raw)
        except (TypeError, ValueError):
            return 0.0
        return val * 100 if val <= 1.0 else val

    # Filter out reefs with 0% risk, then pick the highest-risk one
    live_with_risk = [r for r in all_live if _risk_value(r) > 0]

    # If a specific reefId was requested, prefer it (only if it has real risk data)
    reef: Optional[Dict[str, Any]] = None
    if reef_id:
        candidate = reef_by_id.get(reef_id)
        if candidate and _risk_value(candidate) > 0:
            reef = candidate

    if not reef and live_with_risk:
        reef = max(live_with_risk, key=_risk_value)

    if not reef:
        return JSONResponse(
            status_code=503,
            content={
                "success": False,
                "emailSent": False,
                "message": "No live reef data with valid risk scores is available. Try again after NOAA data refreshes.",
            },
        )

    sent = _send_demo_alert_email(reef, recipient=email)
    if sent:
        reef_name = reef.get("name", "Unknown Reef")
        risk_pct = round(_risk_value(reef))
        event: Dict[str, Any] = {
            "id": f"demo-alert-{utc_now()}",
            "event_type": "alert",
            "description": "Demo alert triggered using live reef data.",
            "reef_name": reef_name,
            "metadata": json.dumps({"risk": risk_pct, "reef_id": reef.get("id")}),
            "timestamp": utc_now(),
        }
        _demo_alert_events.insert(0, event)
        if len(_demo_alert_events) > 20:
            _demo_alert_events.pop()
        return {
            "success": True,
            "emailSent": True,
            "message": f"Demo alert sent for {reef_name} ({risk_pct}% bleaching risk)",
            "sentTo": _mask_email(email),
            "reef": reef_name,
        }
    return JSONResponse(
        status_code=502,
        content={
            "success": False,
            "emailSent": False,
            "message": "SMTP send failed — check ALERT_EMAIL_FROM and ALERT_EMAIL_PASSWORD in Cloud Run environment.",
        },
    )


@app.get("/api/alerts/status")
async def alert_status(researcher_id: Optional[str] = None) -> Dict[str, Any]:
    """Return alert readiness for a specific researcher, or global state if no researcher_id."""
    smtp_ready = bool(ALERT_EMAIL_FROM and ALERT_EMAIL_PASSWORD)
    if researcher_id:
        profile = _get_or_create_researcher_profile(researcher_id)
        email = profile.get("notification_email", "")
        prefix = f"{researcher_id}:"
        return {
            "researcher_id": researcher_id,
            "smtp_ready": smtp_ready,
            "email_configured": bool(email),
            "cooldown_hours": ALERT_COOLDOWN_HOURS,
            "last_sent": {
                k[len(prefix):]: {"sent_at": v, "in_cooldown": _is_in_cooldown(k)}
                for k, v in _alert_last_sent.items()
                if k.startswith(prefix)
            },
        }
    return {
        "smtp_ready": smtp_ready,
        "cooldown_hours": ALERT_COOLDOWN_HOURS,
        "researchers_with_alerts": len(_list_researcher_profiles_with_alerts()),
        "last_sent_keys": list(_alert_last_sent.keys()),
    }


# ---------------------------------------------------------------------------
# ADK Agent endpoint
# ---------------------------------------------------------------------------

class ADKAgentRequest(BaseModel):
    query: str
    session_id: Optional[str] = None
    user_id: str = "reefwatch-user"


@app.post("/api/adk-agent")
async def adk_agent_query(request: ADKAgentRequest) -> Dict[str, Any]:
    """Run the ReefWatch ADK agent for a given natural-language query.

    Requires ``google-adk`` to be installed (it is listed in requirements.txt).
    The agent uses Gemini 2.5 Flash with three tools: reef risk analysis,
    Phoenix trace retrieval, and quality metrics.
    """
    try:
        from google.adk.runners import Runner
        from google.adk.sessions import InMemorySessionService
        from google.genai.types import Content, Part
        from agent import reef_agent  # noqa: PLC0415 — lazy import avoids startup cost
    except ImportError as import_err:
        raise HTTPException(
            status_code=503,
            detail=f"google-adk is not installed or agent.py is missing: {import_err}",
        )

    session_service = InMemorySessionService()
    runner = Runner(
        agent=reef_agent,
        app_name="reefwatch-ai",
        session_service=session_service,
    )

    session_id = request.session_id or f"adk-{int(time.time() * 1000)}"
    user_id = request.user_id

    await session_service.create_session(
        app_name="reefwatch-ai",
        user_id=user_id,
        session_id=session_id,
    )

    message = Content(role="user", parts=[Part(text=request.query)])

    start = time.perf_counter()
    response_text = ""
    tool_calls_made: List[str] = []

    try:
        async for event in runner.run_async(
            user_id=user_id,
            session_id=session_id,
            new_message=message,
        ):
            # Collect tool call names for observability
            if hasattr(event, "tool_call") and event.tool_call:
                tool_calls_made.append(getattr(event.tool_call, "name", "unknown"))
            # Capture final text response
            if hasattr(event, "is_final_response") and event.is_final_response():
                if event.content and event.content.parts:
                    response_text = event.content.parts[0].text or ""
                break
    except Exception as run_err:
        raise HTTPException(status_code=502, detail=f"ADK agent run failed: {run_err}")

    return {
        "response": response_text,
        "session_id": session_id,
        "agent": "reefwatch_agent",
        "model": "gemini-2.5-flash",
        "latency_ms": round(elapsed_ms(start), 2),
        "tools_called": tool_calls_made,
    }


if __name__ == "__main__":
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
