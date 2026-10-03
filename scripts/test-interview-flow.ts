/**
 * Quick harness: locks the speaking-flow rules added for Part 0 + the part
 * transitions.
 *
 *   1. BOTH tabs use the same four Part-0 examiner lines (one source of truth),
 *      and none of them is ever scored or submitted to an evaluation API.
 *   2. The 1v1 Part-1 set spans 2 topics when the first topic holds 5+ questions
 *      and 3 topics when it holds 3-4, questions staying SEQUENTIAL inside each
 *      topic, with no topic repeated and the bank order preserved.
 *   3. The examiner's scripted transitions are wired into the first question of
 *      each part (Part 1 / Part 2 / Part 3).
 *
 * Mirrors the pattern of scripts/test-lesson-focus.ts:
 *   npx tsx scripts/test-interview-flow.ts
 */
import {
  buildPart1QuestionSet,
  getQuestionsByTopic,
  getUniqueTopics,
} from '../src/data/ieltsQuestionsP1';
import {
  IELTS_PART0_INTRO,
  asCambridgeQuestions,
  asInterviewSteps,
  isScoredPart,
} from '../src/data/part0Intro';
import { CAMBRIDGE_TESTS } from '../src/data/cambridgeTests';
import {
  PART1_TRANSITION_LINE,
  PART2_TRANSITION_LINE,
  cambridgeQuestionOpener,
  examInterviewClosing,
  part3TransitionLine,
} from '../src/utils/greetings';

const assert = (cond: unknown, message: string) => {
  if (!cond) throw new Error(message);
};

const flatTopics = (questions: { topic: string }[]) => {
  const seen: string[] = [];
  for (const q of questions) {
    if (seen[seen.length - 1] !== q.topic) seen.push(q.topic);
  }
  return seen;
};

// ---------------------------------------------------------------------------
// 1. Part-0 parity between the two tabs
// ---------------------------------------------------------------------------
assert(IELTS_PART0_INTRO.length === 4, 'Part 0 should hold exactly 4 examiner lines');

const interviewSteps = asInterviewSteps();
assert(interviewSteps.length === IELTS_PART0_INTRO.length, '1v1 adapter dropped a Part-0 line');
interviewSteps.forEach((step, i) => {
  assert(step.part === 'Part 0', `1v1 Part-0 step ${i} must be tagged 'Part 0'`);
  assert(step.instruction === IELTS_PART0_INTRO[i].question, `1v1 Part-0 step ${i} question mismatch`);
  assert(step.response === IELTS_PART0_INTRO[i].sampleAnswer, `1v1 Part-0 step ${i} hint mismatch`);
});

const cambridgeSteps = asCambridgeQuestions('cambridge-2026-test-1');
cambridgeSteps.forEach((step, i) => {
  assert(step.part === 0, `Cambridge Part-0 step ${i} must be part 0`);
  assert(step.question === IELTS_PART0_INTRO[i].question, `Cambridge Part-0 step ${i} question mismatch`);
  assert(step.sampleAnswer === IELTS_PART0_INTRO[i].sampleAnswer, `Cambridge Part-0 step ${i} hint mismatch`);
  assert(step.prepTimeSeconds === 0, `Cambridge Part-0 step ${i} must not use a prep phase`);
  assert(step.speakTimeSeconds > 0, `Cambridge Part-0 step ${i} needs a speaking window`);
});
assert(
  IELTS_PART0_INTRO.every((item) => item.sampleAnswer.trim().length > 20),
  'every Part-0 line needs a real model answer for the Hint button'
);
assert(
  interviewSteps.every((step) => isScoredPart(0) === false),
  'Part 0 must never be scored'
);
assert(
  isScoredPart(1) && isScoredPart(2) && isScoredPart(3) && !isScoredPart(0),
  'isScoredPart must accept only Part 1 | 2 | 3'
);

// ---------------------------------------------------------------------------
// 2. The 1v1 Part-1 topic rule (400 random runs)
// ---------------------------------------------------------------------------
for (let run = 0; run < 400; run++) {
  const { topics, questions } = buildPart1QuestionSet([]);
  assert(topics.length > 0 && questions.length > 0, 'a run must always produce questions');
  assert(new Set(topics).size === topics.length, 'a run must never repeat a topic');

  const firstTopicCount = getQuestionsByTopic(topics[0]).length;
  const expectedTopics = firstTopicCount >= 5 ? 2 : 3;
  assert(
    topics.length === expectedTopics,
    `first topic "${topics[0]}" has ${firstTopicCount} questions → expected ${expectedTopics} topics, got ${topics.length}`
  );

  // Every topic contributes its whole bank set, in bank order, back to back.
  for (const topic of topics) {
    const fromRun = questions.filter((q) => q.topic === topic).map((q) => q.instruction);
    const bank = getQuestionsByTopic(topic).map((q) => q.instruction);
    assert(fromRun.length === bank.length, `topic "${topic}" is not asked in full`);
    assert(fromRun.join('|') === bank.join('|'), `topic "${topic}" questions are out of bank order`);
  }

  // Topics appear one after another (sequential), never interleaved.
  assert(flatTopics(questions).join(',') === topics.join(','), 'topics are interleaved instead of sequential');
  assert(
    questions.every((q) => q.part === 'Part 1' && !!q.response),
    'Part-1 questions must keep the Cambridge book shape (part + model answer)'
  );
}

// ---------------------------------------------------------------------------
// 3. Exclusions + graceful degradation
// ---------------------------------------------------------------------------
const everyTopic = getUniqueTopics();
const empty = buildPart1QuestionSet(everyTopic);
assert(empty.topics.length === 0 && empty.questions.length === 0, 'an exhausted bank must return an empty set');

const halfBank = everyTopic.slice(0, Math.floor(everyTopic.length / 2));
const partial = buildPart1QuestionSet(halfBank);
assert(partial.topics.length >= 1, 'excluding half the bank must still yield a run');
assert(
  partial.topics.every((t) => !halfBank.includes(t)),
  'excluded topics must never be picked'
);

// ---------------------------------------------------------------------------
// 4. What the evaluation APIs actually receive
// ---------------------------------------------------------------------------
const flow = [...asInterviewSteps(), ...buildPart1QuestionSet([]).questions];
const scored = flow.map((step, index) => ({ step, index })).filter(({ step }) => step.part !== 'Part 0');
assert(scored.length === flow.length - 4, 'exactly the 4 Part-0 steps must be filtered out');
assert(scored.every(({ step }) => step.part === 'Part 1'), 'only Part-1 steps may be scored');

// The Part-1 transition is spoken EXACTLY once — at the Part-0 -> Part-1
// boundary (this mirrors the `opensPart1` check inside askQuestion).
const boundaryIdx = flow.findIndex((step) => step.part !== 'Part 0');
const opensPart1 = flow.map(
  (step, i) => step.part !== 'Part 0' && i > 0 && flow[i - 1]?.part === 'Part 0'
);
assert(boundaryIdx === 4, 'Part 1 must begin right after the 4 Part-0 lines');
assert(
  opensPart1.filter(Boolean).length === 1 && opensPart1[boundaryIdx],
  'the Part-1 transition must fire once, and only on the first Part-1 question'
);

// ---------------------------------------------------------------------------
// 5. Cambridge flow: Part 0 first, then the test's untouched parts 1-3
// ---------------------------------------------------------------------------
const cambridgeTest = CAMBRIDGE_TESTS[0];
assert(!!cambridgeTest, 'no Cambridge test available');
const cambridgeFlow = [...asCambridgeQuestions(cambridgeTest.id), ...cambridgeTest.questions];
assert(
  cambridgeFlow.slice(0, 4).every((q) => q.part === 0),
  'a Cambridge run must open with the Part-0 identity check'
);
assert(
  cambridgeFlow.slice(4).every((q) => isScoredPart(q.part)),
  'the Cambridge bank keeps its Part 1-3 questions untouched'
);

// ---------------------------------------------------------------------------
// 6. The examiner's scripted transitions
// ---------------------------------------------------------------------------
assert(
  cambridgeQuestionOpener(1, 0) === PART1_TRANSITION_LINE,
  'the first Part-1 question must open with the Part-1 transition'
);
assert(
  cambridgeQuestionOpener(1, 1) !== PART1_TRANSITION_LINE,
  'later Part-1 questions keep the rotating framing lines'
);
assert(cambridgeQuestionOpener(2, 0) === PART2_TRANSITION_LINE, 'the cue card must open with the Part-2 transition');
assert(
  cambridgeQuestionOpener(3, 0, 'an interesting garden or park').includes('an interesting garden or park'),
  'the Part-3 transition must name the Part-2 topic'
);
assert(
  part3TransitionLine().length > 20 && cambridgeQuestionOpener(3, 1) !== part3TransitionLine(),
  'the Part-3 transition must be used once, and only for the first Part-3 question'
);
assert(
  PART1_TRANSITION_LINE === "Now, in this first part, I'd like to ask you some questions about yourself.",
  'the Part-1 transition must stay the examiner\'s exact wording'
);
assert(
  examInterviewClosing() === 'Thank you. That is the end of the speaking test.',
  'the closing line must stay the examiner\'s exact wording'
);

console.log('INTERVIEW FLOW TEST: PASS');
