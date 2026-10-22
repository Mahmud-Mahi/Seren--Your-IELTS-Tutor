/**
 * Regression harness for Seren's lesson greeting.
 *
 * Bug: the "resume a saved lesson" path returned early from the module
 * effect, which also skipped the greeting. Seren was left mute in the
 * "greeting" mood with NO dialogue bubble at all — the lesson screen looked
 * broken on every visit after the first one, and only on the device that
 * had a saved session.
 *
 * A resumed lesson must still produce a spoken line AND a bubble.
 *
 * Run with: npm run test:lesson-greeting
 */
import {
  lessonModuleGreeting,
  lessonModuleIntro,
  lessonModuleIntroSpeech,
  lessonModuleResumeIntro,
} from '../src/utils/greetings';

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

const TITLE = 'Subject-Verb Agreement with Indefinite Pronouns';
const PROMPT = 'Say the corrected version aloud, then make one new sentence.';

// --- a fresh lesson --------------------------------------------------------
const fresh = lessonModuleGreeting({
  moduleTitle: TITLE,
  nickname: 'Mahi',
  practicePrompt: PROMPT,
  errorAnalysis: "'Some' needs the plural verb 'use'.",
  correction: 'some use mobile phones',
});
check('a fresh lesson has bubble text', fresh.display.length > 0);
check('a fresh lesson greets by name', fresh.display.includes('Mahi'));
check('a fresh lesson names the module', fresh.display.includes(TITLE));
check('a fresh lesson reads the practice prompt aloud', fresh.spoken.includes(PROMPT));
check('a fresh lesson reads the correction aloud', fresh.spoken.includes('some use mobile phones'));

// --- a RESUMED lesson (the bug) -------------------------------------------
const resumed = lessonModuleGreeting({
  moduleTitle: TITLE,
  nickname: 'Mahi',
  practicePrompt: PROMPT,
  resuming: true,
});
check('a RESUMED lesson still has bubble text', resumed.display.length > 0);
check('a RESUMED lesson still has something to SAY', resumed.spoken.length > 0);
check('a resumed lesson says welcome back', resumed.display.includes('Welcome back'));
check('a resumed lesson names the module', resumed.display.includes(TITLE));
check('a resumed lesson greets by name', resumed.display.includes('Mahi'));
check(
  'a resumed lesson does NOT replay the whole first-time welcome',
  !resumed.display.includes("Let's master this concept")
);

// --- degenerate input -----------------------------------------------------
const noTitle = lessonModuleGreeting({ moduleTitle: '', nickname: 'Mahi' });
check('a missing title still yields a spoken line', noTitle.spoken.length > 0);
check('a missing title still yields bubble text', noTitle.display.length > 0);

const noNickname = lessonModuleGreeting({ moduleTitle: TITLE, nickname: '' });
check('a missing nickname still yields a spoken line', noNickname.spoken.length > 0);

// --- the individual helpers ----------------------------------------------
check('lessonModuleIntro greets by name', lessonModuleIntro(TITLE, 'Mahi').includes('Mahi'));
check(
  'lessonModuleIntroSpeech appends the prompt',
  lessonModuleIntroSpeech(TITLE, 'Mahi', PROMPT).includes(PROMPT)
);
check(
  'lessonModuleResumeIntro says welcome back',
  lessonModuleResumeIntro(TITLE, 'Mahi').startsWith('Welcome back')
);

console.log('');
console.log(fail === 0 ? `ALL PASS (${pass} checks)` : `${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
