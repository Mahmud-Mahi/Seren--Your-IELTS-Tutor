import { runtimeConfig } from './config';
import { ttsProvider, azureTtsConfig, pollyTtsConfig } from './config';
import { cleanSpeechText } from '../utils/textClean';
import type { Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';

// ---------- voice catalogs ----------
const GOOGLE_VOICES = [
  { id: 'google-tts-en-us', name: 'Google TTS (US English)', locale: 'en-US', gender: 'Female', personality: 'Instant, free, no subscription (default)' },
  { id: 'google-tts-en-gb', name: 'Google TTS (British English)', locale: 'en-GB', gender: 'Female', personality: 'British accent' },
  { id: 'google-tts-en-au', name: 'Google TTS (Australian English)', locale: 'en-AU', gender: 'Female', personality: 'Australian accent' },
  { id: 'google-tts-en-in', name: 'Google TTS (Indian English)', locale: 'en-IN', gender: 'Female', personality: 'Indian English accent' },
  { id: 'google-tts-en-ca', name: 'Google TTS (Canadian English)', locale: 'en-CA', gender: 'Female', personality: 'Canadian accent' },
  { id: 'google-tts-en-ie', name: 'Google TTS (Irish English)', locale: 'en-IE', gender: 'Female', personality: 'Irish accent' },
];

const AZURE_VOICES = [
  { id: 'en-US-JennyNeural', name: 'Jenny (US)', locale: 'en-US', gender: 'Female', personality: 'Warm, friendly & conversational' },
  { id: 'en-US-AriaNeural', name: 'Aria (US)', locale: 'en-US', gender: 'Female', personality: 'Professional, confident' },
  { id: 'en-US-GuyNeural', name: 'Guy (US)', locale: 'en-US', gender: 'Male', personality: 'Confident, energetic' },
  { id: 'en-US-EmmaNeural', name: 'Emma (US)', locale: 'en-US', gender: 'Female', personality: 'Cheerful, optimistic' },
  { id: 'en-GB-SoniaNeural', name: 'Sonia (UK)', locale: 'en-GB', gender: 'Female', personality: 'Warm British' },
  { id: 'en-GB-RyanNeural', name: 'Ryan (UK)', locale: 'en-GB', gender: 'Male', personality: 'Friendly British' },
];

const POLLY_VOICES = [
  { id: 'Joanna', name: 'Joanna (US)', locale: 'en-US', gender: 'Female', personality: 'Amazon Polly neural' },
  { id: 'Matthew', name: 'Matthew (US)', locale: 'en-US', gender: 'Male', personality: 'Amazon Polly neural' },
  { id: 'Ivy', name: 'Ivy (US)', locale: 'en-US', gender: 'Female', personality: 'Amazon Polly neural (child)' },
  { id: 'Kendra', name: 'Kendra (US)', locale: 'en-US', gender: 'Female', personality: 'Amazon Polly neural' },
  { id: 'Kimberly', name: 'Kimberly (US)', locale: 'en-US', gender: 'Female', personality: 'Amazon Polly neural' },
  { id: 'Salli', name: 'Salli (US)', locale: 'en-US', gender: 'Female', personality: 'Amazon Polly neural' },
  { id: 'Joey', name: 'Joey (US)', locale: 'en-US', gender: 'Male', personality: 'Amazon Polly neural' },
  { id: 'Justin', name: 'Justin (US)', locale: 'en-US', gender: 'Male', personality: 'Amazon Polly neural (child)' },
  { id: 'Nicole', name: 'Nicole (AU)', locale: 'en-AU', gender: 'Female', personality: 'Amazon Polly neural' },
  { id: 'Russell', name: 'Russell (AU)', locale: 'en-AU', gender: 'Male', personality: 'Amazon Polly neural' },
  { id: 'Amy', name: 'Amy (UK)', locale: 'en-GB', gender: 'Female', personality: 'Amazon Polly neural' },
  { id: 'Emma', name: 'Emma (UK)', locale: 'en-GB', gender: 'Female', personality: 'Amazon Polly neural' },
  { id: 'Brian', name: 'Brian (UK)', locale: 'en-GB', gender: 'Male', personality: 'Amazon Polly neural' },
];

export function currentProvider(): string {
  const prov = ttsProvider();
  if (prov === 'azure' && azureTtsConfig()) return 'azure';
  if (prov === 'polly' && pollyTtsConfig()) return 'polly';
  return 'google';
}

/** Voices for a specific provider (or all if no provider given). */
export function ttsVoices(provider?: string): { id: string; name: string; locale: string; gender: string; personality: string }[] {
  const p = provider || currentProvider();
  if (p === 'azure') return AZURE_VOICES;
  if (p === 'polly') return POLLY_VOICES;
  return GOOGLE_VOICES;
}

/** All voices from every provider, tagged with their provider. */
export function allTtsVoices(): { id: string; name: string; locale: string; gender: string; personality: string; provider: string }[] {
  return [
    ...GOOGLE_VOICES.map((v) => ({ ...v, provider: 'google' })),
    ...AZURE_VOICES.map((v) => ({ ...v, provider: 'azure' })),
    ...POLLY_VOICES.map((v) => ({ ...v, provider: 'polly' })),
  ];
}

const TTS_VOICE_IDS = () => new Set(ttsVoices().map((v) => v.id));

export function defaultTtsVoice(): string {
  const p = currentProvider();
  return defaultTtsVoiceForProvider(p);
}

export function defaultMaleTtsVoice(): string {
  const p = currentProvider();
  return defaultMaleTtsVoiceForProvider(p);
}

export function defaultMaleTtsVoiceForProvider(provider: string): string {
  if (provider === 'azure') return 'en-US-GuyNeural';
  if (provider === 'polly') return 'Matthew';
  // Google's free translate endpoint has no male voice; fall back to a
  // British female as the closest "examiner" flavour. (A true male google
  // voice would need the paid Google Cloud TTS API.)
  return 'google-tts-en-gb';
}

export function defaultTtsVoiceForProvider(provider: string): string {
  // Prefer per-provider saved voice, then global fallback, then env, then default.
  let preferred = '';
  if (provider === 'azure') preferred = runtimeConfig.ttsVoices.azure || runtimeConfig.ttsVoice || process.env.TTS_VOICE || 'en-US-JennyNeural';
  else if (provider === 'polly') preferred = runtimeConfig.ttsVoices.polly || runtimeConfig.ttsVoice || process.env.TTS_VOICE || 'Joanna';
  else preferred = runtimeConfig.ttsVoices.google || runtimeConfig.ttsVoice || process.env.TTS_VOICE || 'google-tts-en-ca';
  const ids = new Set(ttsVoices(provider).map((v) => v.id));
  const fallback = provider === 'azure' ? 'en-US-JennyNeural' : provider === 'polly' ? 'Joanna' : 'google-tts-en-ca';
  return ids.has(preferred) ? preferred : fallback;
}

export function sanitizeVoice(voice: any): string | null {
  if (typeof voice !== 'string') return null;
  const v = voice.trim();
  return TTS_VOICE_IDS().has(v) ? v : null;
}

export function sanitizeVoiceForProvider(voice: any, provider: string): string | null {
  if (typeof voice !== 'string') return null;
  const v = voice.trim();
  const ids = new Set(ttsVoices(provider).map((vo) => vo.id));
  return ids.has(v) ? v : null;
}

export function cleanTextForTts(text: string): string {
  return cleanSpeechText(text).slice(0, currentProvider() === 'google' ? 1200 : 3000);
}

// ---------- Google ----------
const LANG_MAP: Record<string, string> = {
  'google-tts-en-us': 'en-US',
  'google-tts-en-gb': 'en-GB',
  'google-tts-en-au': 'en-AU',
  'google-tts-en-in': 'en-IN',
  'google-tts-en-ca': 'en-CA',
  'google-tts-en-ie': 'en-IE',
};

function splitChunks(text: string, max = 180): string[] {
  const out: string[] = [];
  let buf = '';
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const s of sentences) {
    if (!s.trim()) continue;
    if (buf && buf.length + s.length + 1 > max) {
      out.push(buf.trim());
      buf = '';
    }
    buf += ' ' + s;
  }
  if (buf.trim()) out.push(buf.trim());
  const final: string[] = [];
  for (const c of out) {
    if (c.length <= max) final.push(c);
    else for (let i = 0; i < c.length; i += max) final.push(c.slice(i, i + max));
  }
  return final.filter(Boolean);
}

async function fetchGoogleChunk(chunk: string, lang: string): Promise<Buffer> {
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(chunk)}&tl=${lang}&client=tw-ob`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
  if (!res.ok) throw new Error(`Google TTS HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function synthesizeGoogle(res: Response, text: string, voice: string): Promise<void> {
  const clean = cleanTextForTts(text);
  if (!clean) throw new Error('No speakable text after cleanup');
  const lang = LANG_MAP[voice] || 'en';
  const chunks = splitChunks(clean);
  const buffers = await Promise.all(chunks.map((c) => fetchGoogleChunk(c, lang)));
  const audio = Buffer.concat(buffers);
  if (!audio.length) throw new Error('Empty TTS audio response');
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.end(audio);
}

// ---------- Azure ----------
function escapeXml(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

async function synthesizeAzure(res: Response, text: string, voice: string): Promise<void> {
  const cfg = azureTtsConfig();
  if (!cfg) throw new Error('Azure TTS not configured (missing key/region)');
  const clean = cleanTextForTts(text);
  if (!clean) throw new Error('No speakable text after cleanup');
  const locale = voice.split('-').slice(0, 2).join('-');
  const ssml = `<speak version='1.0' xml:lang='${locale}'><voice name='${voice}'>${escapeXml(clean)}</voice></speak>`;
  const url = `https://${cfg.region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': cfg.key,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3',
      'User-Agent': 'Seren',
    },
    body: ssml,
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => '');
    throw new Error(`Azure TTS ${r.status}: ${msg.slice(0, 200)}`);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length) throw new Error('Empty Azure TTS audio response');
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.end(buf);
}

// ---------- Amazon Polly ----------
function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}
function hmacBuf(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest();
}

async function synthesizePolly(res: Response, text: string, voice: string): Promise<void> {
  const cfg = pollyTtsConfig();
  if (!cfg) throw new Error('Amazon Polly not configured (missing keys/region)');
  const clean = cleanTextForTts(text);
  if (!clean) throw new Error('No speakable text after cleanup');
  const { accessKey, secretKey, region } = cfg;
  const host = `polly.${region}.amazonaws.com`;
  const endpoint = `https://${host}/v1/speech`;
  const payload = JSON.stringify({ Text: clean, OutputFormat: 'mp3', VoiceId: voice, Engine: 'standard' });
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const canonicalHeaders = `host:${host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-date';
  const payloadHash = sha256Hex(payload);
  const canonicalRequest = `POST\n/v1/speech\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const credentialScope = `${dateStamp}/${region}/polly/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`;
  const kDate = hmacBuf('AWS4' + secretKey, dateStamp);
  const kRegion = hmacBuf(kDate, region);
  const kService = hmacBuf(kRegion, 'polly');
  const kSigning = hmacBuf(kService, 'aws4_request');
  const signature = hmacBuf(kSigning, stringToSign).toString('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const r = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'host': host,
      'x-amz-date': amzDate,
      'Authorization': authorization,
    },
    body: payload,
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => '');
    throw new Error(`Amazon Polly ${r.status}: ${msg.slice(0, 200)}`);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length) throw new Error('Empty Polly audio response');
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.end(buf);
}

// ---------- main ----------
export async function synthesizeToResponse(
  res: Response,
  text: string,
  voice: string,
  rate?: number,
  pitch?: number
): Promise<void> {
  const provider = currentProvider();
  const isMale = typeof voice === 'string' && voice.trim().toLowerCase() === 'male';
  const selected = isMale
    ? defaultMaleTtsVoice()
    : sanitizeVoice(voice) || defaultTtsVoice();

  if (provider === 'azure') {
    await synthesizeAzure(res, text, selected);
  } else if (provider === 'polly') {
    await synthesizePolly(res, text, selected);
  } else {
    await synthesizeGoogle(res, text, selected);
  }
}

export function closeAllTtsConnections(): void {}
