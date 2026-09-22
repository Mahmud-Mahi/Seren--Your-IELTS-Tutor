import { fetchWithTimeout } from './llm';
import {
  ASSEMBLYAI_SPEECH_MODELS,
  DEEPGRAM_STT_MODELS,
  GROQ_STT_MODELS,
  assemblyAiApiKey,
  deepgramApiKey,
  groqSttApiKey,
  runtimeConfig,
  sttEngine,
  sttModelFor,
  type SttEngine,
} from './config';
import { whisperSTT } from './whisper';

export interface SttResult {
  success: boolean;
  transcript: string;
  engine: SttEngine;
  requestedEngine: SttEngine;
  fallback: boolean;
  fallbackReason?: string;
  error?: string;
}

const HALLUCINATION_RE = /^(thank you\.?|thanks for watching!?|thank you for watching\.?|okay\.?|so\.?|alright\.?|bye\.?|yeah\.?|uh[- ]?huh\.?|mm[- ]?hmm\.?|uh\.?|um\.?)$/i;
const FILLER_ONLY_RE = /^(?:(?:okay|so|um|uh|uhh|umm|er|ah|yeah|yep|yup|alright|thank you|thanks|bye|well)[\s,.!?-]*)+$/i;

function cleanTranscript(raw: string): string {
  const trimmed = (raw || '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return '';
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length >= 2 && !HALLUCINATION_RE.test(trimmed) && !FILLER_ONLY_RE.test(trimmed)) return trimmed;
  return '';
}

function extensionFor(mimeType: string): { ext: string; contentType: string } {
  const mime = (mimeType || '').toLowerCase();
  if (mime.includes('mp4') || mime.includes('m4a')) return { ext: 'm4a', contentType: 'audio/mp4' };
  if (mime.includes('wav')) return { ext: 'wav', contentType: 'audio/wav' };
  if (mime.includes('ogg')) return { ext: 'ogg', contentType: 'audio/ogg' };
  if (mime.includes('mpeg') || mime.includes('mp3')) return { ext: 'mp3', contentType: 'audio/mpeg' };
  return { ext: 'webm', contentType: 'audio/webm' };
}
async function transcribeWithGroq(audioBase64: string, mimeType: string, model: string): Promise<string> {
  const key = runtimeConfig.endpoints?.groq?.apiKey || groqSttApiKey();
  if (!key) {
    const err: any = new Error('Groq API key is missing - add it in Settings Speech-to-Text');
    err.code = 'STT_NO_KEY';
    throw err;
  }
  const baseUrl = runtimeConfig.endpoints?.groq?.baseUrl || 'https://api.groq.com/openai/v1';
  const form = new FormData();
  const { ext, contentType } = extensionFor(mimeType);
  const bytes = Buffer.from(audioBase64, 'base64');
  form.append('file', new Blob([bytes], { type: contentType }), `audio.${ext}`);
  form.append('model', model || GROQ_STT_MODELS[0]);
  form.append('response_format', 'json');
  const res = await fetchWithTimeout(
    `${baseUrl}/audio/transcriptions`,
    { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form as any },
    60000
  );
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const err: any = new Error(`Groq STT failed (HTTP ${res.status}): ${text.slice(0, 240)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  try {
    const json = JSON.parse(text);
    return String(json?.text || '');
  } catch {
    return text;
  }
}
async function transcribeWithAssemblyAI(audioBase64: string, mimeType: string, speechModel: string): Promise<string> {
  const key = runtimeConfig.endpoints?.assemblyai?.apiKey || assemblyAiApiKey();
  if (!key) {
    const err: any = new Error('AssemblyAI API key is missing - add it in Settings Speech-to-Text');
    err.code = 'STT_NO_KEY';
    throw err;
  }
  const baseUrl = runtimeConfig.endpoints?.assemblyai?.baseUrl || 'https://api.assemblyai.com';
  const headers: Record<string, string> = { authorization: key };
  const bytes = Buffer.from(audioBase64, 'base64');
  const { contentType } = extensionFor(mimeType);
  const uploadRes = await fetchWithTimeout(`${baseUrl}/v2/upload`, { method: 'POST', headers: { ...headers, 'content-type': contentType }, body: bytes as any }, 60000);
  if (!uploadRes.ok) {
    const body = await uploadRes.text().catch(() => '');
    const err: any = new Error(`AssemblyAI upload failed (HTTP ${uploadRes.status}): ${body.slice(0, 240)}`);
    err.status = uploadRes.status;
    err.body = body;
    throw err;
  }
  const uploadJson: any = await uploadRes.json().catch(() => ({}));
  const uploadUrl = uploadJson?.upload_url;
  if (!uploadUrl) throw new Error('AssemblyAI upload did not return an upload_url');
  const createRes = await fetchWithTimeout(`${baseUrl}/v2/transcript`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ audio_url: uploadUrl, speech_models: [speechModel || ASSEMBLYAI_SPEECH_MODELS[0]] }) }, 30000);
  if (!createRes.ok) {
    const body = await createRes.text().catch(() => '');
    const err: any = new Error(`AssemblyAI job failed (HTTP ${createRes.status}): ${body.slice(0, 240)}`);
    err.status = createRes.status;
    err.body = body;
    throw err;
  }
  const created: any = await createRes.json().catch(() => ({}));
  const transcriptId = created?.id;
  if (!transcriptId) throw new Error('AssemblyAI did not return a transcript id');
  const started = Date.now();
  while (Date.now() - started < 120000) {
    await new Promise((r) => setTimeout(r, 2500));
    const pollRes = await fetchWithTimeout(`${baseUrl}/v2/transcript/${transcriptId}`, { headers }, 15000);
    if (!pollRes.ok) {
      const body = await pollRes.text().catch(() => '');
      const err: any = new Error(`AssemblyAI poll failed (HTTP ${pollRes.status}): ${body.slice(0, 240)}`);
      err.status = pollRes.status;
      err.body = body;
      throw err;
    }
    const polled: any = await pollRes.json().catch(() => ({}));
    if (polled?.status === 'completed') return String(polled?.text || '');
    if (polled?.status === 'error') {
      const err: any = new Error(`AssemblyAI transcription failed: ${polled?.error || 'unknown error'}`);
      err.status = 422;
      err.body = String(polled?.error || '');
      throw err;
    }
  }
  const err: any = new Error('AssemblyAI transcription timed out');
  err.status = 504;
  throw err;
}
async function transcribeLocal(audioBase64: string, mimeType: string): Promise<string> {
  if (!whisperSTT) throw new Error('Whisper engine not loaded - check server startup logs');
  return whisperSTT.transcribe(audioBase64, mimeType);
}

async function transcribeWithDeepgram(audioBase64: string, mimeType: string, model: string): Promise<string> {
  const key = deepgramApiKey();
  if (!key) {
    const err: any = new Error('Deepgram API key is missing - add it in Settings Speech-to-Text');
    err.code = 'STT_NO_KEY';
    throw err;
  }
  const baseUrl = runtimeConfig.endpoints?.deepgram?.baseUrl || 'https://api.deepgram.com';
  const { ext, contentType } = extensionFor(mimeType);
  const bytes = Buffer.from(audioBase64, 'base64');
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: contentType }), `audio.${ext}`);
  form.append('model', model || DEEPGRAM_STT_MODELS[0]);
  const res = await fetchWithTimeout(
    `${baseUrl}/v1/listen`,
    { method: 'POST', headers: { Authorization: `Token ${key}` }, body: form as any },
    60000
  );
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const err: any = new Error(`Deepgram STT failed (HTTP ${res.status}): ${text.slice(0, 240)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  try {
    const json = JSON.parse(text);
    return String(json?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '');
  } catch {
    return text;
  }
}

function looksLikeQuotaError(err: any): boolean {
  const status = Number(err?.status);
  if (status === 402 || status === 429) return true;
  const text = `${err?.message || ''} ${err?.body || ''}`.toLowerCase();
  return text.includes('insufficient') || text.includes('quota') || text.includes('credit') || text.includes('billing') || text.includes('payment required') || text.includes('rate limit') || text.includes('too many requests') || text.includes('exceeded') || text.includes('free tier');
}

function shouldFallbackToLocal(err: any): boolean {
  const status = Number(err?.status);
  if (err?.code === 'STT_NO_KEY') return true;
  if (status === 401 || status === 403) return true;
  if (looksLikeQuotaError(err)) return true;
  if (!status || status >= 500 || status === 408 || status === 504) return true;
  return false;
}

export async function describeSttEngines() {
  const engines = [
    { key: 'local', label: 'Local STT (Sherpa-ONNX)', description: 'Offline, private and always free. Default fallback.', needsKey: false, hasKey: true, reachable: true, model: sttModelFor('local'), models: ['whisper-base.en-local'] },
    { key: 'groq', label: 'Groq Cloud STT', description: 'Fast cloud Whisper. Reuses the Groq API key used for chat responses.', needsKey: true, hasKey: Boolean(groqSttApiKey()), reachable: false, model: sttModelFor('groq'), models: [...GROQ_STT_MODELS] },
    { key: 'assemblyai', label: 'AssemblyAI STT', description: 'Accurate cloud speech models with upload plus async transcript flow.', needsKey: true, hasKey: Boolean(assemblyAiApiKey()), reachable: false, model: sttModelFor('assemblyai'), models: [...ASSEMBLYAI_SPEECH_MODELS] },
    { key: 'deepgram', label: 'Deepgram STT', description: 'Ultra-fast cloud speech-to-text with Nova and Flux models.', needsKey: true, hasKey: Boolean(deepgramApiKey()), reachable: false, model: sttModelFor('deepgram'), models: [...DEEPGRAM_STT_MODELS] },
  ];

  // Health-check cloud engines that have a key
  await Promise.allSettled(
    engines.map(async (e) => {
      if (!e.hasKey) return;
      try {
        if (e.key === 'groq') {
          const r = await fetchWithTimeout('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${groqSttApiKey()}` } }, 6000);
          e.reachable = r.ok;
        } else if (e.key === 'assemblyai') {
          const r = await fetchWithTimeout('https://api.assemblyai.com/v2/transcript?limit=1', { headers: { authorization: assemblyAiApiKey() } }, 6000);
          e.reachable = r.ok;
        } else if (e.key === 'deepgram') {
          const r = await fetchWithTimeout('https://api.deepgram.com/v1/projects', { headers: { Authorization: `Token ${deepgramApiKey()}` } }, 6000);
          e.reachable = r.ok;
        }
      } catch {
        e.reachable = false;
      }
    })
  );

  return engines;
}
export async function transcribeAudioWithFallback(params: { audioBase64: string; mimeType: string; engine?: string | null }): Promise<SttResult> {
  const requested = (params.engine && ['local', 'groq', 'assemblyai', 'deepgram'].includes(String(params.engine)) ? String(params.engine) : sttEngine()) as SttEngine;
  const audioBase64 = params.audioBase64 || '';
  const mimeType = params.mimeType || '';
  if (!audioBase64 || audioBase64.length < 50) {
    return { success: true, transcript: '', engine: requested, requestedEngine: requested, fallback: false };
  }
  if (requested === 'local') {
    try {
      const text = cleanTranscript(await transcribeLocal(audioBase64, mimeType));
      return { success: true, transcript: text, engine: 'local', requestedEngine: requested, fallback: false };
    } catch (err: any) {
      return { success: false, transcript: '', engine: 'local', requestedEngine: requested, fallback: false, error: err?.message || 'Local transcription failed' };
    }
  }
  const model = sttModelFor(requested);
  try {
    let raw: string;
    if (requested === 'groq') {
      raw = await transcribeWithGroq(audioBase64, mimeType, model);
    } else if (requested === 'deepgram') {
      raw = await transcribeWithDeepgram(audioBase64, mimeType, model);
    } else {
      raw = await transcribeWithAssemblyAI(audioBase64, mimeType, model);
    }
    const text = cleanTranscript(raw);
    console.log(`[stt] ${requested} OK (${text.split(/\s+/).filter(Boolean).length} words, model ${model})`);
    return { success: true, transcript: text, engine: requested, requestedEngine: requested, fallback: false };
  } catch (cloudErr: any) {
    console.warn(`[stt] ${requested} failed (${cloudErr?.message || cloudErr}) - checking local fallback`);
    if (!shouldFallbackToLocal(cloudErr)) {
      return { success: false, transcript: '', engine: requested, requestedEngine: requested, fallback: false, error: cloudErr?.message || `${requested} transcription failed` };
    }
    try {
      const localText = cleanTranscript(await transcribeLocal(audioBase64, mimeType));
      console.log(`[stt] fallback to local STT after ${requested} error (${cloudErr?.status || cloudErr?.code || 'cloud-error'})`);
      return { success: true, transcript: localText, engine: 'local', requestedEngine: requested, fallback: true, fallbackReason: cloudErr?.message || `${requested} unavailable` };
    } catch (localErr: any) {
      return { success: false, transcript: '', engine: 'local', requestedEngine: requested, fallback: true, fallbackReason: cloudErr?.message || `${requested} unavailable`, error: localErr?.message || 'Local fallback transcription failed' };
    }
  }
}
