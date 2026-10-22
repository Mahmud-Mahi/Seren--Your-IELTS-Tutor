/**
 * Autosave storage primitives — the whole-UI resume system lives in
 * `src/autosave/` (keep feature screens lean; they only call these helpers).
 *
 * Every record is written synchronously on EVERY state change (write-through),
 * so killing the tab/app mid-keystroke still resumes. Payloads are small
 * (progress pointers, transcripts, drafts) — a localStorage write is
 * sub-millisecond. Reads are validation-guarded: corrupt or stale records
 * resolve to `null` and the screen starts fresh instead of crashing.
 */

const PREFIX = 'seren_autosave_';

/** Load a record, or `fallback` when missing / unparsable. */
export function loadAutosave<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null || raw === undefined) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Persist a record immediately (write-through, no debounce). */
export function saveAutosave(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage full/blocked — the app keeps working in memory.
  }
}

/** Remove a record (user explicitly cancelled / reset that flow). */
export function clearAutosave(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {}
}

/** Drop pre-autosave legacy keys once their contents have been migrated. */
export function removeLegacyKeys(keys: string[]): void {
  for (const key of keys) {
    try {
      localStorage.removeItem(key);
    } catch {}
  }
}

/** A JSON object whose values are all strings. */
export function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === 'string');
}

/** A JSON object whose keys map to booleans. */
export function isBooleanRecord(value: unknown): value is Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === 'boolean');
}
