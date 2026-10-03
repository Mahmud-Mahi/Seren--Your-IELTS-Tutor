import rawQuestions from '../../assets/ielts-questions-p1.json';

export interface IELTSPart1Question {
  topic: string;
  part: string;
  instruction: string;
  response: string;
}

export const IELTS_P1_QUESTIONS: IELTSPart1Question[] = (rawQuestions as any[]).map((q) => ({
  topic: String(q.topic || ''),
  part: String(q.part || ''),
  instruction: String(q.instruction || ''),
  response: String(q.response || ''),
}));

export function getUniqueTopics(): string[] {
  return [...new Set(IELTS_P1_QUESTIONS.map((q) => q.topic))];
}

export function getQuestionsByTopic(topic: string): IELTSPart1Question[] {
  return IELTS_P1_QUESTIONS.filter((q) => q.topic === topic);
}

export function pickRandomTopic(exclude: string[]): string | null {
  const available = getUniqueTopics().filter((t) => !exclude.includes(t));
  if (available.length === 0) return null;
  return available[Math.floor(Math.random() * available.length)];
}

/**
 * Builds the Part-1 question set for ONE 1v1 interview run.
 *
 * Rule (mirrors how a real Part 1 spans several topic sets):
 *  - the FIRST topic is picked at random, skipping every `exclude`d topic,
 *  - if that topic holds 5 or more questions the run spans 2 topics,
 *  - if it holds 3-4 questions the run spans 3 topics,
 *  - inside every topic the questions stay SEQUENTIAL (bank order) and are
 *    asked topic after topic; no topic is ever repeated inside a run.
 *
 * Questions are never reshaped or rewritten — the Cambridge IELTS book format
 * of the bank is preserved (`topic` / `part` / `instruction` / `response`).
 */
export function buildPart1QuestionSet(exclude: string[] = []): {
  topics: string[];
  questions: IELTSPart1Question[];
} {
  const used = new Set(exclude);

  const pickTopic = (): string | null => {
    const available = getUniqueTopics().filter((t) => !used.has(t));
    if (available.length === 0) return null;
    return available[Math.floor(Math.random() * available.length)];
  };

  const first = pickTopic();
  if (!first) return { topics: [], questions: [] };
  used.add(first);

  // A large first topic already fills the run, so two topics are enough;
  // a small one needs a third to reach a Part-1-sized conversation.
  const targetTopicCount = getQuestionsByTopic(first).length >= 5 ? 2 : 3;

  const topics: string[] = [first];
  const questions: IELTSPart1Question[] = [...getQuestionsByTopic(first)];

  while (topics.length < targetTopicCount) {
    const next = pickTopic();
    if (!next) break; // bank exhausted — run with the topics we already have
    used.add(next);
    topics.push(next);
    questions.push(...getQuestionsByTopic(next));
  }

  return { topics, questions };
}
