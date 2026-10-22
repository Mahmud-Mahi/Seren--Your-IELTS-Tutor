import { runtimeConfig } from './config';

// ---------------------------------------------------------------------------
// Multi-provider OpenAI-compatible LLM layer (Local -> Ollama -> Groq cascade)
// ---------------------------------------------------------------------------

export interface LLMProvider {
  key: 'local' | 'ollama' | 'groq';
  label: string;
  baseUrl: string;
  model: string; // 'auto' triggers auto-detection from /models
  apiKey: string;
  timeoutMs: number;
  supportsResponseFormat: boolean;
}

export function getProviders(): LLMProvider[] {
  const defs: LLMProvider[] = [
    {
      key: 'local',
      label: 'Local LLM Server',
      baseUrl: (process.env.LLM_BASE_URL || 'http://localhost:3456/v1').replace(/\/+$/, ''),
      model: process.env.LLM_MODEL || 'auto',
      apiKey: process.env.LLM_API_KEY || 'none',
      timeoutMs: parseInt(process.env.LLM_TIMEOUT_MS || '120000', 10),
      supportsResponseFormat: false,
    },
    {
      key: 'ollama',
      label: 'Ollama',
      baseUrl: (process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1').replace(/\/+$/, ''),
      model: process.env.OLLAMA_MODEL || 'ornith:9b',
      apiKey: 'ollama',
      timeoutMs: parseInt(process.env.OLLAMA_TIMEOUT_MS || '120000', 10),
      supportsResponseFormat: false,
    },
    {
      key: 'groq',
      label: 'Groq Cloud (free tier)',
      baseUrl: (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, ''),
      model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
      apiKey: process.env.GROQ_API_KEY || '',
      timeoutMs: parseInt(process.env.GROQ_TIMEOUT_MS || '45000', 10),
      supportsResponseFormat: true,
    },
  ];

  // Runtime endpoint overrides (custom base URL / API key per provider)
  for (const def of defs) {
    const ep = runtimeConfig.endpoints[def.key];
    if (ep?.baseUrl) def.baseUrl = ep.baseUrl.replace(/\/+$/, '');
    if (ep && ep.apiKey !== undefined) {
      def.apiKey = ep.apiKey === '' ? (def.key === 'local' ? 'none' : '') : ep.apiKey;
    }
  }

  // Runtime model overrides set via /api/providers/configure (key -> model id)
  for (const def of defs) {
    const override = runtimeConfig.modelOverrides[def.key];
    if (override) def.model = override;
  }

  const priority = (process.env.PROVIDER_PRIORITY || 'local,ollama,groq')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const ordered: LLMProvider[] = [];
  for (const key of priority) {
    const def = defs.find((d) => d.key === key);
    if (def) ordered.push(def);
  }
  for (const def of defs) {
    if (!ordered.includes(def)) ordered.push(def);
  }
  return ordered;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
export { fetchWithTimeout };

// ---------------------------------------------------------------------------
// Transient-failure handling.
//
// A provider that is momentarily overloaded (HTTP 429/5xx) or whose socket
// blipped is NOT broken: the previous code cooled the model down for 10
// minutes on ANY error, which punished healthy providers for a temporary
// hiccup and made one rate-limited call poison the whole cascade. Transient
// failures are now retried IN PLACE with exponential backoff and never put a
// cooldown on the provider; only permanent failures (auth, bad request,
// unknown model) cool a model down.
// ---------------------------------------------------------------------------

const TRANSIENT_RETRY_DELAYS_MS = [400, 1200, 3000];
const MAX_TRANSIENT_RETRIES = TRANSIENT_RETRY_DELAYS_MS.length;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Extract the HTTP status from an LLM error message ("HTTP 503 from …"). */
export function httpStatusOfError(err: any): number | null {
  const match = String(err?.message || '').match(/\bHTTP\s+(\d{3})\b/i);
  return match ? Number(match[1]) : null;
}

/**
 * True when the failure is temporary and the SAME request is likely to
 * succeed if retried shortly (rate limits, upstream 5xx, network resets,
 * timeouts). Everything else is permanent and must cascade immediately.
 */
export function isTransientLLMError(err: any): boolean {
  const status = httpStatusOfError(err);
  if (status != null) {
    return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  }
  const message = String(err?.message || err || '').toLowerCase();
  if (!message) return false;
  return (
    /timed? ?out|timeout|etimedout|econnreset|econnrefused|eai_again|epipe|socket hang up|fetch failed|network|aborted|empty completion/.test(
      message
    )
  );
}

// Ranked candidate cache per provider ('auto' mode discovers many models)
const providerCandidatesCache: Map<string, { models: string[]; at: number }> = new Map();
// Sticky preference: the last model that actually answered on each provider
const lastGoodModel: Map<string, string> = new Map();
// Temporary cooldown for models that recently failed (502/unavailable/timeout)
const modelCooldowns: Map<string, number> = new Map();
const MODEL_COOLDOWN_MS = 10 * 60 * 1000;
// How many candidate models to try per provider before cascading to the next one
const MAX_MODELS_PER_PROVIDER = 3;

// Providers that must NEVER be used in the automatic cascade. They remain
// fully available when explicitly pinned (Settings / x-seren-provider).
export const EXCLUDED_FROM_AUTO_CASCADE = new Set<string>(['ollama']);

const EXCLUDED_MODEL_PATTERNS = /embed|whisper|tts|rerank|image|clip|guard|moderation|flux|stable|sd3|dall/i;
const PREFERRED_MODEL_PATTERNS: RegExp[] = [
  /gpt-4o|gpt-4\.1|gpt-5|gpt-?oss|o3|o4-mini/i,
  /claude.*(sonnet|opus|haiku)/i,
  /deepseek.*(v3|r1|chat)/i,
  /qwen/i,
  /llama/i,
  /glm-?4/i,
  /kimi|mistral|gemma|phi-?3/i,
];

function scoreModel(id: string): number {
  if (EXCLUDED_MODEL_PATTERNS.test(id)) return -1;
  for (let i = 0; i < PREFERRED_MODEL_PATTERNS.length; i++) {
    if (PREFERRED_MODEL_PATTERNS[i].test(id)) return 100 - i;
  }
  return /instruct|chat|turbo|latest/i.test(id) ? 50 : 10;
}

async function resolveProviderModels(provider: LLMProvider): Promise<string[]> {
  // Always discover available models so a failing configured model cascades
  // to the provider's other models before we give up on the provider itself
  const cached = providerCandidatesCache.get(provider.key);
  if (!cached || Date.now() - cached.at >= 60000) {
    let discovered: string[] = [];
    try {
      const res = await fetchWithTimeout(
        `${provider.baseUrl}/models`,
        {
          headers: provider.apiKey && provider.apiKey !== 'none'
            ? { Authorization: `Bearer ${provider.apiKey}` }
            : {},
        },
        6000
      );
      if (res.ok) {
        const json: any = await res.json();
        const ids: string[] = (json?.data || [])
          .map((m: any) => m?.id)
          .filter((id: any) => typeof id === 'string' && id.length > 0);
        const ranked = ids
          .map((id) => ({ id, score: scoreModel(id) }))
          .filter((m) => m.score >= 0)
          .sort((a, b) => b.score - a.score)
          .map((m) => m.id);
        discovered = [...new Set(ranked)];
      }
    } catch (e) {
      // server unreachable — no candidates
    }
    providerCandidatesCache.set(provider.key, { models: discovered, at: Date.now() });
  }

  const discovered = providerCandidatesCache.get(provider.key)?.models || [];
  if (provider.model && provider.model !== 'auto') {
    // Configured/pinned model first, then every other model this provider offers
    return [provider.model, ...discovered.filter((m) => m !== provider.model)];
  }
  return discovered;
}

async function resolveProviderModel(provider: LLMProvider): Promise<string | null> {
  const models = await resolveProviderModels(provider);
  const good = lastGoodModel.get(provider.key);
  if (good && models.includes(good)) return good;
  return models[0] || null;
}

export async function isProviderReachable(provider: LLMProvider): Promise<{ reachable: boolean; model: string | null; latencyMs: number | null }> {
  const started = Date.now();
  try {
    const res = await fetchWithTimeout(
      `${provider.baseUrl}/models`,
      {
        headers:
          provider.apiKey && provider.apiKey !== 'none'
            ? { Authorization: `Bearer ${provider.apiKey}` }
            : {},
      },
      5000
    );
    const latencyMs = Date.now() - started;
    if (!res.ok) return { reachable: false, model: null, latencyMs };
    const model = await resolveProviderModel(provider);
    return { reachable: true, model, latencyMs };
  } catch (e) {
    return { reachable: false, model: null, latencyMs: null };
  }
}

function buildJsonSystemInstruction(systemInstruction: string | undefined, jsonSchemaHint: string): string {
  const base = systemInstruction
    ? `${systemInstruction} You must respond with ONLY valid JSON (no markdown fences, no commentary).`
    : 'You must respond with ONLY valid JSON (no markdown fences, no commentary).';
  return `${base}\n\nThe JSON must match this exact structure:\n${jsonSchemaHint}`;
}

export interface CallLLMOptions {
  systemInstruction?: string;
  userPrompt: string;
  json?: boolean;
  jsonSchemaHint?: string;
  temperature?: number;
  maxTokens?: number;
  pinnedProvider?: string | null;
}

export async function callLLM(opts: CallLLMOptions): Promise<{ text: string; provider: string; model: string }> {
  const pinned = (opts.pinnedProvider || runtimeConfig.pinnedProvider || process.env.PINNED_PROVIDER || '').toLowerCase() || null;
  const providers = getProviders();
  let lastError: any = null;

  for (const provider of providers) {
    if (pinned && provider.key !== pinned) continue;
    // Ollama is excluded from the AUTO cascade entirely — it is only used
    // when explicitly pinned via Settings or x-seren-provider header
    if (!pinned && EXCLUDED_FROM_AUTO_CASCADE.has(provider.key)) continue;
    if (provider.key === 'groq' && !provider.apiKey) {
      lastError = new Error('Groq API key not configured');
      continue;
    }

    const candidates = await resolveProviderModels(provider);
    // Sticky: prefer the last model that answered on this provider
    const good = lastGoodModel.get(provider.key);
    const orderedModels = good && candidates.includes(good)
      ? [good, ...candidates.filter((m) => m !== good)]
      : candidates;

    let tried = 0;
    for (const model of orderedModels) {
      if (tried >= MAX_MODELS_PER_PROVIDER) break;
      const cooldownKey = `${provider.key}::${model}`;
      if ((modelCooldowns.get(cooldownKey) || 0) > Date.now()) continue;
      tried++;

      const systemMessages: string[] = [];
      if (opts.systemInstruction || (opts.json && opts.jsonSchemaHint)) {
        systemMessages.push(
          opts.json && opts.jsonSchemaHint
            ? buildJsonSystemInstruction(opts.systemInstruction, opts.jsonSchemaHint)
            : opts.systemInstruction || ''
        );
      }

      const body: Record<string, any> = {
        model,
        messages: [
          ...(systemMessages.length && systemMessages[0] ? [{ role: 'system', content: systemMessages[0] }] : []),
          { role: 'user', content: opts.userPrompt },
        ],
        temperature: opts.temperature ?? 0.7,
        stream: false,
      };
      if (opts.maxTokens) body.max_tokens = opts.maxTokens;
      if (opts.json && provider.supportsResponseFormat) {
        body.response_format = { type: 'json_object' };
      }

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (provider.apiKey && provider.apiKey !== 'none') {
        headers['Authorization'] = `Bearer ${provider.apiKey}`;
      }

      // Two attempts per model: the second drops response_format in case the backend rejects it.
      // TRANSIENT failures (429/5xx/network/timeout) are retried IN PLACE with
      // exponential backoff and never cool the model down — only permanent
      // failures do, so a rate-limited provider stays usable for the next call.
      for (let attempt = 0; attempt < 2; attempt++) {
        let transientRetries = 0;
        let modelFailed = false;
        for (;;) {
          try {
            const res = await fetchWithTimeout(
              `${provider.baseUrl}/chat/completions`,
              { method: 'POST', headers, body: JSON.stringify(body) },
              provider.timeoutMs
            );

            if (!res.ok) {
              const errText = await res.text().catch(() => '');
              if (attempt === 0 && body.response_format && (res.status === 400 || res.status === 422)) {
                delete body.response_format;
                break; // retry the same model WITHOUT response_format
              }
              throw new Error(`HTTP ${res.status} from ${provider.key}/${model}: ${errText.slice(0, 200)}`);
            }

            const json: any = await res.json();
            const text: string = json?.choices?.[0]?.message?.content || '';
            if (!text.trim()) throw new Error(`Empty completion from ${provider.key}/${model}`);

            lastGoodModel.set(provider.key, model);
            return { text: text.trim(), provider: provider.key, model };
          } catch (err: any) {
            lastError = err;
            const transient = isTransientLLMError(err);
            if (transient && transientRetries < MAX_TRANSIENT_RETRIES) {
              const delay = TRANSIENT_RETRY_DELAYS_MS[transientRetries];
              transientRetries++;
              console.warn(
                `[LLM] Transient failure on '${provider.key}'/'${model}' (${err?.message || err}) — retrying in ${delay}ms (${transientRetries}/${MAX_TRANSIENT_RETRIES})`
              );
              await sleep(delay);
              continue; // retry the SAME model/provider
            }
            console.warn(`[LLM] Provider '${provider.key}' model '${model}' failed:`, err?.message || err);
            // Only a PERMANENT failure earns a cooldown. A transient failure
            // says nothing about the model's health, so the provider keeps its
            // place in the cascade for the very next request.
            if (!transient) {
              modelCooldowns.set(cooldownKey, Date.now() + MODEL_COOLDOWN_MS);
            }
            modelFailed = true;
            break; // move to next candidate model
          }
        }
        // The model is exhausted (permanent failure or retries spent) —
        // never re-enter the format-fallback attempt for the same model.
        if (modelFailed) break;
      }
    }
  }

  throw lastError || new Error('No LLM provider available');
}
// Robust JSON extraction from LLM output (handles fences, prose wrappers, trailing commas)
export function parseJsonLoose(raw: string): any | null {
  if (!raw) return null;
  let t = raw.trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  try {
    return JSON.parse(t);
  } catch {}
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start !== -1 && end > start) {
    let candidate = t.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {}
    candidate = candidate.replace(/,\s*([}\]])/g, '$1');
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  return null;
}
async function callLLMWithCascade(opts: CallLLMOptions): Promise<{ text: string; provider: string; model: string }> {
  try {
    return await callLLM(opts);
  } catch (err: any) {
    if (!opts.pinnedProvider) throw err;
    console.warn(`[LLM] pinned provider '${opts.pinnedProvider}' failed (${err?.message || err}) — retrying via auto-cascade`);
    return callLLM({ ...opts, pinnedProvider: null });
  }
}
export { callLLMWithCascade };

// Drop every cached model/cooldown assumption — used when endpoints, models or
// the pinned provider change, and on factory reset.
export function clearProviderCaches(): void {
  providerCandidatesCache.clear();
  lastGoodModel.clear();
  modelCooldowns.clear();
}
