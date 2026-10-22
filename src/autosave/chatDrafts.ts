/**
 * 1v1 chat drafts — a typed-but-unsent message must survive tab/app switches
 * and reappear when the tab (or mode) is opened again. One record, one slot
 * per mode: sending clears that mode's draft.
 */
import { loadAutosave, saveAutosave } from './storage';

export type ChatDraftMode = 'Interview' | 'Casual Chat';

export interface ChatDraft {
  input: string;
  answer: string;
}

export type ChatDrafts = Record<ChatDraftMode, ChatDraft>;

const KEY = 'chat.drafts';
const EMPTY: ChatDraft = { input: '', answer: '' };

function coerceDraft(value: unknown): ChatDraft {
  if (!value || typeof value !== 'object') return { ...EMPTY };
  const record = value as Record<string, unknown>;
  return {
    input: typeof record.input === 'string' ? record.input : '',
    answer: typeof record.answer === 'string' ? record.answer : '',
  };
}

export function loadChatDrafts(): ChatDrafts {
  const stored = loadAutosave<Record<string, unknown> | null>(KEY, null);
  return {
    Interview: coerceDraft(stored?.Interview),
    'Casual Chat': coerceDraft(stored?.['Casual Chat']),
  };
}

export function saveChatDrafts(drafts: ChatDrafts): void {
  saveAutosave(KEY, drafts);
}

/** Write-through merge: update one mode's draft, keep the other's. */
export function saveChatDraftForMode(mode: ChatDraftMode, draft: Partial<ChatDraft>): void {
  const all = loadChatDrafts();
  all[mode] = { ...all[mode], ...draft };
  saveAutosave(KEY, all);
}
