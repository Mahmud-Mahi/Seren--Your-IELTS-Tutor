/**
 * Cross-device sync E2E — simulates two machines with completely separate
 * localStorage caches, both signed into the same account, talking to one
 * shared cloud store. Verifies the real cross-device flow:
 *
 *   A: complete a lesson (writes localStorage)  -> pushed to the cloud
 *   B: sign in (fresh cache)                    -> pulls the lesson down
 *   B: edit something                           -> pushed back
 *   A: sync again                               -> sees B's edit
 *
 * The cloud is a file-backed store (so the two device processes, which run
 * as separate "machines", share it) with Firestore's last-write-wins rules.
 *
 * Usage: npx tsx scripts/test-cross-device.ts
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

/** The shared "cloud" file both devices read and write. */
const CLOUD_FILE = path.join(os.tmpdir(), 'seren-cross-device-cloud.json');

interface Row {
  value: string | null;
  updatedAt: number;
}

/** A minimal localStorage implementation so each device has its own cache. */
class DeviceStorage {
  store = new Map<string, string>();
  file?: string;
  constructor(file?: string) {
    this.file = file;
    if (file && fs.existsSync(file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const [k, v] of Object.entries(raw)) this.store.set(k, String(v));
      } catch {}
    }
  }
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(k: string) {
    return this.store.has(k) ? this.store.get(k)! : null;
  }
  key(i: number) {
    return Array.from(this.store.keys())[i] ?? null;
  }
  removeItem(k: string) {
    this.store.delete(k);
  }
  setItem(k: string, v: string) {
    this.store.set(k, String(v));
  }
  /** Persists the cache to disk (this device's "disk"). */
  save(): void {
    if (!this.file) return;
    const obj: Record<string, string> = {};
    for (const [k, v] of this.store) obj[k] = v;
    fs.writeFileSync(this.file, JSON.stringify(obj, null, 2));
  }
}

/** Reads the shared cloud file into { uid -> { key -> row } }. */
function readCloud(): Record<string, Record<string, Row>> {
  if (!fs.existsSync(CLOUD_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CLOUD_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/** Writes the shared cloud file back to disk. */
function writeCloud(cloud: Record<string, Record<string, Row>>): void {
  fs.writeFileSync(CLOUD_FILE, JSON.stringify(cloud, null, 2));
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

/**
 * Device worker — runs ONE phase in its own process with its own local cache
 * file, against the shared cloud file.
 */
async function runDevicePhase(): Promise<void> {
  // argv: [node, script, --device, <name>, <phase>, <uid>]
  const [, , , deviceName, phase, uid] = process.argv;
  const cacheFile = path.join(os.tmpdir(), `seren-device-${deviceName}.json`);
  const storage = new DeviceStorage(cacheFile);

  (globalThis as any).localStorage = storage;
  (globalThis as any).window = globalThis;
  (globalThis as any).Storage = DeviceStorage;
  (globalThis as any).document = { addEventListener: () => {}, visibilityState: 'visible' };
  (globalThis as any).addEventListener = () => {};

  const { setCloudBackend } = await import('../src/auth/cloud-sync');
  const { installSyncInterceptor, hydrate, syncNow, setSyncSession } = await import('../src/auth/sync');

  // The file-backed cloud both devices share, with Firestore's LWW rules.
  setCloudBackend({
    async push(accountId, entries) {
      const cloud = readCloud();
      const store = (cloud[accountId] = cloud[accountId] || {});
      for (const entry of entries) {
        const current = store[entry.key];
        if (current && current.updatedAt > entry.updatedAt) continue;
        store[entry.key] = { value: entry.value, updatedAt: entry.updatedAt };
      }
      writeCloud(cloud);
    },
    async pull(accountId) {
      const store = readCloud()[accountId] || {};
      return Object.entries(store).map(([key, row]) => ({
        key,
        value: row.value,
        updatedAt: row.updatedAt,
      }));
    },
  });

  installSyncInterceptor();

  const session = { uid, email: 'mahi@example.com', displayName: null, photoURL: null };
  // The push engine only talks to the cloud when a session is active.
  setSyncSession(session);

  if (phase === 'upload') {
    // Device A has local progress from a completed lesson.
    storage.setItem('seren_user_profile', JSON.stringify({ nickname: 'Mahi' }));
    storage.setItem(
      'seren_autosave_lesson.session.p::m',
      JSON.stringify({ feedbackHistory: [{ round: 1 }], followUpCount: 1 })
    );
    await hydrate(session);
    await syncNow();
  } else if (phase === 'pull') {
    // A fresh machine signing in with the same account.
    const result = await hydrate(session);
    assert(result.ok, 'device hydrate ok');
    const profile = storage.getItem('seren_user_profile');
    assert(profile && profile.includes('Mahi'), 'device received the profile from the cloud');
    const lesson = storage.getItem('seren_autosave_lesson.session.p::m');
    assert(lesson && lesson.includes('followUpCount'), 'device received the lesson session');
    assert(result.pulled >= 1, 'device pulled remote values');
  } else if (phase === 'edit') {
    storage.setItem('seren_user_eval', JSON.stringify({ band: 8.0, testLabel: 'From device B' }));
    await syncNow();
  } else if (phase === 'recheck') {
    await hydrate(session);
    const evalValue = storage.getItem('seren_user_eval');
    assert(evalValue && evalValue.includes('device B'), 'device A received device B edit');
  }

  storage.save();
}

/** Runs one device phase in a fresh child process (a separate "machine"). */
function runPhase(deviceName: string, phase: string, uid: string): void {
  const res = spawnSync(
    // Use the tsx loader so the child can run this TypeScript file directly.
    'npx',
    [
      'tsx',
      // Re-invoke this same script for the device worker.
      fileURLToPath(import.meta.url),
      '--device',
      deviceName,
      phase,
      uid,
    ],
    { encoding: 'utf8', stdio: 'pipe' }
  );
  if (res.status !== 0) {
    throw new Error(`device ${deviceName} phase ${phase} failed:\n${res.stdout}\n${res.stderr}`);
  }
}

async function main(): Promise<void> {
  // A device worker re-invokes this same script with `--device`; it must run
  // exactly one phase and exit — never the orchestrator (that would recurse).
  if (process.argv[2] === '--device') {
    await runDevicePhase();
    return;
  }

  // Start from a clean cloud + clean device caches.
  for (const file of [CLOUD_FILE]) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  for (const name of ['A', 'B']) {
    const cache = path.join(os.tmpdir(), `seren-device-${name}.json`);
    if (fs.existsSync(cache)) fs.unlinkSync(cache);
  }

  const uid = 'shared-uid-123';

  // 1. Device A completes a lesson and uploads it.
  runPhase('A', 'upload', uid);

  // 2. Device B signs in on a fresh machine and receives that lesson.
  runPhase('B', 'pull', uid);

  // 3. Device B edits a report and pushes it back.
  runPhase('B', 'edit', uid);

  // 4. Device A syncs again and sees device B's edit.
  runPhase('A', 'recheck', uid);

  console.log('Cross-device sync test passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
