/**
 * Audio synthesis, speech recognition, and sound effects for Seren
 */

import { cleanSpeechText } from './textClean';

/**
 * Progress of the utterance currently playing, used for the reading-along
 * highlight (Cambridge Solutions). `progress` is 0..1 through the utterance
 * and `speaking` is only true while audio is actually audible — so consumers
 * clear their highlight during the silent gaps between turns.
 */
export interface SpeechProgressUpdate {
  progress: number;
  speaking: boolean;
}

// Sound effect synthesizer using Web Audio API
class SoundFX {
  private ctx: AudioContext | null = null;

  public getContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  unlock() {
    try {
      const ctx = this.getContext();
      if (ctx && ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.resume();
      }
    } catch (e) {}
  }

  playChime(type: 'start' | 'success' | 'tick' | 'ding') {
    try {
      const ctx = this.getContext();
      if (!ctx) return;

      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      if (type === 'start') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(440, now); // A4
        osc.frequency.exponentialRampToValueAtTime(880, now + 0.2); // A5
        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
        osc.start(now);
        osc.stop(now + 0.35);
      } else if (type === 'success') {
        // Two-tone cheerful chord
        const notes = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6
        notes.forEach((freq, i) => {
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.connect(g);
          g.connect(ctx.destination);
          o.type = 'triangle';
          o.frequency.setValueAtTime(freq, now + i * 0.08);
          g.gain.setValueAtTime(0.12, now + i * 0.08);
          g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.08 + 0.4);
          o.start(now + i * 0.08);
          o.stop(now + i * 0.08 + 0.4);
        });
      } else if (type === 'tick') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(900, now);
        gain.gain.setValueAtTime(0.05, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
        osc.start(now);
        osc.stop(now + 0.05);
      } else if (type === 'ding') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(659.25, now); // E5
        gain.gain.setValueAtTime(0.18, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
        osc.start(now);
        osc.stop(now + 0.6);
      }
    } catch (e) {
      console.warn('Audio play error:', e);
    }
  }
}

export const soundFX = new SoundFX();

export type TTSEngineMode = 'server' | 'browser';

// Neural TTS via the backend (/api/tts, Microsoft Edge neural voices) with
// browser SpeechSynthesis as an automatic fallback.
class SpeechEngine {
  private synth: SpeechSynthesis | null = null;
  private voices: SpeechSynthesisVoice[] = [];
  private selectedVoice: SpeechSynthesisVoice | null = null;
  private isSpeaking = false;
  private currentSpeakingText = '';
  /**
   * Sequential-duplicate guard. Effects and safety-net timers across the app
   * can request the SAME phrase again the moment the previous utterance
   * finishes (StrictMode remounts, view switches, overlapping onEnd fires) —
   * repeating her own sentence sounds like a voice glitch. Anything identical
   * requested within this window is skipped.
   */
  private lastFinishedText = '';
  private lastFinishedAt = 0;
  private readonly DUPLICATE_SPEAK_COOLDOWN_MS = 1500;
  /** Stamps the finished utterance so an immediate identical repeat is dropped. */
  private markFinished(text: string) {
    this.lastFinishedText = text;
    this.lastFinishedAt = Date.now();
  }
  private keepAliveTimer: any = null;
  private pendingSpeakTimeout: any = null;
  private isUnlocked = false;
  private lastServerBlocked = false;
  private queuedSpeakTask: { text: string; options?: any; resolve: () => void; gen: number } | null = null;

  // Server neural TTS state
  private ttsEngine: TTSEngineMode = 'server';
  private ttsVoice: string | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private audioObjectUrl: string | null = null;
  private speakGeneration = 0;
  // AbortController for the in-flight /api/tts fetch — lets stop() cancel a
  // slow/stale request instantly instead of waiting on the socket.
  private ttsAbortCtrl: AbortController | null = null;
  // Settles the in-flight server utterance's speak() promise when its audio
  // element is detached externally (newer utterance / stop()), so the caller
  // awaiting it never hangs.
  private activeServerSettle: ((result: boolean) => void) | null = null;

  // Reading-along progress clock (see SpeechProgressUpdate above).
  private progressListeners = new Set<(update: SpeechProgressUpdate) => void>();
  private progressTimer: any = null;

  constructor() {
    if (typeof window !== 'undefined') {
      try {
        const storedEngine = localStorage.getItem('seren_tts_engine');
        if (storedEngine === 'server' || storedEngine === 'browser') {
          this.ttsEngine = storedEngine;
        }
        const storedVoice = localStorage.getItem('seren_tts_voice');
        if (storedVoice) this.ttsVoice = storedVoice;
      } catch (e) {}
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      this.synth = window.speechSynthesis;
      this.loadVoices();
      if (typeof window.speechSynthesis.onvoiceschanged !== 'undefined') {
        window.speechSynthesis.onvoiceschanged = () => this.loadVoices();
      }
      // Re-check after 500ms and 1500ms for delayed voice initialization in Chromium
      setTimeout(() => this.loadVoices(), 500);
      setTimeout(() => this.loadVoices(), 1500);

      // Auto-unlock on first document interaction if blocked by browser autoplay policy
      const unlockHandler = () => {
        this.unlock();
      };
      window.addEventListener('click', unlockHandler, { once: false, capture: true });
      window.addEventListener('pointerdown', unlockHandler, { once: false, capture: true });
      window.addEventListener('keydown', unlockHandler, { once: false, capture: true });
      window.addEventListener('touchstart', unlockHandler, { once: false, capture: true });
    }
  }

  public setTtsEngine(mode: TTSEngineMode) {
    this.ttsEngine = mode;
    try {
      localStorage.setItem('seren_tts_engine', mode);
    } catch (e) {}
    this.stop();
    // Re-allow server attempts after a manual switch
  }

  public getTtsEngine(): TTSEngineMode {
    return this.ttsEngine;
  }

  public setVoice(voice: string | null) {
    this.ttsVoice = voice;
    try {
      if (voice) {
        localStorage.setItem('seren_tts_voice', voice);
      } else {
        localStorage.removeItem('seren_tts_voice');
      }
    } catch (e) {}
  }

  public getVoice(): string | null {
    return this.ttsVoice;
  }

  // Probe the backend neural TTS; cached failure for 60s to avoid slow retries
  public async checkServerTts(): Promise<boolean> {
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Voice check.' }),
      });
      if (res.ok && (res.headers.get('content-type') || '').startsWith('audio/')) {
        // Consume/discard the tiny audio body
        await res.blob();
        return true;
      }
    } catch (e) {}
    return false;
  }


  private stopServerAudio() {
    // If a server utterance is mid-playback, resolve its pending speak()
    // promise first so no session loop ever hangs on a detached element.
    const settle = this.activeServerSettle;
    this.activeServerSettle = null;
    try { settle?.(true); } catch (e) {}
    // Drop the progress clock silently — the caller emits the "stopped"
    // signal when the utterance is genuinely over (stop / onended).
    this.stopProgressLoop(false);
    if (this.audioEl) {
      // Detach handlers FIRST: clearing src can fire an 'error' event whose
      // stale finish()/onEnd would otherwise cut short newer speech gates
      try {
        this.audioEl.onended = null;
        this.audioEl.onerror = null;
        this.audioEl.onplaying = null;
        this.audioEl.pause();
        this.audioEl.src = '';
      } catch (e) {}
      this.audioEl = null;
    }
    if (this.audioObjectUrl) {
      try {
        URL.revokeObjectURL(this.audioObjectUrl);
      } catch (e) {}
      this.audioObjectUrl = null;
    }
  }

  private async speakWithServer(
    cleanedText: string,
    options: any,
    resolve: () => void,
    gen: number
  ): Promise<boolean> {
    try {
      this.stopServerAudio();
      this.stopBrowserSpeech();

      // Cancel any still-in-flight TTS request so a fresh utterance is never
      // queued behind a slow/stale one.
      if (this.ttsAbortCtrl) this.ttsAbortCtrl.abort();
      const abortCtrl = new AbortController();
      this.ttsAbortCtrl = abortCtrl;

      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: cleanedText,
          // Per-utterance voice override (e.g. the fixed male examiner voice in
          // the Cambridge Solutions tab); falls back to the configured Seren voice.
          voice: (typeof options?.voice === 'string' && options.voice.trim()) || this.ttsVoice || undefined,
          rate: typeof options?.rate === 'number' ? options.rate : 1,
          pitch: typeof options?.pitch === 'number' ? options.pitch : 1.06,
        }),
        signal: abortCtrl.signal,
      });

      this.ttsAbortCtrl = null;

      if (this.isStale(gen)) {
        resolve();
        return true;
      }

      if (!res.ok || !(res.headers.get('content-type') || '').startsWith('audio/')) {
        throw new Error(`TTS endpoint returned ${res.status}`);
      }

      const blob = await res.blob();
      if (this.isStale(gen)) {
        resolve();
        return true;
      }
      if (!blob || blob.size === 0) throw new Error('Empty TTS audio response');

      // Plain Blob playback instead of MediaSource streaming: MSE supports
      // only a handful of codec containers, races on partial MP3 chunks and
      // can leave the utterance in "never started" silence. A blob <audio>
      // element plays the exact bytes the server produced, in every browser,
      // with no timing races.
      const objectUrl = URL.createObjectURL(blob);
      this.audioObjectUrl = objectUrl;
      const audio = new Audio(objectUrl);
      this.audioEl = audio;

      this.isSpeaking = true;
      this.currentSpeakingText = cleanedText;
      this.queuedSpeakTask = null;
      options?.onStart?.();

      // Settle the in-flight playback from outside too: stopServerAudio()
      // (newer utterance / stop()) detaches the element's handlers, and this
      // hook makes sure the awaiting speak() still resolves instead of
      // hanging the session loop forever.
      let settleDone: ((result: boolean) => void) | null = null;
      const done = new Promise<boolean>((resolveDone) => {
        settleDone = resolveDone;
      });
      this.activeServerSettle = (result: boolean) => {
        const s = settleDone;
        this.activeServerSettle = null;
        s?.(result);
      };

      audio.onended = () => {
        if (this.isStale(gen)) {
          this.activeServerSettle?.(true);
          return;
        }
        this.isSpeaking = false;
        this.currentSpeakingText = '';
        this.markFinished(cleanedText);
        this.stopProgressLoop();
        this.activeServerSettle?.(true);
      };
      audio.onerror = () => {
        // Broken/unplayable audio → surface as a failure so dispatchSpeak
        // degrades to the browser engine instead of leaving the user with
        // silence and no fallback.
        this.activeServerSettle?.(false);
      };

      try {
        await audio.play();
      } catch (e: any) {
        // Autoplay blocked: this audio will NEVER actually play, so settle
        // the utterance right away. Keep the task queued so unlock() (first
        // user gesture) replays it as neural speech instead of degrading to
        // the browser voice.
        this.lastServerBlocked = true;
        this.stopServerAudio();
        this.isSpeaking = false;
        this.currentSpeakingText = '';
        resolve();
        return true;
      }

      // Real playback started — drive the reading highlight off the audio clock.
      this.startProgressLoop(cleanedText, typeof options?.rate === 'number' ? options.rate : 1, true);

      const ok = await done;
      this.activeServerSettle = null;

      if (ok) {
        this.stopServerAudio();
        if (!this.isStale(gen)) {
          this.isSpeaking = false;
          this.currentSpeakingText = '';
          this.markFinished(cleanedText);
          options?.onEnd?.();
        }
        resolve();
        return true;
      }

      // Server audio genuinely failed to play — hand over to the browser
      // engine so the user still hears the utterance.
      this.stopServerAudio();
      this.isSpeaking = false;
      this.currentSpeakingText = '';
      resolve();
      return false;
    } catch (err: any) {
      this.ttsAbortCtrl = null;
      if (err?.name === 'NotAllowedError') {
        this.lastServerBlocked = true;
        return false;
      }
      if (this.isStale(gen)) {
        resolve();
        return true;
      }
      console.warn('Server neural TTS unavailable, falling back to browser voice:', err?.message || err);
      return false;
    }
  }

  public unlock() {
    this.isUnlocked = true;
    if (this.synth) {
      try {
        if (this.synth.paused) {
          this.synth.resume();
        }
      } catch (e) {}
    }
    soundFX.unlock();

    // If there was a queued speech that couldn't autoplay due to browser policy, fire it now
    if (this.queuedSpeakTask) {
      const task = this.queuedSpeakTask;
      this.queuedSpeakTask = null;
      void this.dispatchSpeak(task.text, task.options, task.resolve, task.gen);
    }
  }

  private loadVoices() {
    if (!this.synth && typeof window !== 'undefined' && 'speechSynthesis' in window) {
      this.synth = window.speechSynthesis;
    }
    if (!this.synth) return;

    try {
      this.voices = this.synth.getVoices();
      if (this.voices && this.voices.length > 0) {
        // Heuristic: Prefer warm, pleasant English female/natural voices
        const preferred =
          this.voices.find(
            (v) =>
              v.lang.startsWith('en') &&
              (v.name.includes('Natural') ||
                v.name.includes('Google') ||
                v.name.includes('Samantha') ||
                v.name.includes('Victoria') ||
                v.name.includes('Zira') ||
                v.name.includes('Karen') ||
                v.name.includes('Moira') ||
                v.name.includes('Serena') ||
                v.name.includes('Ava') ||
                v.name.includes('Jenny') ||
                v.name.includes('Aria'))
          ) ||
          this.voices.find((v) => v.lang === 'en-GB' || v.lang === 'en-US' || v.lang === 'en-AU') ||
          this.voices.find((v) => v.lang.startsWith('en')) ||
          this.voices[0] ||
          null;

        this.selectedVoice = preferred;
      }
    } catch (e) {
      console.warn('Error fetching speech synthesis voices:', e);
    }
  }

  private startKeepAlive() {
    this.stopKeepAlive();
    // Chrome bug: Speech synthesis stops playing after ~10-15 seconds unless paused & resumed
    this.keepAliveTimer = setInterval(() => {
      if (this.synth && this.synth.speaking) {
        this.synth.pause();
        this.synth.resume();
      } else {
        this.stopKeepAlive();
      }
    }, 4500);
  }

  private stopKeepAlive() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  speak(
    text: string,
    options?: {
      rate?: number;
      pitch?: number;
      voice?: string; // one-off voice id (e.g. male examiner) for this utterance
      onStart?: () => void;
      onEnd?: () => void;
      onBoundary?: (charIndex: number) => void;
    }
  ): Promise<void> {
    return new Promise((resolve) => {
      const gen = ++this.speakGeneration;
      this.queuedSpeakTask = { text, options, resolve, gen };
      void this.dispatchSpeak(text, options, resolve, gen);
    });
  }

  private isStale(gen: number): boolean {
    return gen !== this.speakGeneration;
  }

  private async dispatchSpeak(text: string, options: any, resolve: () => void, gen: number) {
    // Markdown, bracketed asides and emoji are never spoken (emoji would be
    // read out loud by the neural voice). See src/utils/textClean.ts.
    const cleaned = cleanSpeechText(text);

    if (!cleaned || this.isStale(gen)) {
      this.isSpeaking = false;
      this.queuedSpeakTask = null;
      resolve();
      return;
    }

    // Same phrase already being spoken on either engine — never restart or overlap.
    // Resolve quietly WITHOUT firing onEnd, since nothing new was spoken.
    if (this.isSpeaking && this.currentSpeakingText === cleaned) {
      this.queuedSpeakTask = null;
      resolve();
      return;
    }

    // Same phrase finished moments ago and is requested again — skip the
    // repeat instead of playing her own sentence a second time.
    if (
      cleaned !== '' &&
      cleaned === this.lastFinishedText &&
      Date.now() - this.lastFinishedAt < this.DUPLICATE_SPEAK_COOLDOWN_MS
    ) {
      this.queuedSpeakTask = null;
      resolve();
      return;
    }

    // Always prefer the neural (Jenny) voice: attempt the server on every
    // utterance. A single transient failure must not silently downgrade
    // subsequent speech to the browser voice for a cooldown window.
    if (this.ttsEngine === 'server') {
      this.lastServerBlocked = false;
      const ok = await this.speakWithServer(cleaned, options, resolve, gen);
      if (ok) return;
      if (this.isStale(gen)) {
        return;
      }
      // Autoplay-blocked before any user gesture: keep the task queued and
      // wait for unlock() (first click/keypress) instead of degrading to the
      // browser voice — the neural greeting then plays as soon as allowed.
      if (this.lastServerBlocked && this.queuedSpeakTask) {
        return;
      }
      if (!this.queuedSpeakTask) {
        return;
      }
    }

    this.queuedSpeakTask = null;
    this.stopServerAudio();
    this.executeSpeak(text, options, resolve, gen);
  }

  private stopBrowserSpeech() {
    if (this.pendingSpeakTimeout) {
      clearTimeout(this.pendingSpeakTimeout);
      this.pendingSpeakTimeout = null;
    }
    this.stopKeepAlive();
    if (this.synth) {
      try {
        this.synth.cancel();
      } catch (e) {}
    }
  }

  private executeSpeak(
    text: string,
    options: any,
    resolve: () => void,
    gen: number
  ) {
    // A newer speak() superseded this one — stay silent and settle quietly
    if (this.isStale(gen)) {
      this.isSpeaking = false;
      resolve();
      return;
    }

    // Guarantee engine exclusivity: never layer browser speech over server audio
    this.stopServerAudio();

    if (!this.synth) {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        this.synth = window.speechSynthesis;
      }
    }

    if (!this.synth) {
      options?.onStart?.();
      setTimeout(() => {
        options?.onEnd?.();
        resolve();
      }, 1500);
      return;
    }

    // Clear pending speak timeouts
    if (this.pendingSpeakTimeout) {
      clearTimeout(this.pendingSpeakTimeout);
      this.pendingSpeakTimeout = null;
    }

    try {
      this.synth.cancel(); // Stop any pending utterance
      if (this.synth.paused) {
        this.synth.resume();
      }
    } catch (e) {}

    if (!text || !text.trim()) {
      this.isSpeaking = false;
      resolve();
      return;
    }

    // Re-query voices if not already populated
    if (!this.voices || this.voices.length === 0) {
      this.loadVoices();
    }

    // Clean up markdown formatting + emoji for clear spoken output
    const cleanedText = cleanSpeechText(text);

    if (this.isSpeaking && this.currentSpeakingText === cleanedText) {
      // Already speaking this exact phrase, do not cancel or restart
      return;
    }

    // Chromium microtask delay between cancel() and speak() prevents dropped utterances
    this.pendingSpeakTimeout = setTimeout(() => {
      if (this.isStale(gen)) {
        this.isSpeaking = false;
        resolve();
        return;
      }
      try {
        const utterance = new SpeechSynthesisUtterance(cleanedText);
        if (this.selectedVoice) {
          utterance.voice = this.selectedVoice;
        }
        utterance.rate = options?.rate || 1.0;
        utterance.pitch = options?.pitch || 1.06; // slightly warmer, pleasant tone
        utterance.lang = this.selectedVoice?.lang || 'en-US';

        utterance.onstart = () => {
          this.isSpeaking = true;
          this.currentSpeakingText = cleanedText;
          this.queuedSpeakTask = null; // Successfully started
          this.startKeepAlive();
          this.startProgressLoop(cleanedText, utterance.rate || 1, false);
          options?.onStart?.();
        };

        utterance.onend = () => {
          this.isSpeaking = false;
          this.currentSpeakingText = '';
          this.markFinished(text);
          this.stopKeepAlive();
          this.stopProgressLoop();
          options?.onEnd?.();
          resolve();
        };

        utterance.onerror = (e) => {
          // Note: cancel triggers 'interrupted' or 'canceled', which is normal on navigation
          this.isSpeaking = false;
          this.currentSpeakingText = '';
          this.stopKeepAlive();
          this.stopProgressLoop();
          options?.onEnd?.();
          resolve();
        };

        if (options?.onBoundary) {
          utterance.onboundary = (e) => {
            options.onBoundary?.(e.charIndex);
          };
        }

        if (this.synth.paused) {
          this.synth.resume();
        }

        this.synth.speak(utterance);
      } catch (err) {
        console.warn('Speech synthesis speak execution error:', err);
        this.isSpeaking = false;
        options?.onEnd?.();
        resolve();
      }
    }, 10);
  }

  stop() {
    // Invalidate any in-flight synthesis so stale fetches/callbacks stay silent
    this.speakGeneration++;
    // Cancel any in-flight /api/tts fetch instantly
    if (this.ttsAbortCtrl) {
      this.ttsAbortCtrl.abort();
      this.ttsAbortCtrl = null;
    }
    // A stopped task must never be replayed by unlock() later
    this.queuedSpeakTask = null;
    if (this.pendingSpeakTimeout) {
      clearTimeout(this.pendingSpeakTimeout);
      this.pendingSpeakTimeout = null;
    }
    this.stopKeepAlive();
    this.stopServerAudio();
    if (this.synth) {
      try {
        this.synth.cancel();
      } catch (e) {}
    }
    this.isSpeaking = false;
    this.currentSpeakingText = '';
    // Tell the reading highlight that nothing is being spoken any more.
    this.stopProgressLoop();
  }

  getIsSpeaking(): boolean {
    const audioActive = Boolean(this.audioEl && !this.audioEl.paused && !this.audioEl.ended);
    return this.isSpeaking || audioActive || (this.synth ? this.synth.speaking : false);
  }

  // ---------------------------------------------------------------------------
  // Reading-along progress (Cambridge Solutions highlight)
  // ---------------------------------------------------------------------------

  /** Subscribe to the progress clock of whatever is being spoken right now. */
  public subscribeSpeechProgress(listener: (update: SpeechProgressUpdate) => void): () => void {
    this.progressListeners.add(listener);
    return () => {
      this.progressListeners.delete(listener);
    };
  }

  private emitSpeechProgress(progress: number, speaking: boolean) {
    const clamped = Math.min(1, Math.max(0, progress));
    for (const listener of Array.from(this.progressListeners)) {
      try {
        listener({ progress: clamped, speaking });
      } catch (e) {}
    }
  }

  /**
   * Starts ticking progress for one utterance.
   *
   * The neural (server) engine plays a single <audio> blob, so progress is read
   * straight off its `currentTime`/`duration`. The browser engine exposes no
   * such clock, so elapsed wall time over an estimated duration is used instead
   * — accurate enough to drive a reading highlight.
   */
  private startProgressLoop(text: string, rate: number, useAudioClock: boolean) {
    this.stopProgressLoop(false);
    const startedAt = Date.now();
    const estimatedMs = this.estimateUtteranceMs(text, rate);
    this.emitSpeechProgress(0, true);
    this.progressTimer = setInterval(() => {
      if (useAudioClock) {
        const audio = this.audioEl;
        if (audio && isFinite(audio.duration) && audio.duration > 0) {
          this.emitSpeechProgress(audio.currentTime / audio.duration, true);
          return;
        }
      }
      this.emitSpeechProgress((Date.now() - startedAt) / estimatedMs, true);
    }, 80);
  }

  private stopProgressLoop(emitStopped = true) {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
    if (emitStopped) this.emitSpeechProgress(0, false);
  }

  /** Rough spoken length of a line, used when no audio clock is available. */
  private estimateUtteranceMs(text: string, rate = 1): number {
    const words = (text.match(/[A-Za-z0-9']+/g) || []).length || 1;
    const wordsPerMinute = 165 * (rate > 0 ? rate : 1);
    return Math.max(1200, (words / wordsPerMinute) * 60000);
  }
}

export const serenVoice = new SpeechEngine();

// Audio Recorder for High-Fidelity Multimodal AI Speech-to-Text
export class AudioRecorderController {
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private animationFrameId: number | null = null;
  private onLevelUpdate?: (level: number) => void;
  // Live loudness subscribers — used by the mic equalizer UI (ChatGPT-style
  // waveform in the input box). Notified every animation frame with a
  // normalized 0..1 level while a recording session is armed.
  private levelListeners = new Set<(level: number) => void>();
  // Generation counter: bumped by every start()/stop() so a stop() that lands
  // while getUserMedia is still opening can invalidate the in-flight start().
  private startGeneration = 0;

  public isRecording = false;

  /** Subscribe to real-time mic loudness (0..1). Returns an unsubscribe fn. */
  public addLevelListener(listener: (level: number) => void): () => void {
    this.levelListeners.add(listener);
    return () => {
      this.levelListeners.delete(listener);
    };
  }

  async start(onLevel?: (level: number) => void): Promise<boolean> {
    const generation = ++this.startGeneration;
    try {
      this.onLevelUpdate = onLevel;
      this.audioChunks = [];

      // Tear down any stale session first so its mic stream never leaks into
      // the new recording (a new attempt can start before the previous
      // finalize got around to stopping the recorder)
      if (this.mediaRecorder || this.stream) {
        try {
          if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
          }
          if (this.audioContext && this.audioContext.state !== 'closed') {
            this.audioContext.close().catch(() => {});
          }
        } catch (e) {}
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
          // Keep the pending onstop handler: a concurrent stop() awaiting it
          // must still resolve
          try {
            this.mediaRecorder.stop();
          } catch (e) {}
        }
        this.mediaRecorder = null;
        this.audioContext = null;
        this.analyser = null;
        this.cleanup(); // stops the old tracks and clears chunks
      }

      if (!navigator.mediaDevices?.getUserMedia) {
        return false;
      }

      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 44100,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      // A stop() landed while the mic permission/stream was opening — release
      // the tracks immediately instead of recording into an orphan session.
      if (generation !== this.startGeneration) {
        this.stream.getTracks().forEach((track) => track.stop());
        this.stream = null;
        return false;
      }

      // Arm the level monitor before its first animation-frame tick.
      this.isRecording = true;

      // Setup audio analyzer for the live mic equalizer / level monitoring
      try {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioCtx) {
          this.audioContext = new AudioCtx();
          if (this.audioContext.state === 'suspended') {
            void this.audioContext.resume().catch(() => {});
          }
          const source = this.audioContext.createMediaStreamSource(this.stream);
          this.analyser = this.audioContext.createAnalyser();
          this.analyser.fftSize = 256;
          this.analyser.smoothingTimeConstant = 0.72;
          source.connect(this.analyser);

          const bufferLength = this.analyser.frequencyBinCount;
          const dataArray = new Uint8Array(bufferLength);

          const monitorLevel = () => {
            if (!this.isRecording || !this.analyser) return;
            this.analyser.getByteTimeDomainData(dataArray);
            let sumSquares = 0;
            for (let i = 0; i < bufferLength; i++) {
              const sample = (dataArray[i] - 128) / 128;
              sumSquares += sample * sample;
            }
            // RMS tracks the actual microphone waveform. Frequency-bin
            // averages tend to stay near zero for speech after suppression.
            const rms = Math.sqrt(sumSquares / bufferLength);
            const normalized = Math.min(1, Math.max(0, (rms - 0.008) * 5.5));
            this.onLevelUpdate?.(normalized);
            for (const listener of Array.from(this.levelListeners)) {
              try {
                listener(normalized);
              } catch (e) {}
            }
            this.animationFrameId = requestAnimationFrame(monitorLevel);
          };

          monitorLevel();
        }
      } catch (e) {
        // Non-critical visualizer fallback
      }

      // Check supported MIME types
      let mimeType = 'audio/webm;codecs=opus';
      if (typeof MediaRecorder !== 'undefined') {
        if (!MediaRecorder.isTypeSupported(mimeType)) {
          mimeType = MediaRecorder.isTypeSupported('audio/webm')
            ? 'audio/webm'
            : MediaRecorder.isTypeSupported('audio/mp4')
            ? 'audio/mp4'
            : '';
        }
      }

      this.mediaRecorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      this.mediaRecorder.start(250); // Slice chunks every 250ms
      return true;
    } catch (e) {
      this.isRecording = false;
      console.warn('Audio recorder startup error:', e);
      return false;
    }
  }

  async stop(): Promise<{ blob: Blob; base64: string; mimeType: string } | null> {
    this.isRecording = false;
    // Invalidate any in-flight start() (e.g. delayed by the start-chime).
    this.startGeneration++;

    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      try {
        this.audioContext.close();
      } catch (e) {}
      this.audioContext = null;
    }

    return new Promise((resolve) => {
      if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
        this.cleanup();
        resolve(null);
        return;
      }

      this.mediaRecorder.onstop = async () => {
        const mimeType = this.mediaRecorder?.mimeType || 'audio/webm';
        const blob = new Blob(this.audioChunks, { type: mimeType });
        this.cleanup();

        try {
          const reader = new FileReader();
          reader.readAsDataURL(blob);
          reader.onloadend = () => {
            const base64Data = (reader.result as string).split(',')[1] || '';
            resolve({ blob, base64: base64Data, mimeType });
          };
          reader.onerror = () => {
            resolve({ blob, base64: '', mimeType });
          };
        } catch (e) {
          resolve({ blob, base64: '', mimeType });
        }
      };

      try {
        this.mediaRecorder.stop();
      } catch (e) {
        this.cleanup();
        resolve(null);
      }
    });
  }

  private cleanup() {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    this.audioChunks = [];
  }
}

export const activeAudioRecorder = new AudioRecorderController();

// STT client helper — records are posted to the server and transcribed by the
// selected engine (local Sherpa-ONNX, Groq Cloud, or AssemblyAI). Cloud credit
// exhaustion / missing keys automatically fall back to local on the server.
// Returns '' when nothing could be transcribed.
export interface TranscribeResult {
  text: string;
  engine?: string;
  fallback?: boolean;
  fallbackReason?: string;
}

export async function transcribeAudio(params: {
  audioBase64?: string;
  mimeType?: string;
}): Promise<string> {
  const result = await transcribeAudioDetailed(params);
  return result.text;
}

export async function transcribeAudioDetailed(params: {
  audioBase64?: string;
  mimeType?: string;
}): Promise<TranscribeResult> {
  try {
    const res = await fetch('/api/transcribe-audio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const data = await res.json();
    if (data.success && data.transcript) {
      if (data.fallback) console.warn('STT fallback to local:', data.fallbackReason || 'cloud unavailable');
      return {
        text: String(data.transcript).trim(),
        engine: data.engine,
        fallback: Boolean(data.fallback),
        fallbackReason: data.fallbackReason,
      };
    }
    if (!data.success && data.error) {
      console.warn('STT error:', data.error);
    }
  } catch (e) {
    console.warn('STT request failed:', e);
  }
  return { text: '' };
}
