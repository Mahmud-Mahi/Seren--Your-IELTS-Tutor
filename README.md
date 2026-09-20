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
- **Speech-to-Text**: Local offline Whisper (sherpa-onnx) + browser Web Speech API
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

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Frontend (React)                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐     │
│  │Diagnostic│ │  Score   │ │  Lesson  │ │   1v1    │     │
│  │   Test   │ │  Report  │ │  Studio  │ │   Chat   │     │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘     │
│                    Web Speech API                        │
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
│   │   ├── DiagnosticTest.tsx    # Cambridge IELTS test flow
│   │   ├── EvaluationReport.tsx  # Score report with tabs
│   │   ├── LessonStudio.tsx      # Personalized lesson modules
│   │   ├── SerenLiveChat.tsx      # 1v1 chat & interview mode
│   │   ├── SerenAvatar.tsx        # Animated character avatar
│   │   ├── SettingsModal.tsx     # Provider & voice config
│   │   └── ...
│   ├── utils/
│   │   ├── speech.ts        # TTS, STT, sound effects
│   │   ├── evaluation.ts    # LLM response normalization
│   │   ├── greetings.ts     # AI greeting generation
│   │   └── ...
│   ├── data/                # IELTS question banks
│   ├── types.ts             # TypeScript interfaces
│   └── App.tsx              # Main application
├── server.ts                # Express backend (LLM, TTS, STT)
├── stt-whisper.cjs          # sherpa-onnx Whisper STT binding
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
| **STT** | sherpa-onnx Whisper (local), Web Speech API |
| **TTS** | Microsoft Edge Neural TTS, SpeechSynthesis |
| **PWA** | Service Worker, Web App Manifest |

---

## 🤝 Contributing

Contributions are welcome! Feel free to open issues or submit pull requests.

---

## 📬 Contact

Questions, feedback, or just want to say hi? Reach out!

📧 **Email**: [mahmudurahmanmahi26@gmail.com](mailto:mahmudurahmanmahi26@gmail.com)

---

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/Mahmud-Mahi/Seren--Your-IELTS-Tutor/blob/master/LICENSE)

> The MIT License text is available on GitHub: [choosealicense.com/licenses/mit](https://choosealicense.com/licenses/mit/) · [GitHub's MIT license template](https://github.com/licenses/license-mit)

---

<div align="center">

Made with ❤️ for IELTS learners worldwide

</div>
