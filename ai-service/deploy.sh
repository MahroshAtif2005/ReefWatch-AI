#!/usr/bin/env bash
# Deploy the ReefWatch AI FastAPI service to Cloud Run with:
#   - min-instances=1  (no cold starts, in-memory state persists)
#   - Cloud Scheduler keep-alive job hitting /health every 4 minutes
#
# Fill in the four variables below before running.
# Run once to deploy; re-run on every new release — the scheduler job is idempotent.

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────
PROJECT_ID="project-9b3e2672-8819-4fa5-afe"
REGION="us-central1"
SERVICE_NAME="reefwatch-ai-service"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/cloud-run-source-deploy/${SERVICE_NAME}"
# ──────────────────────────────────────────────────────────────────────────────

echo "==> Building and pushing image: ${IMAGE}"
gcloud builds submit . \
  --tag "${IMAGE}" \
  --project "${PROJECT_ID}"

echo "==> Deploying ${SERVICE_NAME} to Cloud Run (${REGION})"
gcloud run deploy "${SERVICE_NAME}" \
  --image "${IMAGE}" \
  --region "${REGION}" \
  --project "${PROJECT_ID}" \
  --platform managed \
  --allow-unauthenticated \
  --min-instances 1 \
  --max-instances 10 \
  --memory 1Gi \
  --cpu 1 \
  --port 8000 \
  --timeout 300 \
  --cpu-boost

# Grab the live service URL (avoids hardcoding it)
SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
  --region "${REGION}" \
  --project "${PROJECT_ID}" \
  --format "value(status.url)")

echo "==> Service URL: ${SERVICE_URL}"

# ── Cloud Scheduler keep-alive ─────────────────────────────────────────────────
JOB_NAME="reefwatch-warmup"  # existing job name in GCP
HEALTH_URL="${SERVICE_URL}/health"

echo "==> Configuring Cloud Scheduler keep-alive job: ${JOB_NAME}"

if gcloud scheduler jobs describe "${JOB_NAME}" \
     --location "${REGION}" \
     --project "${PROJECT_ID}" &>/dev/null; then
  echo "    Job exists — updating schedule/URI"
  gcloud scheduler jobs update http "${JOB_NAME}" \
    --location "${REGION}" \
    --project "${PROJECT_ID}" \
    --schedule "*/4 * * * *" \
    --uri "${HEALTH_URL}" \
    --http-method GET \
    --attempt-deadline 30s
else
  echo "    Creating new job"
  gcloud scheduler jobs create http "${JOB_NAME}" \
    --location "${REGION}" \
    --project "${PROJECT_ID}" \
    --schedule "*/4 * * * *" \
    --uri "${HEALTH_URL}" \
    --http-method GET \
    --attempt-deadline 30s \
    --description "Keep-alive ping for ${SERVICE_NAME} — fires every 4 min to prevent cold starts"
fi

# ── Cloud Scheduler nightly self-improvement ──────────────────────────────────
# Uses /api/self-improvement/nightly which runs a lightweight health check
# first and only calls Gemini when quality has degraded or the last full eval
# is older than 47 hours.  Deadline is 270 s (enough for the full pipeline:
# 60 s Gemini batch + prompt rewrite + overhead, well within the 300 s
# Cloud Run request timeout).
SI_JOB_NAME="reefwatch-self-improve"
SI_URL="${SERVICE_URL}/api/self-improvement/nightly"

echo "==> Configuring Cloud Scheduler nightly self-improvement job: ${SI_JOB_NAME}"

if gcloud scheduler jobs describe "${SI_JOB_NAME}" \
     --location "${REGION}" \
     --project "${PROJECT_ID}" &>/dev/null; then
  echo "    Job exists — updating URI and deadline"
  gcloud scheduler jobs update http "${SI_JOB_NAME}" \
    --location "${REGION}" \
    --project "${PROJECT_ID}" \
    --schedule "0 2 * * *" \
    --uri "${SI_URL}" \
    --http-method POST \
    --headers "Content-Type=application/json" \
    --message-body "{}" \
    --attempt-deadline 270s \
    --time-zone "UTC"
else
  echo "    Creating new job"
  gcloud scheduler jobs create http "${SI_JOB_NAME}" \
    --location "${REGION}" \
    --project "${PROJECT_ID}" \
    --schedule "0 2 * * *" \
    --uri "${SI_URL}" \
    --http-method POST \
    --headers "Content-Type=application/json" \
    --message-body "{}" \
    --attempt-deadline 270s \
    --time-zone "UTC" \
    --description "Nightly self-improvement — health check + optional Gemini eval at 2 AM UTC"
fi

echo ""
echo "Done."
echo "  Service   : ${SERVICE_URL}"
echo "  Keepalive : pinging ${HEALTH_URL} every 4 minutes"
echo "  Nightly SI: running self-improvement at 2am UTC daily"
