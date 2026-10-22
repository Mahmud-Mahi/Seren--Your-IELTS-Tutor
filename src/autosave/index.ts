/**
 * Whole-app autosave system — public surface. Feature screens import only
 * from here; the per-feature modules own their storage shapes.
 */
export { loadAutosave, saveAutosave, clearAutosave, removeLegacyKeys } from './storage';
export { saveLessonSession, loadLessonSessionInit, loadLessonSession, hasSessionContent } from './lessonSession';
export type { LessonSession, LessonSessionFields, LessonSessionInit } from './lessonSession';
export { loadCambridgeSession, saveCambridgeSession, clearCambridgeSession } from './cambridgeSession';
export type { CambridgeSession } from './cambridgeSession';
export { loadSolutionsProgress, saveSolutionsProgress } from './solutionsProgress';
export type { SolutionsProgress, SolutionsPlayback, SolutionsSpeaker } from './solutionsProgress';
export { loadChatDrafts, saveChatDrafts, saveChatDraftForMode } from './chatDrafts';
export type { ChatDraft, ChatDrafts, ChatDraftMode } from './chatDrafts';
