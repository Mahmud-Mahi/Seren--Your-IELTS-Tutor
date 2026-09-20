import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { pipeline, type Readable } from 'stream';
import type { Response } from 'express';
import { runtimeConfig } from './config';
import { cleanSpeechText } from '../utils/textClean';

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
// ---------------------------------------------------------------------------
// Neural TTS (Microsoft Edge Read Aloud service) — free, high-quality voices
// ---------------------------------------------------------------------------

export const TTS_VOICES: { id: string; name: string; locale: string; gender: string; personality: string }[] = [
  { id: 'en-US-JennyNeural', name: 'Jenny', locale: 'en-US', gender: 'Female', personality: 'Warm, friendly & conversational (recommended for Seren)' },
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

export function defaultTtsVoice(): string {
  return runtimeConfig.ttsVoice || process.env.TTS_VOICE || 'en-US-JennyNeural';
}

export function sanitizeVoice(voice: any): string | null {
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

export function cleanTextForTts(text: string): string {
  // Shared with the browser engine (src/utils/textClean.ts): markdown, bracketed
  // asides and EMOJI are removed — the neural voices would otherwise happily
  // read "🎉" out loud as "party popper" in the middle of a sentence.
  return cleanSpeechText(text).slice(0, 3000);
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
function pipeAudioToResponse(session: TtsSession, res: Response): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    try {
      pipeline(session.audioStream, res as any, (err: any) => (err ? reject(err) : resolve()));
    } catch (err) {
      reject(err as any);
    }
  });
}

export async function synthesizeToResponse(
  res: Response,
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
