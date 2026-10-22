import {
  buildLessonChatPrompt,
  buildLessonRoadmapPrompt,
  isUsableSpeakingQuestion,
} from '../src/server/prompts';

const screenshotWorksheetPrompts = [
  'Read each sentence Mahdi actually said. Spot the agreement error, say the corrected version aloud, then state the rule in one phrase.',
  'Complete 10 sentences where the subject is separated from the verb by a prepositional phrase.',
];

for (const worksheetPrompt of screenshotWorksheetPrompts) {
  if (isUsableSpeakingQuestion(worksheetPrompt)) {
    throw new Error(`Worksheet prompt was accepted as speaking practice: ${worksheetPrompt}`);
  }
}

const validQuestion = 'What places in your city are popular, and what makes them special?';
if (!isUsableSpeakingQuestion(validQuestion)) {
  throw new Error('A natural IELTS-style speaking question was rejected');
}

const roadmapPrompt = buildLessonRoadmapPrompt({
  userProfile: { nickname: 'Learner', targetBand: '7.0' },
  pillarsDigest: 'grammar: 5.5 - growth: subject-verb agreement',
  priorityErrorsBlock: '[E1|Grammar] "The parks is busy." - agreement -> fix: "The parks are busy."',
  transcriptsBlock: '[P1] The parks is busy.',
});
// The roadmap prompt now asks for a natural IELTS-style TRANSFER question
// (secondary practice, after the mistake-correction activity) instead of the
// old generic "one open-ended question" instruction.
if (!roadmapPrompt.includes('transferQuestion: one natural IELTS-style speaking question')) {
  throw new Error('Roadmap prompt does not require one spoken transfer question');
}

const livePrompt = buildLessonChatPrompt({
  lessonContext: {
    title: 'Plural subject agreement',
    focusArea: 'plural subject-verb agreement',
    drillPrompt: validQuestion,
  },
  followUpIndex: 0,
  conversationHistory: [],
  message: 'My answer is...',
});
if (!livePrompt.includes('Never ask them to complete a worksheet')) {
  throw new Error('Live lesson prompt does not prohibit worksheet follow-ups');
}

console.log('LESSON PROMPT TEST: PASS');