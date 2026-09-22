/**
 * One-off importer (run AFTER migrate-browser-data.cjs): writes the extracted
 * `seren_*` localStorage entries into the running desktop app over the
 * DevTools protocol, reloads the page, and reads everything back to verify.
 *
 *   1. start the app:  ./release/linux-unpacked/seren --remote-debugging-port=9444
 *   2. node scripts/migrate-browser-data.cjs            (extract)
 *   3. node scripts/import-browser-data.cjs --port 9444 (inject + verify)
 */
'use strict';

const fs = require('fs');

const CDP_PORT = Number(process.env.CDP_PORT || (process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 9444));
// The page now lives on a fixed `seren://app` origin in the desktop app; dev
// mode still attaches over plain http. Match any of them.
const APP_URL_PREFIXES = ['seren://', 'http://127.0.0.1:', 'http://localhost:'];
const DATA_FILE = '/tmp/seren-browser-data.json';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findPageTarget() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && APP_URL_PREFIXES.some((p) => String(t.url).startsWith(p)));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch {}
    await sleep(500);
  }
  throw new Error(`No page target on CDP port ${CDP_PORT} — is the desktop app running?`);
}

function makeRpc(ws) {
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
}

async function evaluate(rpc, expression) {
  const result = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluation failed');
  return result.result ? result.result.value : undefined;
}

(async () => {
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  // The mic preference sits in a prefix-compressed LevelDB entry the extractor
  // cannot fully decode, but its value (`false` = manual mic mode) is plainly
  // visible in the record. Only used when extraction didn't already find it.
  if (!data.seren_auto_mic) data.seren_auto_mic = 'false';

  const page = await findPageTarget();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('WebSocket handshake failed')));
  });
  const rpc = makeRpc(ws);

  const keys = Object.keys(data);
  console.log(`importing ${keys.length} key(s) into the desktop app…`);
  await evaluate(
    rpc,
    `(() => { const data = ${JSON.stringify(data)}; for (const [k, v] of Object.entries(data)) localStorage.setItem(k, v); return Object.keys(data).length; })()`
  );
  await rpc('Page.reload', {}).catch(() => {});
  await sleep(4000);

  const echo = await evaluate(
    rpc,
    `JSON.stringify(Object.fromEntries(Object.entries(localStorage).filter(([k]) => k.startsWith('seren_'))))`
  );
  const stored = JSON.parse(echo);
  let missing = 0;
  for (const key of keys) {
    if (stored[key] === data[key]) console.log(`  ✓ ${key}`);
    else {
      console.log(`  ✗ ${key} — not imported correctly`);
      missing += 1;
    }
  }
  const extra = Object.keys(stored).filter((k) => !keys.includes(k));
  if (extra.length) console.log(`  (app already had: ${extra.join(', ')})`);
  ws.close();
  console.log(missing === 0 ? '\nImport verified — your browser data now lives in the desktop app.' : `\n${missing} key(s) failed.`);
  process.exit(missing === 0 ? 0 : 1);
})().catch((e) => {
  console.error(`import failed: ${e.message}`);
  process.exit(1);
});
