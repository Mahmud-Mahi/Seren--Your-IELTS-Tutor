<div align="center">

![Seren](public/icons/icon-192.png)

# Seren — Your IELTS Tutor

**Your personal AI IELTS speaking coach** — practice speaking, get instant CEFR evaluation, and improve with personalized lesson plans.

[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)](https://vitejs.dev/)
[![Node.js](https://img.shields.io/badge/Node.js-Express-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![PWA](https://img.shields.io/badge/PWA-Ready-5A0FC8?logo=pwa&logoColor=white)](https://web.dev/progressive-web-app/)
[![Release](https://img.shields.io/github/v/release/Mahmud-Mahi/Seren--Your-IELTS-Tutor?color=ff79c6&label=release&logo=github)](https://github.com/Mahmud-Mahi/Seren--Your-IELTS-Tutor/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Mahmud-Mahi/Seren--Your-IELTS-Tutor/total?color=50fa7b&label=downloads&logo=github)](https://github.com/Mahmud-Mahi/Seren--Your-IELTS-Tutor/releases)

**📥 [Download the latest release](https://github.com/Mahmud-Mahi/Seren--Your-IELTS-Tutor/releases/latest) · 📧 [mahmudurahmanmahi26@gmail.com](mailto:mahmudurahmanmahi26@gmail.com)**

</div>

---

## ✨ Features

### 🎤 Full Diagnostic Test
Complete Cambridge IELTS-style speaking assessment across all three parts:
- **Part 1** — Introduction & familiar topics (4-5 questions)
- **Part 2** — Cue card with 1-minute preparation
- **Part 3** — Abstract discussion & follow-up questions

### 📊 AI-Powered Evaluation
Instant detailed scoring across four IELTS pillars:

| Pillar | What's Assessed |
|--------|----------------|
| **Fluency & Coherence** | Smoothness, pacing, logical flow |
| **Lexical Resource** | Vocabulary range, precision, idiomatic language |
| **Grammatical Range** | Sentence structures, error frequency, complexity |
| **Pronunciation** | Clarity, stress, intonation, individual sounds |

### 📈 Score Report
- Predicted IELTS band score (0-9)
- CEFR level assessment (A1-C2)
- Strengths & growth areas per pillar
- Upgraded expressions with band-level alternatives
- Pronunciation tips with IPA transcriptions
- Speech statistics (WPM, pause fluency, vocabulary variety)

### 📚 Personalized Lesson Studio
AI-generated lesson roadmap tailored to your weaknesses:
- Rapid fire drills
- Cue card practice
- Lexical boost exercises
- Shadowing sessions
- Mock exam simulations

### 💬 1v1 Chat Practice
Two practice modes:
- **Casual Chat** — Free conversation on everyday topics
- **Interview Mode** — Structured IELTS Part 1 simulation with random topics

### 🔊 Real-Time Voice
- **Speech-to-Text**: Local offline Whisper (sherpa-onnx) with a live mic equalizer in the input box
- **Text-to-Speech**: Microsoft Edge Neural TTS with browser fallback
- Seren speaks questions aloud and listens to your answers

### 📱 Progressive Web App
- Installable on desktop & mobile

---

## 📸 Preview

### 🎤 Cambridge Speaking Test

| Part 1 — Introduction & Lifestyle | Part 2 — Cue Card |
| --- | --- |
| ![Part 1](public/Preview/seren-p1.png) | ![Part 2](public/Preview/seren-p2.png) |

| Part 3 — Two-Way Discussion | Test Selection |
| --- | --- |
| ![Part 3](public/Preview/seren-p3.png) | ![Test selection](public/Preview/seren-test.png) |

### 📊 Score Report

| Overall Evaluation | 4-Pillar Score Cards |
| --- | --- |
| ![Score report](public/Preview/seren-report.png) | ![4-Pillar scores](public/Preview/seren-report-2.png) |

| Band 8+ Sentence Upgrades | Phonetic Coaching |
| --- | --- |
| ![Sentence upgrades](public/Preview/seren-report-3.png) | ![Phonetic coaching](public/Preview/seren-report-4.png) |

### 📚 Lessons, Chat & Settings

| Personalized Lesson Studio | 1v1 Chat (Interview Mode) |
| --- | --- |
| ![Custom lessons](public/Preview/seren-custom-lessons.png) | ![1v1 interview](public/Preview/seren-1v1-interview.png) |

| AI Engine Settings |
| --- |
| ![Settings](public/Preview/setings.png) |

---

## 📥 Download

Grab the latest installer from the **[Releases page](https://github.com/Mahmud-Mahi/Seren--Your-IELTS-Tutor/releases/latest)** — no terminal and no Node.js install required.

| Platform | Installer | How to install |
|----------|-----------|----------------|
| 🪟 **Windows** 10/11 (x64) | [`Seren-Setup-1.3.1.exe`](https://github.com/Mahmud-Mahi/Seren--Your-IELTS-Tutor/releases/download/v1.3.1/Seren-Setup-1.3.1.exe) | Run the installer — per-user install, no admin prompt. It is unsigned, so SmartScreen may warn on first launch. |
| 🐧 **Linux** (Debian / Ubuntu / Kali) | [`seren_1.3.1_amd64.deb`](https://github.com/Mahmud-Mahi/Seren--Your-IELTS-Tutor/releases/download/v1.3.1/seren_1.3.1_amd64.deb) | `sudo apt install ./seren_1.3.1_amd64.deb` |
| 📦 **All versions** | [Releases](https://github.com/Mahmud-Mahi/Seren--Your-IELTS-Tutor/releases) | Full release history, each with notes and checksums |

> 🎙️ Every installer **bundles the offline Whisper speech model** (~280 MB), so the first launch needs no extra download.
>
> 📧 Questions, feedback or a bug report? [mahmudurahmanmahi26@gmail.com](mailto:mahmudurahmanmahi26@gmail.com)

---

## 🆕 What's New in 1.3.1

### ✨ Added & Updated
- 🪟 **Window memory** — Seren reopens at the size, position and maximized state you left it in, and re-centres itself if that monitor is gone.
- 🎙️ **Sharper offline speech-to-text** — the full-precision Whisper `base.en` model now ships inside the installer and is copied into your data folder on first launch, so your first recording never waits on a model download.
- 👤 **Editable profile & preferences** — the header avatar now opens a Preferences panel with nickname, avatar image, target audience, target band and coaching focus.
- 🖼️ **Custom avatars** — upload your own photo during onboarding or later in Preferences; it appears in the header and the 1v1 chat.
- ⏳ **"Transcribing your speech…" state** — Cambridge Test, Lesson Studio and 1v1 chat show a spinner while Whisper works, and the mic button stays locked so recordings can never be cut off or double-started.
- ↕️ **Resizable chat history** — drag the divider in 1v1 chat to give messages more or less room; the composer keeps its natural height.
- 🎚️ **More responsive mic equalizer** — true RMS level metering with smoothing and a fixed height, so the input box no longer jumps.

### 🐛 Fixed
- 🔇 **Flat mic bars** — levels are now read from the real microphone waveform (frequency-bin averages sit near zero for speech).
- 🔁 **Parallel recorders** — starting a new recording while Whisper was still transcribing could spawn a second recorder and drop audio.
- 🎧 **Frozen equalizer** — a suspended `AudioContext` kept the live level meter dead until restart; it now resumes automatically.
- 🧯 **Stuck recording flag** — a failed recorder startup left the controller marked as "recording" and blocked the next attempt.
- 📐 **Layout polish** — header branding no longer squeezes the toolbar, chat/tip cards are centred and width-capped, and the Settings modal and voice picker no longer overflow.

### 📦 Downloads
- 🪟 Windows: `Seren-Setup-1.3.1.exe`
- 🐧 Debian/Ubuntu: `seren_1.3.1_amd64.deb`

### 🔐 Checksums (SHA-256)
```text
56f37872f2d81e8953ce41d4a9c5b3f5c3496c78a2d10c442bf36e4e9bfd108a  Seren-Setup-1.3.1.exe
d58a38b839df3ab341158b7dfc86bd80bd7e109ee3488c67e43debe856fc3e6f  seren_1.3.1_amd64.deb
```

---

## 🚀 Quick Start

### Prerequisites
- [Node.js](https://nodejs.org/) 18+
- A microphone for voice practice

### Installation

```bash
git clone https://github.com/Mahmud-Mahi/Seren--Your-IELTS-Tutor.git
cd Seren--Your-IELTS-Tutor
npm install
cp .env.example .env
```

### Configure LLM Provider

Edit `.env` with your preferred provider. Seren uses a **cascading fallback** system:

```env
# Option 1: Local LLM (LM Studio, llama.cpp, LiteLLM, vLLM)
LLM_BASE_URL=http://localhost:3456/v1
LLM_MODEL=auto
LLM_API_KEY=none

# Option 2: Ollama (free, runs locally)
OLLAMA_BASE_URL=http://localhost:11434/v1
OLLAMA_MODEL=ornith:9b

# Option 3: Groq Cloud (free tier, no credit card)
GROQ_API_KEY=your_groq_api_key_here
GROQ_MODEL=openai/gpt-oss-120b

# Provider priority order
PROVIDER_PRIORITY=local,ollama,groq
```

> **No API key? No problem!** Configure everything at runtime through the in-app Settings panel.

### Run the App

**Development** (runs the Express backend + serves the React frontend):

```bash
npm run dev
```

**Production**:

```bash
npm run build
npm start
```

The app will be available at **http://localhost:3000** (or the `PORT` you configured).

> 💡 **Completely free & better performance — no API key needed!** Use my other repo [token-free-gateway](https://github.com/Mahmud-Mahi/token-free-gateway) — a lightweight AI gateway that exposes an OpenAI-compatible interface with full Tools support, using web AI sessions instead of API tokens. Point Seren's `LLM_BASE_URL` at it and enjoy free, unlimited LLM access:

```env
LLM_BASE_URL=http://localhost:3456/v1
LLM_MODEL=auto
LLM_API_KEY=none
```

---

## 🖥️ Desktop App

Seren also runs as a **standalone desktop app** — its own window and launcher icon, no terminal and no browser tab. Electron is only a *shell*: it boots the exact same Express backend (`dist/server.cjs`) on **Electron's built-in Node runtime**, so no system Node.js is needed at runtime, then opens the UI at `http://127.0.0.1:<port>`.

```bash
npm run app:start     # build + open the desktop window
npm run app:dev       # desktop window attached to a running `npm run dev` (hot reload)
npm run dev:watch     # auto-restart the backend when src/server/* changes
```

The packaged desktop executable also provides command-line information without
opening the application window:

```bash
seren --version       # print the installed version
seren --help          # show command-line options
```

For an unpacked Linux build, run `./release/linux-unpacked/seren --version` or
`./release/linux-unpacked/seren --help`.

### Build installers

```bash
npm run app:dist      # Linux   → release/seren_1.3.1_amd64.deb
npm run app:dist:win  # Windows → release/Seren-Setup-1.3.1.exe  (cross-built with wine)
npm run app:dist:all  # both in one go
npm run app:inspect   # list what actually got packaged (files, deps, secrets, size)
npm run app:dist:mac  # macOS .dmg — must be run ON macOS
```

Each build is also **runnable without installing**: `./release/linux-unpacked/seren`.

> **First run note:** Electron 44 ships its downloader as a separate bin (no `postinstall`), so after `npm install` run `npx install-electron` once if `electron .` complains about a missing binary. Building installers does not need it — electron-builder fetches Electron itself.

### Install (Debian / Ubuntu / Kali)

```bash
sudo apt install ./release/seren_*_amd64.deb       # menu entry + /usr/bin/seren
sudo apt remove seren                              # uninstall (your data is preserved)
```

Verify the generated dependencies resolve on your distro *before* installing:

```bash
dpkg-deb -I release/*.deb | grep -A2 Depends
apt-get -s install ./release/*.deb        # read-only simulation
```

### Where your data lives

The installed app bundle is read-only, so everything writable lives in the OS app-data folder:

| Platform | Folder |
|----------|--------|
| Linux | `~/.config/Seren/` |
| Windows | `%APPDATA%\Seren\` |
| macOS | `~/Library/Application Support/Seren/` |

| File | Contents |
|------|----------|
| `seren-settings.json` | API keys, provider pinning, models, voice (on first desktop launch it is **imported once** from the project root if present) |
| `seren-server.log` | Full startup + backend log — the first place to look when something fails (also in the app's Help menu) |
| `models/` | Whisper STT model (~280 MB full-precision `base.en`; copied from the installer on first launch, auto-downloaded only if missing) |
| `.env` | Optional: put `GROQ_API_KEY`, `LLM_BASE_URL`, `OLLAMA_BASE_URL`, … here for the desktop app |

### Moving your browser data into the desktop app

The app keeps onboarding/profile/preferences in localStorage, which is **per-browser** — the desktop app starts with a fresh profile even if you used Seren in Chrome. Your **settings file** (API keys, provider, voice) is imported automatically on first launch.

The easiest way to carry the rest over is built into the app: **Settings → Your Data → Export backup** in the browser app, then **Import backup** in the desktop app. The backup is a plain JSON file containing every `seren_*` key (profile, reports, lessons, chats, preferences). For raw LevelDB extraction there are two one-time scripts:

```bash
node scripts/migrate-browser-data.cjs    # extract seren_* data from Chrome/Chromium/Brave/Edge (read-only)
node scripts/import-browser-data.cjs --port 9444   # inject into the running desktop app + verify
```

Run the second command while the desktop app is open **with a debug port**, e.g.:

```bash
./release/linux-unpacked/seren --remote-debugging-port=9444
```

It reloads the window and verifies every key, so you see exactly what was carried over (profile, preferences, history). The extractor parses Chrome's LevelDB properly — 32 KB log block framing, snappy-compressed `.ldb` table blocks, prefix-compressed keys — and also picks up data the desktop app wrote under an old `http://127.0.0.1:<port>` origin.

### Desktop behaviour worth knowing

- **Stable origin** — the window always loads the fixed `seren://app` origin, which the shell transparently proxies to whichever loopback port the backend picked. localStorage is origin-scoped, so chat history, reports and lessons can never be stranded by a port change. **Settings → Display Size** provides independent whole-UI zoom (including images) and text-only scaling, while **Settings → Your Data** provides JSON backup and restore.
- **Ports** — the app prefers `3000` and automatically falls back to a free port if it is busy, so the `EADDRINUSE` failure can no longer block startup. If a Seren server is already running on 3000, the window attaches to it instead of starting a second one.
- **Network** — the desktop shell binds the backend to `127.0.0.1` only, so your API keys are never reachable from the LAN (the browser workflow keeps the previous `0.0.0.0` behaviour).
- **Closing the window quits the app** (all platforms), including the backend process — no invisible server left behind.
- **An LLM is still required** (Groq free tier or a local Ollama/LM Studio). The desktop app does not remove that; configure it in Settings or `.env`.
- **Offline speech-to-text needs `ffmpeg` on `PATH`** — the local Whisper engine decodes through it. Cloud STT (Groq Whisper, the default in Settings) needs no external binary, and Seren falls back automatically when `ffmpeg` is missing.
- **Linux sandbox error on launch?** (`The SUID sandbox helper binary was found, but is not configured correctly`) run the unpacked build with `--no-sandbox`, or install the `.deb`, which sets the sandbox helper up correctly.
- **Windows** shows a SmartScreen warning on first run because the installer is unsigned; add a code-signing certificate under `win.signtoolOptions` to remove it.

### Extending the desktop app

`electron/main.cjs` is the shell (window, ports, permissions, shutdown) and `electron-builder.yml` decides what ships. Both are written so normal development needs **no** packaging changes — adding React code, backend routes, question data or ordinary npm dependencies requires nothing at all. For the two cases that do need a line (a new on-disk runtime asset, or a native module), see [`electron-resources/README.md`](electron-resources/README.md).

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Frontend (React)                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐     │
│  │Diagnostic│ │  Score   │ │  Lesson  │ │   1v1    │     │
│  │   Test   │ │  Report  │ │  Studio  │ │   Chat   │     │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘     │
│          Mic equalizer → MediaRecorder (Whisper STT)     │
└─────────────────────────┬────────────────────────────────┘
                          │ HTTP / REST
┌─────────────────────────┴────────────────────────────────┐
│                  Backend (Express)                       │
│  ┌──────────────────────────────────────────────────┐    │
│  │            LLM Provider Cascade                  │    │
│  │    Local → Ollama → Groq (auto-fallback)         │    │
│  └──────────────────────────────────────────────────┘    │
│  ┌─────────────────┐  ┌─────────────────────────────┐    │
│  │   Whisper STT   │  │     Edge Neural TTS         │    │
│  │  (sherpa-onnx)  │  │     (msedge-tts)            │    │
│  └─────────────────┘  └─────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘
```

---

## ⚙️ Configuration

### LLM Providers

| Provider | Description | Setup |
|----------|-------------|-------|
| **Local** | Self-hosted LLM via OpenAI-compatible API | Set `LLM_BASE_URL` to your server |
| **Ollama** | Run open-source models locally | Install [Ollama](https://ollama.com) |
| **Groq** | Free cloud API (no credit card) | Get key at [console.groq.com](https://console.groq.com) |
| **[token-free-gateway](https://github.com/Mahmud-Mahi/token-free-gateway)** | Free OpenAI-compatible gateway using web AI sessions — no API tokens required | Run the gateway locally and set `LLM_BASE_URL` to it |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_BASE_URL` | `http://localhost:3456/v1` | Local LLM server URL |
| `LLM_MODEL` | `auto` | Model ID or `auto` for auto-detect |
| `OLLAMA_BASE_URL` | `http://localhost:11434/v1` | Ollama server URL |
| `OLLAMA_MODEL` | `ornith:9b` | Ollama model name |
| `GROQ_API_KEY` | — | Groq API key |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | Groq model ID |
| `PROVIDER_PRIORITY` | `local,ollama,groq` | Fallback order |
| `TTS_ENABLED` | `true` | Enable text-to-speech |
| `TTS_VOICE` | `en-US-JennyNeural` | Edge TTS voice ID |
| `PORT` | `3000` | Server port |

---

## 📁 Project Structure

```
├── src/
│   ├── components/          # React UI components
│   │   ├── CambridgeTest.tsx     # Cambridge IELTS test flow
│   │   ├── CambridgeSolutions.tsx # Model answers & "what to notice"
│   │   ├── EvaluationReport.tsx  # Score report with tabs
│   │   ├── LessonStudio.tsx      # Personalized lesson modules
│   │   ├── SerenLiveChat.tsx     # 1v1 chat & interview mode
│   │   ├── UserPref.tsx          # Profile & coaching preferences
│   │   ├── SettingsModal.tsx     # Provider, voice & data config
│   │   └── ...
│   ├── utils/
│   │   ├── speech.ts        # TTS, STT, sound effects
│   │   ├── evaluation.ts    # LLM response normalization
│   │   ├── greetings.ts     # AI greeting generation
│   │   └── ...
│   ├── data/                # IELTS question banks
│   ├── types.ts             # TypeScript interfaces
│   └── App.tsx              # Main application
├── server.ts                # Dev entry (thin boot file → src/server/index.ts)
├── src/server/              # Express backend modules (routes, LLM, TTS, STT)
├── stt-whisper.cjs          # sherpa-onnx Whisper STT binding
├── electron/                # Desktop shell (main.cjs, preload.cjs, splash)
├── public/                  # Static assets & PWA manifest
├── assets/                  # IELTS test data (JSON)
└── .env.example             # Environment template
```

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|------------|
| **Frontend** | React 19, TypeScript, Tailwind CSS 4, Motion |
| **Build** | Vite 6, esbuild |
| **Backend** | Express.js, Node.js |
| **LLM** | OpenAI-compatible API (Local/Ollama/Groq) |
| **STT** | sherpa-onnx Whisper (local) + live mic equalizer |
| **TTS** | Microsoft Edge Neural TTS, SpeechSynthesis |
| **PWA** | Service Worker, Web App Manifest |

---

## 🤝 Contributing

Contributions are welcome! Feel free to open issues or submit pull requests.

---

## 📬 Contact

Questions, feedback, or just want to say hi? Reach out!

📧 **Email**: [mahmudurahmanmahi26@gmail.com](mailto:mahmudurahmanmahi26@gmail.com)

🐙 **GitHub**: [@Mahmud-Mahi](https://github.com/Mahmud-Mahi) · 📦 **Downloads**: [Releases](https://github.com/Mahmud-Mahi/Seren--Your-IELTS-Tutor/releases)

---

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/Mahmud-Mahi/Seren--Your-IELTS-Tutor/blob/master/LICENSE)

> The MIT License text is available on GitHub: [choosealicense.com/licenses/mit](https://choosealicense.com/licenses/mit/) · [GitHub's MIT license template](https://github.com/licenses/license-mit)

---

<div align="center">

Made with ❤️ for IELTS learners worldwide

</div>
