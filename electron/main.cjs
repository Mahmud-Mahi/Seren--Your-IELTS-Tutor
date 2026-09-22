/**
 * Seren — Electron main process.
 *
 * The desktop app is a thin shell around the web app that already exists:
 *   1. It boots the very same Express server (`dist/server.cjs`) that `npm start`
 *      boots — using Electron's bundled Node runtime (ELECTRON_RUN_AS_NODE), so
 *      no system Node.js installation is required.
 *   2. It points a Chromium window at http://127.0.0.1:<port>.
 *
 * Nothing in the web app is Electron-specific: `npm run dev`, `npm start` and
 * the plain browser workflow keep working exactly as before. The only contract
 * is the SEREN_* environment variables set below (see src/server/config.ts,
 * src/server/index.ts, stt-whisper.cjs), which let a read-only installed app
 * bundle keep its writable data (settings, Whisper model, logs) in the OS
 * app-data folder.
 *
 * Ways to launch:
 *   electron . --dev            attach to a running `npm run dev` (port 3000)
 *   electron . --dev-url=<url>  attach to an arbitrary URL
 *   electron .                  run the built server  (npm run app:start)
 */
'use strict';

const { app, BrowserWindow, Menu, ipcMain, protocol, session, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const CLI_HELP = `Seren — Your IELTS Tutor

Usage:
  seren [options]

Options:
  -h, --help       Show this help message
  -v, --version    Show the application version
  --dev            Attach to a development server at http://localhost:3000
  --dev-url=<url>  Attach to a development server at a custom URL
`;

const cliArgs = new Set(process.argv.slice(1));
if (cliArgs.has('--version') || cliArgs.has('-v')) {
  console.log(app.getVersion());
  app.exit(0);
}
if (cliArgs.has('--help') || cliArgs.has('-h')) {
  console.log(CLI_HELP);
  app.exit(0);
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------
// Must happen before the first app.getPath('userData') call so data always
// lands in one stable folder:
//   Linux   ~/.config/Seren
//   Windows %APPDATA%\Seren
//   macOS   ~/Library/Application Support/Seren
app.setName('Seren');

// Chromium blocks audio until the user interacts with the page. Seren speaks
// its questions on its own, so pre-authorise playback for this app.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// ---------------------------------------------------------------------------
// Stable app origin — user data can never be orphaned by a port change
// ---------------------------------------------------------------------------
// All user data (localStorage: profile, chat history, reports, lessons) is
// keyed by ORIGIN, and an origin includes the port. The local server prefers
// port 3000 but silently falls back to a random free port when it is busy, so
// loading the server URL directly would strand the user's data on the old
// origin the first time the port changes. Instead the window ALWAYS loads a
// fixed origin (`seren://app`) and this process transparently forwards every
// request to whichever loopback port the server actually picked.
//
// Must be registered before the app is ready.
const APP_PROTOCOL = 'seren';
const APP_ORIGIN = 'seren://app';
let serverOrigin = ''; // http://127.0.0.1:<port> — resolved during boot

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_PROTOCOL,
    privileges: {
      standard: true, // full URL semantics + working localStorage
      secure: true, // secure context (microphone access, crypto)
      supportFetchAPI: true,
      stream: true,
      codeCache: true,
    },
  },
]);

// ---------------------------------------------------------------------------
// Paths & configuration
// ---------------------------------------------------------------------------
const APP_ROOT = app.getAppPath(); // <install>/resources/app when packaged
const DIST_DIR = path.join(APP_ROOT, 'dist');
const SERVER_ENTRY = path.join(DIST_DIR, 'server.cjs');
const PRELOAD = path.join(__dirname, 'preload.cjs');
const APP_ICON = path.join(DIST_DIR, 'icons', 'icon-512.png');

const DATA_DIR = app.getPath('userData');
const MODELS_DIR = path.join(DATA_DIR, 'models');
const LOG_FILE = path.join(DATA_DIR, 'seren-server.log');
const PREFERRED_PORT = Number(process.env.PORT || 3000);
// Whisper (WASM) + Vite-less boot is usually < 2s, but a cold first run on a
// slow disk may take longer — wait generously, the splash screen is visible.
const BOOT_TIMEOUT_MS = 90000;

// `--dev`, `--dev-url=<url>` or SEREN_DEV_URL: attach to a server that is
// already running (e.g. `npm run dev`) instead of starting another one.
const DEV_URL = (() => {
  const flag = process.argv.find((a) => a.startsWith('--dev-url='));
  if (flag) return flag.slice('--dev-url='.length);
  if (process.env.SEREN_DEV_URL) return process.env.SEREN_DEV_URL;
  if (process.argv.includes('--dev')) return 'http://localhost:3000';
  return null;
})();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let serverChild = null; // spawned server (null when attaching to a dev server)
let serverReady = false;
let mainWindow = null;
let splashWindow = null;
let booting = false;
let quitting = false;

// ---------------------------------------------------------------------------
// Logging — mirrored to the terminal and to <userData>/seren-server.log
// ---------------------------------------------------------------------------
function resetLog() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LOG_FILE, `Seren ${app.getVersion()} — Electron ${process.versions.electron}\n`);
  } catch {}
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(`[seren]${line}`);
  try {
    fs.appendFileSync(LOG_FILE, `${line}\n`);
  } catch {}
}

/** Main-process env is authoritative: load <project>/.env when present (dev). */
function loadProjectEnv() {
  const envFile = path.join(APP_ROOT, '.env');
  if (!fs.existsSync(envFile)) return;
  try {
    require('dotenv').config({ path: envFile });
    log(`loaded environment defaults from ${envFile}`);
  } catch (e) {
    log(`could not load ${envFile}: ${e?.message || e}`);
  }
}

/**
 * One-time migration: when the desktop app starts for the first time, carry the
 * settings saved by `npm start`/`npm run dev` (project-root seren-settings.json,
 * which holds API keys) into the app-data folder. Never overwrites existing data.
 */
function seedSettingsFromProject() {
  const source = path.join(APP_ROOT, 'seren-settings.json');
  const target = path.join(DATA_DIR, 'seren-settings.json');
  try {
    if (fs.existsSync(target) || !fs.existsSync(source)) return;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.copyFileSync(source, target);
    log('imported existing seren-settings.json into the app data folder');
  } catch (e) {
    log(`settings import skipped: ${e?.message || e}`);
  }
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------
/** True for the local server this app owns (and the configured dev server). */
function isInternalUrl(target) {
  try {
    const url = new URL(String(target));
    if (url.protocol === `${APP_PROTOCOL}:`) return true;
    if (!/^https?:$/.test(url.protocol)) return false;
    if (DEV_URL) {
      try {
        if (url.origin === new URL(DEV_URL).origin) return true;
      } catch {}
    }
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  } catch {
    return false;
  }
}

function openExternal(target) {
  if (!/^https?:$/.test(String(target))) {
    log(`blocked external open of non-web URL: ${target}`);
    return;
  }
  shell.openExternal(target).catch((e) => log(`openExternal failed: ${e?.message || e}`));
}

/**
 * Serves the app window from the fixed `seren://app` origin by transparently
 * forwarding every request to the loopback server (whose port may differ per
 * launch). Request bodies are buffered — the app never streams uploads, so
 * this stays simple and reliable.
 */
function registerAppProtocol() {
  protocol.handle(APP_PROTOCOL, async (request) => {
    if (!serverOrigin) {
      return new Response('Seren is still starting…', { status: 503 });
    }
    try {
      const url = new URL(request.url);
      const headers = new Headers(request.headers);
      headers.delete('host');
      const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
      const body = hasBody ? await request.arrayBuffer() : undefined;
      return await fetch(`${serverOrigin}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body,
        redirect: 'manual',
      });
    } catch (error) {
      log(`seren:// request failed: ${error?.message || error}`);
      return new Response('Seren backend unreachable.', { status: 502 });
    }
  });
}

// ---------------------------------------------------------------------------
// Ports & readiness
// ---------------------------------------------------------------------------
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves with the port number when `port` can be bound, or null when busy. */
function probePort(port) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const server = net.createServer();
    server.once('error', () => finish(null));
    server.once('listening', () => {
      const address = server.address();
      const value = address && typeof address === 'object' ? address.port : null;
      server.close(() => finish(value));
    });
    server.listen(port, '127.0.0.1');
  });
}

/** Prefer 3000; fall back to an OS-assigned port so a busy port is never fatal. */
async function pickPort() {
  const preferred = await probePort(PREFERRED_PORT);
  if (preferred) return preferred;
  log(`port ${PREFERRED_PORT} is busy — using an OS-assigned port instead`);
  const fallback = await probePort(0);
  if (!fallback) throw new Error('No free TCP port available');
  return fallback;
}

/**
 * Is a Seren instance already serving on this URL? Used to attach to a running
 * `npm run dev` server instead of starting a second one. /api/health also
 * probes cloud providers, so it can be slow — hence the short timeout: a miss
 * only means we start our own server on another port.
 */
async function isSerenHealthy(baseUrl, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: controller.signal });
    if (!res.ok) return false;
    const body = await res.json();
    return Boolean(body && body.status === 'ok');
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves as soon as something accepts TCP connections on the port — a plain
 * connect probe, deliberately not /api/health (which reaches out to the
 * internet and would delay showing the window by seconds).
 */
function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      let done = false;
      const retry = () => {
        if (done) return;
        done = true;
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`The local server did not start within ${Math.round(timeoutMs / 1000)}s`));
        } else {
          setTimeout(attempt, 250);
        }
      };
      socket.setTimeout(1500);
      socket.once('connect', () => {
        if (done) return;
        done = true;
        socket.destroy();
        resolve();
      });
      socket.once('timeout', retry);
      socket.once('error', retry);
    };
    attempt();
  });
}

// ---------------------------------------------------------------------------
// Server process
// ---------------------------------------------------------------------------
function spawnServer(port) {
  const env = {
    ...process.env,
    // Run Electron's bundled Node runtime as plain Node — no system Node needed.
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    PORT: String(port),
    // Loopback only: the local API holds API keys and can reach paid providers.
    HOST: '127.0.0.1',
    // Writable data goes to the app-data folder (an installed bundle is read-only).
    SEREN_DATA_DIR: DATA_DIR,
    SEREN_MODELS_DIR: MODELS_DIR,
    SEREN_DIST_DIR: DIST_DIR,
  };

  log(`starting local server: ${SERVER_ENTRY}`);
  log(`  data dir: ${DATA_DIR}`);
  log(`  dist dir: ${DIST_DIR}`);

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env,
    // cwd = app-data folder so the server's dotenv() picks up <userData>/.env
    cwd: DATA_DIR,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });

  const relay = (stream, prefix) => {
    if (!stream) return;
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) log(`server ${prefix}${line}`);
      }
    });
  };
  relay(child.stdout, '› ');
  relay(child.stderr, '! ');

  child.on('error', (err) => log(`server process error: ${err?.message || err}`));
  child.on('exit', (code, signal) => {
    const wasCurrent = serverChild === child;
    if (wasCurrent) serverChild = null;
    log(`server exited (code ${code}, signal ${signal || 'none'})`);
    // A crash after a healthy boot leaves a window where every request fails —
    // say so instead of showing silent errors.
    if (!quitting && wasCurrent && serverReady) {
      showErrorPage('The local server stopped unexpectedly.');
    }
  });

  return child;
}

/**
 * Graceful stop: IPC message first (handled in src/server/index.ts), then
 * SIGTERM, then SIGKILL as a last resort. Works on every platform — ppid-based
 * orphan detection is unreliable on Windows, so we never rely on it.
 */
function stopServer() {
  const child = serverChild;
  serverChild = null;
  serverReady = false;
  if (!child || child.exitCode !== null || child.killed) return;
  log('stopping local server');
  try {
    child.send('shutdown');
  } catch {}
  try {
    child.kill('SIGTERM');
  } catch {}
  const killTimer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {}
  }, 4000);
  killTimer.unref?.();
  child.once('exit', () => clearTimeout(killTimer));
}

/**
 * Either attach to an already running Seren (a dev server, or an instance left
 * behind by a previous run) or start our own on a free port.
 */
async function resolveServerUrl() {
  if (DEV_URL) {
    log(`dev mode — attaching to ${DEV_URL} (not starting a local server)`);
    return { url: DEV_URL, dev: true };
  }

  const preferredUrl = `http://127.0.0.1:${PREFERRED_PORT}`;
  const preferredFree = await probePort(PREFERRED_PORT);
  if (preferredFree === null && (await isSerenHealthy(preferredUrl))) {
    log(`a Seren server is already running on ${preferredUrl} — attaching to it`);
    return { url: preferredUrl, dev: false };
  }

  const port = preferredFree ?? (await pickPort());
  const child = spawnServer(port);
  serverChild = child;

  const exitedEarly = new Promise((_, reject) => {
    child.once('exit', (code) =>
      reject(new Error(`The local server exited with code ${code} before it started.`))
    );
  });

  await Promise.race([waitForPort(port, BOOT_TIMEOUT_MS), exitedEarly]);
  serverReady = true;
  log(`server is listening on http://127.0.0.1:${port}`);
  return { url: `http://127.0.0.1:${port}`, dev: false };
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
function createSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) return;
  splashWindow = new BrowserWindow({
    width: 420,
    height: 250,
    frame: false,
    resizable: false,
    show: false,
    center: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#282a36',
    title: 'Starting Seren…',
    icon: APP_ICON,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splashWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.show();
  });
  splashWindow.on('closed', () => {
    splashWindow = null;
  });
  // Local file (not a data: URL) so the packaged app behaves identically.
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
}

function closeSplash() {
  const win = splashWindow;
  splashWindow = null;
  if (win && !win.isDestroyed()) win.close();
}

/** Creates the app window on first use and returns it (visible on first paint). */
function ensureMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#282a36',
    autoHideMenuBar: true,
    title: 'Seren — Your IELTS Tutor',
    icon: APP_ICON,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  registerShellAccelerators(mainWindow);

  mainWindow.once('ready-to-show', () => {
    closeSplash();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // External links open in the user's real browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternalUrl(url)) return { action: 'allow' };
    openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (isInternalUrl(target)) return;
    event.preventDefault();
    openExternal(target);
  });

  mainWindow.webContents.on('did-fail-load', (_event, code, description, failedUrl) => {
    if (quitting || String(failedUrl).startsWith('file:')) return;
    showErrorPage(`Could not reach ${failedUrl}`, `${code} ${description}`);
  });

  return mainWindow;
}

/** Boot-failure screen: what went wrong, where the log is, and a retry button. */
function showErrorPage(message, detail = '') {
  log(`showing startup error: ${message}${detail ? ` (${detail})` : ''}`);
  closeSplash();
  const win = ensureMainWindow();
  const query = { message: String(message) };
  if (detail) query.detail = String(detail);
  query.log = LOG_FILE;
  win.loadFile(path.join(__dirname, 'startup-error.html'), { query });
  if (!win.isVisible()) win.show();
}

// ---------------------------------------------------------------------------
// Menu (hidden until Alt is pressed — see autoHideMenuBar)
// ---------------------------------------------------------------------------
/**
 * The app window's menu.
 *
 * On Linux/Windows there is deliberately NO application menu. An (even
 * auto-hidden) menu bar intercepts Alt-based key combinations before the web
 * app ever sees them — which broke every in-app keyboard shortcut (Alt+1..5,
 * Alt+P, Alt+M, Alt+V, …). The few shell-level actions users still need
 * (zoom, reload, devtools, fullscreen, quit) are handled per-keystroke in
 * registerShellAccelerators() instead.
 *
 * macOS keeps a normal menu: menu mnemonics don't use Alt there, and the OS
 * expects an app menu in the system bar.
 */
function buildMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  const template = [
    { role: 'appMenu' },
    { label: 'File', submenu: [{ role: 'close' }] },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Open data folder', click: () => fs.existsSync(DATA_DIR) && shell.openPath(DATA_DIR) },
        { label: 'Show server log', click: () => fs.existsSync(LOG_FILE) && shell.openPath(LOG_FILE) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Shell-level accelerators for Linux/Windows (where there is no application
 * menu to host them). Electron accelerators normally come from menu roles;
 * with the menu removed they stop working entirely, so the equivalent keys
 * are intercepted here on the fast path. Everything else — notably anything
 * with Alt — passes straight through to the web app's own shortcuts.
 */
function registerShellAccelerators(win) {
  if (process.platform === 'darwin') return;
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const wc = win.webContents;
    const ctrl = input.control || input.meta;
    const key = input.key;
    const handled = () => event.preventDefault();
    if (ctrl && (key === '=' || key === '+')) {
      wc.setZoomLevel(wc.getZoomLevel() + 0.5);
      return handled();
    }
    if (ctrl && (key === '-' || key === '_' || key === 'Subtract')) {
      wc.setZoomLevel(wc.getZoomLevel() - 0.5);
      return handled();
    }
    if (ctrl && (key === '0' || key === 'Numpad0')) {
      wc.setZoomLevel(0);
      return handled();
    }
    if (ctrl && input.shift && (key === 'r' || key === 'R')) {
      wc.reloadIgnoringCache();
      return handled();
    }
    if ((ctrl && (key === 'r' || key === 'R')) || key === 'F5') {
      wc.reload();
      return handled();
    }
    if ((ctrl && input.shift && (key === 'i' || key === 'I')) || key === 'F12') {
      wc.toggleDevTools();
      return handled();
    }
    if (key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      return handled();
    }
    if (ctrl && key === 'q') {
      app.quit();
      return handled();
    }
  });
}

// ---------------------------------------------------------------------------
// Permissions — the app only ever needs the microphone
// ---------------------------------------------------------------------------
function configureSessionPermissions() {
  const ses = session.defaultSession;

  /** Chromium does not always pass the origin to the synchronous check. */
  const originIsOurs = (origin) => {
    if (origin) return isInternalUrl(origin);
    const current = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.getURL() : '';
    return isInternalUrl(current);
  };

  const wantsVideo = (details) => {
    const types = details?.mediaTypes || [];
    return types.includes('video') || details?.mediaType === 'video';
  };

  const allow = (origin, permission, details) => {
    if (!originIsOurs(origin)) return false;
    if (permission === 'media') return !wantsVideo(details);
    return permission === 'fullscreen';
  };

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const origin = webContents && !webContents.isDestroyed() ? webContents.getURL() : '';
    const ok = allow(origin, permission, details);
    if (!ok) log(`denied '${permission}' request from ${origin || '<unknown origin>'}`);
    callback(ok);
  });

  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) =>
    allow(requestingOrigin, permission, details)
  );
}

// ---------------------------------------------------------------------------
// IPC — the only surface preload.cjs exposes
// ---------------------------------------------------------------------------
function registerIpcHandlers() {
  ipcMain.handle('seren:app-info', () => ({
    isDesktop: true,
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    platform: process.platform,
  }));

  ipcMain.handle('seren:open-log', async () => {
    if (!fs.existsSync(LOG_FILE)) return false;
    await shell.openPath(LOG_FILE);
    return true;
  });

  ipcMain.handle('seren:open-data-folder', async () => {
    if (!fs.existsSync(DATA_DIR)) return false;
    await shell.openPath(DATA_DIR);
    return true;
  });

  ipcMain.handle('seren:retry-boot', async () => {
    stopServer();
    await delay(400);
    await boot();
    return true;
  });
}

// ---------------------------------------------------------------------------
// Boot & lifecycle
// ---------------------------------------------------------------------------
async function boot() {
  if (booting) return;
  booting = true;
  try {
    // Attaching to a dev server reuses a window instantly — no splash.
    if (!DEV_URL) createSplash();
    const { url, dev } = await resolveServerUrl();
    if (dev) {
      // Dev mode attaches straight to the running dev server (unchanged).
      ensureMainWindow().loadURL(url);
    } else {
      // Production always loads the FIXED app origin — the port the server
      // picked stays an internal detail of the main process, so the origin
      // (and therefore all localStorage data) is stable across launches.
      serverOrigin = url;
      ensureMainWindow().loadURL(`${APP_ORIGIN}/`);
    }
    if (DEV_URL) closeSplash();
  } catch (error) {
    showErrorPage(
      error?.message || 'Seren failed to start.',
      `Full details are in the log: ${LOG_FILE}`
    );
  } finally {
    booting = false;
  }
}

// A failure in the shell must be logged, never swallowed.
process.on('uncaughtException', (err) => log(`uncaught exception: ${err?.stack || err}`));
process.on('unhandledRejection', (reason) => log(`unhandled rejection: ${reason?.stack || reason}`));

// Single instance: a second launch focuses the running window instead of
// fighting over the port or booting a duplicate server.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    resetLog();
    log(`starting Seren ${app.getVersion()} (Electron ${process.versions.electron}, ${process.platform})`);
    loadProjectEnv();
    seedSettingsFromProject();
    buildMenu();
    configureSessionPermissions();
    registerAppProtocol();
    registerIpcHandlers();
    void boot();
  });

  // Closing the window quits the app on every platform — including macOS — so
  // the local server never keeps running invisibly in the background.
  app.on('window-all-closed', () => app.quit());
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void boot();
  });

  const shutdown = (reason) => {
    if (quitting) return;
    quitting = true;
    log(`shutting down (${reason})`);
    stopServer();
  };
  app.on('before-quit', () => shutdown('before-quit'));
  app.on('will-quit', () => shutdown('will-quit'));
  process.on('SIGINT', () => {
    shutdown('SIGINT');
    app.quit();
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
    app.quit();
  });
}
