# Desktop build resources

Files here are **build-time only** — electron-builder reads them while packaging and
never copies them into the installed app (the folder is referenced by
`directories.buildResources` in [`../electron-builder.yml`](../electron-builder.yml)).

| File | Used for |
|------|----------|
| `icon.png` (512×512) | Linux `.deb` icons (hicolor sizes) and the macOS `.dmg` icon |
| `icon.ico` (256→16, multi-size) | Windows installer and `.exe` icon |
| `entitlements.mac.plist` | macOS hardened-runtime entitlements — `com.apple.security.device.audio-input` is **required** or the packaged app is denied microphone access |

Regenerate the Windows icon after changing `icon.png`:

```bash
magick public/icons/icon-512.png -define icon:auto-resize=256,128,64,48,32,16 electron-resources/icon.ico
```

---

## How the desktop app is wired (30-second version)

`electron/main.cjs` starts `dist/server.cjs` as a **separate Node process**
(`ELECTRON_RUN_AS_NODE`, so Electron's own runtime is used) and points a window at
`http://127.0.0.1:<port>`. Four environment variables are what keep a read-only
install working:

| Variable | Set by the shell to | Read by |
|----------|--------------------|---------|
| `SEREN_DATA_DIR` | app-data folder | `src/server/config.ts` (settings) |
| `SEREN_MODELS_DIR` | `<app-data>/models` | `stt-whisper.cjs` (Whisper model + temp audio) |
| `SEREN_DIST_DIR` | `<install>/resources/app/dist` | `src/server/index.ts` (static files) |
| `HOST` | `127.0.0.1` | `src/server/index.ts` (loopback only) |

All four **default to the previous behaviour** (`process.cwd()` / project `models/` /
`0.0.0.0`), which is why `npm run dev`, `npm start` and the browser workflow are
untouched.

`asar` is deliberately **disabled** (`electron-builder.yml`): the backend runs as a
plain Node child process and must resolve its modules with normal Node semantics,
so keeping files unpacked removes a whole class of "works in dev, fails when
installed" surprises.

---

## Everyday changes need no config

| You change | What to do |
|-----------|------------|
| React/UI/components, styles, event handlers | `npm run app:dev` — hot reloads in the window |
| Backend routes, prompts, TTS/STT logic | restart `npm run dev` (or `npm run dev:watch`) |
| IELTS question banks / any **imported** JSON | nothing — Vite bundles it into `dist/assets/*.js` |
| A regular npm dependency | `npm install <pkg>` → it ships automatically if it is in `dependencies`, then `npm run app:dist` |
| Version / app name | `version` / `productName` — artifact names are templated from them |
| Electron upgrade | `npm i -D electron@latest` → `npm run app:dist` (nothing native to rebuild: STT is WASM) |

## Recipe 1 — a new file the backend reads **from disk** at runtime

Most data belongs in `import`s (bundled automatically). Only files opened by path
with `fs` need packaging work:

1. Put the file under `dist/` (i.e. ship it from `public/` or copy it in the build
   script) **or** allowlist a top-level folder in `electron-builder.yml`:

   ```yaml
   files:
     - my-data-folder/**/*
   ```

2. Point the code at a path that survives installation — derive it from
   `SEREN_DIST_DIR` (or add a new `SEREN_*` variable set in `electron/main.cjs`),
   never from `process.cwd()`.
3. Rebuild and confirm it was included:

   ```bash
   npm run app:dist && npm run app:inspect
   ```

## Recipe 2 — a new dependency

| Kind of package | What to do |
|-----------------|------------|
| Pure JS / ESM | `dependencies` only — nothing else |
| WebAssembly (like `sherpa-onnx`) | `dependencies` only |
| N-API prebuilt binaries | `dependencies` + add it to `asarUnpack` |
| `node-gyp` compiled addon | `dependencies` + `asarUnpack` + set `npmRebuild: true` |

Rule of thumb: if `dist/server.cjs` requires it at runtime, it must be in
`dependencies` (the bundle is built with `--packages=external`), never in
`devDependencies` — that rule already applies to `npm start`.

## Recipe 3 — renaming the app

Names appear in three places that must stay in sync:

1. `productName` in `electron-builder.yml` (installer, `/opt/<name>`, window class).
2. `desktopName` in `package.json` — Electron derives the Linux app_id/WM_CLASS from
   it, and `linux.syncDesktopName: true` makes `StartupWMClass` match, so the desktop
   environment links the window to the launcher icon.
3. `app.setName('Seren')` in `electron/main.cjs` — decides `~/.config/Seren`.

If you change these, existing users' data folder does **not** move automatically;
`seedSettingsFromProject()` only imports from the project root on first launch.
