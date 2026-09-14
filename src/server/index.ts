import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import type { Socket } from 'net';
import { registerRoutes } from './routes';
import { getProviders, EXCLUDED_FROM_AUTO_CASCADE } from './llm';
import { ttsEnabled } from './config';
import { defaultTtsVoice } from './tts';
import { whisperSTT } from './whisper';

/**
 * Server entry point — boots the Express app, registers every API route
 * (see src/server/routes/), wires the Vite dev server / static build and
 * handles graceful shutdown. Non-route concerns live in sibling modules:
 *  - config.ts      durable settings + runtime configuration
 *  - whisper.ts     local sherpa-onnx STT loader
 *  - llm.ts         multi-provider LLM cascade
 *  - tts.ts         neural Edge TTS layer
 *  - evaluation.ts  evaluation data-shaping + fallbacks
 *  - prompts.ts     every prompt / schema hint sent to the AI
 *  - chat.ts        offline chat fallback responses
 */

// Keep the process alive across stray TTS WebSocket frames / rejected promises
// (the msedge-tts hardening lives in tts.ts).
process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception (server kept alive):', err?.stack || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled rejection (server kept alive):', reason);
});

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  app.use(express.json({ limit: '10mb' }));

  // All API routes
  registerRoutes(app);

  // Vite integration
  let viteInstance: Awaited<ReturnType<typeof createViteServer>> | null = null;
  if (process.env.NODE_ENV !== 'production') {
    viteInstance = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(viteInstance.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    const providers = getProviders()
      .map((p) => `${p.key}(${p.baseUrl})`)
      .join(' -> ');
    const effectiveAuto = getProviders()
      .filter((p) => !EXCLUDED_FROM_AUTO_CASCADE.has(p.key))
      .map((p) => p.key)
      .join(' -> ');
    console.log(`Lumi — Your IELTS Tutor server running on http://localhost:${PORT}`);
    console.log(`(also reachable on your LAN at http://<your-ip>:${PORT})`);
    console.log(`LLM provider cascade: ${providers}`);
    console.log(`Auto cascade (no pin): ${effectiveAuto} — ollama only when explicitly selected`);
    console.log(`Neural TTS: ${ttsEnabled() ? `enabled, voice ${defaultTtsVoice()}` : 'disabled'}`);
    console.log(`Local Whisper STT: ${whisperSTT ? 'loaded' : 'not available'}`);
  });

  // Track every open connection so shutdown can release the port immediately
  const openSockets = new Set<Socket>();
  server.on('connection', (socket) => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\nPort ${PORT} is already in use — stop the other instance first:`);
      console.error(`  fuser -k ${PORT}/tcp        # force-free the port`);
      console.error(`  kill $(lsof -t -i:${PORT})  # or stop it by PID\n`);
      process.exit(1);
    }
    throw err;
  });

  // Graceful shutdown: Ctrl+C / stop / terminal close frees port instantly
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received — stopping Lumi and releasing port ${PORT}…`);
    try {
      void viteInstance?.close();
    } catch (e) {}
    for (const socket of openSockets) socket.destroy();
    server.close(() => {
      console.log('Lumi stopped — port released.');
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
  process.on('message', (msg: any) => {
    if (msg === 'shutdown') shutdown('SIGTERM');
  });

  // If the launcher (npm/sh) died without signalling us, we are an orphan
  // reparented to init — stop on our own so port is never left bound
  setInterval(() => {
    if (process.ppid === 1 && !shuttingDown) shutdown('orphan-watchdog');
  }, 5000).unref();
}

// Boot the whole thing. Errors here are fatal (build issues, missing deps…).
startServer().catch((err) => {
  console.error('[server] Fatal boot error:', err?.stack || err);
  process.exit(1);
});