/**
 * Cloud-sync doctor — answers "is my data actually in Firebase?".
 *
 * Reads the Firebase refresh token that the app itself persisted (desktop app
 * IndexedDB or a Chrome profile), exchanges it for a short-lived ID token, and
 * lists what is actually stored under `users/{uid}/kv` in Cloud Firestore.
 *
 * It also reports the local state of every store it finds, so you can see at a
 * glance whether a key is still waiting to be pushed (`dirty`) — the symptom
 * of a failed upload.
 *
 * Run with: npm run check:sync
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const PROJECT_ID = process.env.VITE_FIREBASE_PROJECT_ID || '';
const API_KEY = process.env.VITE_FIREBASE_API_KEY || '';

if (!PROJECT_ID || !API_KEY) {
  console.error('Firebase is not configured. Run via npm (which loads .env) or export the vars first.');
  process.exit(1);
}

function authStoreRoots(): string[] {
  const home = os.homedir();
  return [
    path.join(home, '.config/Seren/IndexedDB'),
    path.join(home, '.config/google-chrome/Default/IndexedDB'),
    path.join(home, '.config/chromium/Default/IndexedDB'),
    path.join(home, '.config/BraveSoftware/Brave-Browser/Default/IndexedDB'),
    path.join(home, 'Library/Application Support/Seren/IndexedDB'),
    path.join(home, 'AppData/Roaming/Seren/IndexedDB'),
  ];
}

function localStoreRoots(): string[] {
  const home = os.homedir();
  return [
    path.join(home, '.config/Seren/Local Storage'),
    path.join(home, '.config/google-chrome/Default/Local Storage'),
    path.join(home, '.config/chromium/Default/Local Storage'),
    path.join(home, '.config/BraveSoftware/Brave-Browser/Default/Local Storage'),
    path.join(home, 'Library/Application Support/Seren/Local Storage'),
    path.join(home, 'AppData/Roaming/Seren/Local Storage'),
  ];
}

function walk(dir: string, depth = 0): string[] {
  if (depth > 3) return [];
  let out: string[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(full, depth + 1));
    else out.push(full);
  }
  return out;
}

function findRefreshTokens(): string[] {
  const found = new Set<string>();
  for (const root of authStoreRoots()) {
    for (const file of walk(root)) {
      let data: Buffer;
      try {
        data = fs.readFileSync(file);
      } catch {
        continue;
      }
      let idx = data.indexOf('refreshToken');
      while (idx !== -1) {
        const tail = data.subarray(idx, idx + 1400);
        const runs = tail.toString('latin1').match(/[A-Za-z0-9_-]{180,}/g) || [];
        for (const run of runs) if (run.startsWith('AMf-')) found.add(run);
        idx = data.indexOf('refreshToken', idx + 1);
      }
    }
  }
  return [...found];
}

async function exchange(
  refreshToken: string
): Promise<{ idToken: string; uid: string; email: string } | null> {
  try {
    const res = await fetch(
      `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(API_KEY)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
      }
    );
    if (!res.ok) return null;
    const body: any = await res.json();
    if (!body?.id_token) return null;
    const payload = JSON.parse(Buffer.from(body.id_token.split('.')[1], 'base64').toString('utf8'));
    return { idToken: body.id_token, uid: payload.sub, email: payload.email || '' };
  } catch {
    return null;
  }
}

function localStores() {
  const out: { store: string; keys: number; account?: string; dirty: number; stamps: number }[] = [];
  for (const root of localStoreRoots()) {
    if (!fs.existsSync(root)) continue;
    const keys = new Set<string>();
    let account: string | undefined;
    let dirty = 0;
    let stamps = 0;
    for (const file of walk(root)) {
      let data: Buffer;
      try {
        data = fs.readFileSync(file);
      } catch {
        continue;
      }
      const text = data.toString('latin1');
      for (const m of text.matchAll(/seren_[A-Za-z0-9_.-]+/g)) keys.add(m[0]);
      const metaMatch = text.match(/\{"account":.*?"dirty":\{.*?\}\}/s);
      if (metaMatch) {
        try {
          const meta = JSON.parse(metaMatch[0]);
          account = meta.account;
          dirty = Object.keys(meta.dirty || {}).length;
          stamps = Object.keys(meta.stamps || {}).length;
        } catch {}
      }
    }
    if (keys.size) out.push({ store: root, keys: keys.size, account, dirty, stamps });
  }
  return out;
}

async function main() {
  console.log('=== local stores ===');
  const stores = localStores();
  if (!stores.length) console.log('  (no Seren local storage found)');
  for (const s of stores) {
    console.log(`  ${s.store}`);
    console.log(
      `     keys=${s.keys}  account=${s.account || '(none)'}  stamps=${s.stamps}  dirty(unsent)=${s.dirty}`
    );
    if (s.dirty > 0) {
      console.log('     ^^ these keys are still WAITING to be pushed — the last upload failed');
    }
  }

  console.log('\n=== authenticating against Firebase ===');
  const tokens = findRefreshTokens();
  if (!tokens.length) {
    console.log('  No persisted Firebase session found — sign in through the app first.');
    process.exit(1);
  }
  let session: { idToken: string; uid: string; email: string } | null = null;
  for (const t of tokens) {
    session = await exchange(t);
    if (session) break;
  }
  if (!session) {
    console.log('  Found a stored session but it could not be refreshed (signed out / revoked).');
    process.exit(1);
  }
  console.log(`  signed in as ${session.email} (uid ${session.uid})`);

  console.log('\n=== Firestore: users/' + session.uid + '/kv ===');
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/users/${session.uid}/kv?key=${encodeURIComponent(API_KEY)}`,
    { headers: { Authorization: `Bearer ${session.idToken}` } }
  );
  if (res.status === 403) {
    console.log('  403 PERMISSION_DENIED');
    console.log('  -> The Firestore security rules are still denying this user.');
    console.log('  -> Publish firestore.rules (Firestore Database -> Rules -> Publish).');
    process.exit(2);
  }
  if (!res.ok) {
    console.log(`  HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    process.exit(2);
  }
  const body: any = await res.json();
  const docs = body.documents || [];
  console.log(`  documents: ${docs.length}`);
  for (const doc of docs) {
    const f = doc.fields || {};
    const k = f.k?.stringValue;
    const v = f.v?.stringValue;
    const u = f.u?.integerValue;
    console.log(
      `    ${String(k || doc.name).padEnd(52)} ${v == null ? 'TOMBSTONE' : `${v.length} chars`}  u=${u}`
    );
  }
  if (!docs.length) {
    console.log('  (empty — nothing uploaded yet. Open the app once so it can push.)');
  }
}

main().catch((err) => {
  console.error('check failed:', err?.message || err);
  process.exit(1);
});
