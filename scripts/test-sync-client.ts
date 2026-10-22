/**
 * Quick harness: mocks localStorage + the cloud backend to drive the client
 * sync engine through its merge rules — first-signup upload, account-switch
 * wipe, LWW pull merge, dirty push, and recovery-snapshot filling.
 * Run: npx tsx scripts/test-sync-client.ts
 */

// --- localStorage mock (must exist before the module is imported) ----------
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }
}
(globalThis as any).localStorage = new MemoryStorage();
(globalThis as any).window = globalThis;
// installSyncInterceptor patches Storage.prototype — give Node that global.
(globalThis as any).Storage = MemoryStorage;
// Install visibility listeners — stub what Node lacks.
(globalThis as any).document = {
  addEventListener: () => {},
  visibilityState: 'visible',
};

// --- cloud backend mock: in-memory store with LWW + PER-USER isolation -----
// Each uid gets its own set of rows, so a second account can never see the
// first account's data — the same guarantee Firestore Security Rules give.
interface Row {
  value: string | null;
  updatedAt: number;
}
const cloud = new Map<string, Map<string, Row>>();
function storeFor(uid: string): Map<string, Row> {
  let store = cloud.get(uid);
  if (!store) {
    store = new Map<string, Row>();
    cloud.set(uid, store);
  }
  return store;
}
let cloudAcceptPush = true;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

async function run(): Promise<void> {
  const { setCloudBackend } = await import('../src/auth/cloud-sync');
  const { hydrate, setSyncSession, syncNow, applyRecoverySnapshot, installSyncInterceptor } = await import(
    '../src/auth/sync'
  );

  // Install a fake cloud that mimics Firestore's last-write-wins semantics.
  setCloudBackend({
    async push(uid, entries) {
      if (!cloudAcceptPush) throw new Error('cloud unavailable');
      const store = storeFor(uid);
      for (const entry of entries) {
        const current = store.get(entry.key);
        // LWW: an older incoming write never overwrites a newer stored one.
        if (current && current.updatedAt > entry.updatedAt) continue;
        store.set(entry.key, { value: entry.value, updatedAt: entry.updatedAt });
      }
    },
    async pull(uid) {
      return Array.from(storeFor(uid), ([key, row]) => ({
        key,
        value: row.value,
        updatedAt: row.updatedAt,
      }));
    },
  });

  // The app installs this in main.tsx before rendering — do the same here so
  // localStorage writes are tracked as dirty.
  installSyncInterceptor();
  const sessionA = { uid: 'uid-A', email: 'a@example.com', displayName: null, photoURL: null };
  const sessionB = { uid: 'uid-B', email: 'b@example.com', displayName: null, photoURL: null };

  // --- 1. first sign-in on a device with existing local data → uploads it
  localStorage.setItem('seren_user_profile', '{"nickname":"Mahi"}');
  localStorage.setItem('seren_view', 'lessons');
  let result = await hydrate(sessionA);
  assert(result.ok, 'hydrate A ok');
  assert(storeFor('uid-A').get('seren_user_profile')?.value === '{"nickname":"Mahi"}', 'local profile uploaded');
  assert(storeFor('uid-A').get('seren_view')?.value === 'lessons', 'local view uploaded');

  // --- 2. a remote change from another device merges in when newer
  storeFor('uid-A').set('seren_eval_history', { value: '[{"id":"r1"}]', updatedAt: Date.now() + 10_000 });
  result = await hydrate(sessionA);
  assert(result.pulled >= 1, 'remote eval history pulled');
  assert(localStorage.getItem('seren_eval_history') === '[{"id":"r1"}]', 'remote value applied locally');
  assert(result.accountSwitched === false, 'same account is not a switch');

  // --- 3. dirty local edit pushes on next hydrate (offline-first)
  localStorage.setItem('seren_user_profile', '{"nickname":"Mahi v2"}');
  setSyncSession(sessionA);
  await syncNow();
  assert(storeFor('uid-A').get('seren_user_profile')?.value === '{"nickname":"Mahi v2"}', 'dirty push reached the cloud');

  // --- 4. offline push failure keeps the dirty flag (retry later)
  localStorage.setItem('seren_view', 'report');
  cloudAcceptPush = false;
  await syncNow();
  cloudAcceptPush = true;
  const metaRaw = localStorage.getItem('seren_sync_meta');
  assert(metaRaw && JSON.parse(metaRaw).dirty['seren_view'], 'failed push keeps key dirty');
  await syncNow();
  assert(storeFor('uid-A').get('seren_view')?.value === 'report', 'retry after failure pushes');

  // --- 5. account switch wipes previous account's local data first
  storeFor('uid-B').set('seren_user_eval', { value: '{"switched":true}', updatedAt: Date.now() + 20_000 });
  result = await hydrate(sessionB);
  assert(result.accountSwitched, 'account switch detected');
  assert(localStorage.getItem('seren_user_profile') === null, 'old account data wiped');
  assert(localStorage.getItem('seren_user_eval') === '{"switched":true}', 'new account data pulled');
  assert(
    storeFor('uid-A').get('seren_user_profile')?.value === '{"nickname":"Mahi v2"}',
    "account A's cloud data is untouched by account B"
  );

  // --- 6. recovery snapshot only fills EMPTY keys, never overwrites
  localStorage.setItem('seren_autosave_lesson.session.p::m', '{"feedbackHistory":[],"followUpCount":0}');
  const applied = applyRecoverySnapshot({
    'seren_autosave_lesson.session.p::m': '{"feedbackHistory":[{"fb":1}],"followUpCount":1}',
    'seren_user_eval': '{"switched":true,"sabotage":true}',
  });
  assert(applied, 'recovery applied at least one key');
  assert(
    localStorage.getItem('seren_autosave_lesson.session.p::m')?.includes('"fb":1'),
    'recovery filled the empty session'
  );
  assert(
    localStorage.getItem('seren_user_eval') === '{"switched":true}',
    'recovery never overwrites non-empty data'
  );

  // --- 7. a deleted key is tombstoned so a stale device can't resurrect it
  localStorage.setItem('seren_view', 'report');
  setSyncSession(sessionB);
  await syncNow();
  assert(storeFor('uid-B').get('seren_view')?.value === 'report', 'deletion is tombstoned in the cloud');

  // --- 8. OFFLINE → cloud must UPLOAD the local data, never wipe it
  // (the offline copy is the only copy — wiping it would destroy the user's
  //  work the moment they sign in).
  const offline = { uid: 'offline', email: null, displayName: null, photoURL: null };
  localStorage.setItem('seren_user_profile', '{"nickname":"Made offline"}');
  localStorage.setItem('seren_lesson_history', '[{"id":"offline-lesson"}]');
  result = await hydrate(offline);
  assert(result.accountSwitched === false, 'offline mode is not an account switch');

  const cloud = { uid: 'uid-C', email: 'c@example.com', displayName: null, photoURL: null };
  result = await hydrate(cloud);
  assert(result.accountSwitched === false, 'offline → cloud is not an account switch');
  assert(
    localStorage.getItem('seren_user_profile') === '{"nickname":"Made offline"}',
    'offline progress survives signing in'
  );
  assert(
    storeFor('uid-C').get('seren_user_profile')?.value === '{"nickname":"Made offline"}',
    'offline progress is uploaded to the cloud account'
  );
  assert(
    storeFor('uid-C').get('seren_lesson_history')?.value === '[{"id":"offline-lesson"}]',
    'offline lesson history is uploaded too'
  );

  // --- 9. cloud A → cloud B (two REAL accounts) DOES wipe, so accounts
  //       never mix on one machine.
  storeFor('uid-D').set('seren_user_eval', { value: '{"d":true}', updatedAt: Date.now() + 30_000 });
  const accountD = { uid: 'uid-D', email: 'd@example.com', displayName: null, photoURL: null };
  result = await hydrate(accountD);
  assert(result.accountSwitched === true, 'cloud A → cloud B is an account switch');
  assert(localStorage.getItem('seren_user_profile') === null, "cloud A's data wiped on switch to cloud B");

  console.log('All client sync tests passed.');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
