import type express from 'express';
import {
  memoryStatus,
  parseMemoryPluginFile,
  saveMemoryConfig,
  testMemoryConnection,
} from '../memory';

export function registerMemoryRoutes(app: express.Express): void {
  app.get('/api/memory/status', (_req, res) => {
    res.json({ success: true, memory: memoryStatus() });
  });

  app.post('/api/memory/configure', (req, res) => {
    try {
      const body = { ...(req.body || {}) };
      if (typeof body.pluginContent === 'string') {
        body.manifest = parseMemoryPluginFile(body.pluginContent);
        delete body.pluginContent;
      }
      saveMemoryConfig(body);
      res.json({ success: true, memory: memoryStatus() });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err?.message || 'Could not save memory plugin settings.' });
    }
  });

  app.post('/api/memory/test', async (req, res) => {
    try {
      const result = await testMemoryConnection(req.body || {});
      res.json({ success: true, ...result });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err?.message || 'Memory plugin test failed.' });
    }
  });
}
