import { Router } from 'express';
import { getAlertStatus, sendReefAlert } from '../services/alertService.js';
import { getStoredActiveReefs } from '../services/monitoringService.js';

const router = Router();

const reefKey = (reef) => reef?.id || reef?.stationId || reef?.station_id || reef?.name;
const isCriticalReef = (reef) => reef?.status === 'critical' || Number(reef?.riskScore) >= 75;

async function getAlertCandidateReefs() {
  return getStoredActiveReefs();
}

router.post('/test', async (req, res, next) => {
  try {
    const reefs = await getAlertCandidateReefs();
    const requestedReefId = req.body?.reefId;
    const reef = requestedReefId
      ? reefs.find((candidate) => reefKey(candidate) === requestedReefId)
      : reefs.find(isCriticalReef);

    if (!reef) {
      res.status(404).json({
        success: false,
        emailSent: false,
        message: requestedReefId
          ? `No reef found for reefId ${requestedReefId}`
          : 'No critical reef is currently available for a test alert.',
      });
      return;
    }

    const result = await sendReefAlert(reef, { bypassCooldown: true });
    res.json({
      success: true,
      emailSent: result.emailSent,
      reef: reef.name,
      sentTo: result.sentTo,
    });
  } catch (error) {
    if (error.statusCode) {
      res.status(error.statusCode).json({
        success: false,
        emailSent: false,
        message: error.message,
      });
      return;
    }

    next(error);
  }
});

router.get('/status', (_req, res, next) => {
  try {
    res.json({ alerts: getAlertStatus() });
  } catch (error) {
    next(error);
  }
});

export default router;
