/**
 * Cambridge Test session — resume the exact test + question (e.g. Part 1
 * question 3) after the app is closed. Removed ONLY when the test is
 * cancelled explicitly (start over) or completes (submitted for evaluation).
 */
import { loadAutosave, saveAutosave, clearAutosave, removeLegacyKeys, isStringRecord } from './storage';

export interface CambridgeSession {
  selectedTestId: string;
  idx: number;
  transcripts: Record<string, string>;
  cueNotes: string;
  savedAt: number;
}

const KEY = 'cambridge';
const LEGACY_PROGRESS = 'seren_cambridge_progress';
const LEGACY_DIAG = 'seren_diag_progress';

export function loadCambridgeSession(): CambridgeSession | null {
  const stored = loadAutosave<any>(KEY, null);
  if (stored && typeof stored.selectedTestId === 'string' && stored.selectedTestId) {
    return {
      selectedTestId: stored.selectedTestId,
      idx: Number.isInteger(stored.idx) && stored.idx >= 0 ? stored.idx : 0,
      transcripts: isStringRecord(stored.transcripts) ? stored.transcripts : {},
      cueNotes: typeof stored.cueNotes === 'string' ? stored.cueNotes : '',
      savedAt: 0,
    };
  }
  // One-time migration from the pre-autosave progress record.
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_PROGRESS) || '{}');
    if (legacy && typeof legacy.selectedTestId === 'string' && legacy.selectedTestId) {
      return {
        selectedTestId: legacy.selectedTestId,
        idx: Number.isInteger(legacy.idx) && legacy.idx >= 0 ? legacy.idx : 0,
        transcripts: isStringRecord(legacy.transcripts) ? legacy.transcripts : {},
        cueNotes: '',
        savedAt: 0,
      };
    }
  } catch {}
  return null;
}

export function saveCambridgeSession(session: Omit<CambridgeSession, 'savedAt'>): void {
  saveAutosave(KEY, { ...session, savedAt: Date.now() });
}

export function clearCambridgeSession(): void {
  clearAutosave(KEY);
  removeLegacyKeys([LEGACY_PROGRESS, LEGACY_DIAG]);
}
