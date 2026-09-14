import type express from 'express';
import { whisperSTT } from '../whisper';

export function registerSttRoutes(app: express.Express): void {
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
}
