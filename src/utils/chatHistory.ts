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

// ---------------------------------------------------------------------------
// Merging two devices' chat histories.
//
// A plain last-write-wins replace means two devices that both talked to Seren
// keep ERASING each other's conversations: whoever wrote last wins, and the
// other device's messages are gone (in the cloud AND locally). The interview
// thread is a conversation, not a preference — it must be UNIONED, not
// overwritten. Messages carry unique ids, so a union is exact and lossless.
// ---------------------------------------------------------------------------

export interface ChatHistoryBundle {
  Interview: ChatMessage[];
  'Casual Chat': ChatMessage[];
}

function parseHistory(raw: string | null | undefined): ChatHistoryBundle | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return {
      Interview: Array.isArray(parsed.Interview) ? filterValidMessages(parsed.Interview) : [],
      'Casual Chat': Array.isArray(parsed['Casual Chat'])
        ? filterValidMessages(parsed['Casual Chat'])
        : [],
    };
  } catch {
    return null;
  }
}

/**
 * Newest activity in a thread (0 when the thread is empty).
 */
function lastActivity(messages: ChatMessage[]): number {
  let newest = 0;
  for (const m of messages) {
    const t = m?.timestamp || 0;
    if (t > newest) newest = t;
  }
  return newest;
}

/**
 * Merge two chat histories, THREAD BY THREAD.
 *
 * A thread is a transcript, not a bag of messages: interleaving two
 * independent conversations (an old greeting in the middle of a new one)
 * makes no sense, and unioning them also resurrects stale fragments of
 * sessions that are weeks old. So each thread is decided on its own:
 *
 *   - the thread whose LAST MESSAGE is more recent wins  → the current
 *     conversation replaces the old one;
 *   - a thread that is empty on one side never erases the other side;
 *   - on a tie, the messages are unioned (nothing is lost).
 *
 * The comparison uses the newest MESSAGE timestamp, not the timestamp of the
 * localStorage key: the key's stamp says when the file was written (which
 * happens on any unrelated edit), while the message timestamps say when the
 * conversation actually happened.
 *
 * Returns null when either side cannot be parsed (the caller then falls back
 * to a plain replace rather than guessing).
 */
export function mergeChatHistories(
  localRaw: string | null | undefined,
  remoteRaw: string | null | undefined,
  /**
   * When the two threads have different recency, the timestamps say which one
   * is the current conversation. They ALSO decide the empty-vs-non-empty case:
   * an empty thread only erases the other side when the side that emptied it
   * is the newer one — otherwise it just means "this device never had that
   * thread" and erasing it would destroy the other device's conversation.
   */
  opts?: { localStamp?: number; remoteStamp?: number }
): string | null {
  const local = parseHistory(localRaw);
  const remote = parseHistory(remoteRaw);
  if (!local || !remote) return null;
  const localStamp = opts?.localStamp ?? 0;
  const remoteStamp = opts?.remoteStamp ?? 0;
  const merged: ChatHistoryBundle = { Interview: [], 'Casual Chat': [] };
  for (const mode of ['Interview', 'Casual Chat'] as const) {
    const localThread = local[mode];
    const remoteThread = remote[mode];
    const localLast = lastActivity(localThread);
    const remoteLast = lastActivity(remoteThread);
    if (localLast > remoteLast) {
      merged[mode] = localThread;
    } else if (remoteLast > localLast) {
      merged[mode] = remoteThread;
    } else if (localThread.length === 0 || remoteThread.length === 0) {
      // One side has no thread at all. It erases the other side ONLY when it is
      // the newer side — i.e. that device deliberately cleared the thread.
      const localIsNewer = localStamp > remoteStamp;
      merged[mode] = localIsNewer ? localThread : remoteThread;
    } else {
      // Same recency (or both empty) — union, de-duplicated by message id.
      const seen = new Set<string>();
      const all = [...localThread, ...remoteThread].sort(
        (a, b) => (a?.timestamp || 0) - (b?.timestamp || 0)
      );
      merged[mode] = all.filter((m) => {
        if (!m || seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });
    }
  }
  return JSON.stringify(merged);
}

/**
 * Notifies the app that a mirrored value changed underneath it. The sync
 * engine writes remote values straight into localStorage, but React components
 * that mirrored that storage into their own state would keep showing the old
 * value until they re-read. This event is the bridge.
 */
export const REMOTE_UPDATE_EVENT = 'seren:remote-update';

export function notifyRemoteUpdate(key: string): void {
  try {
    globalThis.dispatchEvent?.(
      new CustomEvent(REMOTE_UPDATE_EVENT, { detail: { key } }) as Event
    );
  } catch {
    // No DOM (tests / SSR) — nothing to notify.
  }
}

/**
 * Subscribe to chat-history changes made by the sync engine (a remote device
 * pushed an update) or by another tab of this same browser.
 */
export function subscribeToChatHistory(onChange: (key: string) => void): () => void {
  const remoteHandler = (event: Event) => {
    const key = (event as CustomEvent)?.detail?.key;
    onChange(typeof key === 'string' ? key : '');
  };
  const storageHandler = (event: StorageEvent) => {
    if (event.key) onChange(event.key);
  };
  globalThis.addEventListener?.(REMOTE_UPDATE_EVENT, remoteHandler as EventListener);
  globalThis.addEventListener?.('storage', storageHandler as EventListener);
  return () => {
    globalThis.removeEventListener?.(REMOTE_UPDATE_EVENT, remoteHandler as EventListener);
    globalThis.removeEventListener?.('storage', storageHandler as EventListener);
  };
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