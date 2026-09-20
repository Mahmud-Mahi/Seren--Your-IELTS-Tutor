import { LessonRoadmapModule, SavedLessonPlan, SpeakingEvaluation } from '../types';

/**
 * Custom Lesson history — the persistent store behind the Custom Lessons tab.
 *
 * Every completed test / practice session produces an AI lesson roadmap. This
 * store keeps the roadmap of EVERY session (newest first) so retaking a test
 * never deletes older lessons, and persists per-lesson tick marks (completed)
 * so a finished lesson stays ticked across reloads. Stored in localStorage
 * under `seren_lesson_history`.
 */

const STORAGE_KEY = 'seren_lesson_history';
const MAX_PLANS = 50; // bounded like the Score Report history

/**
 * Stable signature of a roadmap's CONTENT (title + drill prompt) — used to
 * dedupe repeated saves of the same lessons. Deliberately NOT based on module
 * ids: the LLM reuses generic ids like 'module-1'...'module-4' for every test,
 * so id-based fingerprints would wrongly flag every NEW test's lessons as a
 * duplicate of the first stored one and silently drop them.
 */
export function lessonPlanFingerprint(modules: LessonRoadmapModule[]): string {
  return modules
    .map((m) => `${m.title || ''}::${m.practiceDrill?.prompt || m.description || ''}`)
    .join('|');
}

export function loadLessonHistory(): SavedLessonPlan[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (p): p is SavedLessonPlan =>
          p &&
          typeof p.id === 'string' &&
          typeof p.savedAt === 'number' &&
          Array.isArray(p.modules)
      )
      .map((p) => ({
        ...p,
        // Normalize fingerprints: entries saved by the old id-based version
        // (module-1|module-2|...) get their content fingerprint recomputed so
        // dedupe works correctly for them too.
        fingerprint: lessonPlanFingerprint(p.modules),
      }))
      .sort((a, b) => b.savedAt - a.savedAt); // newest first
  } catch {
    return [];
  }
}

function persist(plans: SavedLessonPlan[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(plans));
  } catch {
    // storage may be full or blocked — the app keeps working in-memory.
  }
}

/**
 * Store the roadmap of a freshly completed evaluation (if not already stored).
 * Returns the updated plan list (newest first). Completion tick marks already
 * recorded on an existing plan are never reset by a duplicate save.
 */
export function saveLessonPlan(
  evaluation: SpeakingEvaluation,
  opts: { source: SavedLessonPlan['source']; testId?: string; testLabel?: string }
): SavedLessonPlan[] {
  const modules = Array.isArray(evaluation.lessonRoadmap) ? evaluation.lessonRoadmap : [];
  if (modules.length === 0) return loadLessonHistory();

  const fingerprint = lessonPlanFingerprint(modules);
  const plans = loadLessonHistory();

  // Same roadmap already stored (e.g. jumping back to an old report) — keep
  // the original entry, including its tick marks.
  if (plans.some((p) => p.fingerprint === fingerprint)) return plans;

  const entry: SavedLessonPlan = {
    id: `lessons-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    savedAt: Date.now(),
    source: opts.source,
    testId: opts.testId,
    testLabel: opts.testLabel || 'Custom Lessons',
    fingerprint,
    modules,
  };
  const next = [entry, ...plans].slice(0, MAX_PLANS);
  persist(next);
  return next;
}

/**
 * Tick a lesson off: mark it completed (with a timestamp) in the store.
 * Returns the updated plan list (newest first). No-op if plan/module is unknown.
 */
export function markLessonComplete(planId: string, moduleId: string): SavedLessonPlan[] {
  const plans = loadLessonHistory();
  const next = plans.map((p) =>
    p.id === planId
      ? {
          ...p,
          modules: p.modules.map((m) =>
            m.id === moduleId && !m.completed
              ? { ...m, completed: true, completedAt: Date.now() }
              : m
          ),
        }
      : p
  );
  persist(next);
  return next;
}

export function clearLessonHistory(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}