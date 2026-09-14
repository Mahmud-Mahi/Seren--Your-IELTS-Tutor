import type express from 'express';
import { registerSystemRoutes } from './system';
import { registerProviderRoutes } from './providers';
import { registerTtsRoutes } from './tts';
import { registerSttRoutes } from './stt';
import { registerEvaluationRoutes } from './evaluation';
import { registerLessonRoutes } from './lesson';

/**
 * Registers every API route on the Express app. Individual route modules live
 * in this folder, one concern per file:
 *  - system.ts       /api/health, /api/system/reset
 *  - providers.ts    /api/providers/status, /api/providers/models, /api/providers/configure
 *  - tts.ts          /api/tts (GET+POST), /api/tts/voices
 *  - stt.ts          /api/transcribe-audio, /api/stt/status, /api/stt/test
 *  - evaluation.ts   /api/evaluate-speech, /api/evaluate-practice
 *  - lesson.ts       /api/lumi-chat, /api/generate-lesson-drill
 */
export function registerRoutes(app: express.Express): void {
  registerSystemRoutes(app);
  registerProviderRoutes(app);
  registerTtsRoutes(app);
  registerSttRoutes(app);
  registerEvaluationRoutes(app);
  registerLessonRoutes(app);
}