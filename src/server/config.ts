import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

// Load .env FIRST (before any module reads process.env at import time).
dotenv.config();

export const SETTINGS_FILE = path.join(process.cwd(), 'lumi-settings.json');

// ---------------------------------------------------------------------------
// Durable settings: survive server restarts (API keys, models, voice, pinning)
// ---------------------------------------------------------------------------

export interface StoredSettings {
  groqApiKey?: string;
  pinnedProvider?: string | null;
  modelOverrides?: Record<string, string>;
  ttsVoice?: string;
  ttsEnabled?: boolean;
  endpoints?: Record<string, { baseUrl?: string; apiKey?: string }>;
}

export function loadStoredSettings(): StoredSettings {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

export function saveStoredSettings(settings: StoredSettings): void {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (e: any) {
    console.warn('[settings] Could not persist settings:', e?.message || e);
  }
}

// ---------------------------------------------------------------------------
// Runtime configuration (can be overridden at runtime via /api/providers/configure)
// ---------------------------------------------------------------------------
export const runtimeConfig: {
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

// Boot-time snapshot so a factory reset can restore .env-provided defaults
export const BOOT_GROQ_API_KEY = process.env.GROQ_API_KEY || '';

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

export function ttsEnabled(): boolean {
  if (runtimeConfig.ttsEnabled !== null) return runtimeConfig.ttsEnabled;
  return (process.env.TTS_ENABLED || 'true').toLowerCase() !== 'false';
}
