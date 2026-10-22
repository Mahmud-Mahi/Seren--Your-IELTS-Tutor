/**
 * Regression harness for the lesson RESUME path.
 *
 * Bug: the lesson autosave wrote an all-empty session record the moment the
 * Custom Lessons tab opened — before the learner had answered anything:
 *
 *   { feedbackHistory: [], followUpCount: 0, conversationHistory: [],
 *     lessonSummary: null, userSpokenText: '', localCompleted: {} }
 *
 * On the NEXT visit `loadLessonSessionInit` found that empty record and
 * returned it, so the app took the RESUME branch and Seren greeted the
 * learner with "Welcome back … Let's pick up where you left off." — skipping
 * the drill prompt, the error analysis and the corrected sentence, which the
 * first-time path reads aloud.
 *
 * The desktop app hit this on EVERY launch (its localStorage survives
 * restarts), while the web app usually had no record at all. Same code,
 * different behaviour — the desktop app looked muted, the web app didn't.
 *
 * The fix: an empty session is NOT a session. Only a session with real work
 * may be resumed.
 *
 * Run with: npm run test:lesson-session
 */
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};

import { lessonModuleGreeting } from '../src/utils/greetings';
import {
  loadLessonSessionInit,
  saveLessonSession,
  hasSessionContent,
  type LessonSessionFields,
} from '../src/autosave/lessonSession';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean) => {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}`);
  }
};

const PLAN_ID = 'lessons-1-test';
const MODULE_ID = 'module-1';

const plans = [
  {
    id: PLAN_ID,
    modules: [
      { id: MODULE_ID, title: 'Subject-Verb Agreement with Indefinite Pronouns' },
      { id: 'module-2', title: 'Mixed Conditionals' },
    ],
  },
] as any;

const EMPTY: LessonSessionFields = {
  feedbackHistory: [],
  followUpCount: 0,
  conversationHistory: [],
  lessonSummary: null,
  userSpokenText: '',
  localCompleted: {},
};

// --- hasSessionContent ---------------------------------------------------
check('an empty session has NO content', !hasSessionContent(EMPTY));
check('a session with feedback rounds has content', hasSessionContent({ ...EMPTY, feedbackHistory: [{ a: 1 }] }));
check('a session with follow-ups has content', hasSessionContent({ ...EMPTY, followUpCount: 2 }));
check('a session with conversation has content', hasSessionContent({ ...EMPTY, conversationHistory: [{ q: 'x' }] }));
check('a session with a draft answer has content', hasSessionContent({ ...EMPTY, userSpokenText: 'my answer' }));
check('a session with a wrap-up summary has content', hasSessionContent({ ...EMPTY, lessonSummary: { improved: ['a'], toTargetBand: ['b'] } }));
check('a whitespace-only draft is NOT content', !hasSessionContent({ ...EMPTY, userSpokenText: '   ' }));

// --- THE BUG: the phantom empty session ---------------------------------
// Opening the tab writes an empty session (this is what the autosave does).
saveLessonSession(PLAN_ID, MODULE_ID, EMPTY);

// The stored record exists — that is exactly the state the desktop app was
// stuck in.
const rawStored = (globalThis as any).localStorage.getItem(`seren_autosave_lesson.session.${PLAN_ID}::${MODULE_ID}`);
check('the empty session WAS written to storage', !!rawStored);

// ...but it must NOT be treated as a resumable session.
const init = loadLessonSessionInit(plans);
check('an EMPTY session still resolves the last-open module', init !== null);
check('an EMPTY session is flagged as having NO content', init?.hasContent === false);

// --- a REAL session is still resumed ------------------------------------
saveLessonSession(PLAN_ID, MODULE_ID, {
  ...EMPTY,
  feedbackHistory: [{ original: 'x', corrected: 'y' }],
});
const realInit = loadLessonSessionInit(plans);
check('a session with real work IS resumed', realInit !== null);
check('a session with real work is flagged as having content', realInit?.hasContent === true);
check('the resumed session restores the rounds', (realInit?.feedbackHistory?.length ?? 0) === 1);
check('the resumed session points at the right module', realInit?.module?.id === MODULE_ID);

// --- a session with only a draft answer is resumed ----------------------
saveLessonSession(PLAN_ID, MODULE_ID, { ...EMPTY, userSpokenText: 'some uses mobile phone' });
const draftInit = loadLessonSessionInit(plans);
check('a session with only a draft answer IS resumed', draftInit !== null);
check('the draft answer is restored', draftInit?.userSpokenText === 'some uses mobile phone');

// --- a stale pointer to an unknown plan resolves to null ----------------
store.set('seren_autosave_lesson.active', JSON.stringify({ planId: 'gone', moduleId: 'module-1', savedAt: 1 }));
check('a stale pointer resolves to null', loadLessonSessionInit(plans) === null);

// --- the greeting the app will actually use -----------------------------
// Never-started lesson → hasContent === false → the FIRST-TIME path → the
// drill is read aloud (identical to the web app).
saveLessonSession(PLAN_ID, MODULE_ID, EMPTY);
const neverStarted = loadLessonSessionInit(plans);
const freshGreeting = lessonModuleGreeting({
  moduleTitle: 'Subject-Verb Agreement with Indefinite Pronouns',
  nickname: 'Mahi',
  practicePrompt: 'Say the corrected sentence aloud.',
  errorAnalysis: "'Some' needs the plural verb 'use'.",
  correction: 'some use mobile phones',
  resuming: neverStarted?.hasContent === true,
});
check('a never-started lesson reads the drill prompt aloud', freshGreeting.spoken.includes('Say the corrected sentence aloud.'));
check('a never-started lesson reads the error analysis aloud', freshGreeting.spoken.includes("'Some' needs the plural verb 'use'."));
check('a never-started lesson reads the correction aloud', freshGreeting.spoken.includes('some use mobile phones'));
check('a never-started lesson uses the FIRST-TIME welcome', freshGreeting.display.includes("Let's master this concept"));

// A lesson with real work → hasContent === true → the RESUME path → a short
// "Welcome back …" greeting (the drill is on screen already).
saveLessonSession(PLAN_ID, MODULE_ID, { ...EMPTY, feedbackHistory: [{ original: 'x' }] });
const withWork = loadLessonSessionInit(plans);
const resumeGreeting = lessonModuleGreeting({
  moduleTitle: 'Subject-Verb Agreement with Indefinite Pronouns',
  nickname: 'Mahi',
  practicePrompt: 'Say the corrected sentence aloud.',
  errorAnalysis: "'Some' needs the plural verb 'use'.",
  correction: 'some use mobile phones',
  resuming: withWork?.hasContent === true,
});
check('a lesson with real work uses the RESUME welcome', resumeGreeting.display.includes('Welcome back'));
check('a lesson with real work keeps the short resume greeting', !resumeGreeting.display.includes("Let's master this concept"));

console.log('');
console.log(fail === 0 ? `ALL PASS (${pass} checks)` : `${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);