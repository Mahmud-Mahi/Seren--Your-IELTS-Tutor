import { ChatMessage } from '../types';

/**
 * TWO separate chat threads — one per mode — like two distinct WhatsApp chats
 * with the same person:
 *   • Interview  : IELTS practice questions, answers, evaluation
 *   • Casual Chat: friendly conversation
 * They never mix. Both persist to localStorage under `seren_chat_history`.
 */

const STORAGE_KEY = 'seren_chat_history';
export type ChatMode = 'Interview' | 'Casual Chat';

export function loadMessagesByMode(): Record<ChatMode, ChatMessage[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { Interview: [], 'Casual Chat': [] };
    const parsed = JSON.parse(raw);
    // Migrate old single-thread format (flat array) into the casual thread.
    if (Array.isArray(parsed)) {
      return { Interview: [], 'Casual Chat': filterValidMessages(parsed) };
    }
    if (parsed && typeof parsed === 'object') {
      return {
        Interview: Array.isArray(parsed.Interview) ? filterValidMessages(parsed.Interview) : [],
        'Casual Chat': Array.isArray(parsed['Casual Chat']) ? filterValidMessages(parsed['Casual Chat']) : [],
      };
    }
    return { Interview: [], 'Casual Chat': [] };
  } catch {
    return { Interview: [], 'Casual Chat': [] };
  }
}

export function saveMessagesByMode(messages: Record<ChatMode, ChatMessage[]>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
  } catch {
    // storage may be full or blocked — the app keeps working in-memory.
  }
}

function filterValidMessages(list: any[]): ChatMessage[] {
  return list.filter(
    (m): m is ChatMessage =>
      m &&
      typeof m.id === 'string' &&
      (m.sender === 'user' || m.sender === 'seren') &&
      typeof m.text === 'string' &&
      typeof m.timestamp === 'number'
  );
}

export function newMessageId(prefix = 'msg'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function clearChatMessages(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

// ---- Interview session persistence ----
// The chat bubbles above survive reloads, but the interview's STATE MACHINE
// (which topic, which questions, which index, which answers) lives in React
// state and used to reset to empty. Answering a question after a reload then
// advanced `askQuestion(idx)` against an empty question list, which printed
// "That was the last question" after the very first response. Persisting the
// session lets the resume path rehydrate the full question flow.
const SESSION_KEY = 'seren_interview_session';

export interface StoredInterviewQuestion {
  topic: string;
  part: string;
  instruction: string;
  response: string;
}

export interface InterviewSessionState {
  topic: string;
  questions: StoredInterviewQuestion[];
  currentQuestionIdx: number;
  userAnswers: Record<number, string>;
  lastAnsweredIdx: number;
}

export function loadInterviewSession(): InterviewSessionState | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.topic === 'string' &&
      Array.isArray(parsed.questions) &&
      parsed.questions.length > 0
    ) {
      return {
        topic: parsed.topic,
        questions: parsed.questions,
        currentQuestionIdx: typeof parsed.currentQuestionIdx === 'number' ? parsed.currentQuestionIdx : 0,
        userAnswers: parsed.userAnswers && typeof parsed.userAnswers === 'object' ? parsed.userAnswers : {},
        lastAnsweredIdx: typeof parsed.lastAnsweredIdx === 'number' ? parsed.lastAnsweredIdx : -1,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveInterviewSession(state: InterviewSessionState | null): void {
  try {
    if (state === null) {
      localStorage.removeItem(SESSION_KEY);
    } else {
      localStorage.setItem(SESSION_KEY, JSON.stringify(state));
    }
  } catch {
    // storage may be full or blocked — the app keeps working in-memory.
  }
}