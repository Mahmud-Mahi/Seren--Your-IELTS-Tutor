import type express from 'express';
import { callLLM, parseJsonLoose } from '../llm';
import {
  buildLumiChatPrompt,
  LUMI_CASUAL_SYSTEM,
  LUMI_CHAT_SYSTEM,
  LUMI_CASUAL_SCHEMA,
  LUMI_CHAT_SCHEMA,
  buildLessonDrillPrompt,
  LESSON_DRILL_SCHEMA,
} from '../prompts';
import { generateFallbackChatResponse } from '../chat';

export function registerLessonRoutes(app: express.Express): void {
  // Interactive Lumi Chat / IELTS Speaking Session Endpoint
  app.post('/api/lumi-chat', async (req, res) => {
    try {
      const { userProfile, evaluation, conversationHistory, message, mode } = req.body;
      const pinnedProvider = (req.get('x-lumi-provider') || '').toLowerCase() || null;

      const isCasualMode = mode === 'Casual Chat';

      const prompt = buildLumiChatPrompt({
        isCasual: isCasualMode,
        userProfile,
        evaluation,
        conversationHistory,
        message,
        mode,
      });
      const schemaHint = isCasualMode ? LUMI_CASUAL_SCHEMA : LUMI_CHAT_SCHEMA;

      const { text, provider, model } = await callLLM({
        systemInstruction: isCasualMode ? LUMI_CASUAL_SYSTEM : LUMI_CHAT_SYSTEM,
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
      console.warn('Notice in Lumi chat endpoint fallback:', err?.message || err);
      const fallbackReply = generateFallbackChatResponse(req.body?.userProfile, req.body?.message, req.body?.mode);
      return res.json({ success: true, reply: fallbackReply, error: err.message });
    }
  });

  // Drill / Lesson Generator Endpoint
  app.post('/api/generate-lesson-drill', async (req, res) => {
    try {
      const { userProfile, lessonModule } = req.body || {};
      const pinnedProvider = (req.get('x-lumi-provider') || '').toLowerCase() || null;

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
