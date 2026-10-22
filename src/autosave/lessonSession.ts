/**
 * Custom Lessons session — resume a drill mid-arc (e.g. left after
 * 2 follow-ups → reopen continues from the reply box, not from scratch).
 *
 * One slot per module (`lesson.session.<planId>::<moduleId>`) plus a pointer
 * to the last-open module (`lesson.active`): switching to a module with a
 * saved session restores it; switching to a fresh one starts clean.
 */
import { loadAutosave, saveAutosave } from './storage';
import type { LessonRoadmapModule, SavedLessonPlan } from '../types';

export interface LessonSessionFields {
  feedbackHistory: any[];
  followUpCount: number;
  conversationHistory: any[];
  lessonSummary: { improved: string[]; toTargetBand: string[] } | null;
  userSpokenText: string;
  localCompleted: Record<string, boolean>;
}

export interface LessonSession extends LessonSessionFields {
  savedAt: number;
}

/** Validated init data for a resume (plan + module resolved against live plans). */
export interface LessonSessionInit extends LessonSessionFields {
  planId: string;
  module: LessonRoadmapModule;
  /**
   * True when this session holds REAL learner work (see `hasSessionContent`).
   *
   * The app uses this to pick the greeting: a session with content is a
   * genuine RESUME ("Welcome back …"), while an empty one is still a FRESH
   * lesson — so Seren reads the drill prompt, the error analysis and the
   * corrected sentence aloud.
   */
  hasContent: boolean;
}

const ACTIVE_KEY = 'lesson.active';
const sessionKey = (planId: string, moduleId: string) =>
  `lesson.session.${planId}::${moduleId}`;

export function saveLessonSession(
  planId: string,
  moduleId: string,
  fields: LessonSessionFields
): void {
  if (!planId || !moduleId) return;
  saveAutosave(sessionKey(planId, moduleId), { ...fields, savedAt: Date.now() });
  saveAutosave(ACTIVE_KEY, { planId, moduleId, savedAt: Date.now() });
}

/**
 * True when the stored session holds REAL learner work.
 *
 * Why this exists:
 *
 * The autosave writes on EVERY commit — including the very first one, which
 * happens the moment the Custom Lessons tab opens, before the learner has
 * answered anything. That write created an all-empty session record:
 *
 *   { feedbackHistory: [], followUpCount: 0, conversationHistory: [],
 *     lessonSummary: null, userSpokenText: '', localCompleted: {} }
 *
 * On the NEXT visit, `loadLessonSessionInit` found that (empty) record, so
 * the app took the RESUME path and Seren greeted the learner with
 * "Welcome back … Let's pick up where you left off." instead of the
 * first-time welcome that reads the drill prompt, the error analysis and
 * the corrected sentence aloud.
 *
 * The desktop app hit this on every launch (its localStorage lives in
 * ~/.config/Seren and survives restarts), while the web app usually opened
 * with no record at all — which is exactly why the two behaved differently
 * despite being built from the same code.
 *
 * So: an empty session is NOT a session. Only a session with actual work
 * (feedback rounds, follow-ups, a draft answer or a wrap-up summary) may
 * be resumed.
 */
export function hasSessionContent(fields: LessonSessionFields): boolean {
  return (
    (fields.feedbackHistory?.length ?? 0) > 0 ||
    (fields.conversationHistory?.length ?? 0) > 0 ||
    (fields.followUpCount ?? 0) > 0 ||
    !!fields.lessonSummary ||
    !!(fields.userSpokenText || '').trim()
  );
}

/** Non-empty session fields shared by the resume init objects. */
function coerceFields(raw: any): LessonSessionFields {
  return {
    feedbackHistory: Array.isArray(raw?.feedbackHistory) ? raw.feedbackHistory : [],
    followUpCount: Number.isFinite(raw?.followUpCount) ? raw.followUpCount : 0,
    conversationHistory: Array.isArray(raw?.conversationHistory) ? raw.conversationHistory : [],
    lessonSummary:
      raw?.lessonSummary &&
      Array.isArray(raw.lessonSummary.improved) &&
      Array.isArray(raw.lessonSummary.toTargetBand)
        ? raw.lessonSummary
        : null,
    userSpokenText: typeof raw?.userSpokenText === 'string' ? raw.userSpokenText : '',
    localCompleted:
      raw?.localCompleted && typeof raw.localCompleted === 'object' && !Array.isArray(raw.localCompleted)
        ? raw.localCompleted
        : {},
  };
}

/**
 * Read once at LessonStudio mount: the last-open module + its saved rounds,
 * validated against the current plans (stale pointers resolve to null).
 *
 * The returned init ALWAYS points at the last-open module — reopening the
 * app should land the learner where they were, even if that module has no
 * work yet. `hasContent` then tells the screen whether this is a genuine
 * RESUME (real work to pick up) or a FRESH lesson (nothing done yet).
 *
 * That distinction matters: the autosave writes an all-empty record the
 * moment the tab opens, so without it every later visit would look like a
 * "resume" and Seren would skip the drill prompt, the error analysis and
 * the corrected sentence.
 */
export function loadLessonSessionInit(plans: SavedLessonPlan[]): LessonSessionInit | null {
  const active = loadAutosave<{ planId?: string; moduleId?: string } | null>(ACTIVE_KEY, null);
  if (!active?.planId || !active?.moduleId) return null;
  const plan = plans.find((p) => p.id === active.planId);
  const module = plan?.modules.find((m) => m.id === active.moduleId);
  if (!plan || !module) return null;
  const stored = loadAutosave<LessonSession | null>(sessionKey(active.planId, active.moduleId), null);
  if (!stored) return null;
  const fields = coerceFields(stored);
  return { planId: plan.id, module, ...fields, hasContent: hasSessionContent(fields) };
}

/**
 * Per-module read used when the user CLICKS another module in the roadmap —
 * previously a switch always reset to empty state and the autosave then
 * OVERWROTE the clicked module's saved transcript with that empty state
 * (destroying finished lessons' answers/follow-ups). Loading the saved session
 * on switch keeps every module's rounds reviewable and intact.
 */
export function loadLessonSession(
  planId: string,
  moduleId: string
): LessonSessionFields | null {
  if (!planId || !moduleId) return null;
  const stored = loadAutosave<LessonSession | null>(sessionKey(planId, moduleId), null);
  if (!stored) return null;
  return coerceFields(stored);
}
