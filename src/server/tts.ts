import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { pipeline, type Readable } from 'stream';
import https from 'https';
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
// Must stay below TTS_SYNTHESIS_TIMEOUT_MS so a stuck connect fails with a
// clear error (and releases the socket) before the outer timeout fires.
const TTS_CONNECTION_TIMEOUT_MS = 6000;
// One format for the whole app — the socket is bound to it, so a pooled
// connection must never be reused with a different one.
const TTS_OUTPUT_FORMAT = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;

// ---------------------------------------------------------------------------
// Edge TTS HTTP agent
// ---------------------------------------------------------------------------
// Node's "Happy Eyeballs" (autoSelectFamily, on by default since Node 20)
// races the A and AAAA records of api.msedgeservices.com. On a host without
// IPv6 connectivity the AAAA attempt fails instantly with ENETUNREACH, and
// the A attempt is aborted after autoSelectFamilyAttemptTimeout (250ms by
// default) — even though the A connect itself needs ~400ms here. Every such
// race collapses into a Node AggregateError (code ETIMEDOUT, empty message),
// which is what surfaced as:
//
//   [TTS] attempt 1/3 failed (ETIMEDOUT): Edge TTS WebSocket error:  (code=ETIMEDOUT)
//
// Letting the resolver pick a single address (the OS applies the usual
// dual-stack preference) removes the race entirely — measured 0/10 failures
// versus 2/10 with ETIMEDOUT before this change.
const edgeTtsAgent = new https.Agent({
  autoSelectFamily: false,
});

// ---------------------------------------------------------------------------
// Edge TTS connection pool
// ---------------------------------------------------------------------------
// Every utterance used to open a brand-new WebSocket to Microsoft's Edge
// endpoint: a fresh DNS lookup, TCP handshake, TLS handshake and WebSocket
// upgrade — ~1.5s before the first audio sample, and a brand-new connection
// every single time Seren speaks. Rapid-fire speech also tripped the
// endpoint's rate limiter (HTTP 429).
//
// The endpoint speaks the same protocol over a long-lived socket, so the
// connection is kept warm and reused. One entry per voice: the Cambridge
// Solutions tab uses a fixed examiner voice while the rest of the app uses
// the configured one, and a socket is bound to the voice it was opened with.
//
// The library (msedge-tts 2.x) supports this: `setMetadata` is a no-op when
// the voice and format are unchanged, `_send` transparently re-opens the
// socket if it was closed in the meantime, and every request is tracked by
// its own request id, so several utterances can share one socket.
const ttsPool = new Map<string, PooledTts>();

interface PooledTts {
  tts: MsEdgeTTS;
  voice: string;
  /** Resolves once the voice/format handshake has completed. */
  ready: Promise<void>;
  /** Number of requests currently streaming on this connection. */
  active: number;
  /** The connection is broken and must not be handed out again. */
  dead: boolean;
  /** Idle timer that closes the socket after a period of inactivity. */
  idleTimer: NodeJS.Timeout | null;
}

/** Close an idle connection so it doesn't linger for the whole app session. */
const TTS_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

async function acquireTts(voice: string): Promise<PooledTts> {
  let entry = ttsPool.get(voice);
  if (!entry) {
    const tts = new MsEdgeTTS({
      agent: edgeTtsAgent,
      connectionTimeoutMs: TTS_CONNECTION_TIMEOUT_MS,
    });
    entry = { tts, voice, active: 0, dead: false, ready: Promise.resolve(), idleTimer: null };
    // Publish before awaiting so concurrent callers share one socket.
    ttsPool.set(voice, entry);
    // Opening the socket can fail (offline, DNS hiccup, TLS problem) — the
    // retry loop in synthesizeToResponse() picks it up from there.
    entry.ready = tts
      .setMetadata(voice, TTS_OUTPUT_FORMAT, {})
      .then(() => undefined)
      .catch((err) => {
        // The handshake failed — make sure this half-open entry never
        // reaches the pool and every waiter sees the same error.
        discardTts(entry!);
        throw err;
      });
  }
  entry.active++;
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
  try {
    await entry.ready;
  } catch (err) {
    entry.active--;
    throw err;
  }
  return entry;
}

/** Drops a broken connection so the next request opens a fresh one. */
function discardTts(entry: PooledTts): void {
  if (entry.dead) return;
  entry.dead = true;
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
  if (ttsPool.get(entry.voice) === entry) ttsPool.delete(entry.voice);
  try { entry.tts.close(); } catch {}
}

/** Returns a connection to the pool, or discards it when it went bad. */
function releaseTts(entry: PooledTts, dead: boolean): void {
  if (dead) {
    discardTts(entry);
    return;
  }
  if (entry.active > 0) entry.active--;
  if (entry.active === 0 && !entry.dead) scheduleIdleClose(entry);
}

/** Closes a connection that has been idle for a while. */
function scheduleIdleClose(entry: PooledTts): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    entry.idleTimer = null;
    if (entry.active > 0 || entry.dead) return;
    discardTts(entry);
  }, TTS_IDLE_TIMEOUT_MS);
  // Never keep the process alive just for an idle TTS socket.
  entry.idleTimer.unref?.();
}

/** Closes every pooled Edge TTS connection (server shutdown). */
export function closeAllTtsConnections(): void {
  for (const entry of Array.from(ttsPool.values())) {
    discardTts(entry);
  }
  ttsPool.clear();
}

// A `TtsSession` bundles the produced audio stream with the pooled
// connection that created it, so callers can always release the stream once
// it is consumed (or abandoned).
interface TtsSession {
  audioStream: Readable;
  entry: PooledTts;
  released: boolean;
}

function destroyTtsSession(session: TtsSession | null | undefined, dead = false): void {
  if (!session || session.released) return;
  session.released = true;
  try { session.audioStream.destroy(); } catch {}
  releaseTts(session.entry, dead);
}

async function synthesizeOnce(
  text: string,
  voice: string,
  rate?: number,
  pitch?: number
): Promise<TtsSession> {
  const clean = cleanTextForTts(text);
  if (!clean) throw new Error('No speakable text after cleanup');

  // Reuse a warm connection for this voice instead of dialling Microsoft for
  // every single utterance. acquireTts() opens one on demand and hands the
  // same socket to the next request.
  const entry = await acquireTts(voice);

  try {
    const prosody: { rate?: number; pitch?: string } = {};
    if (typeof rate === 'number' && isFinite(rate) && rate > 0 && rate !== 1) prosody.rate = rate;
    if (typeof pitch === 'number' && isFinite(pitch)) {
      const hz = Math.max(-50, Math.min(50, Math.round((pitch - 1) * 50)));
      if (hz !== 0) prosody.pitch = `${hz >= 0 ? '+' : ''}${hz}Hz`;
    }

    // msedge-tts versions differ on sync/async toStream — handle both
    const result: any = entry.tts.toStream(escapeXml(clean), prosody);
    const { audioStream } = result && typeof result.then === 'function' ? await result : result;
    return { audioStream: audioStream as Readable, entry, released: false };
  } catch (err) {
    // The connection is unusable — drop it so the next attempt reconnects.
    releaseTts(entry, true);
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
      // A timed-out turn leaves the socket in an unknown state, so the
      // connection is discarded rather than reused.
      void synth.then((session) => destroyTtsSession(session, true)).catch(() => {});
      reject(new Error('TTS synthesis timed out'));
    }, ms);

    synth.then(
      (session) => {
        if (settled) {
          destroyTtsSession(session, true);
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
      // Set when the Edge connection itself failed, so the pooled socket is
      // dropped instead of being reused for the next attempt.
      let connectionBroken = false;
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
        // The failure came from the Edge service, not from the browser: the
        // socket is unusable (dropped mid-stream, HTTP 429, TLS/connect
        // error). Mark it so the pooled connection is discarded and the next
        // attempt dials a fresh one.
        connectionBroken = true;
        if (res.headersSent) break;
        console.warn(
          `[TTS] attempt ${attempt + 1}/${TTS_MAX_ATTEMPTS} failed${errCode ? ` (${errCode})` : ''}:`,
          err?.message || err
        );
      } finally {
        // Release the session's stream + connection whether we succeeded,
        // failed, timed out, or the client disconnected mid-pipe.
        res.removeListener('close', onClientGone);
        destroyTtsSession(session, connectionBroken);
        session = null;
      }
    }
    throw lastErr;
  } finally {
    res.removeListener('close', markClientGone);
  }
}
