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
  isUsableSpeakingQuestion,
} from '../prompts';
import {
  runLessonRoadmapPass as runLessonRoadmapPassShared,
  type LessonRoadmapPassResult,
} from '../lessonRoadmap';
import {
  normalizeEvaluationShape,
  backfillLessonFocus,
  buildDegradation,
  splitIntoSentences,
  resolveResponsePart,
  UPGRADE_CHUNK_SIZE,
  type ExtractedSentence,
  generateNoSpeechEvaluation,
  generateFallbackEvaluation,
} from '../evaluation';

// ---------------------------------------------------------------------------
// Enrichment passes — ONE call each so a full evaluation costs ~8 LLM calls
// total instead of dozens. The pronunciation scan used to run one call PER
// answer with up to 3 retries (up to 36 calls for a 12-question test).
// ---------------------------------------------------------------------------

// Hard cap on coaching words for the WHOLE test: hardest-only quality wins.
const MAX_PRONUNCIATION_TIPS = 10;

function isValidPronunciationTip(t: any): boolean {
  const w = String(t?.word || '').trim();
  return (
    w.length >= 2 &&
    /^[A-Za-z][A-Za-z'-]*$/.test(w) &&
    String(t?.ipa || '').includes('/') &&
    !String(t?.ipa || '').includes('...') &&
    String(t?.tip || '').length > 15 &&
    String(t?.exampleSentence || '').length > 15
  );
}

// ONE pronunciation call for the whole test. The prompt's rubric keeps only
// genuinely hard/uncommon words; the server enforces dedupe + the hard cap
// regardless of model whims.
async function runPronunciationScan(opts: {
  transcriptsBlock: string;
  totalWords: number;
  pinnedProvider: string | null;
}): Promise<any[]> {
  const { transcriptsBlock, totalWords, pinnedProvider } = opts;
  let arr: any[] = [];
  for (let attempt = 0; attempt < 2 && arr.filter(isValidPronunciationTip).length === 0; attempt++) {
    try {
      const tp = await callLLMWithCascade({
        systemInstruction:
          'You are a phonetics coach for IELTS candidates. Return real, concrete pronunciation data in valid JSON - never placeholders.',
        userPrompt: buildPronunciationScanPrompt(transcriptsBlock),
        json: true,
        jsonSchemaHint: PRONUNCIATION_TIPS_SCHEMA,
        temperature: 0.3 + attempt * 0.25,
        maxTokens: Math.min(1600, 700 + Math.min(900, totalWords * 6)),
        pinnedProvider,
      });
      const tParsed = parseJsonLoose(tp.text);
      arr = Array.isArray(tParsed?.pronunciationTips)
        ? tParsed.pronunciationTips
        : Array.isArray(tParsed)
        ? tParsed
        : [];
    } catch (e: any) {
      console.warn('[evaluate] pronunciation scan failed:', e?.message || e);
    }
  }
  const seen = new Set<string>();
  const merged: any[] = [];
  for (const t of arr) {
    if (!isValidPronunciationTip(t)) continue;
    const key = String(t.word).toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(t);
    if (merged.length >= MAX_PRONUNCIATION_TIPS) break;
  }
  return merged;
}

// ONE dedicated lesson-roadmap call. The scoring prompt no longer carries the
// roadmap, so this pass goes deep: every module quotes the learner's own
// faulty sentences and ships "fix this sentence" exercises built from them.
//
// The pass lives in src/server/lessonRoadmap.ts so the evaluation routes and
// the lesson-only regeneration endpoint share ONE implementation: modules are
// validated PER MODULE (a single sloppy module no longer discards the whole
// roadmap) and broken modules are repaired deterministically from the
// learner's own words before validation runs.
async function runLessonRoadmapPass(opts: {
  userProfile: any;
  parsed: any;
  transcriptsBlock: string;
  pinnedProvider: string | null;
  /** The learner's upgraded sentences — resolved lazily (see the call below). */
  upgrades?: any[] | (() => any[] | Promise<any[]>);
}): Promise<LessonRoadmapPassResult> {
  const { userProfile, parsed, transcriptsBlock, pinnedProvider, upgrades } = opts;
  const priorityErrors = Array.isArray(parsed?.priorityErrors) ? parsed.priorityErrors.slice(0, 6) : [];
  return runLessonRoadmapPassShared({
    userProfile,
    pillars: parsed?.pillars,
    priorityErrors,
    transcriptsBlock,
    // Lazy: the sentence-upgrade lane fills this array in parallel, so it is
    // resolved at repair time (after that lane finished), not when the pass
    // is scheduled.
    upgrades: () =>
      typeof upgrades === 'function' ? upgrades() : upgrades || [],
    pinnedProvider,
  });
}

export function registerEvaluationRoutes(app: express.Express): void {
  // Diagnostic Speech Evaluation Endpoint
app.post('/api/evaluate-speech', async (req, res) => {
    try {
      const { userProfile, responses, stats } = req.body;
      const pinnedProvider = (req.get('x-seren-provider') || '').toLowerCase() || null;

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

      // Scoring only — roadmap + pronunciation run in dedicated passes below;
      // sentence count only adds minor output headroom
      const maxTokens = Math.min(4000, 1800 + Math.ceil(sentences.length / 2) * 24);

      const { text, provider, model } = await callLLMWithCascade({
        systemInstruction: 'You are Seren, an expert IELTS Speaking examiner.',
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

      // Normalize arrays
      if (!Array.isArray(parsed.upgradedExpressions)) parsed.upgradedExpressions = [];
      if (!Array.isArray(parsed.pronunciationTips)) parsed.pronunciationTips = [];

      // Three enrichment lanes run IN PARALLEL so the dedicated lessons call
      // adds zero wall-clock time:
      //  (a) sentence upgrades — chunked, sequential inside the lane
      //  (b) ONE consolidated pronunciation scan (was: one call PER answer ×3
      //      attempts → up to 36 calls for a 12-question test)
      //  (c) ONE dedicated lesson-roadmap call (was: squeezed into the scoring
      //      prompt, which diluted both the score and the drill quality)
      const upgradeLane = (async () => {
        if (sentences.length === 0) return;
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
      })();

      const tipsLane = runPronunciationScan({ transcriptsBlock, totalWords: spokenWords, pinnedProvider });
      const lessonsLane = runLessonRoadmapPass({
        userProfile,
        parsed,
        transcriptsBlock,
        pinnedProvider,
        // The sentence-upgrade lane is still running: the roadmap repair waits
        // for it so the corrections it writes are the REAL ones.
        upgrades: () => upgradeLane.then(() => parsed.upgradedExpressions || []),
      });

      const [tips, roadmap] = await Promise.all([tipsLane, lessonsLane]);
      await upgradeLane;
      parsed.pronunciationTips = tips;
      // Deterministic part stamping: whichever answer contains the word owns it.
      tips.forEach((t: any) => {
        const word = String(t.word || '').toLowerCase();
        for (let i = 0; i < (responses?.length || 0); i++) {
          if ((responses[i]?.transcript || '').toLowerCase().includes(word)) {
            t.part = resolveResponsePart(responses[i], i);
            return;
          }
        }
      });
      parsed.lessonRoadmap = roadmap.modules;
      // Guarantee every roadmap module is anchored to one real, specific error
      // (now that the dedicated pass has filled the roadmap).
      backfillLessonFocus(parsed);
      console.log(
        `[evaluate-speech] enrichment: ${parsed.upgradedExpressions.length}/${sentences.length} upgrades, ${tips.length} pronunciation tips, ${roadmap.modules.length} lesson modules`
      );

      // Explicit degradation metadata: the client must be able to tell the
      // difference between "there were no real errors to teach" and "the
      // lesson pass failed" so it can offer a retry.
      const degradation = buildDegradation({
        lessonsFailed: roadmap.failed,
        lessonsPartial: roadmap.degraded,
        pronunciationEmpty: tips.length === 0,
        usedFallback: false,
        notes: roadmap.notes,
      });
      if (degradation) parsed.degradation = degradation;

      return res.json({ success: true, evaluation: parsed, provider, model, degradation: degradation || null });
    } catch (err: any) {
      console.error('Error evaluating speech:', err);
      const fallback = generateFallbackEvaluation(req.body?.userProfile, req.body?.responses, req.body?.stats);
      const degradation = buildDegradation({
        lessonsFailed: true,
        lessonsPartial: false,
        pronunciationEmpty: true,
        usedFallback: true,
        notes: [err?.message || 'evaluation failed'],
      });
      return res.json({
        success: true,
        evaluation: { ...fallback, degradation: degradation || undefined },
        error: err.message,
        isFallback: true,
        degradation: degradation || null,
      });
    }
  });
  // Interview Practice Evaluation Endpoint (JSON-based questions + sample answers)
  app.post('/api/evaluate-practice', async (req, res) => {
    try {
      const { userProfile, topic, questions, stats } = req.body;
      const pinnedProvider = (req.get('x-seren-provider') || '').toLowerCase() || null;

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

      // Scoring only — roadmap + pronunciation run in dedicated passes below
      const maxTokens = Math.min(3500, 1600 + allSentences.length * 30);

      const { text, provider, model } = await callLLMWithCascade({
        systemInstruction: 'You are Seren, an expert IELTS Speaking examiner.',
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

      if (!Array.isArray(parsed.upgradedExpressions)) parsed.upgradedExpressions = [];
      if (!Array.isArray(parsed.pronunciationTips)) parsed.pronunciationTips = [];

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

      // Compact Q/A block shared by BOTH dedicated enrichment passes
      const transcriptsBlock = (questions || [])
        .filter((q: any) => String(q?.userAnswer || '').trim())
        .map((q: any) => `Q: "${q.question}"
A: "${q.userAnswer}"`)
        .join('\n');

      // ONE consolidated pronunciation scan + ONE dedicated lesson-roadmap
      // call, in parallel (was: one tip call per question ×3 attempts).
      const [tips, roadmap] = await Promise.all([
        runPronunciationScan({ transcriptsBlock, totalWords: spokenWords, pinnedProvider }),
        runLessonRoadmapPass({
          userProfile,
          parsed,
          transcriptsBlock,
          pinnedProvider,
          // The practice upgrades are already complete (they are stamped
          // deterministically from the question bank above).
          upgrades: () => parsed.upgradedExpressions || [],
        }),
      ]);
      parsed.pronunciationTips = tips;
      parsed.lessonRoadmap = roadmap.modules;
      // Guarantee every roadmap module is anchored to one real, specific error
      backfillLessonFocus(parsed);
      console.log(
        `[evaluate-practice] enrichment: ${tips.length} pronunciation tips, ${roadmap.modules.length} lesson modules`
      );

      const degradation = buildDegradation({
        lessonsFailed: roadmap.failed,
        lessonsPartial: roadmap.degraded,
        pronunciationEmpty: tips.length === 0,
        usedFallback: false,
        notes: roadmap.notes,
      });
      if (degradation) parsed.degradation = degradation;

      return res.json({ success: true, evaluation: parsed, provider, model, degradation: degradation || null });
    } catch (err: any) {
      console.error('Error in practice evaluation:', err);
      const fallback = generateFallbackEvaluation(req.body?.userProfile, (req.body?.questions || []).map((q: any) => ({ transcript: q.userAnswer, question: q.question, partTitle: 'Interview', topic: req.body?.topic })), req.body?.stats);
      const degradation = buildDegradation({
        lessonsFailed: true,
        lessonsPartial: false,
        pronunciationEmpty: true,
        usedFallback: true,
        notes: [err?.message || 'evaluation failed'],
      });
      return res.json({
        success: true,
        evaluation: { ...fallback, degradation: degradation || undefined },
        error: err.message,
        isFallback: true,
        degradation: degradation || null,
      });
    }
  });
}
