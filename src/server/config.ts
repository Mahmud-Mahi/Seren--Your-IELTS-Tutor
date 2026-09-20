import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

// Load .env FIRST (before any module reads process.env at import time).
dotenv.config();

export const SETTINGS_FILE = path.join(process.cwd(), 'seren-settings.json');
// Pre-rename settings file. Read as a fallback so existing installations keep
// their saved API keys / model / voice preferences after the rename. The
// legacy file is never deleted — only read when the new file is absent.
export const LEGACY_SETTINGS_FILE = path.join(process.cwd(), 'lumi-settings.json');

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

function readSettingsFile(file: string): StoredSettings | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) || null;
  } catch {
    return null;
  }
}

export function loadStoredSettings(): StoredSettings {
  // New file first; fall back to the pre-rename `lumi-settings.json` so no
  // previously saved settings are lost. Legacy data is preserved as-is.
  return readSettingsFile(SETTINGS_FILE) ?? readSettingsFile(LEGACY_SETTINGS_FILE) ?? {};
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
