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
 *
 * A lesson plan is identified by the TEST it came from (source + testId), so
 * a regeneration of the same test REPLACES that plan in place instead of
 * adding a second, near-identical entry:
 *  - the EXISTING entry keeps its id and its position in the list, so the
 *    learner's per-module tick marks (completed / completedAt / score) are
 *    carried over for every module whose id still exists;
 *  - the module CONTENT is refreshed, so a retry that produced better or
 *    repaired modules actually shows up instead of leaving stale lessons;
 *  - plans without a testId (legacy entries) are matched by their content
 *    fingerprint instead, so the list never grows duplicates.
 *
 * Returns the updated plan list (newest first).
 */
export function saveLessonPlan(
  evaluation: SpeakingEvaluation,
  opts: { source: SavedLessonPlan['source']; testId?: string; testLabel?: string }
): SavedLessonPlan[] {
  const modules = Array.isArray(evaluation.lessonRoadmap) ? evaluation.lessonRoadmap : [];
  if (modules.length === 0) return loadLessonHistory();

  const fingerprint = lessonPlanFingerprint(modules);
  const plans = loadLessonHistory();

  // Identity: the test this plan belongs to. Fall back to the content
  // fingerprint for legacy plans that carry no testId.
  const existingIndex = opts.testId
    ? plans.findIndex(
        (p) => p.testId === opts.testId && p.source === opts.source
      )
    : plans.findIndex((p) => p.fingerprint === fingerprint);
  const fallbackIndex =
    existingIndex === -1 ? plans.findIndex((p) => p.fingerprint === fingerprint) : -1;
  const targetIndex = existingIndex !== -1 ? existingIndex : fallbackIndex;

  if (targetIndex !== -1) {
    // Same lessons already stored — update them in place, keeping the ticks.
    const existing = plans[targetIndex];
    const previousById = new Map(existing.modules.map((m) => [m.id, m]));
    const merged = modules.map((m) => {
      const previous = previousById.get(m.id);
      if (!previous) return m;
      // Keep the learner's completion state; take the fresh content.
      return {
        ...m,
        ...(previous.completed ? { completed: true, completedAt: previous.completedAt } : {}),
        ...(typeof previous.score === 'number' ? { score: previous.score } : {}),
      };
    });
    const next = [...plans];
    next[targetIndex] = { ...existing, modules: merged, fingerprint };
    persist(next);
    return next;
  }

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