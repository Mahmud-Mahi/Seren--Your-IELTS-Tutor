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
} from '../prompts';
import { generateFallbackChatResponse, buildDeterministicLessonSummary } from '../chat';

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

        const { text, provider, model } = await callLLM({
          systemInstruction: LESSON_CHAT_SYSTEM,
          userPrompt: buildLessonChatPrompt({
            lessonContext,
            followUpIndex: roundIndex,
            conversationHistory,
            message,
          }),
          json: true,
          jsonSchemaHint: LESSON_CHAT_SCHEMA,
          temperature: 0.8,
          pinnedProvider,
        });

        const parsed = parseJsonLoose(text);
        if (!parsed || !parsed.replyText) {
          throw new Error('LLM returned malformed chat JSON');
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
      const fallbackReply = generateFallbackChatResponse(req.body?.userProfile, req.body?.message, req.body?.mode);
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
}
