import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

// Load .env FIRST (before any module reads process.env at import time).
dotenv.config();

// Writable data root. Defaults to the working directory, which keeps
// `npm run dev` / `npm start` behaving exactly as before. The desktop shell
// (electron/main.cjs) points SEREN_DATA_DIR at the OS app-data folder
// (e.g. ~/.config/Seren) because a packaged app bundle is read-only — settings
// containing API keys must never be written inside the installed app.
export const DATA_DIR = process.env.SEREN_DATA_DIR || process.cwd();

export const SETTINGS_FILE = path.join(DATA_DIR, 'seren-settings.json');

// ---------------------------------------------------------------------------
// Durable settings: survive server restarts (API keys, models, voice, pinning)
// ---------------------------------------------------------------------------

export interface StoredSettings {
  groqApiKey?: string;
  assemblyAiApiKey?: string;
  deepgramApiKey?: string;
  sttEngine?: string | null;
  sttModels?: Record<string, string>;
  pinnedProvider?: string | null;
  modelOverrides?: Record<string, string>;
  ttsVoice?: string;
  ttsEnabled?: boolean;
  endpoints?: Record<string, { baseUrl?: string; apiKey?: string }>;
}

function readSettingsFile(file: string): StoredSettings | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) || null;
  } catch {
    return null;
  }
}

export function loadStoredSettings(): StoredSettings {
  return readSettingsFile(SETTINGS_FILE) ?? {};
}

export function saveStoredSettings(settings: StoredSettings): void {
  try {
    // The data root may not exist yet on a fresh desktop install.
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (e: any) {
    console.warn('[settings] Could not persist settings:', e?.message || e);
  }
}

// ---------------------------------------------------------------------------
// Runtime configuration (can be overridden at runtime via /api/providers/configure)
// ---------------------------------------------------------------------------
export const STT_ENGINES = ['local', 'groq', 'assemblyai', 'deepgram'] as const;
export type SttEngine = (typeof STT_ENGINES)[number];

export const GROQ_STT_MODELS = [
  'whisper-large-v3-turbo',
  'whisper-large-v3',
  'distil-whisper-large-v3-en',
] as const;

export const ASSEMBLYAI_SPEECH_MODELS = ['universal-3-5-pro', 'universal-3-pro', 'universal-2'] as const;

export const DEEPGRAM_STT_MODELS = ['nova-3', 'nova-2', 'whisper-large-v3'] as const;

export const runtimeConfig: {
  pinnedProvider: string | null;
  ttsEnabled: boolean | null;
  ttsVoice: string | null;
  modelOverrides: Record<string, string>;
  endpoints: Record<string, { baseUrl?: string; apiKey?: string }>;
  sttEngine: SttEngine | null;
  sttModels: Record<string, string>;
} = {
  pinnedProvider: null,
  ttsEnabled: null,
  ttsVoice: null,
  modelOverrides: {},
  endpoints: {},
  sttEngine: null,
  sttModels: {},
};

// Boot-time snapshot so a factory reset can restore .env-provided defaults
export const BOOT_GROQ_API_KEY = process.env.GROQ_API_KEY || '';
export const BOOT_ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY || '';
export const BOOT_DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || '';
export const BOOT_STT_ENGINE = process.env.STT_ENGINE || '';

// Restore saved preferences on boot (file values win over .env defaults)
{
  const stored = loadStoredSettings();
  if (stored.groqApiKey) process.env.GROQ_API_KEY = stored.groqApiKey;
  if (stored.assemblyAiApiKey) process.env.ASSEMBLYAI_API_KEY = stored.assemblyAiApiKey;
  if (stored.deepgramApiKey) process.env.DEEPGRAM_API_KEY = stored.deepgramApiKey;
  if (stored.sttEngine !== undefined)
    runtimeConfig.sttEngine = STT_ENGINES.includes(stored.sttEngine as SttEngine)
      ? (stored.sttEngine as SttEngine)
      : null;
  else if (BOOT_STT_ENGINE && STT_ENGINES.includes(BOOT_STT_ENGINE as SttEngine))
    runtimeConfig.sttEngine = BOOT_STT_ENGINE as SttEngine;
  if (stored.sttModels) runtimeConfig.sttModels = stored.sttModels;
  if (stored.pinnedProvider !== undefined) runtimeConfig.pinnedProvider = stored.pinnedProvider;
  if (stored.modelOverrides) runtimeConfig.modelOverrides = stored.modelOverrides;
  if (stored.ttsVoice) runtimeConfig.ttsVoice = stored.ttsVoice;
  if (stored.ttsEnabled !== undefined) runtimeConfig.ttsEnabled = stored.ttsEnabled;
  if (stored.endpoints) runtimeConfig.endpoints = stored.endpoints;
}

export function sttEngine(): SttEngine {
  if (runtimeConfig.sttEngine && STT_ENGINES.includes(runtimeConfig.sttEngine)) {
    return runtimeConfig.sttEngine;
  }
  const env = (process.env.STT_ENGINE || '').trim().toLowerCase();
  if (STT_ENGINES.includes(env as SttEngine)) return env as SttEngine;
  return 'local';
}

export function sttModelFor(engine: SttEngine): string {
  const override = runtimeConfig.sttModels[engine];
  if (override && override.trim()) {
    const clean = override.trim();
    if (engine === 'groq' && !(GROQ_STT_MODELS as readonly string[]).includes(clean)) {
      delete runtimeConfig.sttModels[engine];
    } else if (engine === 'assemblyai' && !(ASSEMBLYAI_SPEECH_MODELS as readonly string[]).includes(clean)) {
      delete runtimeConfig.sttModels[engine];
    } else if (engine === 'deepgram' && !(DEEPGRAM_STT_MODELS as readonly string[]).includes(clean)) {
      delete runtimeConfig.sttModels[engine];
    } else {
      return clean;
    }
  }
  if (engine === 'groq') {
    return process.env.GROQ_STT_MODEL?.trim() || GROQ_STT_MODELS[0];
  }
  if (engine === 'assemblyai') {
    return process.env.ASSEMBLYAI_SPEECH_MODEL?.trim() || ASSEMBLYAI_SPEECH_MODELS[0];
  }
  if (engine === 'deepgram') {
    return process.env.DEEPGRAM_STT_MODEL?.trim() || DEEPGRAM_STT_MODELS[0];
  }
  return 'whisper-base.en-local';
}

export function groqSttApiKey(): string {
  // Groq cloud LLM and STT share one Groq API key, so the selected engine can
  // reuse the existing key stored for chat responses.
  return process.env.GROQ_API_KEY || '';
}

export function assemblyAiApiKey(): string {
  return process.env.ASSEMBLYAI_API_KEY || '';
}

export function deepgramApiKey(): string {
  return process.env.DEEPGRAM_API_KEY || '';
}

export function ttsEnabled(): boolean {
  if (runtimeConfig.ttsEnabled !== null) return runtimeConfig.ttsEnabled;
  return (process.env.TTS_ENABLED || 'true').toLowerCase() !== 'false';
}
