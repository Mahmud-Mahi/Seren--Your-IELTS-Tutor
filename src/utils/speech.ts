/**
 * Audio synthesis, speech recognition, and sound effects for Lumi
 */

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

  constructor() {
    if (typeof window !== 'undefined') {
      try {
        const storedEngine = localStorage.getItem('lumi_tts_engine');
        if (storedEngine === 'server' || storedEngine === 'browser') {
          this.ttsEngine = storedEngine;
        }
        const storedVoice = localStorage.getItem('lumi_tts_voice');
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
      localStorage.setItem('lumi_tts_engine', mode);
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
        localStorage.setItem('lumi_tts_voice', voice);
      } else {
        localStorage.removeItem('lumi_tts_voice');
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
          // the Cambridge Solutions tab); falls back to the configured Lumi voice.
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

      const ok = await done;
      this.activeServerSettle = null;

      if (ok) {
        this.stopServerAudio();
        if (!this.isStale(gen)) {
          this.isSpeaking = false;
          this.currentSpeakingText = '';
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
    const cleaned = (text || '')
      .replace(/[*_#`~]/g, '')
      .replace(/\[.*?\]/g, '')
      .replace(/\(.*?\)/g, '')
      .trim();

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

    // Clean up markdown formatting for clear spoken output
    const cleanedText = text
      .replace(/[*_#`~]/g, '')
      .replace(/\[.*?\]/g, '')
      .replace(/\(.*?\)/g, '')
      .trim();

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
          options?.onStart?.();
        };

        utterance.onend = () => {
          this.isSpeaking = false;
          this.currentSpeakingText = '';
          this.stopKeepAlive();
          options?.onEnd?.();
          resolve();
        };

        utterance.onerror = (e) => {
          // Note: cancel triggers 'interrupted' or 'canceled', which is normal on navigation
          this.isSpeaking = false;
          this.currentSpeakingText = '';
          this.stopKeepAlive();
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
  }

  getIsSpeaking(): boolean {
    const audioActive = Boolean(this.audioEl && !this.audioEl.paused && !this.audioEl.ended);
    return this.isSpeaking || audioActive || (this.synth ? this.synth.speaking : false);
  }
}

export const lumiVoice = new SpeechEngine();

export interface SpeechLocaleOption {
  code: string;
  name: string;
  flag: string;
}

export const SUPPORTED_SPEECH_LOCALES: SpeechLocaleOption[] = [
  { code: 'en-US', name: 'English (US & International)', flag: '🇺🇸' },
  { code: 'en-GB', name: 'English (British / UK)', flag: '🇬🇧' },
  { code: 'en-IN', name: 'English (India & South Asia)', flag: '🇮🇳' },
  { code: 'en-AU', name: 'English (Australia)', flag: '🇦🇺' },
  { code: 'en-CA', name: 'English (Canada)', flag: '🇨🇦' },
  { code: 'en-NZ', name: 'English (New Zealand)', flag: '🇳🇿' },
  { code: 'en-IE', name: 'English (Ireland)', flag: '🇮🇪' },
  { code: 'en-SG', name: 'English (Singapore & SE Asia)', flag: '🇸🇬' },
  { code: 'en-PH', name: 'English (Philippines)', flag: '🇵🇭' },
  { code: 'en-ZA', name: 'English (South Africa)', flag: '🇿🇦' },
];

// Audio Recorder for High-Fidelity Multimodal AI Speech-to-Text
export class AudioRecorderController {
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private animationFrameId: number | null = null;
  private onLevelUpdate?: (level: number) => void;
  // Generation counter: bumped by every start()/stop() so a stop() that lands
  // while getUserMedia is still opening can invalidate the in-flight start().
  private startGeneration = 0;

  public isRecording = false;

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

      // Setup audio analyzer for realistic soundwave level monitoring
      try {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioCtx && this.onLevelUpdate) {
          this.audioContext = new AudioCtx();
          const source = this.audioContext.createMediaStreamSource(this.stream);
          this.analyser = this.audioContext.createAnalyser();
          this.analyser.fftSize = 256;
          source.connect(this.analyser);

          const bufferLength = this.analyser.frequencyBinCount;
          const dataArray = new Uint8Array(bufferLength);

          const monitorLevel = () => {
            if (!this.isRecording || !this.analyser) return;
            this.analyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < bufferLength; i++) {
              sum += dataArray[i];
            }
            const avg = sum / bufferLength;
            const normalized = Math.min(1, avg / 100);
            this.onLevelUpdate?.(normalized);
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
      this.isRecording = true;
      return true;
    } catch (e) {
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

// Whisper STT client helper — sends recorded audio to server, gets text back.
// Web Speech API draft is used as fallback if Whisper fails.
export async function transcribeAudioWithAI(params: {
  audioBase64?: string;
  mimeType?: string;
  draftTranscript?: string;
}): Promise<string> {
  try {
    const res = await fetch('/api/transcribe-audio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const data = await res.json();
    if (data.success && data.transcript) {
      return data.transcript.trim();
    }
  } catch (e) {
    console.warn('Whisper STT fallback:', e);
  }
  return params.draftTranscript?.trim() || '';
}

// Web Speech Recognition Controller with Live Streaming
export interface SpeechRecognitionController {
  start: () => void;
  stop: () => void;
  abort: () => void;
  reset: () => void;
  setBaseTranscript: (text: string) => void;
  setLanguage: (lang: string) => void;
  isSupported: boolean;
}

export function createSpeechRecognizer(callbacks: {
  onResult: (transcript: string, isFinal: boolean) => void;
  onError?: (error: string) => void;
  onStart?: () => void;
  onEnd?: () => void;
  initialText?: string;
  lang?: string;
}): SpeechRecognitionController {
  const SpeechRecognition =
    (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

  if (!SpeechRecognition) {
    return {
      start: () => {
        callbacks.onError?.('Speech recognition is not supported in this browser. You can type your responses directly.');
      },
      stop: () => {},
      abort: () => {},
      reset: () => {},
      setBaseTranscript: () => {},
      setLanguage: () => {},
      isSupported: false,
    };
  }

  let recognition: any = null;
  let isListening = false;
  let shouldBeRecording = false;
  let baseTranscript = (callbacks.initialText || '').trim();
  let currentSessionFinal = '';
  let currentLanguage = callbacks.lang || 'en-US';
  let restartTimeout: any = null;
  let restartAttempt = 0;
  const RESTART_DELAYS = [200, 500, 1000, 2000];

  // Watchdog: Chrome's recognizer sometimes dies silently mid-session (no
  // onend/onerror — results just stop, e.g. ~60-90s into a long turn). We
  // track liveness and hard-restart with a FRESH instance when that happens.
  const WATCHDOG_IDLE_MS = 15000;
  let watchdogTimer: any = null;
  let lastActivityAt = Date.now();
  let hardRestarting = false;
  let hardRestartGuard: any = null;

  const noteActivity = () => {
    lastActivityAt = Date.now();
  };

  const mergeSessionFinal = () => {
    if (currentSessionFinal) {
      baseTranscript = [baseTranscript, currentSessionFinal]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      currentSessionFinal = '';
    }
  };

  const clearHardRestartGuard = () => {
    if (hardRestartGuard) {
      clearTimeout(hardRestartGuard);
      hardRestartGuard = null;
    }
    hardRestarting = false;
  };

  // Abort whatever exists and start a completely FRESH recognition instance.
  // Reusing an instance after a silent death is unreliable — Chrome's
  // SpeechRecognition enters a tainted state where .start() throws or does
  // nothing at all. Crucially this does NOT fire onEnd/onStart callbacks, so
  // the UI never flips out of its "recording" state during recovery.
  const hardRestart = () => {
    // The aborted instance may fire a late onend — suppress it so it cannot
    // schedule a competing restart or re-merge finalized text
    hardRestarting = true;
    if (hardRestartGuard) clearTimeout(hardRestartGuard);
    hardRestartGuard = setTimeout(() => {
      hardRestartGuard = null;
      hardRestarting = false;
    }, 2500);

    clearTimeout(restartTimeout);
    restartTimeout = null;
    mergeSessionFinal();

    initRecognition(); // aborts the old instance and creates a fresh one
    try {
      recognition.start();
      restartAttempt = 0;
    } catch (e) {
      console.warn('Speech recognition hard restart failed:', e);
      restartAttempt++;
    }
    noteActivity();
  };

  const stopWatchdog = () => {
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
  };

  const startWatchdog = () => {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(() => {
      if (!shouldBeRecording) {
        stopWatchdog();
        return;
      }
      const idleMs = Date.now() - lastActivityAt;
      if (isListening && idleMs > WATCHDOG_IDLE_MS) {
        // Recognizer claims to be listening but produced nothing for a long
        // time → Chrome's silent-death state
        console.warn(
          `Speech recognition watchdog: no results for ${Math.round(idleMs / 1000)}s — restarting with a fresh instance`
        );
        hardRestart();
      } else if (!isListening && !restartTimeout && !hardRestarting && idleMs > 8000) {
        // Should be recording, nothing is listening, and no restart was ever
        // scheduled (start() threw on a tainted instance)
        hardRestart();
      }
    }, 5000);
  };

  const bindRecognitionHandlers = () => {
    if (!recognition) return;

    recognition.onstart = () => {
      isListening = true;
      noteActivity();
      callbacks.onStart?.();
    };

    recognition.onresult = (event: any) => {
      noteActivity();
      let sessionFinal = '';
      let sessionInterim = '';

      for (let i = 0; i < event.results.length; ++i) {
        const res = event.results[i];
        if (!res || !res[0]) continue;

        const transcriptChunk = (res[0].transcript || '').trim();
        if (res.isFinal) {
          sessionFinal += (sessionFinal ? ' ' : '') + transcriptChunk;
        } else {
          sessionInterim += (sessionInterim ? ' ' : '') + transcriptChunk;
        }
      }

      currentSessionFinal = sessionFinal;

      // Cleanly combine base transcript + session finalized + interim hypothesis
      const parts = [baseTranscript, sessionFinal, sessionInterim].filter(Boolean);
      let combined = parts.join(' ').replace(/\s+/g, ' ').trim();

      // Standard capitalization for first letters of sentences
      combined = combined.replace(/(^\s*|\.\s+)([a-z])/g, (_match, sep, char) => `${sep}${char.toUpperCase()}`);

      const isFinal = Boolean(event.results[event.results.length - 1]?.isFinal);
      callbacks.onResult(combined, isFinal);
    };

    recognition.onerror = (event: any) => {
      noteActivity();
      console.warn('Speech recognition event note:', event.error);
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        shouldBeRecording = false;
        isListening = false;
        callbacks.onError?.('Microphone access blocked. Please check browser permissions.');
      } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
        callbacks.onError?.(event.error);
      }
    };

    recognition.onend = () => {
      isListening = false;

      // A hard restart just aborted this instance — its late onend must not
      // schedule a competing restart or re-merge finalized text
      if (hardRestarting) return;

      // If user is actively recording and the browser ended session on pause,
      // create a FRESH recognition instance to avoid Chrome's tainted-instance bug
      if (shouldBeRecording) {
        mergeSessionFinal();
        noteActivity();

        clearTimeout(restartTimeout);
        const delay = RESTART_DELAYS[Math.min(restartAttempt, RESTART_DELAYS.length - 1)];
        restartTimeout = setTimeout(() => {
          restartTimeout = null;
          if (shouldBeRecording && !isListening) {
            try {
              // Destroy the old instance and create a fresh one — Chrome's
              // SpeechRecognition sometimes enters a tainted state after
              // auto-stop where .start() silently fails or throws, so
              // reusing the same instance is unreliable.
              initRecognition();
              recognition.start();
              restartAttempt = 0;
            } catch (e) {
              console.warn('Restarting recognition with fresh instance:', e);
              restartAttempt++;
              if (restartAttempt < RESTART_DELAYS.length) {
                recognition.onend?.();
              } else {
                // All retries exhausted — inform the component so the UI
                // can reflect that recording has stopped.
                shouldBeRecording = false;
                callbacks.onEnd?.();
              }
            }
          }
        }, delay);
      } else {
        callbacks.onEnd?.();
      }
    };
  };

  const initRecognition = () => {
    try {
      if (recognition) {
        try {
          recognition.abort();
        } catch (e) {}
      }

      recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1; // 1 alternative provides stable continuous speech without word flapping
      recognition.lang = currentLanguage;

      bindRecognitionHandlers();
    } catch (e: any) {
      console.error('Error creating recognition instance:', e);
    }
  };

  initRecognition();

  return {
    start: () => {
      shouldBeRecording = true;
      restartAttempt = 0; // Reset backoff on fresh start
      noteActivity();
      startWatchdog();
      if (isListening || hardRestarting) return;
      // Always begin from a FRESH instance — after long sessions Chrome's
      // recognizer can be tainted and a plain .start() throws or silently
      // does nothing. hardRestart preserves the transcript and never flips
      // the UI out of its recording state.
      hardRestart();
    },
    stop: () => {
      shouldBeRecording = false;
      clearTimeout(restartTimeout);
      restartTimeout = null;
      stopWatchdog();
      clearHardRestartGuard();
      mergeSessionFinal();
      if (recognition) {
        try {
          recognition.stop();
        } catch (e) {}
      }
      isListening = false;
      callbacks.onEnd?.();
    },
    abort: () => {
      shouldBeRecording = false;
      clearTimeout(restartTimeout);
      restartTimeout = null;
      stopWatchdog();
      clearHardRestartGuard();
      if (recognition) {
        try {
          recognition.abort();
        } catch (e) {}
      }
      isListening = false;
    },
    reset: () => {
      baseTranscript = '';
      currentSessionFinal = '';
    },
    setBaseTranscript: (text: string) => {
      baseTranscript = (text || '').trim();
      currentSessionFinal = '';
    },
    setLanguage: (lang: string) => {
      currentLanguage = lang;
      if (recognition) {
        recognition.lang = lang;
      }
    },
    isSupported: true,
  };
}
