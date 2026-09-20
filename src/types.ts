export type CEFRLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';

export type SerenMood = 'greeting' | 'speaking' | 'listening' | 'encouraging' | 'evaluating' | 'celebrating';

export interface UserProfile {
  nickname: string;
  goal: string; // e.g. 'IELTS Academic', 'IELTS General', 'Career & Job Interviews', 'Study Abroad', 'Daily Conversational Fluency'
  targetAudience: string; // e.g. 'IELTS Examiners', 'Native English Speakers', 'International Colleagues', 'University Professors'
  targetBand: string; // e.g. '6.5', '7.0', '7.5', '8.0', '8.5+'
  selfAssessedLevel: string; // e.g. 'A2 - Elementary', 'B1 - Intermediate', 'B2 - Upper Intermediate', 'C1 - Advanced'
  preferredFocus: string[]; // e.g. 'Fluency & Flow', 'Band 8+ Vocabulary', 'Grammar Precision', 'Pronunciation & Accent'
  joinedAt: number;
}

export interface DiagnosticQuestion {
  id: string;
  part: 1 | 2 | 3;
  partTitle: string;
  topic: string;
  question: string;
  instructions: string;
  prepTimeSeconds: number;
  speakTimeSeconds: number;
  bulletPoints?: string[];
  cueTips?: string[];
  sampleAnswer?: string;
}

export interface PillarScore {
  score: number; // 0 to 9 IELTS band style
  cefr: CEFRLevel;
  strengths: string[];
  growthAreas: string[];
  examinerCommentary: string;
}

export interface UpgradedExpression {
  original: string;
  upgraded: string;
  ieltsBand: string;
  explanation: string;
  part?: number;
  index?: number;
}

export interface PronunciationTip {
  word: string;
  ipa: string;
  phoneticSpelling: string;
  tip: string;
  exampleSentence: string;
  part?: number;
}

export interface LessonRoadmapModule {
  id: string;
  title: string;
  level: string;
  category: 'Fluency' | 'Vocabulary' | 'Grammar' | 'Part 2 Cue Card' | 'Pronunciation' | 'Examiner Strategy';
  duration: string;
  description: string;
  objectives: string[];
  // ONE specific skill this lesson drills (e.g. "third-conditional hypotheticals").
  // Stamped by the evaluation LLM, backfilled deterministically from the pillar
  // growth areas when the model omits it — see src/server/evaluation.ts.
  focusArea?: string;
  // One real sentence the student actually said that shows the error being fixed.
  exampleError?: string;
  practiceDrill: {
    type: 'rapid_fire' | 'cue_card' | 'lexical_boost' | 'shadowing' | 'mock_exam';
    prompt: string;
    modelBand9Sample: string;
    tips: string[];
  };
  completed?: boolean;
  completedAt?: number; // epoch ms — when the user finished the lesson drill
  score?: number;
}

export interface SpeakingEvaluation {
  overallCEFR: CEFRLevel;
  predictedIeltsBand: number; // e.g. 6.5
  cefrDescriptor: string;
  executiveSummary: string;
  // Optional provenance metadata stamped at evaluation time so the Score
  // Report can show WHICH Cambridge test (or practice session) a report is for.
  testId?: string; // e.g. 'cambridge-2026-test-1'
  testLabel?: string; // e.g. 'Cambridge 2026 (Test-1)'
  pillars: {
    fluency: PillarScore;
    lexical: PillarScore;
    grammar: PillarScore;
    pronunciation: PillarScore;
  };
  upgradedExpressions: UpgradedExpression[];
  pronunciationTips: PronunciationTip[];
  stats: {
    totalWords: number;
    estimatedWPM: number;
    pauseFluencyRating: 'Smooth' | 'Moderate Pauses' | 'Hesitant';
    varietyRating: 'High' | 'Good' | 'Repetitive';
  };
  lessonRoadmap: LessonRoadmapModule[];
}

export interface ChatMessage {
  id: string;
  sender: 'seren' | 'user';
  text: string;
  timestamp: number;
  mood?: SerenMood;
  // True once the user has edited the message in the chat bubble (optional,
  // so legacy/history messages simply render without the "(edited)" marker).
  edited?: boolean;
  audioSpoken?: boolean;
  feedback?: {
    correctedSentence?: string;
    lexicalBoost?: string[];
    ieltsTip?: string;
  };
}

/**
 * A completed evaluation persisted to report history (`seren_eval_history`).
 * Lets the Score Report tab list every past test and jump back into any of
 * them without losing older results when a new test overwrites the "active"
 * evaluation.
 */
export interface SavedReport {
  id: string; // unique history entry id
  completedAt: number; // epoch ms
  source: 'cambridge' | 'practice';
  testId?: string; // cambridge test id (evaluate-speech) or undefined for chat practice
  testLabel?: string; // human label e.g. 'Cambridge 2026 (Test-1)' or '1v1 Chat Practice'
  evaluation: SpeakingEvaluation;
}

/**
 * A lesson-roadmap snapshot stored in the Custom Lesson history
 * (`seren_lesson_history`). Every completed test / practice session keeps its
 * AI-generated lessons so a newer test NEVER deletes older ones — the list is
 * ordered newest first, and each lesson's completed tick mark persists here.
 */
export interface SavedLessonPlan {
  id: string; // unique lesson-history entry id
  savedAt: number; // epoch ms — drives the newest-first ordering
  source: 'cambridge' | 'practice';
  testId?: string;
  testLabel?: string; // human label e.g. 'Cambridge 2026 (Test-1)'
  fingerprint: string; // module-id signature used to dedupe repeated saves
  modules: LessonRoadmapModule[];
}
