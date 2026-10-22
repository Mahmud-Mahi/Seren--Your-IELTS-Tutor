import fs from 'fs';
import path from 'path';
import type express from 'express';
import { DATA_DIR } from '../config';
import {
  getGoogleAuthResult,
  isGoogleAuthConfigured,
  startGoogleAuth,
} from '../google-auth';

/**
 * Google sign-in routes:
 *   POST /api/auth/google/start        → { id, url }   (open `url` in the browser)
 *   GET  /api/auth/google/result?id=…  → { status, idToken?, error? }
 *
 * The renderer opens `url` in the user's real browser so Google never sees an
 * embedded user agent, then polls `result` until the local server has swapped
 * the authorization code for a Google ID token. The renderer then exchanges
 * that token for a Firebase session (see `src/auth/session.ts`).
 *
 * CORS is intentionally permissive: the desktop renderer talks to this API
 * from the `seren://app` origin, and a user may also point the browser build
 * at a LAN deployment. Auth is bearer-token only (no cookies), so reflecting
 * the request origin carries no credential-leak risk.
 */
export function registerAccountRoutes(app: express.Express): void {
  const cors: express.RequestHandler = (req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  };
  // Mounted via use() (not per-route) so OPTIONS preflights reach the
  // middleware too — Express only runs per-route middleware on its method.
  app.use(['/api/auth', '/api/recovery'], cors);

  app.post('/api/auth/google/start', async (_req, res) => {
    if (!isGoogleAuthConfigured()) {
      return res.status(503).json({ ok: false, error: 'google_oauth_not_configured' });
    }
    try {
      const { id, url } = await startGoogleAuth();
      return res.json({ ok: true, id, url });
    } catch (error: any) {
      return res.status(500).json({ ok: false, error: error?.message || 'start_failed' });
    }
  });

  app.get('/api/auth/google/result', (req, res) => {
    const id = String(req.query.id || '');
    if (!id) return res.status(400).json({ status: 'error', error: 'missing_id' });
    return res.json(getGoogleAuthResult(id));
  });

  /**
   * One-time data-loss recovery bundle. The operator (or a migration script)
   * may drop `seren-recovery.json` = { localStorageKey: value, ... } into the
   * server's data dir; the client then restores only keys that are still
   * empty locally and uploads them to the account. 404 when absent.
   */
  app.get('/api/recovery/snapshot', (_req, res) => {
    try {
      const file = path.join(DATA_DIR, 'seren-recovery.json');
      if (!fs.existsSync(file)) return res.status(404).json({ ok: false, error: 'none' });
      const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!snapshot || typeof snapshot !== 'object') {
        return res.status(500).json({ ok: false, error: 'corrupt' });
      }
      return res.json({ ok: true, snapshot });
    } catch {
      return res.status(500).json({ ok: false, error: 'read_failed' });
    }
  });
}
