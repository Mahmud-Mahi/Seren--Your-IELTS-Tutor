import type express from 'express';
import { callLLM, parseJsonLoose } from '../llm';
import {
  buildSerenChatPrompt,
  SEREN_CASUAL_SYSTEM,
  SEREN_CHAT_SYSTEM,
  SEREN_CASUAL_SCHEMA,
  SEREN_CHAT_SCHEMA,
  buildLessonChatPrompt,
  LESSON_CHAT_SYSTEM,
  LESSON_CHAT_SCHEMA,
  LESSON_MAX_FOLLOW_UPS,
  buildLessonDrillPrompt,
  LESSON_DRILL_SCHEMA,
  isUsableSpeakingQuestion,
  endsWithUsableSpeakingQuestion,
} from '../prompts';
import { runLessonRoadmapPass } from '../lessonRoadmap';
import { backfillLessonFocus, buildDegradation } from '../evaluation';
import { generateFallbackChatResponse, buildDeterministicLessonSummary } from '../chat';

const str = (v: any): string => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();

export function registerLessonRoutes(app: express.Express): void {
  // Interactive Seren Chat / IELTS Speaking Session Endpoint
  app.post('/api/seren-chat', async (req, res) => {
    try {
      const { userProfile, evaluation, conversationHistory, message, mode, lessonContext, followUpIndex } = req.body;
      const pinnedProvider = (req.get('x-seren-provider') || '').toLowerCase() || null;

      const isCasualMode = mode === 'Casual Chat';
      // Lesson Practice mode runs the bounded, error-focused session protocol
      // (see prompts.ts): ONE skill, max LESSON_MAX_FOLLOW_UPS follow-up
      // rounds, then a wrap-up summary and lessonComplete.
      const isLessonMode =
        !isCasualMode && typeof mode === 'string' && mode.startsWith('Lesson Practice:');

      if (isLessonMode) {
        const roundIndex = Number.isFinite(Number(followUpIndex))
          ? Math.max(0, Math.floor(Number(followUpIndex)))
          : 0;

        const lessonPrompt = buildLessonChatPrompt({
          lessonContext,
          followUpIndex: roundIndex,
          conversationHistory,
          message,
        });
        const fallbackQuestion = isUsableSpeakingQuestion(lessonContext?.drillPrompt)
          ? lessonContext.drillPrompt
          : 'What is one example from your daily life that illustrates this skill?';
        let parsed: any = null;
        let provider: string | undefined;
        let model: string | undefined;

        for (let attempt = 0; attempt < 2; attempt++) {
          const result = await callLLM({
            systemInstruction: LESSON_CHAT_SYSTEM,
            userPrompt: attempt === 0
              ? lessonPrompt
              : `${lessonPrompt}\n\nYour previous reply was rejected because it did not end with one natural, answerable speaking question. Return the complete JSON again. End replyText with exactly one question for spoken practice. Do not give a worksheet, sentence-completion task, or meta-instruction.`,
            json: true,
            jsonSchemaHint: LESSON_CHAT_SCHEMA,
            temperature: 0.8,
            pinnedProvider,
          });
          provider = result.provider;
          model = result.model;
          parsed = parseJsonLoose(result.text);
          if (!parsed || !parsed.replyText) {
            throw new Error('LLM returned malformed chat JSON');
          }

          const needsFollowUpQuestion = roundIndex < LESSON_MAX_FOLLOW_UPS && !parsed.lessonComplete;
          if (!needsFollowUpQuestion || endsWithUsableSpeakingQuestion(parsed.replyText)) break;
          if (attempt === 1) {
            const focus = lessonContext?.focusArea || lessonContext?.title || 'this speaking skill';
            parsed.replyText = `Let's keep practising ${focus}. ${fallbackQuestion}`;
            parsed.lessonComplete = false;
          }
        }
        parsed.followUpNumber = roundIndex;

        // Guarantee a summary whenever the lesson is declared complete.
        const summaryMissing =
          !parsed.summary ||
          !Array.isArray(parsed.summary.improved) ||
          parsed.summary.improved.length === 0;
        if (parsed.lessonComplete && summaryMissing) {
          parsed.summary = buildDeterministicLessonSummary(lessonContext, Math.min(roundIndex + 1, LESSON_MAX_FOLLOW_UPS + 1));
        }

        // Deterministic cap enforcement: on/after the final round the lesson
        // MUST wrap up even if a chatty model ignored the FINAL ROUND rule.
        if (roundIndex >= LESSON_MAX_FOLLOW_UPS) {
          parsed.lessonComplete = true;
          if (summaryMissing) {
            parsed.summary = buildDeterministicLessonSummary(lessonContext, Math.min(roundIndex + 1, LESSON_MAX_FOLLOW_UPS + 1));
          }
        }

        return res.json({ success: true, reply: parsed, provider, model });
      }

      const prompt = buildSerenChatPrompt({
        isCasual: isCasualMode,
        userProfile,
        evaluation,
        conversationHistory,
        message,
        mode,
      });
      const schemaHint = isCasualMode ? SEREN_CASUAL_SCHEMA : SEREN_CHAT_SCHEMA;

      const { text, provider, model } = await callLLM({
        systemInstruction: isCasualMode ? SEREN_CASUAL_SYSTEM : SEREN_CHAT_SYSTEM,
        userPrompt: prompt,
        json: true,
        jsonSchemaHint: schemaHint,
        temperature: 0.8,
        pinnedProvider,
      });

      const parsed = parseJsonLoose(text);
      if (!parsed || !parsed.replyText) {
        throw new Error('LLM returned malformed chat JSON');
      }
      return res.json({ success: true, reply: parsed, provider, model });
    } catch (err: any) {
      console.warn('Notice in Seren chat endpoint fallback:', err?.message || err);
      const { userProfile, message, mode, lessonContext, followUpIndex } = req.body || {};
      // Lesson Practice must NEVER fall back to the generic chat scripts — the
      // old greeting fallback ("Hi Seren, it's a pleasure to connect…") used to
      // leak into the follow-up feedback panel whenever the LLM call failed
      // mid-lesson. Instead: re-ask the drill question (or wrap up honestly on
      // the final round) and flag the reply so the client can skip fabricated
      // feedback instead of rendering it as a real evaluation.
      if (typeof mode === 'string' && mode.startsWith('Lesson Practice:')) {
        const roundIndex = Number.isFinite(Number(followUpIndex))
          ? Math.max(0, Math.floor(Number(followUpIndex)))
          : 0;
        const isFinalRound = roundIndex >= LESSON_MAX_FOLLOW_UPS;
        const focus = lessonContext?.focusArea || lessonContext?.title || 'this speaking skill';
        const retryQuestion = isUsableSpeakingQuestion(lessonContext?.drillPrompt)
          ? lessonContext.drillPrompt
          : 'What is one example from your daily life that illustrates this skill?';
        const lessonFallback: any = {
          replyText: isFinalRound
            ? `Let's wrap up ${focus} for today — you've put in solid practice, and that already moves you forward.`
            : `I want to make sure I caught every detail of that answer. Let's try that once more: ${retryQuestion}`,
          mood: 'encouraging',
          fallback: true,
        };
        if (isFinalRound) {
          lessonFallback.lessonComplete = true;
          lessonFallback.summary = buildDeterministicLessonSummary(
            lessonContext,
            Math.min(roundIndex + 1, LESSON_MAX_FOLLOW_UPS + 1)
          );
        }
        return res.json({ success: true, reply: lessonFallback, error: err.message });
      }
      const fallbackReply = generateFallbackChatResponse(userProfile, message, mode);
      return res.json({ success: true, reply: fallbackReply, error: err.message });
    }
  });

  // Drill / Lesson Generator Endpoint
  app.post('/api/generate-lesson-drill', async (req, res) => {
    try {
      const { userProfile, lessonModule } = req.body || {};
      const pinnedProvider = (req.get('x-seren-provider') || '').toLowerCase() || null;

      const prompt = buildLessonDrillPrompt({
        nickname: userProfile?.nickname || 'Learner',
        targetBand: userProfile?.targetBand || '7.5',
        lessonModule,
      });
      const schemaHint = LESSON_DRILL_SCHEMA;

      const { text, provider, model } = await callLLM({
        userPrompt: prompt,
        json: true,
        jsonSchemaHint: schemaHint,
        temperature: 0.7,
        pinnedProvider,
      });

      const parsed = parseJsonLoose(text);
      if (!parsed || !parsed.warmupQuestion) {
        throw new Error('LLM returned malformed drill JSON');
      }
      return res.json({ success: true, drill: parsed, provider, model });
    } catch (err: any) {
      console.warn('Notice in generate-lesson-drill fallback:', err?.message || err);
      return res.json({
        success: true,
        drill: {
          warmupQuestion: `Let's focus on ${req.body?.lessonModule?.title || 'English fluency'}. Share your thoughts in 30 seconds.`,
          keyVocabulary: ['Pivotal', 'Substantiate', 'Remarkable', 'In essence'],
          challengeQuestion: `How would you articulate your perspective on ${req.body?.lessonModule?.category || 'this topic'} using advanced discourse markers?`,
          band9Guidance: 'Begin with a clear thesis, elaborate with relevant evidence, and conclude with an impactful summary.',
        },
      });
    }
  });

  // -------------------------------------------------------------------------
  // Lesson-only regeneration.
  //
  // The evaluation endpoints build the lesson roadmap as part of the same
  // request as the scoring. When that pass fails (rate limit, provider
  // hiccup) the user would otherwise have to retake the whole test just to
  // get their lessons back. This endpoint regenerates ONLY the roadmap from
  // the learner's own recorded answers, so the client can offer a cheap
  // "Retry lessons" action.
  // -------------------------------------------------------------------------
  app.post('/api/generate-lessons', async (req, res) => {
    try {
      const { userProfile, evaluation, responses, questions } = req.body || {};
      const pinnedProvider = (req.get('x-seren-provider') || '').toLowerCase() || null;

      // Rebuild the learner's own words from whatever the client still has:
      // the raw answers when available, otherwise the recorded sentences of
      // the stored report.
      const transcriptLines: string[] = [];
      if (Array.isArray(responses)) {
        for (const r of responses) {
          const transcript = str(r?.transcript);
          if (!transcript) continue;
          transcriptLines.push(`Q: "${str(r?.question)}"\nA: "${transcript}"`);
        }
      }
      if (!transcriptLines.length && Array.isArray(questions)) {
        for (const q of questions) {
          const answer = str(q?.userAnswer);
          if (!answer) continue;
          transcriptLines.push(`Q: "${str(q?.question)}"\nA: "${answer}"`);
        }
      }
      if (!transcriptLines.length && Array.isArray(evaluation?.upgradedExpressions)) {
        // The stored report keeps every sentence the learner spoke, together
        // with the corrected version — perfect grounding material.
        for (const u of evaluation.upgradedExpressions) {
          const original = str(u?.original);
          if (!original) continue;
          transcriptLines.push(`A: "${original}"`);
        }
      }
      const transcriptsBlock = transcriptLines.join('\n');
      if (!transcriptsBlock.trim()) {
        return res.status(400).json({
          success: false,
          error: 'No recorded answers are available to build lessons from.',
          lessonRoadmap: [],
        });
      }

      const priorityErrors = Array.isArray(evaluation?.priorityErrors)
        ? evaluation.priorityErrors.slice(0, 6)
        : [];
      const upgrades = Array.isArray(evaluation?.upgradedExpressions)
        ? evaluation.upgradedExpressions
        : [];

      const result = await runLessonRoadmapPass({
        userProfile,
        pillars: evaluation?.pillars,
        priorityErrors,
        transcriptsBlock,
        upgrades,
        pinnedProvider,
      });

      // Deterministic lesson-focus backfill still runs on the result so a
      // module always ends up anchored to one specific error.
      const holder: any = {
        pillars: evaluation?.pillars,
        upgradedExpressions: upgrades,
        lessonRoadmap: result.modules,
      };
      backfillLessonFocus(holder);

      const degradation = buildDegradation({
        lessonsFailed: result.failed,
        lessonsPartial: result.degraded,
        pronunciationEmpty: false,
        usedFallback: false,
        notes: result.notes,
      });

      return res.json({
        success: true,
        lessonRoadmap: holder.lessonRoadmap,
        provider: result.provider,
        model: result.model,
        degradation: degradation || null,
        repaired: result.repaired,
        dropped: result.dropped,
      });
    } catch (err: any) {
      console.error('Error in generate-lessons:', err);
      const degradation = buildDegradation({
        lessonsFailed: true,
        lessonsPartial: false,
        pronunciationEmpty: false,
        usedFallback: false,
        notes: [err?.message || 'lesson generation failed'],
      });
      return res.json({
        success: false,
        error: err?.message || 'Lesson generation failed.',
        lessonRoadmap: [],
        degradation: degradation || null,
      });
    }
  });
}
