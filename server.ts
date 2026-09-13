import express from 'express';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { pipeline, type Readable } from 'stream';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import type { Socket } from 'net';
import { createServer as createViteServer } from 'vite';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { casualGreetingReply, tutorGreetingReply } from './src/utils/greetings';

dotenv.config();
dotenv.config();

// ---------------------------------------------------------------------------
// msedge-tts hardening — late WebSocket frames must never kill the server
// ---------------------------------------------------------------------------
// When the browser aborts a TTS request (pause / stop / next utterance in the
// Solutions tab), the audio stream is destroyed and the WebSocket closed. Late
// audio frames can still arrive afterwards and the library's message handler
// looks up a stream entry that no longer exists, throwing an UNCAUGHT
// exception that takes the whole Node process down ("Cannot read properties
// of undefined (reading 'audio')"). Every /api/tts call then fails and the
// app silently degrades to the robotic browser voice. Guard the internal push
// helpers against a missing stream entry, and install a global safety net so
// a TTS hiccup can never crash the server again.
const msedgeProto = MsEdgeTTS.prototype as unknown as Record<string, (...args: any[]) => void>;
for (const methodName of ['_pushAudioData', '_pushMetadata']) {
  const original = msedgeProto[methodName];
  if (typeof original !== 'function') continue;
  msedgeProto[methodName] = function (this: any, ...args: any[]) {
    // Frame for a stream that was already torn down (aborted request) — drop it
    if (!this._streams || !this._streams[args[1]]) return;
    try {
      return original.apply(this, args);
    } catch {
      // Pushing into a destroyed Readable throws — harmless for an aborted
      // request, but it must never escape into the WebSocket receiver.
    }
  };
}

process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception (server kept alive):', err?.stack || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled rejection (server kept alive):', reason);
});


// ---------------------------------------------------------------------------
// sherpa-onnx Whisper STT (local, offline, no API key)
// ---------------------------------------------------------------------------
const _cjsRequire = (() => {
  try { return createRequire(import.meta.url); } catch {}
  // esbuild CJS bundle: __dirname is the dist/ folder
  try { return createRequire(path.join(__dirname || '.', 'noop.cjs')); } catch {}
  return null;
})();

if (!_cjsRequire) {
  console.warn('[stt] Cannot load sherpa-onnx: no CJS require available');
}

let whisperSTT: { transcribe(base64: string, mime: string): Promise<string> } | null = null;
try {
  let srcDir = '';
  try {
    if (import.meta?.url) srcDir = path.dirname(fileURLToPath(import.meta.url));
  } catch {}
  const searchDirs = [
    srcDir,
    typeof __dirname !== 'undefined' ? path.resolve(__dirname || '.', '..') : '',
    process.cwd(),
  ];
  const sttModulePath = searchDirs
    .filter(Boolean)
    .map((dir) => path.join(dir!, 'stt-whisper.cjs'))
    .find((p) => fs.existsSync(p));

  if (!sttModulePath || !_cjsRequire) throw new Error('stt-whisper.cjs not found');
  whisperSTT = _cjsRequire(sttModulePath);
  console.log(`[stt] Whisper (sherpa-onnx) loaded — local offline STT enabled`);
  // Hot-start the recognizer shortly after boot so the first user utterance
  // is never decoded through a cold ONNX session. Non-blocking (unref'd).
  const sttWarmUp = (whisperSTT as any).warmUp;
  if (typeof sttWarmUp === 'function') {
    setTimeout(() => {
      try { sttWarmUp.call(whisperSTT); } catch {}
    }, 1000).unref?.();
  }
} catch (e: any) {
  console.warn('[stt] sherpa-onnx Whisper not available:', e?.message || e);
}

// ---------------------------------------------------------------------------
// Durable settings: survive server restarts (API keys, models, voice, pinning)
// ---------------------------------------------------------------------------
const SETTINGS_FILE = path.join(process.cwd(), 'lumi-settings.json');

interface StoredSettings {
  groqApiKey?: string;
  pinnedProvider?: string | null;
  modelOverrides?: Record<string, string>;
  ttsVoice?: string;
  ttsEnabled?: boolean;
  endpoints?: Record<string, { baseUrl?: string; apiKey?: string }>;
}

function loadStoredSettings(): StoredSettings {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function saveStoredSettings(settings: StoredSettings): void {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (e: any) {
    console.warn('[settings] Could not persist settings:', e?.message || e);
  }
}

// ---------------------------------------------------------------------------
// Runtime configuration (can be overridden at runtime via /api/providers/configure)
// ---------------------------------------------------------------------------
const runtimeConfig: {
  pinnedProvider: string | null;
  ttsEnabled: boolean | null;
  ttsVoice: string | null;
  modelOverrides: Record<string, string>;
  endpoints: Record<string, { baseUrl?: string; apiKey?: string }>;
} = {
  pinnedProvider: null,
  ttsEnabled: null,
  ttsVoice: null,
  modelOverrides: {},
  endpoints: {},
};

// Restore saved preferences on boot (file values win over .env defaults)
{
  const stored = loadStoredSettings();
  if (stored.groqApiKey) process.env.GROQ_API_KEY = stored.groqApiKey;
  if (stored.pinnedProvider !== undefined) runtimeConfig.pinnedProvider = stored.pinnedProvider;
  if (stored.modelOverrides) runtimeConfig.modelOverrides = stored.modelOverrides;
  if (stored.ttsVoice) runtimeConfig.ttsVoice = stored.ttsVoice;
  if (stored.ttsEnabled !== undefined) runtimeConfig.ttsEnabled = stored.ttsEnabled;
  if (stored.endpoints) runtimeConfig.endpoints = stored.endpoints;
}

function ttsEnabled(): boolean {
  if (runtimeConfig.ttsEnabled !== null) return runtimeConfig.ttsEnabled;
  return (process.env.TTS_ENABLED || 'true').toLowerCase() !== 'false';
}

// ---------------------------------------------------------------------------
// Multi-provider OpenAI-compatible LLM layer (Local -> Ollama -> Groq cascade)
// ---------------------------------------------------------------------------

interface LLMProvider {
  key: 'local' | 'ollama' | 'groq';
  label: string;
  baseUrl: string;
  model: string; // 'auto' triggers auto-detection from /models
  apiKey: string;
  timeoutMs: number;
  supportsResponseFormat: boolean;
}

function getProviders(): LLMProvider[] {
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
// fully available when explicitly pinned (Settings / x-lumi-provider).
const EXCLUDED_FROM_AUTO_CASCADE = new Set<string>(['ollama']);

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

async function isProviderReachable(provider: LLMProvider): Promise<{ reachable: boolean; model: string | null; latencyMs: number | null }> {
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
    // when explicitly pinned via Settings or x-lumi-provider header
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

      // Two attempts per model: the second drops response_format in case the backend rejects it
      for (let attempt = 0; attempt < 2; attempt++) {
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
              continue;
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
          console.warn(`[LLM] Provider '${provider.key}' model '${model}' failed:`, err?.message || err);
          modelCooldowns.set(cooldownKey, Date.now() + MODEL_COOLDOWN_MS);
          break; // move to next candidate model
        }
      }
    }
  }

  throw lastError || new Error('No LLM provider available');
}

// Robust JSON extraction from LLM output (handles fences, prose wrappers, trailing commas)
function parseJsonLoose(raw: string): any | null {
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

// Complete a partially-generated evaluation so the client never renders
// undefined fields (a rate-limited/truncated LLM response previously produced
// a blank report page). Mirrors src/utils/evaluation.ts on the client.
function normalizeEvaluationShape(ev: any): any {
  const toText = (v: any): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const toNum = (v: any, fb: number): number => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
    return Number.isFinite(n) ? n : fb;
  };
  const toArr = (v: any): string[] => {
    if (Array.isArray(v)) return v.map(toText).map((s: string) => s.trim()).filter(Boolean);
    const s = toText(v).trim();
    return s ? [s] : [];
  };
  const cefrLevels = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  const clampBand = (n: number) => Math.min(9, Math.max(0, n));

  const band = clampBand(toNum(ev?.predictedIeltsBand, 6.5));
  const cefr = cefrLevels.includes(ev?.overallCEFR) ? ev.overallCEFR : 'B2';

  const normPillar = (p: any) => ({
    score: clampBand(toNum(p?.score, band)),
    cefr: cefrLevels.includes(p?.cefr) ? p.cefr : cefr,
    strengths: toArr(p?.strengths),
    growthAreas: toArr(p?.growthAreas),
    examinerCommentary: toText(p?.examinerCommentary),
  });

  ev.overallCEFR = cefr;
  ev.predictedIeltsBand = band;
  ev.cefrDescriptor = toText(ev?.cefrDescriptor) || 'Independent Speaker';
  ev.executiveSummary = toText(ev?.executiveSummary);
  ev.pillars = {
    fluency: normPillar(ev?.pillars?.fluency),
    lexical: normPillar(ev?.pillars?.lexical),
    grammar: normPillar(ev?.pillars?.grammar),
    pronunciation: normPillar(ev?.pillars?.pronunciation),
  };
  ev.upgradedExpressions = Array.isArray(ev?.upgradedExpressions) ? ev.upgradedExpressions : [];
  ev.pronunciationTips = Array.isArray(ev?.pronunciationTips) ? ev.pronunciationTips : [];
  ev.stats = {
    totalWords: Math.max(0, Math.round(toNum(ev?.stats?.totalWords, 0))),
    estimatedWPM: Math.min(250, Math.max(40, Math.round(toNum(ev?.stats?.estimatedWPM, 110)))),
    pauseFluencyRating: toText(ev?.stats?.pauseFluencyRating) || 'Moderate Pauses',
    varietyRating: toText(ev?.stats?.varietyRating) || 'Good',
  };
  ev.lessonRoadmap = Array.isArray(ev?.lessonRoadmap) ? ev.lessonRoadmap : [];
  return ev;
}

// ---------------------------------------------------------------------------
// Full-coverage report analysis: deterministic sentence extraction so EVERY
// meaningful sentence the student spoke gets upgraded, nothing skipped
// ---------------------------------------------------------------------------

interface ExtractedSentence {
  part: number;   // 1..3 real IELTS part (not array index!)
  index: number;  // global 1-based numbering across all parts
  text: string;
}

/**
 * Maps a raw response item to the REAL IELTS part number (1|2|3).
 *
 * Cambridge tests contain MANY questions per section (e.g. 4 × Part 1 + 1 ×
 * Part 2 + 6 × Part 3), so the position of a response inside the submitted
 * array is NOT the part number. Using the array index caused sentences from a
 * Part 2 cue card to be stamped "Part 5" and broke the report's Part filter.
 */
function resolveResponsePart(r: any, fallbackIdx: number): number {
  const fromField = Number(r?.part);
  if (Number.isInteger(fromField) && fromField >= 1 && fromField <= 3) return fromField;
  const title = String(r?.partTitle || '');
  const m = title.match(/part\s*([1-3])\b/i);
  if (m) return Number(m[1]);
  return fallbackIdx + 1;
}

function splitIntoSentences(responses: any[]): ExtractedSentence[] {
  const out: ExtractedSentence[] = [];
  let counter = 0;
  (responses || []).forEach((r: any, idx: number) => {
    const transcript = String(r?.transcript || '').trim();
    if (!transcript) return;
    const part = resolveResponsePart(r, idx);
    const pieces = transcript
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim().replace(/\s+/g, ' '))
      .filter(Boolean);
    for (const raw of pieces) {
      const wordCount = raw.split(/\s+/).filter(Boolean).length;
      if (wordCount < 4) continue; // skip trivial fragments ("Yes.", "I think so.")
      counter += 1;
      out.push({ part, index: counter, text: raw });
    }
  });
  return out;
}

const UPGRADE_CHUNK_SIZE = 12;

function buildUpgradeChunkPrompt(chunk: ExtractedSentence[]): string {
  return `Upgrade every sentence below to Band 8+/9 IELTS standard.
For each: keep the meaning, copy "original" verbatim, output the upgraded version, its band label (e.g. Band 8.0), and a one-line explanation of the improvement.
One entry per sentence, in order. Never skip, merge, or invent.

SENTENCES (${chunk.length}):
${chunk.map((s) => `[S${s.index}|P${s.part}] "${s.text}"`).join('\n')}`;
}

const UPGRADE_CHUNK_SCHEMA = `{
  "upgradedExpressions": [ { "index": 1, "part": 1, "original": "verbatim input", "upgraded": "band 8+ version", "ieltsBand": "Band 8.0", "explanation": "one-line upgrade rationale" } ]
}
Array length = number of input sentences, same order.`;

// When a PINNED provider fails (e.g. Groq quota exhausted / key rate-limited),
// automatically retry through the full auto-cascade so the report still finishes
async function callLLMWithCascade(opts: CallLLMOptions): Promise<{ text: string; provider: string; model: string }> {
  try {
    return await callLLM(opts);
  } catch (err: any) {
    if (!opts.pinnedProvider) throw err;
    console.warn(`[LLM] pinned provider '${opts.pinnedProvider}' failed (${err?.message || err}) — retrying via auto-cascade`);
    return callLLM({ ...opts, pinnedProvider: null });
  }
}

// ---------------------------------------------------------------------------
// Neural TTS (Microsoft Edge Read Aloud service) — free, high-quality voices
// ---------------------------------------------------------------------------

const TTS_VOICES: { id: string; name: string; locale: string; gender: string; personality: string }[] = [
  { id: 'en-US-JennyNeural', name: 'Jenny', locale: 'en-US', gender: 'Female', personality: 'Warm, friendly & conversational (recommended for Lumi)' },
  { id: 'en-US-AriaNeural', name: 'Aria', locale: 'en-US', gender: 'Female', personality: 'Professional, confident' },
  { id: 'en-US-MichelleNeural', name: 'Michelle', locale: 'en-US', gender: 'Female', personality: 'Calm, clear' },
  { id: 'en-US-AvaNeural', name: 'Ava', locale: 'en-US', gender: 'Female', personality: 'Youthful, expressive' },
  { id: 'en-US-EmmaNeural', name: 'Emma', locale: 'en-US', gender: 'Female', personality: 'Cheerful, optimistic' },
  { id: 'en-GB-SoniaNeural', name: 'Sonia', locale: 'en-GB', gender: 'Female', personality: 'Warm British' },
  { id: 'en-GB-LibbyNeural', name: 'Libby', locale: 'en-GB', gender: 'Female', personality: 'Soft British' },
  { id: 'en-AU-NatashaNeural', name: 'Natasha', locale: 'en-AU', gender: 'Female', personality: 'Friendly Australian' },
  { id: 'en-IN-NeerjaNeural', name: 'Neerja', locale: 'en-IN', gender: 'Female', personality: 'Warm Indian English' },
  { id: 'en-IN-SwaraNeural', name: 'Swara', locale: 'en-IN', gender: 'Female', personality: 'Expressive Indian English' },
  { id: 'en-CA-ClaraNeural', name: 'Clara', locale: 'en-CA', gender: 'Female', personality: 'Positive Canadian' },
  { id: 'en-IE-EmilyNeural', name: 'Emily', locale: 'en-IE', gender: 'Female', personality: 'Soft Irish' },
  { id: 'en-US-GuyNeural', name: 'Guy', locale: 'en-US', gender: 'Male', personality: 'Confident, energetic' },
  { id: 'en-GB-RyanNeural', name: 'Ryan', locale: 'en-GB', gender: 'Male', personality: 'Friendly British' },
];

function defaultTtsVoice(): string {
  return runtimeConfig.ttsVoice || process.env.TTS_VOICE || 'en-US-JennyNeural';
}

function sanitizeVoice(voice: any): string | null {
  if (typeof voice !== 'string') return null;
  const v = voice.trim();
  return /^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$/.test(v) ? v : null;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cleanTextForTts(text: string): string {
  return text
    .replace(/[*_#`~]/g, '')
    .replace(/\[.*?\]/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 3000);
}

const TTS_SYNTHESIS_TIMEOUT_MS = 8000;
const TTS_MAX_ATTEMPTS = 3;

// NOTE: A new MsEdgeTTS instance must be created per call. The library's
// internal state (including resolved voice metadata) is corrupted when an
// instance whose stream has ended is reused — that produces
// "Cannot read properties of undefined (reading 'voiceLocale')".

// A `TtsSession` bundles the produced audio stream with the MsEdgeTTS
// instance that created it, so callers can always release the WebSocket once
// the stream is consumed (or abandoned).
interface TtsSession {
  audioStream: Readable;
  tts: MsEdgeTTS;
}

function destroyTtsSession(session: TtsSession | null | undefined): void {
  if (!session) return;
  try { session.audioStream.destroy(); } catch {}
  try { session.tts.close(); } catch {}
}

async function synthesizeOnce(
  text: string,
  voice: string,
  rate?: number,
  pitch?: number
): Promise<TtsSession> {
  // A new MsEdgeTTS instance per call — see comment at TTS_MAX_ATTEMPTS above.
  const tts = new MsEdgeTTS();
  try {
    // Pass empty metadataOptions {} as 3rd arg — prevents the library from
    // crashing with "Cannot read properties of undefined (reading 'voiceLocale')"
    // when it tries to access metadataOptions.voiceLocale internally.
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, {});

    const clean = cleanTextForTts(text);
    if (!clean) throw new Error('No speakable text after cleanup');

    const prosody: { rate?: number; pitch?: string } = {};
    if (typeof rate === 'number' && isFinite(rate) && rate > 0 && rate !== 1) prosody.rate = rate;
    if (typeof pitch === 'number' && isFinite(pitch)) {
      const hz = Math.max(-50, Math.min(50, Math.round((pitch - 1) * 50)));
      if (hz !== 0) prosody.pitch = `${hz >= 0 ? '+' : ''}${hz}Hz`;
    }

    // msedge-tts versions differ on sync/async toStream — handle both
    const result: any = tts.toStream(escapeXml(clean), prosody);
    const { audioStream } = result && typeof result.then === 'function' ? await result : result;
    return { audioStream: audioStream as Readable, tts };
  } catch (err) {
    // Never leak the WebSocket when setup/synthesis fails part-way.
    try { tts.close(); } catch {}
    throw err;
  }
}

// Bounds the time spent connecting + creating the audio stream while making
// sure a synthesis that finishes AFTER the deadline is torn down rather than
// leaked (orphaned WebSockets/streams would otherwise accumulate over time).
function withSynthesisTimeout(
  synth: Promise<TtsSession>,
  ms: number
): Promise<TtsSession> {
  let settled = false;
  return new Promise<TtsSession>((resolve, reject) => {
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      // The synthesis may still be pending — destroy it the moment it resolves.
      void synth.then(destroyTtsSession).catch(() => {});
      reject(new Error('TTS synthesis timed out'));
    }, ms);

    synth.then(
      (session) => {
        if (settled) {
          destroyTtsSession(session);
          return;
        }
        settled = true;
        clearTimeout(deadline);
        resolve(session);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        reject(err);
      }
    );
  });
}

// Pipes the synthesised audio to the Express response. Handles the case where
// `pipeline()` throws synchronously (ERR_STREAM_UNABLE_TO_PIPE) because the
// destination was already destroyed by a client abort.
function pipeAudioToResponse(session: TtsSession, res: express.Response): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    try {
      pipeline(session.audioStream, res as any, (err: any) => (err ? reject(err) : resolve()));
    } catch (err) {
      reject(err as any);
    }
  });
}

async function synthesizeToResponse(
  res: express.Response,
  text: string,
  voice: string,
  rate?: number,
  pitch?: number
): Promise<void> {
  let lastErr: any = null;
  // The browser cancels the TTS request without warning whenever a newer
  // utterance starts (see src/utils/speech.ts: ttsAbortCtrl.abort()), which
  // destroys this response. Once that happens, retrying can only re-throw
  // ERR_STREAM_UNABLE_TO_PIPE ("Cannot pipe to a closed or destroyed stream")
  // into a dead socket, so we must detect it and fail fast instead.
  let clientGone = res.destroyed || res.writableEnded || res.writableFinished;
  const markClientGone = () => {
    clientGone = true;
  };
  res.once('close', markClientGone);

  try {
    // The Edge websocket occasionally drops mid-stream / times out — retry on
    // a fresh connection. A per-attempt timeout fails fast instead of hanging.
    for (let attempt = 0; attempt < TTS_MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        // brief pause before retrying; synthesizeOnce creates a fresh instance
        await new Promise((r) => setTimeout(r, 500));
      }

      if (clientGone || res.destroyed || res.writableEnded) {
        throw Object.assign(new Error('TTS client disconnected'), { code: 'ECONNRESET' });
      }

      let session: TtsSession | null = null;
      const onClientGone = () => {
        clientGone = true;
        // Tear down whatever is mid-flight so the loop exits immediately.
        destroyTtsSession(session);
      };
      res.once('close', onClientGone);

      try {
        session = await withSynthesisTimeout(
          synthesizeOnce(text, voice, rate, pitch),
          TTS_SYNTHESIS_TIMEOUT_MS
        );

        if (clientGone || res.destroyed || res.writableEnded) {
          throw Object.assign(new Error('TTS client disconnected'), { code: 'ECONNRESET' });
        }

        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Cache-Control', 'no-store');

        await pipeAudioToResponse(session, res);
        return;
      } catch (err: any) {
        lastErr = err;
        const errCode = err?.cause?.code || err?.code;
        const destGone =
          clientGone ||
          res.destroyed ||
          res.writableEnded ||
          errCode === 'ERR_STREAM_UNABLE_TO_PIPE' ||
          errCode === 'ERR_STREAM_PREMATURE_CLOSE' ||
          errCode === 'ECONNRESET';
        if (destGone) {
          // Destination is dead — do NOT retry, otherwise every attempt
          // re-throws "Cannot pipe to a closed or destroyed stream".
          throw err;
        }
        if (res.headersSent) break;
        console.warn(
          `[TTS] attempt ${attempt + 1}/${TTS_MAX_ATTEMPTS} failed${errCode ? ` (${errCode})` : ''}:`,
          err?.message || err
        );
      } finally {
        // Release the session's WebSocket + stream whether we succeeded,
        // failed, timed out, or the client disconnected mid-pipe.
        res.removeListener('close', onClientGone);
        destroyTtsSession(session);
        session = null;
      }
    }
    throw lastErr;
  } finally {
    res.removeListener('close', markClientGone);
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

// Boot-time snapshot so a factory reset can restore .env-provided defaults
const BOOT_GROQ_API_KEY = process.env.GROQ_API_KEY || '';

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  app.use(express.json({ limit: '10mb' }));

  // Health check endpoint
  app.get('/api/health', async (req, res) => {
    const providers = getProviders();
    const anyUsable = providers.some((p) => p.key !== 'groq' || p.apiKey);
    res.json({
      status: 'ok',
      hasApiKey: anyUsable,
      providers: providers.map((p) => ({ key: p.key, label: p.label, baseUrl: p.baseUrl })),
      tts: { enabled: ttsEnabled(), voice: defaultTtsVoice() },
      time: new Date().toISOString(),
    });
  });

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

  // Runtime configuration from the settings UI
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
      providerCandidatesCache.clear();
      lastGoodModel.clear();
      modelCooldowns.clear();
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
      providerCandidatesCache.clear();
      lastGoodModel.clear();
      modelCooldowns.clear();
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

  // Neural TTS synthesis (Microsoft Edge Read Aloud voices)
  const handleTts = async (req: express.Request, res: express.Response) => {
    if (!ttsEnabled()) {
      return res.status(503).json({ success: false, error: 'TTS is disabled' });
    }
    try {
      const body = req.method === 'GET' ? (req.query as any) : req.body || {};
      const text = typeof body.text === 'string' ? body.text : '';
      if (!cleanTextForTts(text)) {
        return res.status(400).json({ success: false, error: 'text is required' });
      }
      const voice = sanitizeVoice(body.voice) || defaultTtsVoice();
      const rate = typeof body.rate === 'number' ? body.rate : undefined;
      const pitch = typeof body.pitch === 'number' ? body.pitch : undefined;
      await synthesizeToResponse(res, text, voice, rate, pitch);
    } catch (err: any) {
      const errCode = err?.cause?.code || err?.code;
      // Client aborts (a newer utterance superseded this one) are normal app
      // behaviour — don't log them as errors or try to respond to a dead socket.
      const quiet =
        res.destroyed ||
        res.writableEnded ||
        errCode === 'ECONNRESET' ||
        err?.message === 'TTS client disconnected';
      if (!quiet) {
        console.warn('[TTS] synthesis failed:', err?.message || err);
      }
      if (!res.headersSent) {
        if (quiet) {
          try { res.end(); } catch {}
        } else {
          res.status(502).json({ success: false, error: `TTS synthesis failed: ${err?.message || err}` });
        }
      } else {
        try { res.end(); } catch {}
      }
    }
  };

  app.post('/api/tts', handleTts);
  app.get('/api/tts', handleTts);

  app.get('/api/tts/voices', (req, res) => {
    res.json({ success: true, voices: TTS_VOICES, defaultVoice: defaultTtsVoice(), enabled: ttsEnabled() });
  });

  // Speech-to-text: Whisper (sherpa-onnx) primary, Web Speech API draft as fallback.
  app.post('/api/transcribe-audio', async (req, res) => {
    const { audioBase64 = '', mimeType = '', draftTranscript = '' } = req.body || {};

    // --- Whisper (sherpa-onnx) local offline STT ---
    if (whisperSTT && audioBase64 && audioBase64.length > 50) {
      try {
        const whisperText = await whisperSTT.transcribe(audioBase64, mimeType);
        const trimmed = (whisperText || '').trim();
        const words = trimmed.split(/\s+/).filter(Boolean);
        // tiny.en hallucinate classic phrases ("Thank you.", "Thanks for
        // watching!") on silence/room noise — require real multi-word output
        // before trusting it, otherwise the draft transcript stands
        const hallucination = /^(thank you\.?|thanks for watching!?|thank you for watching\.?|okay\.?|so\.?|alright\.?|bye\.?|yeah\.?|uh[- ]?huh\.?|mm[- ]?hmm\.?|uh\.?|um\.?)$/i;
        // Output consisting ONLY of chained filler words/punctuation is a
        // hallucination too ("Okay, so, um..."), not a real transcription.
        const fillerOnly = /^(?:(?:okay|so|um|uh|uhh|umm|er|ah|yeah|yep|yup|alright|thank you|thanks|bye|well)[\s,.!?-]*)+$/i;
        if (words.length >= 2 && !hallucination.test(trimmed) && !fillerOnly.test(trimmed)) {
          console.log(`[transcribe-audio] Whisper OK (${words.length} words, ${Math.round(audioBase64.length / 1024)}KB audio)`);
          return res.json({
            success: true,
            transcript: trimmed,
            source: 'whisper-local',
          });
        }
        // Diagnosable instead of silently swapped: show exactly what Whisper
        // produced and why the draft is being used instead.
        console.log(`[transcribe-audio] Whisper output rejected (${words.length} words): "${trimmed.slice(0, 120)}" — using Web Speech draft`);
      } catch (whisperErr: any) {
        console.warn('[transcribe-audio] Whisper failed, using draft fallback:', whisperErr?.message || whisperErr);
      }
    }

    // --- Fallback: Web Speech API draft ---
    return res.json({
      success: true,
      transcript: draftTranscript || '',
      source: 'webspeechapi-draft',
    });
  });

  // STT diagnostics: is the local Whisper engine operational right now?
  app.get('/api/stt/status', async (_req, res) => {
    const sttMod = whisperSTT as any;
    if (!sttMod?.getStatus) {
      return res.json({
        success: true,
        available: false,
        stt: null,
        error: 'stt-whisper module failed to load — check server startup logs',
      });
    }
    try {
      const status = await Promise.resolve(sttMod.getStatus());
      res.json({ success: true, available: true, stt: status });
    } catch (e: any) {
      res.json({ success: true, available: false, stt: null, error: e?.message || String(e) });
    }
  });

  // STT self-test: transcribes a bundled reference WAV through the real
  // recognizer and returns the recognized text (proves the whole chain works).
  app.post('/api/stt/test', async (_req, res) => {
    const sttMod = whisperSTT as any;
    if (!sttMod?.runSelfTest) {
      return res.status(503).json({
        success: false,
        ok: false,
        error: 'Whisper module not loaded — check server startup logs',
      });
    }
    try {
      const result = await Promise.resolve(sttMod.runSelfTest());
      res.json({ success: result.ok !== false, ...result });
    } catch (e: any) {
      res.json({ success: false, ok: false, error: e?.message || String(e) });
    }
  });

  // Diagnostic Speech Evaluation Endpoint
  app.post('/api/evaluate-speech', async (req, res) => {
    try {
      const { userProfile, responses, stats } = req.body;
      const pinnedProvider = (req.get('x-lumi-provider') || '').toLowerCase() || null;

      // Defense-in-depth: if the student said (almost) nothing across all
      // parts, do not ask the LLM to score silence — return an honest,
      // low-band evaluation instead of a fabricated one.
      const spokenWords = (responses || []).reduce(
        (sum: number, r: any) => sum + String(r?.transcript || '').trim().split(/\s+/).filter(Boolean).length,
        0
      );
      if (spokenWords < 5) {
        console.log(`[evaluate-speech] insufficient speech (${spokenWords} words) — returning no-speech evaluation`);
        return res.json({
          success: true,
          evaluation: generateNoSpeechEvaluation(userProfile),
          insufficientSpeech: true,
        });
      }

      // Deterministic full-coverage extraction: every meaningful sentence the
      // student actually spoke, grouped under its REAL IELTS part (1|2|3) —
      // Cambridge tests have several questions per part, so the position inside
      // the submitted array is never a proxy for the part number.
      const sentences = splitIntoSentences(responses || []);
      const responsesByPart = (responses || []).reduce(
        (acc: Record<number, any[]>, r: any, idx: number) => {
          const part = resolveResponsePart(r, idx);
          (acc[part] = acc[part] || []).push(r);
          return acc;
        },
        {}
      );
      // Compact transcript render: one line per question, no per-question
      // boilerplate (duration/word-count are derivable and duplicated in STATS)
      const transcriptsBlock = [1, 2, 3]
        .map((part) => {
          const items = responsesByPart[part] || [];
          if (!items.length) {
            return `[P${part}] (no answers)`;
          }
          return items
            .map((r: any) => `[P${part}] Q: "${r.question}"\nA: "${r.transcript || '(no speech)'}"`)
            .join('\n');
        })
        .join('\n');

      const prompt = `Evaluate this IELTS Speaking test (official criteria + CEFR A1-C2).

PROFILE: ${userProfile?.nickname || 'Learner'} | goal: ${userProfile?.goal || 'IELTS Speaking'} | audience: ${userProfile?.targetAudience || 'Examiners & Native Speakers'} | target: Band ${userProfile?.targetBand || '7.5'} | self: ${userProfile?.selfAssessedLevel || 'B1'} | focus: ${userProfile?.preferredFocus?.join(', ') || 'Fluency & Vocabulary'}

TRANSCRIPTS:
${transcriptsBlock}

STATS: ${stats?.totalWords || 120} words, ~${stats?.estimatedWPM || 110} wpm.

SCORING RULES:
1. overallCEFR ∈ [A1,A2,B1,B2,C1,C2]; predictedIeltsBand between 4.0 and 9.0.
2. Score from the transcript ONLY. Empty or near-empty parts get NO credit and pull the band toward 4.0; a near-empty test scores 4.0-5.0, never 7.0+, never the target band.
3. Pillars (fluency, lexical, grammar, pronunciation): score, cefr, 2-3 strengths, 2-3 growthAreas, 1-2 sentence examinerCommentary in Lumi's friendly-expert voice.
4. upgradedExpressions: [] (separate pass). pronunciationTips: [] (separate pass).
5. lessonRoadmap: exactly 4 modules targeting the student's errors and target band.`;

      const schemaHint = `{
  "overallCEFR": "A1|A2|B1|B2|C1|C2",
  "predictedIeltsBand": 6.5,
  "cefrDescriptor": "short label e.g. Upper Intermediate",
  "executiveSummary": "2-3 sentence warm assessment",
  "pillars": {
    "fluency": { "score": 6.5, "cefr": "B2", "strengths": ["..."], "growthAreas": ["..."], "examinerCommentary": "..." },
    "lexical": { "score": 6.5, "cefr": "B2", "strengths": ["..."], "growthAreas": ["..."], "examinerCommentary": "..." },
    "grammar": { "score": 6.5, "cefr": "B2", "strengths": ["..."], "growthAreas": ["..."], "examinerCommentary": "..." },
    "pronunciation": { "score": 6.5, "cefr": "B2", "strengths": ["..."], "growthAreas": ["..."], "examinerCommentary": "..." }
  },
  "upgradedExpressions": [],
  "pronunciationTips": [],
  "stats": { "totalWords": 145, "estimatedWPM": 115, "pauseFluencyRating": "Smooth|Moderate Pauses|Hesitant", "varietyRating": "High|Good|Repetitive" },
  "lessonRoadmap": [ { "id": "module-1", "title": "...", "level": "Band 7.0-8.5", "category": "Fluency|Vocabulary|Grammar|Part 2 Cue Card|Pronunciation|Examiner Strategy", "duration": "15 Mins", "description": "...", "objectives": ["..."], "practiceDrill": { "type": "rapid_fire|cue_card|lexical_boost|shadowing|mock_exam", "prompt": "...", "modelBand9Sample": "...", "tips": ["..."] } } ]
}
(lessonRoadmap: exactly 4 modules)`;

      // 4-module roadmap + 4 pillars need headroom; sentence count only adds minor output
      const maxTokens = Math.min(6000, 2400 + Math.ceil(sentences.length / 2) * 24);

      const { text, provider, model } = await callLLMWithCascade({
        systemInstruction: 'You are Lumi, an expert IELTS Speaking examiner.',
        userPrompt: prompt,
        json: true,
        jsonSchemaHint: schemaHint,
        temperature: 0.4,
        maxTokens,
        pinnedProvider,
      });

      const parsed = parseJsonLoose(text);
      if (!parsed || !parsed.pillars || !parsed.pillars.fluency) {
        throw new Error('LLM returned malformed evaluation JSON');
      }
      // Fill everything the model omitted (stats, pillars, band as number…)
      // so a truncated/rate-limited response can never blank the report
      normalizeEvaluationShape(parsed);

      // GUARANTEED-COVERAGE upgrade pass: always chunked, one call per
      // ≤12-sentence batch, with deterministic index/part stamping so every
      // spoken sentence gets exactly one upgrade regardless of model whims
      if (sentences.length > 0) {
        parsed.upgradedExpressions = [];
        const chunks: ExtractedSentence[][] = [];
        for (let i = 0; i < sentences.length; i += UPGRADE_CHUNK_SIZE) {
          chunks.push(sentences.slice(i, i + UPGRADE_CHUNK_SIZE));
        }
        for (const chunk of chunks) {
          try {
            const up = await callLLMWithCascade({
              systemInstruction: 'You are an elite IELTS Speaking examiner.',
              userPrompt: buildUpgradeChunkPrompt(chunk),
              json: true,
              jsonSchemaHint: UPGRADE_CHUNK_SCHEMA,
              temperature: 0.35,
              maxTokens: Math.min(3600, 300 + chunk.length * 200),
              pinnedProvider,
            });
            const upParsed = parseJsonLoose(up.text);
            let items: any[] = [];
            if (Array.isArray(upParsed?.upgradedExpressions)) items = upParsed.upgradedExpressions;
            else if (Array.isArray(upParsed)) items = upParsed;
            // Deterministic stamping by position — index/part are OUR truth
            items.forEach((u: any, i: number) => {
              const s = chunk[i];
              if (!s) return;
              u.index = s.index;
              u.part = s.part;
              if (!u.original) u.original = s.text;
            });
            parsed.upgradedExpressions.push(...items);
          } catch (chunkErr: any) {
            console.warn('[evaluate-speech] upgrade chunk failed:', chunkErr?.message || chunkErr);
          }
        }
        // Sort by sentence order for a clean report flow
        parsed.upgradedExpressions.sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0));
        console.log(`[evaluate-speech] guaranteed upgrades: ${parsed.upgradedExpressions.length}/${sentences.length} sentences`);
      }

      // Normalize arrays
      if (!Array.isArray(parsed.upgradedExpressions)) parsed.upgradedExpressions = [];
      if (!Array.isArray(parsed.pronunciationTips)) parsed.pronunciationTips = [];

      // GUARANTEED-COVERAGE pronunciation scan: one focused call PER PART so
      // every transcript gets fully scanned; results merged + deduped here
      {
        const mergedTips: any[] = [];
        const seenWords = new Set<string>();
        // Reject schema-placeholder echoes ("...", "/.../") and hollow entries
        const isValidTip = (t: any): boolean => {
          const w = String(t?.word || '').trim();
          return (
            w.length >= 2 &&
            /^[A-Za-z][A-Za-z'-]*$/.test(w) &&
            String(t?.ipa || '').includes('/') &&
            !String(t?.ipa || '').includes('...') &&
            String(t?.tip || '').length > 15 &&
            String(t?.exampleSentence || '').length > 15
          );
        };
        for (let i = 0; i < (responses?.length || 0); i++) {
          const transcript = String(responses[i]?.transcript || '').trim();
          const wordCount = transcript.split(/\s+/).filter(Boolean).length;
          if (!transcript || wordCount < 8) continue;
          let arr: any[] = [];
          // Up to 3 attempts when a scan returns nothing valid; escalate
          // temperature each try to break the model out of placeholder loops
          for (let attempt = 0; attempt < 3 && arr.filter(isValidTip).length === 0; attempt++) {
            try {
              const tp = await callLLMWithCascade({
                systemInstruction: 'You are a phonetics coach for IELTS candidates. Return real, concrete pronunciation data in valid JSON — never placeholders.',
                userPrompt: `Find words in this answer that B1-C1 IELTS learners often mispronounce (stress, vowel quality, silent letters, -ed/-s endings, th/v/w sounds).
For each: word (from the text only), ipa, phoneticSpelling, one-line tip, exampleSentence. Target 5-14 words.

Q: "${responses[i]?.question || ''}"
A: "${transcript}"`,
                json: true,
                jsonSchemaHint: `{
  "pronunciationTips": [ { "word": "mispronounced", "ipa": "/ˌmɪsprəˈnaʊnst/", "phoneticSpelling": "mis-pruh-NOWNST", "tip": "Stress the third syllable -NOWN.", "exampleSentence": "He often mispronounces technical terms." } ]
}`,
                temperature: 0.3 + attempt * 0.25,
                maxTokens: Math.min(2600, 500 + wordCount * 22),
                pinnedProvider,
              });
              const tParsed = parseJsonLoose(tp.text);
              arr = Array.isArray(tParsed?.pronunciationTips)
                ? tParsed.pronunciationTips
                : Array.isArray(tParsed)
                ? tParsed
                : [];
            } catch (tipErr: any) {
              console.warn(`[evaluate-speech] tip scan failed for real part ${resolveResponsePart(responses[i], i)}:`, tipErr?.message || tipErr);
            }
          }
          for (const t of arr) {
            if (!isValidTip(t)) continue;
            const key = String(t.word).toLowerCase().trim();
            if (seenWords.has(key)) continue;
            seenWords.add(key);
            t.part = resolveResponsePart(responses[i], i);
            mergedTips.push(t);
          }
        }
        if (mergedTips.length > 0) parsed.pronunciationTips = mergedTips;
        console.log(`[evaluate-speech] pronunciation scan: ${parsed.pronunciationTips.length} unique words`);
      }

      // Stamp tip parts from transcript lookup when missing
      if (parsed.pronunciationTips.length && responses?.length) {
        parsed.pronunciationTips.forEach((t: any) => {
          if (t.part !== undefined) return;
          const word = String(t.word || '').toLowerCase();
          for (let i = 0; i < responses.length; i++) {
            if ((responses[i]?.transcript || '').toLowerCase().includes(word)) {
              t.part = resolveResponsePart(responses[i], i);
              return;
            }
          }
        });
      }

      return res.json({ success: true, evaluation: parsed, provider, model });
    } catch (err: any) {
      console.error('Error evaluating speech:', err);
      const fallback = generateFallbackEvaluation(req.body?.userProfile, req.body?.responses, req.body?.stats);
      return res.json({ success: true, evaluation: fallback, error: err.message, isFallback: true });
    }
  });

  // Interview Practice Evaluation Endpoint (JSON-based questions + sample answers)
  app.post('/api/evaluate-practice', async (req, res) => {
    try {
      const { userProfile, topic, questions, stats } = req.body;
      const pinnedProvider = (req.get('x-lumi-provider') || '').toLowerCase() || null;

      const spokenWords = (questions || []).reduce(
        (sum: number, q: any) => sum + String(q?.userAnswer || '').trim().split(/\s+/).filter(Boolean).length,
        0
      );
      if (spokenWords < 5) {
        return res.json({
          success: true,
          evaluation: generateNoSpeechEvaluation(userProfile),
          insufficientSpeech: true,
        });
      }

      // Build sentences from user answers
      const allSentences: { index: number; question: string; userAnswer: string; sampleResponse: string }[] = [];
      let counter = 0;
      for (const q of (questions || [])) {
        const answer = String(q?.userAnswer || '').trim();
        if (!answer) continue;
        const sentences = answer
          .split(/(?<=[.!?])\s+/)
          .map((s: string) => s.trim().replace(/\s+/g, ' '))
          .filter((s: string) => s.split(/\s+/).filter(Boolean).length >= 4);
        for (const text of sentences) {
          counter++;
          allSentences.push({ index: counter, question: q.question, userAnswer: text, sampleResponse: q.response || '' });
        }
      }

      const prompt = `Evaluate this IELTS interview practice (official criteria + CEFR A1-C2).

PROFILE: ${userProfile?.nickname || 'Learner'} | goal: ${userProfile?.goal || 'IELTS Speaking'} | target: Band ${userProfile?.targetBand || '7.5'} | self: ${userProfile?.selfAssessedLevel || 'B1'}
TOPIC: ${topic || 'General'}

Q&A:
${(questions || []).map((q: any, i: number) => `[Q${i + 1}] Q: "${q.question}"\nA: "${q.userAnswer || '(no answer)'}"`).join('\n')}

STATS: ${stats?.totalWords || 0} words, ~${stats?.estimatedWPM || 0} wpm.

SCORING RULES:
1. overallCEFR ∈ [A1,A2,B1,B2,C1,C2]; predictedIeltsBand between 4.0 and 9.0.
2. Score from the ACTUAL answers ONLY; empty answers get NO credit.
3. Pillars (fluency, lexical, grammar, pronunciation): score, cefr, 2-3 strengths, 2-3 growthAreas, 1-2 sentence examinerCommentary.
4. upgradedExpressions: [] (built server-side from the model answer bank). pronunciationTips: [] (separate pass).
5. lessonRoadmap: exactly 4 modules targeting the student's errors and target band.`;

      const schemaHint = `{
  "overallCEFR": "A1|A2|B1|B2|C1|C2",
  "predictedIeltsBand": 6.5,
  "cefrDescriptor": "short label",
  "executiveSummary": "2-3 sentence warm assessment",
  "pillars": {
    "fluency": { "score": 6.5, "cefr": "B2", "strengths": ["..."], "growthAreas": ["..."], "examinerCommentary": "..." },
    "lexical": { "score": 6.5, "cefr": "B2", "strengths": ["..."], "growthAreas": ["..."], "examinerCommentary": "..." },
    "grammar": { "score": 6.5, "cefr": "B2", "strengths": ["..."], "growthAreas": ["..."], "examinerCommentary": "..." },
    "pronunciation": { "score": 6.5, "cefr": "B2", "strengths": ["..."], "growthAreas": ["..."], "examinerCommentary": "..." }
  },
  "upgradedExpressions": [],
  "pronunciationTips": [],
  "stats": { "totalWords": 100, "estimatedWPM": 110, "pauseFluencyRating": "Smooth|Moderate Pauses|Hesitant", "varietyRating": "High|Good|Repetitive" },
  "lessonRoadmap": [ { "id": "module-1", "title": "...", "level": "Band 7.0-8.5", "category": "Fluency|Vocabulary|Grammar|Part 2 Cue Card|Pronunciation|Examiner Strategy", "duration": "15 Mins", "description": "...", "objectives": ["..."], "practiceDrill": { "type": "rapid_fire|cue_card|lexical_boost|shadowing|mock_exam", "prompt": "...", "modelBand9Sample": "...", "tips": ["..."] } } ]
}
(lessonRoadmap: exactly 4 modules)`;

      // 4-module roadmap + 4 pillars need headroom; sentence count only adds minor output
      const maxTokens = Math.min(6000, 2400 + allSentences.length * 50);

      const { text, provider, model } = await callLLMWithCascade({
        systemInstruction: 'You are Lumi, an expert IELTS Speaking examiner.',
        userPrompt: prompt,
        json: true,
        jsonSchemaHint: schemaHint,
        temperature: 0.4,
        maxTokens,
        pinnedProvider,
      });

      const parsed = parseJsonLoose(text);
      if (!parsed || !parsed.pillars || !parsed.pillars.fluency) {
        throw new Error('LLM returned malformed evaluation JSON');
      }
      normalizeEvaluationShape(parsed);

      // Deterministic upgrade stamping: override LLM output with JSON model answers
      if (allSentences.length > 0) {
        parsed.upgradedExpressions = allSentences.map((s, i) => ({
          index: s.index,
          original: s.userAnswer,
          upgraded: s.sampleResponse || parsed.upgradedExpressions?.[i]?.upgraded || s.userAnswer,
          ieltsBand: parsed.upgradedExpressions?.[i]?.ieltsBand || 'Band 8.0',
          explanation: parsed.upgradedExpressions?.[i]?.explanation || 'Model answer comparison',
        }));
      }

      if (!Array.isArray(parsed.upgradedExpressions)) parsed.upgradedExpressions = [];
      if (!Array.isArray(parsed.pronunciationTips)) parsed.pronunciationTips = [];

      // Pronunciation scan per question with user answers
      {
        const mergedTips: any[] = [];
        const seenWords = new Set<string>();
        const isValidTip = (t: any): boolean => {
          const w = String(t?.word || '').trim();
          return (
            w.length >= 2 &&
            /^[A-Za-z][A-Za-z'-]*$/.test(w) &&
            String(t?.ipa || '').includes('/') &&
            !String(t?.ipa || '').includes('...') &&
            String(t?.tip || '').length > 15 &&
            String(t?.exampleSentence || '').length > 15
          );
        };

        for (const q of (questions || [])) {
          const transcript = String(q?.userAnswer || '').trim();
          const wordCount = transcript.split(/\s+/).filter(Boolean).length;
          if (!transcript || wordCount < 8) continue;
          let arr: any[] = [];
          for (let attempt = 0; attempt < 3 && arr.filter(isValidTip).length === 0; attempt++) {
            try {
              const tp = await callLLMWithCascade({
                systemInstruction: 'You are a phonetics coach for IELTS candidates. Return real, concrete pronunciation data in valid JSON — never placeholders.',
                userPrompt: `Find words in this answer that B1-C1 IELTS learners often mispronounce (stress, vowel quality, silent letters, -ed/-s endings, th/v/w sounds).
For each: word (from the text only), ipa, phoneticSpelling, one-line tip, exampleSentence. Target 5-14 words.

Q: "${q.question || ''}"
A: "${transcript}"`,
                json: true,
                jsonSchemaHint: `{
  "pronunciationTips": [ { "word": "example", "ipa": "/ɪɡˈzæmpəl/", "phoneticSpelling": "ig-ZAM-puhl", "tip": "Stress the second syllable.", "exampleSentence": "This is a great example." } ]
}`,
                temperature: 0.3 + attempt * 0.25,
                maxTokens: Math.min(2600, 500 + wordCount * 22),
                pinnedProvider,
              });
              const tParsed = parseJsonLoose(tp.text);
              arr = Array.isArray(tParsed?.pronunciationTips)
                ? tParsed.pronunciationTips
                : Array.isArray(tParsed)
                ? tParsed
                : [];
            } catch (tipErr: any) {
              console.warn(`[evaluate-practice] tip scan failed:`, tipErr?.message || tipErr);
            }
          }
          for (const t of arr) {
            if (!isValidTip(t)) continue;
            const key = String(t.word).toLowerCase().trim();
            if (seenWords.has(key)) continue;
            seenWords.add(key);
            mergedTips.push(t);
          }
        }
        if (mergedTips.length > 0) parsed.pronunciationTips = mergedTips;
      }

      return res.json({ success: true, evaluation: parsed, provider, model });
    } catch (err: any) {
      console.error('Error in practice evaluation:', err);
      const fallback = generateFallbackEvaluation(req.body?.userProfile, (req.body?.questions || []).map((q: any) => ({ transcript: q.userAnswer, question: q.question, partTitle: 'Interview', topic: req.body?.topic })), req.body?.stats);
      return res.json({ success: true, evaluation: fallback, error: err.message, isFallback: true });
    }
  });

  // Interactive Lumi Chat / IELTS Speaking Session Endpoint
  app.post('/api/lumi-chat', async (req, res) => {
    try {
      const { userProfile, evaluation, conversationHistory, message, mode } = req.body;
      const pinnedProvider = (req.get('x-lumi-provider') || '').toLowerCase() || null;

      const isCasualMode = mode === 'Casual Chat';

      const prompt = isCasualMode
        ? `Casual conversation with Lumi, a close friend.

FRIEND: ${userProfile?.nickname || 'friend'} | they enjoy: ${userProfile?.preferredFocus?.join(', ') || 'everyday life topics'} | their goal: ${userProfile?.goal || 'general conversation'}

CHAT (last 6):
${conversationHistory?.slice(-6).map((msg: any) => `${msg.sender === 'user' ? 'User' : 'Lumi'}: ${msg.text}`).join('\n')}

LATEST USER: "${message}"

TASK:
- Reply in 2-3 compact, mid-length sentences — warm and natural, like a friend
  texting back. Never one-word answers, never long lectures or bullet points.
- Use their nickname naturally, react to what THEY just said, and ask ONE easy follow-up question about their life, mood, or day.
- Follow their lead: if they bring up a topic, stay on it and be curious. Never force a topic.
- mood describes Lumi RIGHT AFTER her reply: 'speaking' normally, 'encouraging' if the user shared something difficult, 'celebrating' for good news. NEVER use 'listening' — that state is reserved for when the user's microphone is recording.
- IMPORTANT — English rephrasing is allowed ONLY when they make an obvious grammatical slip, and ONLY as a gentle, in-line reflection (e.g. "Oh nice, so you're really into hiking? Tell me more!") — never label it, never say "actually", never grade, never call it a correction. If their English is fine, say nothing about language.
- You are a FRIEND, not a tutor or examiner. Never talk about IELTS, band scores, grading, practice, exams, or language learning UNLESS the user brings it up first. If they ask a test question, act like a curious friend, not a judge.`
        : `Live IELTS speaking session.

USER: ${userProfile?.nickname || 'Learner'} | ${userProfile?.goal || 'IELTS Speaking'} | target Band ${userProfile?.targetBand || '7.5'} | current ${evaluation?.overallCEFR || 'B2'} (${evaluation?.predictedIeltsBand || '6.5'}) | mode: ${mode || 'IELTS Mock Practice'}

CHAT (last 6):
${conversationHistory?.slice(-6).map((msg: any) => `${msg.sender === 'user' ? 'User' : 'Lumi'}: ${msg.text}`).join('\n')}

LATEST USER: "${message}"

TASK:
- Reply in 2-4 sentences, warm and natural.
- Ask a short IELTS Part 1/2/3-style follow-up.
- mood describes Lumi RIGHT AFTER her reply: 'speaking' normally, 'encouraging' if the user shared something difficult, 'celebrating' for good news. NEVER use 'listening' — that state is reserved for when the user's microphone is recording.
- feedback: correctedSentence (Band 8+ phrasing), 2-3 lexicalBoost items, 1 ieltsTip.`;

      const schemaHint = isCasualMode
        ? `{
  "replyText": "Lumi's friendly reply (2-3 compact, mid-length sentences)",
  "mood": "speaking|encouraging|celebrating"
}`
        : `{
  "replyText": "Lumi's reply (2-4 sentences)",
  "mood": "speaking|encouraging|celebrating",
  "feedback": { "correctedSentence": "...", "lexicalBoost": ["...", "..."], "ieltsTip": "..." }
}`;

      const { text, provider, model } = await callLLM({
        systemInstruction: isCasualMode
          ? 'You are Lumi, a warm, curious, genuinely human friend. Keep replies short and natural, talk like a real person — casual tone, light humour, real curiosity about their life. Never sound like a tutor, coach, or examiner.'
          : 'You are Lumi, a charismatic, encouraging AI IELTS tutor. Keep replies concise, natural, and pedagogically rich.',
        userPrompt: prompt,
        json: true,
        jsonSchemaHint: schemaHint,
        temperature: 0.8,
        pinnedProvider,
      });

      const parsed = parseJsonLoose(text);
      if (!parsed || !parsed.replyText) {
        throw new Error('LLM returned malformed chat JSON');
      }
      return res.json({ success: true, reply: parsed, provider, model });
    } catch (err: any) {
      console.warn('Notice in Lumi chat endpoint fallback:', err?.message || err);
      const fallbackReply = generateFallbackChatResponse(req.body?.userProfile, req.body?.message, req.body?.mode);
      return res.json({ success: true, reply: fallbackReply, error: err.message });
    }
  });

  // Drill / Lesson Generator Endpoint
  app.post('/api/generate-lesson-drill', async (req, res) => {
    try {
      const { userProfile, lessonModule } = req.body || {};
      const pinnedProvider = (req.get('x-lumi-provider') || '').toLowerCase() || null;

      const prompt = `Make a 3-step IELTS speaking drill for ${userProfile?.nickname || 'Learner'} (target Band ${userProfile?.targetBand || '7.5'}).
Lesson: ${lessonModule?.title} | Category: ${lessonModule?.category} | ${lessonModule?.description}`;

      const schemaHint = `{
  "warmupQuestion": "an easy opener question on the lesson topic",
  "keyVocabulary": ["4-6 band 8+ words/phrases with short glosses"],
  "challengeQuestion": "a harder IELTS-style challenge question",
  "band9Guidance": "how a band 9 answer would be structured"
}`;

      const { text, provider, model } = await callLLM({
        userPrompt: prompt,
        json: true,
        jsonSchemaHint: schemaHint,
        temperature: 0.7,
        pinnedProvider,
      });

      const parsed = parseJsonLoose(text);
      if (!parsed || !parsed.warmupQuestion) {
        throw new Error('LLM returned malformed drill JSON');
      }
      return res.json({ success: true, drill: parsed, provider, model });
    } catch (err: any) {
      console.warn('Notice in generate-lesson-drill fallback:', err?.message || err);
      return res.json({
        success: true,
        drill: {
          warmupQuestion: `Let's focus on ${req.body?.lessonModule?.title || 'English fluency'}. Share your thoughts in 30 seconds.`,
          keyVocabulary: ['Pivotal', 'Substantiate', 'Remarkable', 'In essence'],
          challengeQuestion: `How would you articulate your perspective on ${req.body?.lessonModule?.category || 'this topic'} using advanced discourse markers?`,
          band9Guidance: 'Begin with a clear thesis, elaborate with relevant evidence, and conclude with an impactful summary.',
        },
      });
    }
  });

  // Factory reset: delete persisted settings and restore boot defaults.
  // The client separately wipes all localStorage keys (lumi_*) and reloads,
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
      process.env.GROQ_API_KEY = BOOT_GROQ_API_KEY;
      providerCandidatesCache.clear();
      lastGoodModel.clear();
      modelCooldowns.clear();
      res.json({ success: true, message: 'All settings restored to defaults' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'reset failed' });
    }
  });

  // Vite integration
  let viteInstance: Awaited<ReturnType<typeof createViteServer>> | null = null;
  if (process.env.NODE_ENV !== 'production') {
    viteInstance = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(viteInstance.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    const providers = getProviders()
      .map((p) => `${p.key}(${p.baseUrl})`)
      .join(' -> ');
    const effectiveAuto = getProviders()
      .filter((p) => !EXCLUDED_FROM_AUTO_CASCADE.has(p.key))
      .map((p) => p.key)
      .join(' -> ');
    console.log(`Lumi — Your IELTS Tutor server running on http://localhost:${PORT}`);
    console.log(`(also reachable on your LAN at http://<your-ip>:${PORT})`);
    console.log(`LLM provider cascade: ${providers}`);
    console.log(`Auto cascade (no pin): ${effectiveAuto} — ollama only when explicitly selected`);
    console.log(`Neural TTS: ${ttsEnabled() ? `enabled, voice ${defaultTtsVoice()}` : 'disabled'}`);
  });

  // Track every open connection so shutdown can release the port immediately
  const openSockets = new Set<Socket>();
  server.on('connection', (socket) => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\nPort ${PORT} is already in use — stop the other instance first:`);
      console.error(`  fuser -k ${PORT}/tcp        # force-free the port`);
      console.error(`  kill $(lsof -t -i:${PORT})  # or stop it by PID\n`);
      process.exit(1);
    }
    throw err;
  });

  // Graceful shutdown: Ctrl+C / stop / terminal close frees port ${PORT} instantly
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received — stopping Lumi and releasing port ${PORT}…`);
    try {
      void viteInstance?.close();
    } catch (e) {}
    for (const socket of openSockets) socket.destroy();
    server.close(() => {
      console.log('Lumi stopped — port released.');
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
  process.on('message', (msg: any) => {
    if (msg === 'shutdown') shutdown('SIGTERM');
  });

  // If the launcher (npm/sh) died without signalling us, we are an orphan
  // reparented to init — stop on our own so port ${PORT} is never left bound
  setInterval(() => {
    if (process.ppid === 1 && !shuttingDown) shutdown('orphan-watchdog');
  }, 5000).unref();
}

// Honest evaluation for a diagnostic with (almost) no speech captured.
// Never invented content: states plainly that nothing could be scored.
function generateNoSpeechEvaluation(userProfile: any) {
  const nickname = userProfile?.nickname || 'Learner';
  const noSpeechPillar = (label: string) => ({
    score: 4.0,
    cefr: 'A2',
    strengths: ['You completed the diagnostic flow and used the recording tools'],
    growthAreas: [
      'Speak for the full time on every part — silence cannot be scored',
      'Answer Part 1 with 3-5 sentences about familiar topics',
      'Use the Part 2 prep minute to jot ideas, then talk continuously'
    ],
    examinerCommentary: `${label}: no measurable speech was captured for this criterion. Retake the diagnostic and answer out loud so Lumi has real language to assess.`,
  });

  return {
    overallCEFR: 'A2',
    predictedIeltsBand: 4.0,
    cefrDescriptor: 'Insufficient Speech Sample — No Score',
    executiveSummary: `${nickname}, I couldn't hear enough speech to assess your English — all three parts came through empty or nearly empty. Nothing was scored here; this is not a reflection of your ability. Retake the diagnostic, speak loudly into the microphone, and answer each part for its full time. Lumi will then give you a real, meaningful band.`,
    pillars: {
      fluency: noSpeechPillar('Fluency'),
      lexical: noSpeechPillar('Lexical Resource'),
      grammar: noSpeechPillar('Grammar'),
      pronunciation: noSpeechPillar('Pronunciation'),
    },
    upgradedExpressions: [],
    pronunciationTips: [],
    stats: {
      totalWords: 0,
      estimatedWPM: 0,
      pauseFluencyRating: 'Hesitant' as const,
      varietyRating: 'Repetitive' as const,
    },
    lessonRoadmap: [],
  };
}

function generateFallbackEvaluation(userProfile: any, responses: any[], stats: any) {
  const nickname = userProfile?.nickname || 'Learner';
  const targetBand = parseFloat(userProfile?.targetBand || '7.0') || 7.0;
  const selfLevel = userProfile?.selfAssessedLevel || 'B2';

  let overallCEFR = 'B2';
  let predictedBand = 6.5;
  if (selfLevel.includes('A1') || selfLevel.includes('A2')) {
    overallCEFR = 'A2';
    predictedBand = 5.0;
  } else if (selfLevel.includes('B1')) {
    overallCEFR = 'B1';
    predictedBand = 5.5;
  } else if (selfLevel.includes('C1') || selfLevel.includes('C2')) {
    overallCEFR = 'C1';
    predictedBand = 7.5;
  }

  return {
    overallCEFR,
    predictedIeltsBand: predictedBand,
    cefrDescriptor: overallCEFR === 'C1' ? 'Effective Operational Proficiency' : overallCEFR === 'B2' ? 'Independent Fluency with Strong Foundations' : 'Developing Conversational Competence',
    executiveSummary: `Great effort, ${nickname}! Lumi has carefully analyzed your spoken responses across all three diagnostic tasks. You demonstrate clear ideas and good communicative intent. To push towards your target of Band ${targetBand}, our focus will be expanding idiomatic collocations and using sophisticated discourse markers to eliminate hesitation in Part 2 and Part 3.`,
    pillars: {
      fluency: {
        score: predictedBand - 0.5 > 4.5 ? predictedBand - 0.5 : 5.0,
        cefr: overallCEFR,
        strengths: [
          'Willingness to speak at reasonable length on familiar topics',
          'Good turn-taking and responsive cadence',
          'Basic sequencing connectors (and, because, so) used reliably'
        ],
        growthAreas: [
          'Reduce mid-sentence filler pauses ("um", "like")',
          'Use advanced cohesive devices (subsequently, conversely, in hindsight)',
          'Maintain momentum during Part 2 2-minute long turns'
        ],
        examinerCommentary: `You speak with genuine enthusiasm, ${nickname}. With targeted pacing drills, you will transition from simple sentence linking to effortless rhythmic flow.`
      },
      lexical: {
        score: predictedBand,
        cefr: overallCEFR,
        strengths: [
          'Clear topic-related vocabulary used accurately',
          'Good ability to paraphrase when reaching for specific terms',
          'Comfortable everyday idiomatic expressions'
        ],
        growthAreas: [
          'Replace generic adjectives (good, bad, nice) with precise Band 8+ terms',
          'Incorporate collocations (e.g. "heavily reliant on", "deep-seated passion")',
          'Demonstrate flexible nuance on abstract societal topics'
        ],
        examinerCommentary: 'Your vocabulary is communicative and clear. Upgrading your adjective and verb precision will quickly unlock higher IELTS band descriptors.'
      },
      grammar: {
        score: predictedBand,
        cefr: overallCEFR,
        strengths: [
          'Frequent error-free simple and compound sentences',
          'Good control of basic present and past tense structures',
          'Intelligible clause connections'
        ],
        growthAreas: [
          'Introduce mixed conditionals and speculative structures ("Had I known...", "It is likely that...")',
          'Watch subject-verb agreement under speaking pressure',
          'Use passive voice and relative clauses for academic balance'
        ],
        examinerCommentary: 'Solid structural foundation! We will introduce high-scoring modal and conditional frameworks in our upcoming practice sessions.'
      },
      pronunciation: {
        score: predictedBand + 0.5 <= 9.0 ? predictedBand + 0.5 : predictedBand,
        cefr: overallCEFR,
        strengths: [
          'Clear overall vocal clarity and audible speech volume',
          'Good basic syllable stress on common multisyllabic words',
          'Engaging friendly vocal pitch'
        ],
        growthAreas: [
          'Master sentence stress to highlight focal keywords',
          'Practice connected speech (linking consonant to vowel sounds)',
          'Intonation modulation at the end of statements vs questions'
        ],
        examinerCommentary: 'Your voice is easy to understand. Refining your cadence and connected speech will give you that natural, confident native-like flair.'
      }
    },
    upgradedExpressions: [
      {
        original: "I like living in my city because it has many shops and good things to do.",
        upgraded: "What captivates me most about my hometown is its vibrant cosmopolitan atmosphere paired with an abundance of recreational amenities.",
        ieltsBand: "Band 8.5",
        part: 1,
        explanation: "Replaces generic 'like' and 'good things' with high-level lexical items ('captivates', 'cosmopolitan atmosphere', 'recreational amenities') and an emphatic cleft sentence."
      },
      {
        original: "I want to achieve this goal for a very long time since I was young.",
        upgraded: "Pursuing this ambition has been a longstanding aspiration of mine ever since my formative years.",
        ieltsBand: "Band 8.0",
        part: 1,
        explanation: "Corrects the tense structure while introducing academic phrases ('longstanding aspiration', 'formative years') that examiners look for in Part 2."
      },
      {
        original: "Technology makes young people feel stressed because they always compare with others on phone.",
        upgraded: "The omnipresence of digital media inadvertently fosters unprecedented social comparison, often exerting psychological pressure on youth.",
        ieltsBand: "Band 9.0",
        part: 1,
        explanation: "Transforms conversational phrasing into an analytical, objective viewpoint suited for top-tier IELTS Part 3 evaluation."
      }
    ],
    pronunciationTips: [
      {
        word: "Cosmopolitan",
        ipa: "/ˌkɒzməˈpɒlɪtən/",
        phoneticSpelling: "koz-muh-POL-uh-tuhn",
        tip: "Place primary stress firmly on the third syllable 'POL'. Keep the vowel crisp.",
        exampleSentence: "She grew up in a cosmopolitan metropolis filled with diverse cultures.",
        part: 1,
      },
      {
        word: "Aspiration",
        ipa: "/ˌæspəˈreɪʃən/",
        phoneticSpelling: "as-puh-RAY-shun",
        tip: "Primary stress on 'RAY'. Glide smoothly from 'puh' to 'RAY-shun'.",
        exampleSentence: "My primary aspiration is to excel in international research.",
        part: 1,
      },
      {
        word: "Omnipresence",
        ipa: "/ˌɒmnɪˈprezəns/",
        phoneticSpelling: "om-ni-PREZ-uhns",
        tip: "Stress the 'PREZ' syllable, keeping the 'om-ni' light and rhythmic.",
        exampleSentence: "The omnipresence of smart devices has reshaped modern habits.",
        part: 1,
      }
    ],
    stats: {
      totalWords: stats?.totalWords || 145,
      estimatedWPM: stats?.estimatedWPM || 115,
      pauseFluencyRating: 'Moderate Pauses' as const,
      varietyRating: 'Good' as const,
    },
    lessonRoadmap: [
      {
        id: 'module-1',
        title: 'Mastering Band 8+ Cohesive Discourse Markers',
        level: 'Band 7.0 - 8.5',
        category: 'Fluency' as const,
        duration: '15 Mins',
        description: 'Learn seamless transitions like "Having said that", "In retrospect", and "From an empirical standpoint" to glide between points without pausing.',
        objectives: [
          'Eliminate "um", "you know", and awkward silences',
          'Master 10 examiner-approved linking structures',
          'Practice 30-second continuous transitions'
        ],
        practiceDrill: {
          type: 'rapid_fire',
          prompt: 'Answer the question: "Do people in your country prefer living in urban centers or rural towns?" using at least two advanced contrast connectors.',
          modelBand9Sample: 'Broadly speaking, there is a pronounced generational divide. Whereas the younger demographic gravitates toward metropolitan hubs for career acceleration, older generations predominantly seek the tranquility of countryside retreats. In essence, it hinges entirely on one’s phase in life.',
          tips: ['Use "Broadly speaking" to initiate', 'Contribute contrast with "Whereas"', 'Summarize with "In essence"']
        }
      },
      {
        id: 'module-2',
        title: 'IELTS Part 2 Cue Card: The 3-Act Storytelling Formula',
        level: 'Band 7.5+',
        category: 'Part 2 Cue Card' as const,
        duration: '20 Mins',
        description: 'Structure your 2-minute long turn into Setup, Climax/Conflict, and Reflection so you never run out of ideas before the timer rings.',
        objectives: [
          'Organize bullet points using the 1-minute prep window',
          'Use evocative sensory and descriptive adjectives',
          'Deliver an impactful closing personal reflection'
        ],
        practiceDrill: {
          type: 'cue_card',
          prompt: 'Describe a memorable journey or adventure you embarked upon with close companions.',
          modelBand9Sample: 'If I were to recount one particularly unforgettable expedition, it would unquestionably be our trek across the northern highlands two summers ago. Initially, we were met with torrential downpours; however, the breathtaking panoramic vista at the summit made every ounce of adversity utterly worthwhile.',
          tips: ['Start with conditional framing: "If I were to recount..."', 'Inject emotional nuance ("utterly worthwhile")']
        }
      },
      {
        id: 'module-3',
        title: 'Lexical Booster: High-Scoring Idiomatic Collocations',
        level: 'Band 8.0+',
        category: 'Vocabulary' as const,
        duration: '15 Mins',
        description: 'Upgrade common everyday expressions into natural, precise native collocations that demonstrate authentic Lexical Resource.',
        objectives: [
          'Replace 15 basic phrases with high-impact collocations',
          'Learn natural academic register for societal discussions',
          'Avoid forced idioms that sound unnatural'
        ],
        practiceDrill: {
          type: 'lexical_boost',
          prompt: 'Express your opinion on whether remote work will completely replace traditional offices.',
          modelBand9Sample: 'While remote employment offers unparalleled flexibility, I contend that physical offices remain indispensable for fostering spontaneous collaboration and cultivating genuine team synergy.',
          tips: ['Pair "unparalleled" with "flexibility"', 'Use "indispensable" instead of "very necessary"']
        }
      },
      {
        id: 'module-4',
        title: 'Part 3 Abstract Analytical Thinking & Speculation',
        level: 'Band 8.5+',
        category: 'Examiner Strategy' as const,
        duration: '25 Mins',
        description: 'Tackle tough philosophical and societal examiner questions with structured nuance, hypothesizing, and international comparisons.',
        objectives: [
          'Adopt the "Perspective - Evidence - Counterargument" paradigm',
          'Use tentative language ("It is plausible that...", "One could argue...")',
          'Impress examiners with macro-level sociological perspectives'
        ],
        practiceDrill: {
          type: 'mock_exam',
          prompt: 'To what extent does artificial intelligence pose a threat to human creativity in artistic fields?',
          modelBand9Sample: 'That is an intriguing dilemma. On one hand, generative algorithms can synthesize imagery and prose at astonishing velocity. Yet, on a deeper level, genuine art stems from lived human vulnerability and existential consciousness—qualities that no algorithmic architecture can authentically replicate.',
          tips: ['Acknowledge the complexity upfront ("That is an intriguing dilemma")', 'Differentiate technical generation from human consciousness']
        }
      }
    ]
  };
}

function generateFallbackChatResponse(userProfile: any, message: string, mode: string) {
  const nickname = userProfile?.nickname || 'friend';
  const cleanMsg = (message || '').toLowerCase();

  // Casual Chat: always reply as a warm human friend — no grading, no IELTS.
  if (mode === 'Casual Chat') {
    if (cleanMsg.includes('hello') || cleanMsg.includes('hi') || cleanMsg.includes('hey') || cleanMsg.includes('good morning') || cleanMsg.includes('good afternoon')) {
      return {
        replyText: casualGreetingReply(nickname),
        mood: 'greeting',
      };
    }
    // Gentle, natural in-line rephrase when there's an obvious grammatical slip.
    const rephrased =
      /(?:i am go(?:ing|es)|i has|i likes|she go|he go|they is|i no (?:want|like|know)|i am very like)/i.test(cleanMsg)
        ? `Oh nice, so you really enjoy ${cleanMsg.replace(/^(?:i|i am|i'm)\s+(?:really\s+|very\s+|so\s+|too\s+)?(?:am\s+|is\s+|are\s+)?/, '').replace(/^(?:very|really|so|too)\s+/i, '').slice(0, 60)} — tell me more about that!`
        : null;
    return {
      replyText: rephrased || `That sounds really interesting, ${nickname}! What happened next?`,
      mood: 'speaking',
    };
  }

  if (cleanMsg.includes('hello') || cleanMsg.includes('hi') || cleanMsg.includes('hey')) {
    return {
      replyText: tutorGreetingReply(nickname),
      mood: 'greeting',
      feedback: {
        correctedSentence: `Hi Lumi, it's a pleasure to connect with you today.`,
        lexicalBoost: ['Pleasure to connect', 'Delighted to practice', 'Hit the ground running'],
        ieltsTip: 'Start your speaking responses with warmth and confident vocal projection.'
      }
    };
  }

  return {
    replyText: `That is a thoughtful perspective, ${nickname}! Expanding on that, how do you think that situation will evolve over the next ten years?`,
    mood: 'speaking',
    feedback: {
      correctedSentence: message ? `In my perspective, ${message.replace(/^i think/i, '').trim()}.` : 'I firmly believe that this trend will continue to shape our future.',
      lexicalBoost: ['In my perspective', 'Exponential growth', 'Transformative impact'],
      ieltsTip: 'Try using hypothetical structures like "If this trend persists, we might witness..." to score Band 8+.'
    }
  };
}

startServer();
