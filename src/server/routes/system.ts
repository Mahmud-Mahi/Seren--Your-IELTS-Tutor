import fs from 'fs';
import type express from 'express';
import { SETTINGS_FILE, runtimeConfig, BOOT_GROQ_API_KEY, BOOT_ASSEMBLYAI_API_KEY, ttsEnabled, sttEngine } from '../config';
import { getProviders, clearProviderCaches } from '../llm';
import { defaultTtsVoice } from '../tts';
import { describeSttEngines } from '../stt-providers';

export function registerSystemRoutes(app: express.Express): void {
  // Health check endpoint
  app.get('/api/health', async (req, res) => {
    const providers = getProviders();
    const anyUsable = providers.some((p) => p.key !== 'groq' || p.apiKey);
    res.json({
      status: 'ok',
      hasApiKey: anyUsable,
      providers: providers.map((p) => ({ key: p.key, label: p.label, baseUrl: p.baseUrl })),
      tts: { enabled: ttsEnabled(), voice: defaultTtsVoice() },
      stt: { engine: sttEngine(), engines: await describeSttEngines() },
      time: new Date().toISOString(),
    });
  });

  // Factory reset: delete persisted settings and restore boot defaults.
  // The client separately wipes all localStorage keys (seren_*) and reloads,
  // so the app starts completely from the beginning (fresh onboarding).
  app.post('/api/system/reset', async (req, res) => {
    try {
      try {
        fs.unlinkSync(SETTINGS_FILE);
      } catch (e) {}
      runtimeConfig.pinnedProvider = null;
      runtimeConfig.modelOverrides = {};
      runtimeConfig.endpoints = {};
      runtimeConfig.ttsVoice = null;
      runtimeConfig.ttsEnabled = null;
      runtimeConfig.sttEngine = null;
      runtimeConfig.sttModels = {};
      process.env.GROQ_API_KEY = BOOT_GROQ_API_KEY;
      process.env.ASSEMBLYAI_API_KEY = BOOT_ASSEMBLYAI_API_KEY;
      clearProviderCaches();
      res.json({ success: true, message: 'All settings restored to defaults' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'reset failed' });
    }
  });
}
