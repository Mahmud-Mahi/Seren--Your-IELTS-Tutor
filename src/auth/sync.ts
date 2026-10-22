/**
 * Cloud sync engine — mirrors every `seren_*` localStorage entry to the
 * signed-in Google account so profile, score reports, lesson transcripts and
 * chat drafts follow the user across machines.
 *
 * Design:
 *  - Storage.prototype is patched ONCE so every existing write path
 *    (autosave, lesson history, chat drafts, App state…) is captured without
 *    touching a single call site.
 *  - `seren_sync_meta` tracks per-key write stamps plus a pending-dirty set.
 *  - Push is debounced (1.2 s) and flushed when the window hides.
 *  - Merge: per-key last-write-wins on wall-clock stamps. The same rule is
 *    applied when reading, so every device converges on the newest value.
 *  - Hydration runs BEFORE the app mounts: push local-only/dirty keys, pull
 *    newer remote keys, and if the account changed, local data from the
 *    previous account is cleared first so accounts never mix.
 *
 * The cloud is Cloud Firestore (see `cloud-sync.ts`). Firebase Auth owns the
 * session, so this module never handles a credential itself — the Firestore
 * SDK attaches the signed-in user's token to every request, and Firestore
 * Security Rules decide what that user may read or write.
 */
import {
  hasCloudBackend,
  pullEntries,
  pushEntries,
  subscribeToEntries,
  type CloudEntry,
} from './cloud-sync';
import { mergeChatHistories, notifyRemoteUpdate } from '../utils/chatHistory';
import { LOCAL_ONLY_UID, type AuthSession } from './session';

const META_KEY = 'seren_sync_meta';
const RECOVERY_FLAG_KEY = 'seren_recovery_applied';
const PUSH_DEBOUNCE_MS = 1200;

/** Keys that are credentials/device-config — never uploaded. */
const EXCLUDED_KEYS = new Set([META_KEY, RECOVERY_FLAG_KEY, 'seren_auth_session']);

export interface SyncMeta {
  /** Account id whose data this device's local cache currently belongs to. */
  account?: string;
  /** Per-key stamp of the last local write / last applied remote write. */
  stamps: Record<string, number>;
  /** Keys written locally but not yet confirmed by the cloud. */
  dirty: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Sync status — a failed upload must never be silent.
//
// The old push path swallowed every error, so a Firestore rules problem (or
// a revoked session) looked exactly like success: the app kept working and
// the data simply never left the device. The status below is the single
// source of truth the UI renders, and `syncNow()` is the manual retry.
// ---------------------------------------------------------------------------

export type SyncPhase = 'idle' | 'syncing' | 'ok' | 'error';

export interface SyncStatus {
  phase: SyncPhase;
  /** Human-readable reason for the current phase (empty when everything is fine). */
  message: string;
  /** True when the failure is worth retrying (transient / offline / rules). */
  retryable: boolean;
  /** Wall-clock of the last successful push / pull. */
  lastSyncedAt: number | null;
  /** Number of local keys still waiting to be uploaded. */
  pending: number;
  /** True when the account is signed in AND a cloud backend exists. */
  cloudAvailable: boolean;
}

let status: SyncStatus = {
  phase: 'idle',
  message: '',
  retryable: true,
  lastSyncedAt: null,
  pending: 0,
  cloudAvailable: false,
};

const statusListeners = new Set<(s: SyncStatus) => void>();

function setStatus(patch: Partial<SyncStatus>): void {
  status = { ...status, ...patch };
  for (const listener of statusListeners) {
    try {
      listener(status);
    } catch {}
  }
}

/** The current sync status (safe to read at any time). */
export function getSyncStatus(): SyncStatus {
  return { ...status, pending: Object.keys(readMeta().dirty || {}).length };
}

/** Subscribe to sync status changes. Returns an unsubscribe function. */
export function subscribeSyncStatus(listener: (s: SyncStatus) => void): () => void {
  statusListeners.add(listener);
  try {
    listener(getSyncStatus());
  } catch {}
  return () => {
    statusListeners.delete(listener);
  };
}

/**
 * Turns a raw Firestore/Auth error into something a learner can act on.
 * PERMISSION_DENIED almost always means the security rules were never
 * published — a setup problem, not a transient one, so it says exactly that.
 */
function describeSyncError(err: any): { message: string; retryable: boolean } {
  const raw = String(err?.message || err?.code || err || 'Unknown sync error');
  const code = String(err?.code || '');
  if (code.includes('permission-denied') || /PERMISSION_DENIED|Missing or insufficient permissions/i.test(raw)) {
    return {
      message:
        'Cloud sync was blocked by the Firestore security rules. Publish firestore.rules (Firestore Database -> Rules -> Publish), then retry.',
      retryable: true,
    };
  }
  if (code.includes('unauthenticated') || /unauthenticated|token.*expired/i.test(raw)) {
    return {
      message: 'Your cloud session expired. Sign out and sign in again to resume syncing.',
      retryable: true,
    };
  }
  if (/offline|network-request-failed|failed to fetch|fetch failed/i.test(raw)) {
    return { message: 'No connection to the cloud — your data is safe locally and will upload automatically.', retryable: true };
  }
  return { message: `Cloud sync failed: ${raw.slice(0, 160)}`, retryable: true };
}

function readMeta(): SyncMeta {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        account: typeof parsed.account === 'string' ? parsed.account : undefined,
        stamps: parsed.stamps && typeof parsed.stamps === 'object' ? parsed.stamps : {},
        dirty: parsed.dirty && typeof parsed.dirty === 'object' ? parsed.dirty : {},
      };
    }
  } catch {}
  return { stamps: {}, dirty: {} };
}

function writeMeta(meta: SyncMeta): void {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch {}
}

export function isSyncableKey(key: string): boolean {
  return key.startsWith('seren_') && !EXCLUDED_KEYS.has(key);
}

// ---------------------------------------------------------------------------
// Write interception
// ---------------------------------------------------------------------------

let suppressDirtyTracking = false;
let installed = false;
let currentSession: AuthSession | null = null;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let unsubscribeRealtime: (() => void) | null = null;

function markDirty(key: string): void {
  if (!isSyncableKey(key) || suppressDirtyTracking) return;
  const now = Date.now();
  const meta = readMeta();
  meta.stamps[key] = now;
  meta.dirty[key] = now;
  writeMeta(meta);
  schedulePush();
}

/**
 * Patches setItem/removeItem once so ANY future write to a `seren_*` key
 * marks that key dirty and schedules a cloud push. Must be called before the
 * app renders.
 */
export function installSyncInterceptor(): void {
  if (installed) return;
  installed = true;
  const originalSet = Storage.prototype.setItem;
  const originalRemove = Storage.prototype.removeItem;
  Storage.prototype.setItem = function (key: string, value: string) {
    const result = originalSet.call(this, key, value);
    if (this === localStorage) markDirty(key);
    return result;
  };
  Storage.prototype.removeItem = function (key: string) {
    const result = originalRemove.call(this, key);
    if (this === localStorage) markDirty(key);
    return result;
  };
  // Flush pending writes when the window is backgrounded or closed so a quit
  // right after a change doesn't leave it unpushed. pagehide listens on
  // globalThis (correct in browsers, and safe where no window exists).
  const flush = () => {
    if (currentSession) void pushNow();
  };
  globalThis.addEventListener?.('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}

/**
 * Called by the app shell whenever the signed-in account changes.
 *
 * Besides pushing, this (re)starts the REALTIME listener: the one-shot pull
 * in hydrate() only ran at boot, so a change made on another device never
 * reached an app that was already open.
 */
export function setSyncSession(session: AuthSession | null): void {
  currentSession = session;
  const offline = !session || session.uid === LOCAL_ONLY_UID;
  setStatus({
    phase: offline ? 'idle' : status.phase === 'error' ? 'error' : 'idle',
    message: offline ? '' : status.message,
    cloudAvailable: !offline && hasCloudBackend(),
  });
  if (offline) {
    stopRealtimeSync();
    return;
  }
  startRealtimeSync(session.uid);
  void pushNow();
}

/** Stops the realtime listener (sign-out / account switch). */
export function stopRealtimeSync(): void {
  if (unsubscribeRealtime) {
    try {
      unsubscribeRealtime();
    } catch {}
    unsubscribeRealtime = null;
  }
}

/**
 * Keeps this device in step with the cloud while it is open.
 *
 * Every remote change is applied with the same rules as the boot-time pull:
 * a pending local edit wins, otherwise a strictly newer remote value is
 * applied. The chat history is merged rather than replaced (see
 * applyRemoteValue).
 */
function startRealtimeSync(uid: string): void {
  stopRealtimeSync();
  if (!hasCloudBackend()) return;
  unsubscribeRealtime = subscribeToEntries(
    uid,
    (entries) => {
      const meta = readMeta();
      let changed = 0;
      for (const entry of entries) {
        if (!entry.key || !isSyncableKey(entry.key)) continue;
        const localStamp = meta.stamps[entry.key] || 0;
        const dirtyStamp = meta.dirty[entry.key] || 0;
        // A local edit that has not been pushed yet always wins.
        if (dirtyStamp > 0) continue;
        if (entry.value == null) {
          // A tombstone: the key was deleted on another device.
          if (entry.updatedAt > localStamp) {
            applyRemoteValue(entry.key, null, entry.updatedAt);
            changed += 1;
          }
          continue;
        }
        if (entry.updatedAt > localStamp) {
          applyRemoteValue(entry.key, entry.value, entry.updatedAt);
          changed += 1;
        }
      }
      if (changed > 0) {
        setStatus({ phase: 'ok', message: '', lastSyncedAt: Date.now(), pending: getSyncStatus().pending });
      }
    },
    (err) => {
      const described = describeSyncError(err);
      setStatus({ phase: 'error', message: described.message, retryable: described.retryable });
    }
  );
}

function schedulePush(): void {
  if (!currentSession) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void pushNow();
  }, PUSH_DEBOUNCE_MS);
}

async function pushNow(): Promise<void> {
  const session = currentSession;
  if (!session) return;
  // Offline mode has no cloud account: there is nothing to push to, and
  // pushing to a fake 'offline' account would clear the dirty flags and lose
  // the data the moment the user signs in for real.
  if (session.uid === LOCAL_ONLY_UID) return;
  if (!hasCloudBackend()) return;
  const meta = readMeta();
  const dirtyKeys = Object.keys(meta.dirty);
  if (dirtyKeys.length === 0) return;
  const entries: CloudEntry[] = [];
  for (const key of dirtyKeys) {
    entries.push({
      key,
      // null = deleted locally (a tombstone, so a stale device can't
      // resurrect the key).
      value: localStorage.getItem(key),
      updatedAt: meta.dirty[key],
    });
  }
  setStatus({ phase: 'syncing', message: '', pending: Object.keys(meta.dirty).length });
  try {
    await pushEntries(session.uid, entries);
  } catch (err: any) {
    // The dirty set stays persisted, so nothing is lost — but the failure is
    // now REPORTED instead of vanishing. A silent failure is what let a
    // rules problem go unnoticed for days.
    const described = describeSyncError(err);
    console.error('[sync] push failed:', err?.message || err);
    setStatus({ phase: 'error', message: described.message, retryable: described.retryable });
    return;
  }
  const fresh = readMeta();
  for (const entry of entries) {
    const still = fresh.dirty[entry.key];
    // Clear only if the key wasn't re-written while the push was in flight.
    if (still === entry.updatedAt) delete fresh.dirty[entry.key];
  }
  writeMeta(fresh);
  const remaining = Object.keys(fresh.dirty).length;
  setStatus({
    phase: remaining > 0 ? 'syncing' : 'ok',
    message: '',
    lastSyncedAt: Date.now(),
    pending: remaining,
    cloudAvailable: true,
  });
  if (remaining > 0) schedulePush();
}

const CHAT_HISTORY_KEY = 'seren_chat_history';

/**
 * Applies a cloud-won value locally.
 *
 * The chat history is special: it is a CONVERSATION, so two devices must not
 * overwrite each other. It is merged (union of messages by id) instead of
 * replaced, and the merged result is marked dirty so it propagates back to the
 * cloud and both devices converge.
 *
 * Every other key is a plain last-write-wins value and is applied without
 * marking it dirty (that would bounce the value straight back).
 */
function applyRemoteValue(key: string, value: string | null, updatedAt: number): void {
  if (key === CHAT_HISTORY_KEY && value != null) {
    const merged = mergeChatHistories(localStorage.getItem(key), value, {
      localStamp: readMeta().stamps[key] || 0,
      remoteStamp: updatedAt,
    });
    if (merged && merged !== localStorage.getItem(key)) {
      // Mark it dirty ON PURPOSE: the union must reach the other device too.
      localStorage.setItem(key, merged);
      const meta = readMeta();
      // Strictly newer than the remote copy, so the union wins the merge.
      meta.stamps[key] = Math.max(meta.stamps[key] || 0, updatedAt) + 1;
      writeMeta(meta);
      notifyRemoteUpdate(key);
      return;
    }
  }
  suppressDirtyTracking = true;
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    const meta = readMeta();
    meta.stamps[key] = updatedAt;
    writeMeta(meta);
  } finally {
    suppressDirtyTracking = false;
  }
  notifyRemoteUpdate(key);
}

// ---------------------------------------------------------------------------
// Hydration (pull + merge) — runs BEFORE the app mounts so React state
// initializers read the already-merged localStorage.
// ---------------------------------------------------------------------------

export interface HydrateResult {
  ok: boolean;
  /** True when local data was cleared because a DIFFERENT account signed in. */
  accountSwitched: boolean;
  pulled: number;
}

/**
 * Brings local storage in line with the account:
 *  1. If a different account signed in on this device, wipe the previous
 *     account's local cache (its data is safe in the cloud) — accounts never
 *     mix on one machine.
 *  2. First sign-in for this account on this device: every existing local
 *     `seren_*` key is marked dirty so it UPLOADS to the new account (this is
 *     what carries an existing user's data into their new account).
 *  3. Push any dirty keys (offline edits from a previous run), then PULL and
 *     apply every remote entry that is newer than the local stamp.
 */
export async function hydrate(session: AuthSession): Promise<HydrateResult> {
  currentSession = session;
  let meta = readMeta();
  let accountSwitched = false;

  const previousAccount = meta.account;
  const switchingAccount = Boolean(previousAccount) && previousAccount !== session.uid;
  // Offline mode (no cloud account) is NOT a real account: its local data has
  // never been uploaded, so it must be UPLOADED to the account the user signs
  // into — never wiped. Only a switch between two real cloud accounts wipes,
  // because then the previous account's data is safely stored in the cloud.
  const previousWasOffline = previousAccount === LOCAL_ONLY_UID;
  const currentIsOffline = session.uid === LOCAL_ONLY_UID;

  // 1. Account switch — drop the other account's local data first.
  if (switchingAccount && !previousWasOffline && !currentIsOffline) {
    accountSwitched = true;
    suppressDirtyTracking = true;
    try {
      const doomed: string[] = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && isSyncableKey(key)) doomed.push(key);
      }
      for (const key of doomed) localStorage.removeItem(key);
    } finally {
      suppressDirtyTracking = false;
    }
    meta = { stamps: {}, dirty: {} };
  }

  // 2. First time THIS account is used on THIS device — existing local data
  // belongs to it (fresh sign-up on the machine where the user already
  // worked, or returning after sign-out) and must be preserved + uploaded.
  if (meta.account !== session.uid) {
    suppressDirtyTracking = true;
    try {
      const now = Date.now();
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && isSyncableKey(key) && meta.stamps[key] === undefined) {
          meta.stamps[key] = now;
          meta.dirty[key] = now;
        }
      }
    } finally {
      suppressDirtyTracking = false;
    }
    meta.account = session.uid;
    writeMeta(meta);
  }

  // 3a. Push first so local-only / offline edits win over stale cloud copies
  // of the same keys (LWW is per-key anyway).
  await pushNow();

  if (!hasCloudBackend()) {
    setStatus({
      phase: 'error',
      message: 'Cloud sync is not configured in this build — progress stays on this device only.',
      retryable: false,
      cloudAvailable: false,
    });
    return { ok: true, accountSwitched, pulled: 0 };
  }
  // Offline mode has no cloud account to pull from.
  if (session.uid === LOCAL_ONLY_UID) return { ok: true, accountSwitched, pulled: 0 };

  // 3b. Pull and merge.
  let pulled = 0;
  try {
    const entries = await pullEntries(session.uid);
    meta = readMeta();
    for (const entry of entries) {
      if (!entry.key || !isSyncableKey(entry.key)) continue;
      const localStamp = meta.stamps[entry.key] || 0;
      const dirtyStamp = meta.dirty[entry.key] || 0;
      // A pending local edit always beats the cloud (its push is queued — it
      // will win by LWW). Otherwise the cloud wins only when strictly newer
      // than the last synced stamp; equal stamps keep local (idempotent).
      const localEditPending = dirtyStamp > 0;
      if (!localEditPending && entry.updatedAt > localStamp) {
        applyRemoteValue(entry.key, entry.value, entry.updatedAt);
        delete meta.dirty[entry.key];
        pulled += 1;
      }
    }
    meta.account = session.uid;
    writeMeta(meta);
    setStatus({
      phase: 'ok',
      message: '',
      lastSyncedAt: Date.now(),
      pending: Object.keys(meta.dirty || {}).length,
      cloudAvailable: true,
    });
    return { ok: true, accountSwitched, pulled };
  } catch (err: any) {
    // Offline — keep local state; dirty keys push when connectivity returns.
    const described = describeSyncError(err);
    console.warn('[sync] pull failed:', err?.message || err);
    setStatus({ phase: 'error', message: described.message, retryable: described.retryable });
    return { ok: true, accountSwitched, pulled: 0 };
  }
}

/** Best-effort immediate push (used by the "Sync now" button). */
export async function syncNow(): Promise<void> {
  setStatus({ phase: 'syncing', message: '' });
  await pushNow();
}

/**
 * One-time recovery: applies a server-provided snapshot of wiped lesson
 * sessions ONLY where the local copy is still empty, so a data-loss event can
 * be restored from the account-side backup bundle shipped by the operator.
 */
export function applyRecoverySnapshot(snapshot: Record<string, string>): boolean {
  if (!snapshot || typeof snapshot !== 'object') return false;
  let applied = 0;
  suppressDirtyTracking = false; // recovery writes SHOULD dirty → re-upload
  for (const [key, value] of Object.entries(snapshot)) {
    if (!isSyncableKey(key) || typeof value !== 'string') continue;
    let local: string | null = null;
    try {
      local = localStorage.getItem(key);
    } catch {}
    const localEmpty =
      local === null ||
      (() => {
        try {
          const parsed = JSON.parse(local);
          if (Array.isArray(parsed)) return parsed.length === 0;
          if (parsed && typeof parsed === 'object') {
            const fb = parsed.feedbackHistory;
            return Array.isArray(fb) && fb.length === 0;
          }
        } catch {}
        return false;
      })();
    if (localEmpty && value) {
      // Direct write so the recovery itself also uploads via markDirty.
      localStorage.setItem(key, value);
      applied += 1;
    }
  }
  if (applied > 0) {
    try {
      localStorage.setItem(RECOVERY_FLAG_KEY, String(Date.now()));
    } catch {}
  }
  return applied > 0;
}

/**
 * Fetches the operator-provided recovery bundle (see /api/recovery/snapshot
 * — 404 when none was ever shipped) and applies it.
 * Idempotent: applyRecoverySnapshot only fills empty/missing keys.
 */
export async function fetchRecoverySnapshot(): Promise<boolean> {
  try {
    const res = await fetch('/api/recovery/snapshot');
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { snapshot?: Record<string, string> } | null;
    if (!body?.snapshot) return false;
    return applyRecoverySnapshot(body.snapshot);
  } catch {
    return false;
  }
}
