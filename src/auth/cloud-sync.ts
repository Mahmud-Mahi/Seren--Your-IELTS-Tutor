/**
 * Cloud storage for the sync engine.
 *
 * The app keeps its working copy in `localStorage` (fast, offline-first,
 * survives a crash mid-lesson) and mirrors it to the cloud so it follows the
 * user across machines. This module is the ONLY place that talks to the
 * cloud; `sync.ts` owns the merge semantics.
 *
 * The production backend is Cloud Firestore. Layout — one document per
 * stored key:
 *
 *   users/{uid}/kv/{encodedKey}  →  { k: <original key>, v: <value|null>, u: <updatedAt> }
 *
 * One document per key (rather than one big blob) keeps writes small, avoids
 * Firestore's 1 MiB document limit, and lets two devices touch different
 * parts of the state without fighting over the same document.
 *
 * Conflict resolution is last-write-wins on the `u` timestamp. It is applied
 * on READ (a remote value only wins when it is strictly newer than the local
 * copy), and a device that notices the cloud holds an older value for a key
 * re-pushes its own newer copy, so every device converges on the newest
 * value without server-side locking.
 *
 * Firestore Security Rules (`firestore.rules`) are the real access control:
 * a user may only read and write their own `users/{uid}` documents.
 */
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  setDoc,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';
import { firebaseDb } from '../firebase/client';
import { mergeChatHistories } from '../utils/chatHistory';

/** The one key whose value is a conversation, not a plain value. */
const CHAT_HISTORY_KEY = 'seren_chat_history';

/** Firestore caps a batch at 500 operations. */
const MAX_BATCH = 400;

/** One stored value plus the timestamp it was last written. */
export interface CloudEntry {
  key: string;
  /** The stored string, or null when the key was deleted (a tombstone). */
  value: string | null;
  /** Wall-clock milliseconds when this value was written. */
  updatedAt: number;
}

/**
 * The storage backend the sync engine talks to. Production uses Firestore;
 * the test harness swaps in an in-memory implementation to exercise the
 * merge rules without a live Firebase project.
 */
export interface CloudBackend {
  push(uid: string, entries: CloudEntry[]): Promise<void>;
  pull(uid: string): Promise<CloudEntry[]>;
}

let override: CloudBackend | null = null;

/** Replaces the storage backend (tests only). Pass null to restore Firestore. */
export function setCloudBackend(backend: CloudBackend | null): void {
  override = backend;
}

/**
 * Firestore document IDs cannot contain a forward slash, so keys are
 * percent-encoded. The encoding is injective, so the original key can be
 * recovered from the document id — and it is also stored in the `k` field so
 * the console stays readable.
 */
export function encodeKey(key: string): string {
  return encodeURIComponent(key);
}

export function decodeKey(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

/** The collection holding one user's mirrored state. */
function kvCollection(db: Firestore, uid: string) {
  return collection(db, 'users', uid, 'kv');
}

/** True when a cloud backend is reachable at all. */
export function hasCloudBackend(): boolean {
  return override !== null || firebaseDb() !== null;
}

/**
 * Writes the given entries. Values are written with their timestamp; a null
 * value is stored as a tombstone so a stale device cannot resurrect a key
 * that was deleted on another machine.
 */
/**
 * Decide which entries may be written, given the timestamp already stored in
 * the cloud for each key.
 *
 * The client merges on read (newer wins), but the cloud used to write
 * UNCONDITIONALLY — so a device holding an older copy silently replaced the
 * newest one, and a device that no longer had a key at all wrote a tombstone
 * that DELETED it. Last-write-wins has to be enforced where the write
 * happens, not only where it is read.
 *
 * Exported for testing: a stale entry (older `u` than the stored one) is
 * dropped, an equal or newer one is written.
 */
export function selectWritableEntries(
  entries: CloudEntry[],
  storedTimestamps: Map<string, number>
): CloudEntry[] {
  return entries.filter((entry) => {
    const stored = storedTimestamps.get(entry.key);
    if (stored === undefined) return true; // nothing there yet
    return entry.updatedAt >= stored;
  });
}

/**
 * Writes the given entries. Values are written with their timestamp; a null
 * value is stored as a tombstone so a stale device cannot resurrect a key
 * that was deleted on another machine.
 *
 * The write is last-write-wins: an entry whose timestamp is OLDER than the
 * one already in the cloud is skipped, so an out-of-date device can never
 * destroy newer data (see selectWritableEntries).
 */
export async function pushEntries(uid: string, entries: CloudEntry[]): Promise<void> {
  if (override) {
    await override.push(uid, entries);
    return;
  }
  const db = firebaseDb();
  if (!db || entries.length === 0) return;

  // Read the current state first so the cloud can arbitrate. If the read
  // fails we do NOT push: the dirty set is persisted, so the data simply
  // stays queued and uploads on the next attempt — whereas a blind write
  // could destroy a newer value that is already in the cloud.
  let storedTimestamps = new Map<string, number>();
  try {
    const snapshot = await getDocs(kvCollection(db, uid));
    for (const document of snapshot.docs) {
      const data = document.data() as { k?: string; u?: number } | undefined;
      const key = typeof data?.k === 'string' ? data.k : decodeKey(document.id);
      const updatedAt = typeof data?.u === 'number' ? data.u : 0;
      storedTimestamps.set(key, updatedAt);
    }
  } catch (err: any) {
    console.warn('[sync] could not read the current cloud state — skipping this push:', err?.message || err);
    return;
  }

  // The chat history is a conversation: before writing it, merge it with the
  // copy already in the cloud. A device that only has the Interview thread
  // must not erase the other device's Casual Chat thread, and a device whose
  // interview is the current one must win over a stale fragment left behind
  // by an older session.
  const currentValues = new Map<string, string>();
  try {
    const snapshot = await getDocs(kvCollection(db, uid));
    for (const document of snapshot.docs) {
      const data = document.data() as { k?: string; v?: string | null } | undefined;
      const key = typeof data?.k === 'string' ? data.k : decodeKey(document.id);
      if (typeof data?.v === 'string') currentValues.set(key, data.v);
    }
  } catch {
    // Non-fatal: the write below simply is not merged this time.
  }

  const writable = selectWritableEntries(entries, storedTimestamps).map((entry) => {
    if (entry.key !== CHAT_HISTORY_KEY || entry.value == null) return entry;
    const merged = mergeChatHistories(entry.value, currentValues.get(entry.key) ?? null, {
      localStamp: entry.updatedAt,
      remoteStamp: storedTimestamps.get(entry.key) ?? 0,
    });
    return merged ? { ...entry, value: merged } : entry;
  });
  if (writable.length === 0) return;
  const skipped = entries.length - writable.length;
  if (skipped > 0) {
    console.log(`[sync] ${skipped} stale entr(y/ies) skipped — the cloud already holds a newer value`);
  }

  for (let offset = 0; offset < writable.length; offset += MAX_BATCH) {
    const chunk = writable.slice(offset, offset + MAX_BATCH);
    const batch = writeBatch(db);
    for (const entry of chunk) {
      batch.set(
        doc(db, 'users', uid, 'kv', encodeKey(entry.key)),
        { k: entry.key, v: entry.value, u: entry.updatedAt }
      );
    }
    await batch.commit();
  }
}

/**
 * Removes a key outright. Only used for tombstones that are older than the
 * retention window — the tombstone itself protects against resurrection
 * until then.
 */
export async function deleteKey(uid: string, key: string): Promise<void> {
  const db = firebaseDb();
  if (!db) return;
  await deleteDoc(doc(db, 'users', uid, 'kv', encodeKey(key)));
}

/** Reads every mirrored key for a user. */
export async function pullEntries(uid: string): Promise<CloudEntry[]> {
  if (override) return override.pull(uid);
  const db = firebaseDb();
  if (!db) return [];
  const snapshot = await getDocs(kvCollection(db, uid));
  const entries: CloudEntry[] = [];
  for (const document of snapshot.docs) {
    const data = document.data() as { k?: string; v?: string | null; u?: number } | undefined;
    if (!data) continue;
    const key = typeof data.k === 'string' ? data.k : decodeKey(document.id);
    const updatedAt = typeof data.u === 'number' ? data.u : 0;
    const value = typeof data.v === 'string' ? data.v : null;
    entries.push({ key, value, updatedAt });
  }
  return entries;
}


// ---------------------------------------------------------------------------
// Realtime listener
//
// The pull used to happen ONCE, when the app booted. A change made on another
// device (or in another tab) therefore never reached an app that was already
// open — the user had to reload to see it. `onSnapshot` keeps every open
// device in step with the cloud as it changes.
// ---------------------------------------------------------------------------

/**
 * Subscribes to the user's mirrored state. The callback receives the full
 * collection on every change (Firestore sends the complete set for a
 * collection listener), so the caller can apply the same merge rules it uses
 * for a one-shot pull.
 *
 * Returns an unsubscribe function.
 */
export function subscribeToEntries(
  uid: string,
  onChange: (entries: CloudEntry[]) => void,
  onError?: (err: any) => void
): () => void {
  const db = firebaseDb();
  if (!db) return () => {};
  return onSnapshot(
    kvCollection(db, uid),
    (snapshot) => {
      const entries: CloudEntry[] = [];
      snapshot.forEach((document) => {
        const data = document.data() as { k?: string; v?: string | null; u?: number } | undefined;
        if (!data) return;
        const key = typeof data.k === 'string' ? data.k : decodeKey(document.id);
        const updatedAt = typeof data.u === 'number' ? data.u : 0;
        const value = typeof data.v === 'string' ? data.v : null;
        entries.push({ key, value, updatedAt });
      });
      onChange(entries);
    },
    (err) => {
      console.warn('[sync] realtime listener failed:', err?.message || err);
      onError?.(err);
    }
  );
}
