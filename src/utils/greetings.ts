/**
 * Greeting scripts — gathered into this single module so no duplicate welcome
 * strings are in-lined across the app. Import these helpers anywhere Seren
 * speaks or shows a welcome message instead of pasting the text by hand.
 *
 * Every helper returns the exact same text that used to be scattered inline so
 * nothing changes perceptibly for the user.
 */

/** Chat — Interview mode: 1v1 IELTS speaking session greeting (bubble + voice). */
export function greetInterview(nickname: string): string {
  return `Hey ${nickname}! Welcome to your 1v1 IELTS speaking session. Let's have a little chat — I'll ask you some questions, so just be yourself and answer naturally in 2-3 sentences.`;
}

/** Chat — Casual mode: the first message sent to the server to start the chat. */
export function casualSessionOpener(): string {
  return `Hey! Let's just chat — no exams, no pressure. What's been on your mind today?`;
}

/** Chat — Casual mode: built-in opener used when the server/LLM is unavailable. */
export function casualFallbackOpener(nickname: string): string {
  return `Hey ${nickname}, good to see you! What's been going on with you today?`;
}

/** Cambridge test — welcome banner/speech for the Cambridge IELTS practice tab. */
export function cambridgeGreetingIntro(nickname: string): string {
  return `Hi ${nickname}! Welcome to your Cambridge IELTS speaking practice.`;
}
export const cambridgeGreetingPrompt = 'Which test would you like to begin with today?';
export function cambridgeGreeting(nickname: string): string {
  return `${cambridgeGreetingIntro(nickname)} ${cambridgeGreetingPrompt}`;
}

// ---- Cambridge test — per-question spoken variety ---------------------------
// Repeating the same opener/closing on every question sounds robotic, so Seren
// rotates natural examiner lines instead. Selection is index-based (matched to
// the question's position within its part) so the spoken text stays stable and
// replayable for any given question while still differing between questions.

const PART1_OPENERS = [
  "Let's begin with Part 1.",
  'Alright, onto the next one.',
  "Here's your next question.",
  "Let's keep the conversation going.",
  'Moving right along with Part 1.',
  "Now, the last one.",
];

const PART3_OPENERS = [
  "And finally, Part 3 — let's discuss this in more depth.",
  "Now let's dig a little deeper.",
  "For this one, I'd like your opinion.",
  "Let's zoom out and look at the bigger picture.",
  "Here's a more thoughtful question for you.",
  "Staying in Part 3, let's take this further.",
];

const PART1_CLOSINGS = [
  'Take a breath, and answer naturally.',
  'Just speak freely — there are no wrong answers.',
  'Keep it personal, and give an example if you can.',
  'Two or three sentences is perfect here.',
  'Relax, and say whatever comes to mind.',
];

const PART3_CLOSINGS = [
  'Think broadly, and share a balanced view.',
  'Consider both sides before you answer.',
  'Back up your opinion with a reason or example.',
  "There's no right answer — just reason it out clearly.",
  'Take a moment to structure your thoughts, then dive in.',
];

function pickRotating(list: string[], partQuestionIndex: number): string {
  return list[partQuestionIndex % list.length];
}

/** Spoken opener for a Cambridge test question (varies per question). */
export function cambridgeQuestionOpener(part: 1 | 2 | 3, partQuestionIndex: number): string {
  if (part === 1) return pickRotating(PART1_OPENERS, partQuestionIndex);
  if (part === 2) return 'Now for Part 2, here is your cue card.';
  return pickRotating(PART3_OPENERS, partQuestionIndex);
}

/** Spoken closing for a Cambridge test question (varies per question). */
export function cambridgeQuestionClosing(part: 1 | 2 | 3, partQuestionIndex: number): string {
  if (part === 1) return pickRotating(PART1_CLOSINGS, partQuestionIndex);
  if (part === 2) return 'One minute to prepare.';
  return pickRotating(PART3_CLOSINGS, partQuestionIndex);
}

/**
 * Lesson studio — opening line when entering a roadmap module.
 *
 * Displayed text STOPS at "Let's master this concept." — the practice prompt
 * itself is never shown in Seren's speech box (it already has its own
 * "Interactive Drill Prompt" panel on screen). Use lessonModuleIntroSpeech for
 * the version Seren reads ALOUD, which includes the prompt.
 *
 * Follow-up questions Seren asks in her replies are unaffected — they come from
 * the chat API and are always kept.
 */
export function lessonModuleIntro(moduleTitle: string, nickname: string): string {
  return `Welcome to "${moduleTitle}", ${nickname}! Let's master this concept.`;
}

/** Spoken intro: same welcome PLUS the practice prompt, read aloud only. */
export function lessonModuleIntroSpeech(moduleTitle: string, nickname: string, practicePrompt: string): string {
  return `${lessonModuleIntro(moduleTitle, nickname)} Here is your practice prompt: ${practicePrompt}`;
}

/** Server — Casual chat greeting reply when the message is a simple hello/hi/hey. */
export function casualGreetingReply(nickname: string): string {
  return `Hey ${nickname}! Good to see you. So what's been going on — how's your day treating you?`;
}

/** Server — Interview/tutor greeting reply when the message is a simple hello/hi/hey. */
export function tutorGreetingReply(nickname: string): string {
  return `Hello ${nickname}! I'm so thrilled to be your English tutor today. What topic would you like to practice, or shall we dive straight into an IELTS mock question?`;
}