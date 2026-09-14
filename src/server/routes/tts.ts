import type express from 'express';
import { ttsEnabled } from '../config';
import { TTS_VOICES, defaultTtsVoice, sanitizeVoice, cleanTextForTts, synthesizeToResponse } from '../tts';

export function registerTtsRoutes(app: express.Express): void {
  // Neural TTS synthesis (Microsoft Edge Read Aloud voices)
  const handleTts = async (req: express.Request, res: express.Response) => {
    if (!ttsEnabled()) {
      return res.status(503).json({ success: false, error: 'TTS is disabled' });
    }
    try {
      const body = req.method === 'GET' ? (req.query as any) : req.body || {};
      const text = typeof body.text === 'string' ? body.text : '';
      if (!cleanTextForTts(text)) {
        return res.status(400).json({ success: false, error: 'text is required' });
      }
      const voice = sanitizeVoice(body.voice) || defaultTtsVoice();
      const rate = typeof body.rate === 'number' ? body.rate : undefined;
      const pitch = typeof body.pitch === 'number' ? body.pitch : undefined;
      await synthesizeToResponse(res, text, voice, rate, pitch);
    } catch (err: any) {
      const errCode = err?.cause?.code || err?.code;
      // Client aborts (a newer utterance superseded this one) are normal app
      // behaviour — don't log them as errors or try to respond to a dead socket.
      const quiet =
        res.destroyed ||
        res.writableEnded ||
        errCode === 'ECONNRESET' ||
        err?.message === 'TTS client disconnected';
      if (!quiet) {
        console.warn('[TTS] synthesis failed:', err?.message || err);
      }
      if (!res.headersSent) {
        if (quiet) {
          try { res.end(); } catch {}
        } else {
          res.status(502).json({ success: false, error: `TTS synthesis failed: ${err?.message || err}` });
        }
      } else {
        try { res.end(); } catch {}
      }
    }
  };

  app.post('/api/tts', handleTts);
  app.get('/api/tts', handleTts);

  app.get('/api/tts/voices', (req, res) => {
    res.json({ success: true, voices: TTS_VOICES, defaultVoice: defaultTtsVoice(), enabled: ttsEnabled() });
  });
}
