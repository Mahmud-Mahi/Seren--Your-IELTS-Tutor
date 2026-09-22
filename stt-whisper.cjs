/**
 * sherpa-onnx Whisper STT helper (CommonJS)
 * Converts base64 audio (webm/opus from MediaRecorder) to text via Whisper base.en.
 * Auto-downloads the model on first run (~150MB).
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

// sherpa-onnx may fail to load (missing/broken native binary). Capture the
// reason so the diagnostics endpoint can surface it instead of crashing here.
let sherpa_onnx = null;
let loadError = null;
try {
  sherpa_onnx = require('sherpa-onnx');
} catch (e) {
  loadError = e?.message || String(e);
}

// Anchor models to the project root whether this helper is required from the
// root (dev / tsx) or from dist/ (esbuild bundle copies it next to server.cjs).
function projectRoot() {
  return path.basename(__dirname) === 'dist' ? path.resolve(__dirname, '..') : __dirname;
}

// Where the Whisper model is stored. Defaults to <projectRoot>/models, keeping
// dev / `npm start` unchanged. The desktop shell points SEREN_MODELS_DIR at a
// writable app-data folder because the installed app bundle is read-only and
// the ~150MB first-run download would otherwise fail.
const MODELS_ROOT = process.env.SEREN_MODELS_DIR
  ? path.resolve(process.env.SEREN_MODELS_DIR)
  : path.join(projectRoot(), 'models');
const MODEL_DIR = path.join(MODELS_ROOT, 'sherpa-onnx-whisper-base.en');
const MODEL_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-base.en.tar.bz2';
const MODEL_ARCHIVE = path.join(MODELS_ROOT, 'sherpa-onnx-whisper-base.en.tar.bz2');

const MODEL_FILES = ['base.en-encoder.int8.onnx', 'base.en-decoder.int8.onnx', 'base.en-tokens.txt'];

// Whisper decodes at most 30s of audio per pass — anything longer is silently
// discarded ("Only waves less than 30 seconds are supported"). Long answers
// are therefore split into chunks just under the limit, preferring quiet
// moments as boundaries so words aren't cut in half.
const MAX_CHUNK_SECONDS = 28;
const TARGET_CHUNK_SECONDS = 24;
const BOUNDARY_SEARCH_SECONDS = 6;
const ENERGY_WINDOW_MS = 250;

function rmsAt(samples, pos, windowSamples) {
  let sum = 0;
  const end = Math.min(pos + windowSamples, samples.length);
  for (let i = pos; i < end; i++) {
    const v = samples[i];
    sum += v * v;
  }
  return sum / Math.max(1, end - pos);
}

/**
 * Pick a low-energy point within [targetEnd - searchSamples, targetEnd] so a
 * chunk boundary lands on silence instead of mid-word.
 */
function findQuietBoundary(samples, sampleRate, targetEnd) {
  const searchSamples = BOUNDARY_SEARCH_SECONDS * sampleRate;
  const windowSamples = Math.floor((ENERGY_WINDOW_MS / 1000) * sampleRate);
  const scanStart = Math.max(0, targetEnd - searchSamples);
  const maxPos = Math.max(scanStart, targetEnd - windowSamples);
  let bestPos = Math.max(0, targetEnd - windowSamples);
  let bestEnergy = Infinity;
  const step = Math.floor(sampleRate * 0.05);
  for (let pos = scanStart; pos <= maxPos; pos += step) {
    const energy = rmsAt(samples, pos, windowSamples);
    if (energy < bestEnergy) {
      bestEnergy = energy;
      bestPos = pos;
    }
  }
  return Math.min(bestPos + windowSamples, targetEnd);
}

// --- Audio conditioning -----------------------------------------------------
// Whisper base.en is sensitive to input level and to leading silence.
// Quiet first recordings (browser/OS AGC still ramping up on a freshly opened
// mic stream) and seconds of room noise at the head of a clip are the classic
// triggers for hallucinated output ("Thank you.", "Okay, so..."). Trimming
// silence and normalizing gain makes every clip — especially the first —
// reach the decoder in the same shape.
const TRIM_WINDOW_MS = 20;      // energy scan window
const TRIM_PAD_MS = 150;        // keep a little natural padding around speech
const MIN_SPEECH_MS = 400;      // if less than this remains, keep the raw clip
const TRIM_FLOOR_RATIO = 0.02;  // silence = below 2% of peak amplitude
const TARGET_RMS = 0.09;        // ~ -21 dBFS, comfortable Whisper input level
const MAX_GAIN = 12;            // never boost near-silence absurdly
const PEAK_CEILING = 0.95;      // never clip after gain is applied

function speechBounds(samples, sampleRate) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
  }
  if (peak <= 0) return null;
  const floorSq = Math.max(peak * TRIM_FLOOR_RATIO, 1e-4) ** 2;
  const win = Math.max(1, Math.floor((TRIM_WINDOW_MS / 1000) * sampleRate));
  const pad = Math.floor((TRIM_PAD_MS / 1000) * sampleRate);
  let first = -1;
  let last = -1;
  for (let pos = 0; pos < samples.length; pos += win) {
    if (rmsAt(samples, pos, win) > floorSq) {
      if (first < 0) first = pos;
      last = pos + win;
    }
  }
  if (first < 0) return null;
  return {
    from: Math.max(0, first - pad),
    to: Math.min(samples.length, last + pad),
  };
}

function trimSilence(samples, sampleRate) {
  const bounds = speechBounds(samples, sampleRate);
  if (!bounds) return samples;
  const trimmedLength = bounds.to - bounds.from;
  const minSamples = Math.floor((MIN_SPEECH_MS / 1000) * sampleRate);
  // Too little speech left to trust the trim, or the clip is basically all
  // speech anyway — leave the recording untouched.
  if (trimmedLength < minSamples || trimmedLength > samples.length * 0.98) {
    return samples;
  }
  return samples.subarray(bounds.from, bounds.to);
}

function normalizeLoudness(samples) {
  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / Math.max(1, samples.length));
  if (rms < 1e-5) return samples; // digital silence — nothing to amplify
  let gain = TARGET_RMS / rms;
  if (gain > MAX_GAIN) gain = MAX_GAIN;
  if (peak * gain > PEAK_CEILING) gain = PEAK_CEILING / peak;
  // Already loud enough — boosting gains nothing and can amplify noise.
  if (gain <= 1.05) return samples;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] * gain;
    out[i] = v > 1 ? 1 : v < -1 ? -1 : v;
  }
  return out;
}

/** Split sample array into consecutive ranges each <= MAX_CHUNK_SECONDS long,
 *  cutting at the quietest spot near every TARGET_CHUNK_SECONDS mark. */
function planChunkRanges(samples, sampleRate) {
  const targetStep = TARGET_CHUNK_SECONDS * sampleRate;
  const minChunkSamples = 5 * sampleRate;
  const ranges = [];
  let prev = 0;
  while (samples.length - prev > MAX_CHUNK_SECONDS * sampleRate) {
    let cut = findQuietBoundary(samples, sampleRate, prev + targetStep);
    // Never allow a degenerate sliver chunk
    if (cut - prev < minChunkSamples) cut = Math.min(prev + targetStep, samples.length);
    ranges.push([prev, cut]);
    prev = cut;
  }
  if (samples.length - prev > 0) ranges.push([prev, samples.length]);
  return ranges;
}

function decodeChunk(recognizer, sampleRate, samples) {
  const stream = recognizer.createStream();
  stream.acceptWaveform(sampleRate, samples);
  recognizer.decode(stream);
  const text = recognizer.getResult(stream).text.trim();
  stream.free();
  return text;
}

/**
 * Fast health probe — no downloads, no model loading.
 * Tells you whether the engine CAN be started right now.
 */
function getStatus() {
  return {
    engine: 'sherpa-onnx-whisper',
    model: 'base.en',
    modelDir: MODEL_DIR,
    sherpaOnnxLoaded: Boolean(sherpa_onnx && typeof sherpa_onnx.createOfflineRecognizer === 'function'),
    loadError,
    modelReady: MODEL_FILES.every((f) => fs.existsSync(path.join(MODEL_DIR, f))),
    recognizerInitialized: Boolean(recognizer),
    ffmpeg: (() => {
      try {
        execSync('ffmpeg -version', { stdio: 'ignore', timeout: 5000 });
        return true;
      } catch {
        return false;
      }
    })(),
  };
}

/**
 * Full end-to-end self-test: decodes a bundled reference WAV through the real
 * recognizer and returns the recognized text. Proves model + runtime actually
 * work, not just that files exist. Errors out immediately (no download) if the
 * model is missing — use `npm run setup-stt` or transcribe once to fetch it.
 */
function runSelfTest() {
  const encoder = path.join(MODEL_DIR, 'base.en-encoder.int8.onnx');
  if (!MODEL_FILES.every((f) => fs.existsSync(path.join(MODEL_DIR, f)))) {
    return {
      ok: false,
      error: 'Whisper model files are missing — run "npm run setup-stt" (downloads base.en, ~150MB)',
    };
  }

  const wavCandidates = [path.join(MODEL_DIR, 'test_wavs', '0.wav'), path.join(MODEL_DIR, 'test_wavs', '1.wav')];
  const wavPath = wavCandidates.find((p) => fs.existsSync(p));
  if (!wavPath) {
    return { ok: false, error: 'No bundled test_wavs found — cannot run a self-test' };
  }

  const t0 = Date.now();
  try {
    const rec = getRecognizer();
    const wave = sherpa_onnx.readWave(wavPath);
    const stream = rec.createStream();
    stream.acceptWaveform(wave.sampleRate, wave.samples);
    rec.decode(stream);
    const text = rec.getResult(stream).text.trim();
    stream.free();
    return { ok: true, text, elapsedMs: Date.now() - t0, source: path.basename(wavPath) };
  } catch (e) {
    return { ok: false, error: e?.message || String(e), elapsedMs: Date.now() - t0 };
  }
}

let recognizer = null;

// Warm-up state: 'done'/'skipped' are terminal, anything else can retry.
let warmUpState = 'idle';

/**
 * Decode one throwaway clip right after startup so the ONNX session, thread
 * pool and first-decode code paths are hot before a real user request arrives.
 * Never downloads the model — if it is missing we skip silently and the first
 * real transcribe will fetch it as before.
 */
function warmUp() {
  if (warmUpState === 'done' || warmUpState === 'skipped') return warmUpState;
  if (!sherpa_onnx) {
    warmUpState = 'skipped';
    return warmUpState;
  }
  if (!MODEL_FILES.every((f) => fs.existsSync(path.join(MODEL_DIR, f)))) {
    warmUpState = 'skipped'; // model not downloaded yet — don't block startup
    return warmUpState;
  }
  const wavCandidates = [path.join(MODEL_DIR, 'test_wavs', '0.wav'), path.join(MODEL_DIR, 'test_wavs', '1.wav')];
  try {
    const rec = getRecognizer();
    const wavPath = wavCandidates.find((p) => fs.existsSync(p));
    if (wavPath) {
      const wave = sherpa_onnx.readWave(wavPath);
      decodeChunk(rec, wave.sampleRate, wave.samples);
    } else {
      // No reference clip bundled: 0.5s of silence still exercises the full
      // ONNX session initialization path.
      decodeChunk(rec, 16000, new Float32Array(8000));
    }
    warmUpState = 'done';
    console.log('[stt-whisper] Warm-up decode complete — recognizer hot');
  } catch (e) {
    // Leave warmUpState untouched so a later call can retry.
    console.warn('[stt-whisper] Warm-up failed (will retry on next call):', e?.message || e);
  }
  return warmUpState;
}

function ensureModel() {
  if (fs.existsSync(path.join(MODEL_DIR, 'base.en-encoder.int8.onnx'))) return;

  console.log('[stt-whisper] Model not found — downloading Whisper base.en (~150MB)...');
  fs.mkdirSync(MODELS_ROOT, { recursive: true });

  execSync(`curl -SL -o "${MODEL_ARCHIVE}" "${MODEL_URL}"`, {
    stdio: 'inherit',
    timeout: 300000,
  });
  execSync(`tar xjf "${MODEL_ARCHIVE}" -C "${MODELS_ROOT}"`, { timeout: 60000 });
  try { fs.unlinkSync(MODEL_ARCHIVE); } catch {}

  if (!fs.existsSync(path.join(MODEL_DIR, 'base.en-encoder.int8.onnx'))) {
    throw new Error('Whisper model download failed');
  }
  console.log('[stt-whisper] Model downloaded successfully');
}

function getRecognizer() {
  if (recognizer) return recognizer;
  if (!sherpa_onnx) {
    throw new Error(`sherpa-onnx failed to load: ${loadError || 'unknown error'}`);
  }

  ensureModel();

  const config = {
    modelConfig: {
      whisper: {
        encoder: path.join(MODEL_DIR, 'base.en-encoder.int8.onnx'),
        decoder: path.join(MODEL_DIR, 'base.en-decoder.int8.onnx'),
        language: '',
        task: 'transcribe',
        tailPaddings: -1,
      },
      tokens: path.join(MODEL_DIR, 'base.en-tokens.txt'),
    },
  };

  recognizer = sherpa_onnx.createOfflineRecognizer(config);
  console.log('[stt-whisper] Whisper recognizer initialized');
  return recognizer;
}

/**
 * Transcribe base64 audio to text.
 * @param {string} audioBase64 - base64-encoded audio (webm, mp4, etc.)
 * @param {string} mimeType - MIME type of the audio (e.g. 'audio/webm;codecs=opus')
 * @returns {Promise<string>} - transcribed text
 */
async function transcribe(audioBase64, mimeType) {
  const tmpDir = os.tmpdir();
  const ts = Date.now();
  const ext = (mimeType || '').includes('mp4') ? '.m4a' : '.webm';
  const inPath = path.join(tmpDir, `stt-in-${ts}${ext}`);
  const outPath = path.join(tmpDir, `stt-out-${ts}.wav`);

  try {
    // Write base64 audio to temp file
    const audioBuf = Buffer.from(audioBase64, 'base64');
    fs.writeFileSync(inPath, audioBuf);

    const fileSize = fs.statSync(inPath).size;
    console.log(`[stt-whisper] Input: ${inPath} (${fileSize} bytes, mime: ${mimeType})`);
    if (fileSize < 100) {
      console.log(`[stt-whisper] Audio too small (${fileSize} bytes), skipping`);
      return '';
    }

    // Convert to 16kHz mono WAV using ffmpeg
    try {
      execSync(
        `ffmpeg -y -i "${inPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${outPath}"`,
        { timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }
      );
    } catch (ffErr) {
      const stderr = ffErr.stderr ? ffErr.stderr.toString().slice(-500) : '';
      console.error(`[stt-whisper] ffmpeg failed for ${inPath}: ${stderr}`);
      return '';
    }

    // Read WAV, condition it, then transcribe (chunked — Whisper only
    // decodes ≤30s per pass)
    const rec = getRecognizer();
    const wave = sherpa_onnx.readWave(outPath);
    const rawDuration = wave.samples.length / wave.sampleRate;

    const samples = normalizeLoudness(trimSilence(wave.samples, wave.sampleRate));
    const duration = samples.length / wave.sampleRate;

    const ranges = planChunkRanges(samples, wave.sampleRate);
    console.log(`[stt-whisper] Decoding ${duration.toFixed(1)}s of audio (raw ${rawDuration.toFixed(1)}s) in ${ranges.length} chunk(s)`);

    const parts = [];
    for (const [from, to] of ranges) {
      const text = decodeChunk(rec, wave.sampleRate, samples.subarray(from, to));
      if (text) parts.push(text);
    }

    return parts.join(' ').replace(/\s+/g, ' ').trim();
  } finally {
    // Clean up temp files
    try { fs.unlinkSync(inPath); } catch {}
    try { fs.unlinkSync(outPath); } catch {}
  }
}

module.exports = { transcribe, getRecognizer, getStatus, runSelfTest, warmUp };
