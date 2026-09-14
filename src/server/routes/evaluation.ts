import type express from 'express';
import { callLLMWithCascade, parseJsonLoose } from '../llm';
import {
  buildEvaluateSpeechPrompt,
  EVALUATE_SPEECH_SCHEMA,
  buildInterviewPracticePrompt,
  INTERVIEW_PRACTICE_SCHEMA,
  buildUpgradeChunkPrompt,
  UPGRADE_CHUNK_SCHEMA,
  buildPronunciationScanPrompt,
  PRONUNCIATION_TIPS_SCHEMA,
} from '../prompts';
import {
  normalizeEvaluationShape,
  backfillLessonFocus,
  splitIntoSentences,
  resolveResponsePart,
  UPGRADE_CHUNK_SIZE,
  type ExtractedSentence,
  generateNoSpeechEvaluation,
  generateFallbackEvaluation,
} from '../evaluation';

export function registerEvaluationRoutes(app: express.Express): void {
  // Diagnostic Speech Evaluation Endpoint
app.post('/api/evaluate-speech', async (req, res) => {
    try {
      const { userProfile, responses, stats } = req.body;
      const pinnedProvider = (req.get('x-lumi-provider') || '').toLowerCase() || null;

      // Defense-in-depth: if the student said (almost) nothing across all
      // parts, do not ask the LLM to score silence — return an honest,
      // low-band evaluation instead of a fabricated one.
      const spokenWords = (responses || []).reduce(
        (sum: number, r: any) => sum + String(r?.transcript || '').trim().split(/\s+/).filter(Boolean).length,
        0
      );
      if (spokenWords < 5) {
        console.log(`[evaluate-speech] insufficient speech (${spokenWords} words) — returning no-speech evaluation`);
        return res.json({
          success: true,
          evaluation: generateNoSpeechEvaluation(userProfile),
          insufficientSpeech: true,
        });
      }

      // Deterministic full-coverage extraction: every meaningful sentence the
      // student actually spoke, grouped under its REAL IELTS part (1|2|3) —
      // Cambridge tests have several questions per part, so the position inside
      // the submitted array is never a proxy for the part number.
      const sentences = splitIntoSentences(responses || []);
      const responsesByPart = (responses || []).reduce(
        (acc: Record<number, any[]>, r: any, idx: number) => {
          const part = resolveResponsePart(r, idx);
          (acc[part] = acc[part] || []).push(r);
          return acc;
        },
        {}
      );
      // Compact transcript render: one line per question, no per-question
      // boilerplate (duration/word-count are derivable and duplicated in STATS)
      const transcriptsBlock = [1, 2, 3]
        .map((part) => {
          const items = responsesByPart[part] || [];
          if (!items.length) {
            return `[P${part}] (no answers)`;
          }
          return items
            .map((r: any) => `[P${part}] Q: "${r.question}"\nA: "${r.transcript || '(no speech)'}"`)
            .join('\n');
        })
        .join('\n');

      const prompt = buildEvaluateSpeechPrompt({ userProfile, transcriptsBlock, stats });
      const schemaHint = EVALUATE_SPEECH_SCHEMA;

      // 4-module roadmap + 4 pillars need headroom; sentence count only adds minor output
      const maxTokens = Math.min(6000, 2400 + Math.ceil(sentences.length / 2) * 24);

      const { text, provider, model } = await callLLMWithCascade({
        systemInstruction: 'You are Lumi, an expert IELTS Speaking examiner.',
        userPrompt: prompt,
        json: true,
        jsonSchemaHint: schemaHint,
        temperature: 0.4,
        maxTokens,
        pinnedProvider,
      });

      const parsed = parseJsonLoose(text);
      if (!parsed || !parsed.pillars || !parsed.pillars.fluency) {
        throw new Error('LLM returned malformed evaluation JSON');
      }
      // Fill everything the model omitted (stats, pillars, band as number…)
      // so a truncated/rate-limited response can never blank the report
      normalizeEvaluationShape(parsed);
      // Guarantee every roadmap module is anchored to one real, specific error
      backfillLessonFocus(parsed);

      // GUARANTEED-COVERAGE upgrade pass: always chunked, one call per
      // ≤12-sentence batch, with deterministic index/part stamping so every
      // spoken sentence gets exactly one upgrade regardless of model whims
      if (sentences.length > 0) {
        parsed.upgradedExpressions = [];
        const chunks: ExtractedSentence[][] = [];
        for (let i = 0; i < sentences.length; i += UPGRADE_CHUNK_SIZE) {
          chunks.push(sentences.slice(i, i + UPGRADE_CHUNK_SIZE));
        }
        for (const chunk of chunks) {
          try {
            const up = await callLLMWithCascade({
              systemInstruction: 'You are an elite IELTS Speaking examiner.',
              userPrompt: buildUpgradeChunkPrompt(chunk),
              json: true,
              jsonSchemaHint: UPGRADE_CHUNK_SCHEMA,
              temperature: 0.35,
              maxTokens: Math.min(3600, 300 + chunk.length * 200),
              pinnedProvider,
            });
            const upParsed = parseJsonLoose(up.text);
            let items: any[] = [];
            if (Array.isArray(upParsed?.upgradedExpressions)) items = upParsed.upgradedExpressions;
            else if (Array.isArray(upParsed)) items = upParsed;
            // Deterministic stamping by position — index/part are OUR truth
            items.forEach((u: any, i: number) => {
              const s = chunk[i];
              if (!s) return;
              u.index = s.index;
              u.part = s.part;
              if (!u.original) u.original = s.text;
            });
            parsed.upgradedExpressions.push(...items);
          } catch (chunkErr: any) {
            console.warn('[evaluate-speech] upgrade chunk failed:', chunkErr?.message || chunkErr);
          }
        }
        // Sort by sentence order for a clean report flow
        parsed.upgradedExpressions.sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0));
        console.log(`[evaluate-speech] guaranteed upgrades: ${parsed.upgradedExpressions.length}/${sentences.length} sentences`);
      }

      // Normalize arrays
      if (!Array.isArray(parsed.upgradedExpressions)) parsed.upgradedExpressions = [];
      if (!Array.isArray(parsed.pronunciationTips)) parsed.pronunciationTips = [];

      // GUARANTEED-COVERAGE pronunciation scan: one focused call PER PART so
      // every transcript gets fully scanned; results merged + deduped here
      {
        const mergedTips: any[] = [];
        const seenWords = new Set<string>();
        // Reject schema-placeholder echoes ("...", "/.../") and hollow entries
        const isValidTip = (t: any): boolean => {
          const w = String(t?.word || '').trim();
          return (
            w.length >= 2 &&
            /^[A-Za-z][A-Za-z'-]*$/.test(w) &&
            String(t?.ipa || '').includes('/') &&
            !String(t?.ipa || '').includes('...') &&
            String(t?.tip || '').length > 15 &&
            String(t?.exampleSentence || '').length > 15
          );
        };
        for (let i = 0; i < (responses?.length || 0); i++) {
          const transcript = String(responses[i]?.transcript || '').trim();
          const wordCount = transcript.split(/\s+/).filter(Boolean).length;
          if (!transcript || wordCount < 8) continue;
          let arr: any[] = [];
          // Up to 3 attempts when a scan returns nothing valid; escalate
          // temperature each try to break the model out of placeholder loops
          for (let attempt = 0; attempt < 3 && arr.filter(isValidTip).length === 0; attempt++) {
            try {
              const tp = await callLLMWithCascade({
                systemInstruction: 'You are a phonetics coach for IELTS candidates. Return real, concrete pronunciation data in valid JSON — never placeholders.',
                userPrompt: buildPronunciationScanPrompt(responses[i]?.question || '', transcript),
                json: true,
                jsonSchemaHint: PRONUNCIATION_TIPS_SCHEMA,
                temperature: 0.3 + attempt * 0.25,
                maxTokens: Math.min(2600, 500 + wordCount * 22),
                pinnedProvider,
              });
              const tParsed = parseJsonLoose(tp.text);
              arr = Array.isArray(tParsed?.pronunciationTips)
                ? tParsed.pronunciationTips
                : Array.isArray(tParsed)
                ? tParsed
                : [];
            } catch (tipErr: any) {
              console.warn(`[evaluate-speech] tip scan failed for real part ${resolveResponsePart(responses[i], i)}:`, tipErr?.message || tipErr);
            }
          }
          for (const t of arr) {
            if (!isValidTip(t)) continue;
            const key = String(t.word).toLowerCase().trim();
            if (seenWords.has(key)) continue;
            seenWords.add(key);
            t.part = resolveResponsePart(responses[i], i);
            mergedTips.push(t);
          }
        }
        if (mergedTips.length > 0) parsed.pronunciationTips = mergedTips;
        console.log(`[evaluate-speech] pronunciation scan: ${parsed.pronunciationTips.length} unique words`);
      }

      // Stamp tip parts from transcript lookup when missing
      if (parsed.pronunciationTips.length && responses?.length) {
        parsed.pronunciationTips.forEach((t: any) => {
          if (t.part !== undefined) return;
          const word = String(t.word || '').toLowerCase();
          for (let i = 0; i < responses.length; i++) {
            if ((responses[i]?.transcript || '').toLowerCase().includes(word)) {
              t.part = resolveResponsePart(responses[i], i);
              return;
            }
          }
        });
      }

      return res.json({ success: true, evaluation: parsed, provider, model });
    } catch (err: any) {
      console.error('Error evaluating speech:', err);
      const fallback = generateFallbackEvaluation(req.body?.userProfile, req.body?.responses, req.body?.stats);
      return res.json({ success: true, evaluation: fallback, error: err.message, isFallback: true });
    }
  });
  // Interview Practice Evaluation Endpoint (JSON-based questions + sample answers)
  app.post('/api/evaluate-practice', async (req, res) => {
    try {
      const { userProfile, topic, questions, stats } = req.body;
      const pinnedProvider = (req.get('x-lumi-provider') || '').toLowerCase() || null;

      const spokenWords = (questions || []).reduce(
        (sum: number, q: any) => sum + String(q?.userAnswer || '').trim().split(/\s+/).filter(Boolean).length,
        0
      );
      if (spokenWords < 5) {
        return res.json({
          success: true,
          evaluation: generateNoSpeechEvaluation(userProfile),
          insufficientSpeech: true,
        });
      }

      // Build sentences from user answers
      const allSentences: { index: number; question: string; userAnswer: string; sampleResponse: string }[] = [];
      let counter = 0;
      for (const q of (questions || [])) {
        const answer = String(q?.userAnswer || '').trim();
        if (!answer) continue;
        const sentences = answer
          .split(/(?<=[.!?])\s+/)
          .map((s: string) => s.trim().replace(/\s+/g, ' '))
          .filter((s: string) => s.split(/\s+/).filter(Boolean).length >= 4);
        for (const text of sentences) {
          counter++;
          allSentences.push({ index: counter, question: q.question, userAnswer: text, sampleResponse: q.response || '' });
        }
      }

      const prompt = buildInterviewPracticePrompt({ userProfile, topic, questions, stats });
      const schemaHint = INTERVIEW_PRACTICE_SCHEMA;

      // 4-module roadmap + 4 pillars need headroom; sentence count only adds minor output
      const maxTokens = Math.min(6000, 2400 + allSentences.length * 50);

      const { text, provider, model } = await callLLMWithCascade({
        systemInstruction: 'You are Lumi, an expert IELTS Speaking examiner.',
        userPrompt: prompt,
        json: true,
        jsonSchemaHint: schemaHint,
        temperature: 0.4,
        maxTokens,
        pinnedProvider,
      });

      const parsed = parseJsonLoose(text);
      if (!parsed || !parsed.pillars || !parsed.pillars.fluency) {
        throw new Error('LLM returned malformed evaluation JSON');
      }
      normalizeEvaluationShape(parsed);
      // Guarantee every roadmap module is anchored to one real, specific error
      backfillLessonFocus(parsed);

      // Deterministic upgrade stamping: override LLM output with JSON model answers
      if (allSentences.length > 0) {
        parsed.upgradedExpressions = allSentences.map((s, i) => ({
          index: s.index,
          original: s.userAnswer,
          upgraded: s.sampleResponse || parsed.upgradedExpressions?.[i]?.upgraded || s.userAnswer,
          ieltsBand: parsed.upgradedExpressions?.[i]?.ieltsBand || 'Band 8.0',
          explanation: parsed.upgradedExpressions?.[i]?.explanation || 'Model answer comparison',
        }));
      }

      if (!Array.isArray(parsed.upgradedExpressions)) parsed.upgradedExpressions = [];
      if (!Array.isArray(parsed.pronunciationTips)) parsed.pronunciationTips = [];

      // Pronunciation scan per question with user answers
      {
        const mergedTips: any[] = [];
        const seenWords = new Set<string>();
        const isValidTip = (t: any): boolean => {
          const w = String(t?.word || '').trim();
          return (
            w.length >= 2 &&
            /^[A-Za-z][A-Za-z'-]*$/.test(w) &&
            String(t?.ipa || '').includes('/') &&
            !String(t?.ipa || '').includes('...') &&
            String(t?.tip || '').length > 15 &&
            String(t?.exampleSentence || '').length > 15
          );
        };

        for (const q of (questions || [])) {
          const transcript = String(q?.userAnswer || '').trim();
          const wordCount = transcript.split(/\s+/).filter(Boolean).length;
          if (!transcript || wordCount < 8) continue;
          let arr: any[] = [];
          for (let attempt = 0; attempt < 3 && arr.filter(isValidTip).length === 0; attempt++) {
            try {
              const tp = await callLLMWithCascade({
                systemInstruction: 'You are a phonetics coach for IELTS candidates. Return real, concrete pronunciation data in valid JSON — never placeholders.',
                userPrompt: buildPronunciationScanPrompt(q.question || '', transcript),
                json: true,
                jsonSchemaHint: PRONUNCIATION_TIPS_SCHEMA,
                temperature: 0.3 + attempt * 0.25,
                maxTokens: Math.min(2600, 500 + wordCount * 22),
                pinnedProvider,
              });
              const tParsed = parseJsonLoose(tp.text);
              arr = Array.isArray(tParsed?.pronunciationTips)
                ? tParsed.pronunciationTips
                : Array.isArray(tParsed)
                ? tParsed
                : [];
            } catch (tipErr: any) {
              console.warn(`[evaluate-practice] tip scan failed:`, tipErr?.message || tipErr);
            }
          }
          for (const t of arr) {
            if (!isValidTip(t)) continue;
            const key = String(t.word).toLowerCase().trim();
            if (seenWords.has(key)) continue;
            seenWords.add(key);
            mergedTips.push(t);
          }
        }
        if (mergedTips.length > 0) parsed.pronunciationTips = mergedTips;
      }

      return res.json({ success: true, evaluation: parsed, provider, model });
    } catch (err: any) {
      console.error('Error in practice evaluation:', err);
      const fallback = generateFallbackEvaluation(req.body?.userProfile, (req.body?.questions || []).map((q: any) => ({ transcript: q.userAnswer, question: q.question, partTitle: 'Interview', topic: req.body?.topic })), req.body?.stats);
      return res.json({ success: true, evaluation: fallback, error: err.message, isFallback: true });
    }
  });
}
