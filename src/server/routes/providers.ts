import type express from 'express';
import { runtimeConfig, saveStoredSettings, ttsEnabled } from '../config';
import { getProviders, isProviderReachable, fetchWithTimeout, clearProviderCaches } from '../llm';
import { defaultTtsVoice, sanitizeVoice } from '../tts';

export function registerProviderRoutes(app: express.Express): void {
  // Provider status (used by the settings UI)
  app.get('/api/providers/status', async (req, res) => {
    try {
      const providers = getProviders();
      const results = await Promise.all(
        providers.map(async (p) => {
          const { reachable, model, latencyMs } = await isProviderReachable(p);
          const needsKey = p.key === 'groq' && !p.apiKey;
          const ep = runtimeConfig.endpoints[p.key] || {};
          return {
            key: p.key,
            label: p.label,
            baseUrl: p.baseUrl,
            configuredModel: p.model,
            resolvedModel: model,
            reachable,
            latencyMs,
            needsKey,
            ready: reachable && !needsKey && Boolean(model),
            customEndpoint: Boolean(ep.baseUrl),
            hasCustomKey: Boolean(ep.apiKey),
          };
        })
      );
      res.json({
        success: true,
        pinnedProvider: runtimeConfig.pinnedProvider || process.env.PINNED_PROVIDER || null,
        priority: (process.env.PROVIDER_PRIORITY || 'local,ollama,groq').split(',').map((s) => s.trim()),
        providers: results,
        tts: { enabled: ttsEnabled(), voice: defaultTtsVoice() },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'status check failed' });
    }
  });

  // List every available model per provider so the UI can offer a picker
  app.get('/api/providers/models', async (req, res) => {
    try {
      const providers = getProviders();
      const results = await Promise.all(
        providers.map(async (p) => {
          if (p.key === 'groq' && !p.apiKey) {
            return { key: p.key, label: p.label, reachable: false, models: [] as string[] };
          }
          try {
            const listRes = await fetchWithTimeout(
              `${p.baseUrl}/models`,
              {
                headers:
                  p.apiKey && p.apiKey !== 'none'
                    ? { Authorization: `Bearer ${p.apiKey}` }
                    : {},
              },
              6000
            );
            if (listRes.ok) {
              const json: any = await listRes.json();
              const ids: string[] = (json?.data || [])
                .map((m: any) => m?.id)
                .filter((id: any) => typeof id === 'string' && id.length > 0);
              return { key: p.key, label: p.label, reachable: true, models: [...new Set(ids)] };
            }
          } catch (e) {}
          return { key: p.key, label: p.label, reachable: false, models: [] as string[] };
        })
      );
      res.json({ success: true, providers: results });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'model listing failed' });
    }
  });
  app.post('/api/providers/configure', async (req, res) => {
    try {
      const { pinnedProvider, groqApiKey, ttsVoice, ttsEnabled: enableTts, models, endpoint } = req.body || {};

    // Custom OpenAI-compatible endpoint (base URL and/or API key) per provider
    if (endpoint !== undefined) {
      if (typeof endpoint !== 'object' || endpoint === null) {
        return res.status(400).json({ success: false, error: 'endpoint must be an object {provider, baseUrl?, apiKey?}' });
      }
      const prov = String((endpoint as any).provider || '');
      if (!['local', 'ollama', 'groq'].includes(prov)) {
        return res.status(400).json({ success: false, error: `Unknown provider '${prov}'` });
      }
      if (!runtimeConfig.endpoints[prov]) runtimeConfig.endpoints[prov] = {};
      if ((endpoint as any).baseUrl !== undefined) {
        const raw = String((endpoint as any).baseUrl).trim();
        if (raw === '') {
          delete runtimeConfig.endpoints[prov].baseUrl;
        } else {
          const normalized = raw.replace(/\/+$/, '');
          if (!/^https?:\/\/.+/i.test(normalized)) {
            return res.status(400).json({ success: false, error: 'baseUrl must start with http:// or https://' });
          }
          runtimeConfig.endpoints[prov].baseUrl = normalized;
        }
      }
      if ((endpoint as any).apiKey !== undefined) {
        const key = String((endpoint as any).apiKey);
        if (key === '') delete runtimeConfig.endpoints[prov].apiKey;
        else runtimeConfig.endpoints[prov].apiKey = key;
      }
      // New backend → drop every cached model/cooldown assumption
      clearProviderCaches();
    }

    if (models !== undefined) {
      if (typeof models !== 'object' || models === null || Array.isArray(models)) {
        return res.status(400).json({ success: false, error: 'models must be an object of providerKey -> modelId' });
      }
      for (const [providerKey, modelId] of Object.entries(models)) {
        if (!['local', 'ollama', 'groq'].includes(providerKey)) {
          return res.status(400).json({ success: false, error: `Unknown provider '${providerKey}'` });
        }
        if (modelId === 'auto' || modelId === '') {
          delete runtimeConfig.modelOverrides[providerKey];
        } else if (typeof modelId === 'string' && /^[A-Za-z0-9._:\-/ ]{1,120}$/.test(modelId.trim())) {
          runtimeConfig.modelOverrides[providerKey] = modelId.trim();
        } else {
          return res.status(400).json({ success: false, error: `Invalid model id for ${providerKey}` });
        }
      }
      clearProviderCaches();
    }

      if (pinnedProvider !== undefined) {
        const valid = ['auto', 'local', 'ollama', 'groq', null];
        if (!valid.includes(pinnedProvider)) {
          return res.status(400).json({ success: false, error: 'pinnedProvider must be auto, local, ollama, groq or null' });
        }
        runtimeConfig.pinnedProvider = pinnedProvider === 'auto' ? null : pinnedProvider;
      }

      if (typeof groqApiKey === 'string' && groqApiKey.trim()) {
        const key = groqApiKey.trim();
        // Validate against Groq before accepting
        try {
          const check = await fetchWithTimeout(
            'https://api.groq.com/openai/v1/models',
            { headers: { Authorization: `Bearer ${key}` } },
            8000
          );
          if (!check.ok) {
            return res.status(400).json({ success: false, error: `Groq rejected the key (HTTP ${check.status})` });
          }
        } catch (e: any) {
          return res.status(400).json({ success: false, error: `Could not reach Groq: ${e?.message || e}` });
        }
        process.env.GROQ_API_KEY = key;
      }

      if (ttsVoice !== undefined) {
        const v = sanitizeVoice(ttsVoice);
        if (!v) return res.status(400).json({ success: false, error: 'Invalid voice id' });
        runtimeConfig.ttsVoice = v;
      }

      if (typeof enableTts === 'boolean') {
        runtimeConfig.ttsEnabled = enableTts;
      }

      // Durable-save the full snapshot so restarts keep every preference
      saveStoredSettings({
        groqApiKey: process.env.GROQ_API_KEY || undefined,
        pinnedProvider: runtimeConfig.pinnedProvider,
        modelOverrides: runtimeConfig.modelOverrides,
        ttsVoice: runtimeConfig.ttsVoice || undefined,
        ttsEnabled: runtimeConfig.ttsEnabled ?? undefined,
        endpoints: runtimeConfig.endpoints,
      });

      res.json({ success: true, config: { pinnedProvider: runtimeConfig.pinnedProvider, models: { ...runtimeConfig.modelOverrides }, ttsVoice: defaultTtsVoice(), ttsEnabled: ttsEnabled() } });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'configuration failed' });
    }
  });
}
