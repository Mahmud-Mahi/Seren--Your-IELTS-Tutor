import type express from 'express';
import { sttEngine } from '../config';
import { describeSttEngines, transcribeAudioWithFallback } from '../stt-providers';
import { whisperSTT } from '../whisper';

export function registerSttRoutes(app: express.Express): void {
  // Speech-to-text with selectable engine: local Sherpa-ONNX (offline default),
  // Groq Cloud Whisper, or AssemblyAI. Cloud failures caused by missing keys,
  // auth errors, quota/credit exhaustion, rate limits or transient 5xx fall
  // back to local automatically.
  app.post('/api/transcribe-audio', async (req, res) => {
    const { audioBase64 = '', mimeType = '', engine = undefined } = req.body || {};

    try {
      const result = await transcribeAudioWithFallback({ audioBase64, mimeType, engine });
      if (!result.success) {
        const status = result.requestedEngine === 'local' && !whisperSTT ? 503 : 500;
        return res.status(status).json({
          success: false,
          transcript: '',
          engine: result.engine,
          requestedEngine: result.requestedEngine,
          fallback: result.fallback,
          fallbackReason: result.fallbackReason,
          error: result.error || 'Transcription failed',
          source: result.fallback ? 'whisper-local-fallback' : `stt-${result.engine}`,
        });
      }
      return res.json({
        success: true,
        transcript: result.transcript,
        engine: result.engine,
        requestedEngine: result.requestedEngine,
        fallback: result.fallback,
        fallbackReason: result.fallbackReason,
        source:
          result.transcript === ''
            ? `${result.engine}-empty`
            : result.fallback
              ? 'whisper-local-fallback'
              : result.engine === 'local'
                ? 'whisper-local'
                : `stt-${result.engine}`,
      });
    } catch (err: any) {
      console.warn('[transcribe-audio] failed:', err?.message || err);
      return res.status(500).json({
        success: false,
        transcript: '',
        error: err?.message || 'Transcription failed',
      });
    }
  });

  // Selectable STT engines + current selection for the Settings UI.
  app.get('/api/stt/engines', async (_req, res) => {
    res.json({ success: true, engine: sttEngine(), engines: await describeSttEngines() });
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
}
