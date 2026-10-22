/**
 * Cambridge Solutions progress — which test + part + finished-topic ticks the
 * user left on, PLUS the live playback position (active topic, question index,
 * whose turn was speaking). Live position restores paused (audio never
 * autoplays after a reload): the exact row is highlighted and one press of
 * Resume continues from the saved question/turn.
 */
import { loadAutosave, saveAutosave, isBooleanRecord } from './storage';

export type SolutionsSpeaker = 'examiner' | 'seren';

export interface SolutionsPlayback {
  activeTopicKey: string;
  currentQIndex: number;
  currentSpeaker: SolutionsSpeaker;
}

export interface SolutionsProgress {
  selectedTestId: string;
  activePart: 1 | 2 | 3;
  finishedTopics: Record<string, boolean>;
  playback: SolutionsPlayback | null;
  savedAt: number;
}

const KEY = 'solutions';

function coercePlayback(value: unknown): SolutionsPlayback | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const { activeTopicKey, currentQIndex, currentSpeaker } = record;
  if (typeof activeTopicKey !== 'string' || !activeTopicKey) return null;
  if (!Number.isInteger(currentQIndex) || (currentQIndex as number) < 0) return null;
  if (currentSpeaker !== 'examiner' && currentSpeaker !== 'seren') return null;
  return {
    activeTopicKey,
    currentQIndex: currentQIndex as number,
    currentSpeaker: currentSpeaker as SolutionsSpeaker,
  };
}

export function loadSolutionsProgress(): SolutionsProgress | null {
  const stored = loadAutosave<any>(KEY, null);
  if (!stored || typeof stored.selectedTestId !== 'string' || !stored.selectedTestId) return null;
  const part = stored.activePart === 2 || stored.activePart === 3 ? stored.activePart : 1;
  let playback = coercePlayback(stored.playback);
  // Reject playback positions that don't belong to this test + part — an
  // inconsistent saved state must never resurrect a stale topic.
  if (playback && !playback.activeTopicKey.startsWith(`${stored.selectedTestId}::${part}::`)) {
    playback = null;
  }
  return {
    selectedTestId: stored.selectedTestId,
    activePart: part,
    finishedTopics: isBooleanRecord(stored.finishedTopics) ? stored.finishedTopics : {},
    playback,
    savedAt: 0,
  };
}

export function saveSolutionsProgress(progress: Omit<SolutionsProgress, 'savedAt'>): void {
  saveAutosave(KEY, { ...progress, savedAt: Date.now() });
}
