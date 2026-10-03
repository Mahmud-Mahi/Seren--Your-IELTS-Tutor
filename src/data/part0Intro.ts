import type { DiagnosticQuestion } from '../types';
import type { IELTSPart1Question } from './ieltsQuestionsP1';

/**
 * Part 0 — the live examiner's introduction + identity check.
 *
 * This is the ONE place the Part-0 script lives: the Cambridge Test tab AND the
 * 1v1 Interview tab both build their flow from `IELTS_PART0_INTRO`, so the
 * examiner's opening lines (and the Part-1 transition that follows them) are
 * always identical in the two modes.
 *
 * In the real test this stage is NOT marked, so Part-0 answers are never sent to
 * the evaluation APIs. Each `sampleAnswer` exists purely for the Hint button,
 * which shows the learner how a natural identity-check reply sounds.
 */
export interface InterviewIntroItem {
  id: string;
  /** Examiner's spoken line (read aloud and shown on screen). */
  question: string;
  /** Model reply revealed by the Hint button — never scored, never submitted. */
  sampleAnswer: string;
}

export const IELTS_PART0_TOPIC = 'Introduction';
export const IELTS_PART0_PART_TITLE = 'Part 0: Introduction & Identity Check';

export const IELTS_PART0_INTRO: InterviewIntroItem[] = [
  {
    id: 'part0-full-name',
    question:
      "Good morning. My name is Seren, and I'll be your examiner today. Can you tell me your full name, please?",
    sampleAnswer:
      'Good morning. My full name is Mahmudur Rahman Mahi — Mahi for short.',
  },
  {
    id: 'part0-call-you',
    question: 'Thank you. And what shall I call you?',
    sampleAnswer: "You can just call me Mahi — that's what everyone calls me.",
  },
  {
    id: 'part0-hometown',
    question: "Can you tell me where you're from?",
    sampleAnswer:
      "I'm from Dhaka, the capital of Bangladesh. I've lived there all my life, so it's very much home — crowded and chaotic at times, but I know every corner of it.",
  },
  {
    id: 'part0-warmup',
    question: 'Lovely. And how are you today?',
    sampleAnswer:
      "I'm very well, thank you — a little nervous, if I'm honest, but mostly just keen to get started.",
  },
];

/**
 * 1v1 Interview tab: the Part-0 items expressed in the existing question-bank
 * shape (`part: 'Part 0'`) so the interview's question flow, session
 * persistence and mic handoff all work without any structural change.
 */
export function asInterviewSteps(): IELTSPart1Question[] {
  return IELTS_PART0_INTRO.map((item) => ({
    topic: IELTS_PART0_TOPIC,
    part: 'Part 0',
    instruction: item.question,
    response: item.sampleAnswer,
  }));
}

/**
 * Cambridge Test tab: the same four lines as `DiagnosticQuestion` steps with
 * `part: 0`. They carry no prep phase and a short 30-second speaking window —
 * an identity check has no exam timer, but the flow still needs a bound.
 */
export function asCambridgeQuestions(testId: string): DiagnosticQuestion[] {
  return IELTS_PART0_INTRO.map((item, index) => ({
    id: `${testId}-part-0-${index + 1}`,
    part: 0,
    partTitle: IELTS_PART0_PART_TITLE,
    topic: IELTS_PART0_TOPIC,
    question: item.question,
    instructions:
      'This is the identity check — it is not scored. Answer naturally in one or two sentences.',
    prepTimeSeconds: 0,
    speakTimeSeconds: 30,
    cueTips: [
      'Keep it short and natural — this stage is not assessed.',
      'A full sentence sounds better than a single word.',
      'Use the Hint button if you want to see a model reply.',
    ],
    sampleAnswer: item.sampleAnswer,
  }));
}

/** True for every step that actually gets scored (Part 1 | 2 | 3). */
export function isScoredPart(part: number): boolean {
  return part === 1 || part === 2 || part === 3;
}
