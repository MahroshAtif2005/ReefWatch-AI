import { Router } from 'express';
import { getAllSettings, setSetting } from '../db/database.js';

const router = Router();

router.get('/', async (_req, res, next) => {
  try {
    res.json(await getAllSettings());
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const settings = req.body?.settings;

    if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
      await Promise.all(
        Object.entries(settings).map(([key, value]) => setSetting(key, value)),
      );
      res.json({ success: true });
      return;
    }

    if (!req.body?.key) {
      res.status(400).json({ success: false, message: 'Provide key/value or settings object.' });
      return;
    }

    await setSetting(req.body.key, req.body?.value);
    res.json({ success: true });
  } catch (error) {
    if (error.statusCode) {
      res.status(error.statusCode).json({ success: false, message: error.message });
      return;
    }

    next(error);
  }
});

export default router;
