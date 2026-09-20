import { useEffect, useState } from 'react';
import type { SerenMood } from '../types';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  SEREN MOOD SYSTEM — single source of truth for the whole app.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  Mood rules (apply EVERYWHERE — chat, lessons, diagnostics):
 *
 *  ┌──────────────┬─────────────────────────────────────────────────────────┐
 *  │ Mood         │ When it appears                                        │
 *  ├──────────────┼─────────────────────────────────────────────────────────┤
 *  │ greeting     │ Seren greets the user (session start, welcome message)  │
 *  │ speaking     │ Seren is replying / asking a question / ready — NEVER   │
 *  │              │ implies the microphone                                 │
 *  │ listening    │ The microphone is open — from the moment it opens      │
 *  │              │ until the moment it closes. Mic-driven ONLY.           │
 *  │ encouraging  │ The user shared something difficult                    │
 *  │ celebrating  │ Good news, achievements, completed drills              │
 *  │ evaluating   │ Scoring / analysis in progress                         │
 *  └──────────────┴─────────────────────────────────────────────────────────┘
 *
 *  `listening` can NEVER be set directly by feature code or by an LLM reply —
 *  it is derived automatically from the microphone lifecycle.
 */

export type { SerenMood } from '../types';

/** When each mood applies — the authoritative rule table. */
export const MOOD_RULES: Record<SerenMood, string> = {
  greeting: 'Seren greets the user (session start, welcome message)',
  speaking: 'Seren is replying, asking a question, or ready — never implies the mic',
  listening: 'The microphone is open, from the moment it opens until it closes',
  encouraging: 'The user shared something difficult or needs support',
  celebrating: 'Good news, achievements, completed drills',
  evaluating: 'Scoring / analysis in progress',
};

/** Status-bar text shown on the avatar for each mood. */
export const MOOD_STATUS_TEXT: Record<SerenMood, string> = {
  greeting: 'Seren is welcoming you',
  speaking: 'Seren is speaking...',
  listening: 'Seren is listening carefully...',
  encouraging: 'Seren is cheering you on!',
  evaluating: 'Seren is analyzing your performance...',
  celebrating: 'Outstanding progress!',
};

/** Accent colors per mood (rings / badges / glows on the avatar). */
export const MOOD_STYLES: Record<SerenMood, { ring: string; badge: string; glow: string; color: string }> = {
  greeting: { ring: 'ring-[#bd93f9]/50', badge: 'bg-[#44475a]/80 text-[#bd93f9] border-[#bd93f9]/40', glow: 'from-[#bd93f9]/15', color: 'text-[#bd93f9]' },
  speaking: { ring: 'ring-[#8be9fd]/50', badge: 'bg-[#44475a]/80 text-[#8be9fd] border-[#8be9fd]/40', glow: 'from-[#8be9fd]/15', color: 'text-[#8be9fd]' },
  listening: { ring: 'ring-[#50fa7b]/50', badge: 'bg-[#44475a]/80 text-[#50fa7b] border-[#50fa7b]/40', glow: 'from-[#50fa7b]/15', color: 'text-[#50fa7b]' },
  encouraging: { ring: 'ring-[#ff79c6]/50', badge: 'bg-[#44475a]/80 text-[#ff79c6] border-[#ff79c6]/40', glow: 'from-[#ff79c6]/15', color: 'text-[#ff79c6]' },
  evaluating: { ring: 'ring-[#ffb86c]/50', badge: 'bg-[#44475a]/80 text-[#ffb86c] border-[#ffb86c]/40', glow: 'from-[#ffb86c]/15', color: 'text-[#ffb86c]' },
  celebrating: { ring: 'ring-[#f1fa8c]/50', badge: 'bg-[#44475a]/80 text-[#f1fa8c] border-[#f1fa8c]/40', glow: 'from-[#f1fa8c]/20', color: 'text-[#f1fa8c]' },
};

class SerenMoodController {
  /** The mood set by feature code (greeting/speaking/encouraging/...). */
  private base: SerenMood = 'greeting';
  /** Mic override — while true the mood is ALWAYS 'listening'. */
  private micIsOpen = false;
  private listeners = new Set<(mood: SerenMood) => void>();

  get current(): SerenMood {
    return this.micIsOpen ? 'listening' : this.base;
  }

  /**
   * Set the app-level mood. 'listening' is intentionally IGNORED here —
   * it can only ever come from the microphone lifecycle.
   */
  set(mood: SerenMood): void {
    if (mood === 'listening') return;
    if (this.base === mood) return;
    this.base = mood;
    this.emit();
  }

  /** The moment the microphone opens. */
  micOpened(): void {
    if (this.micIsOpen) return;
    this.micIsOpen = true;
    this.emit();
  }

  /** The moment the microphone closes — returns to the previous base mood. */
  micClosed(): void {
    if (!this.micIsOpen) return;
    this.micIsOpen = false;
    this.emit();
  }

  subscribe(fn: (mood: SerenMood) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(): void {
    const mood = this.current;
    this.listeners.forEach((fn) => fn(mood));
  }
}

/** App-wide singleton mood controller. */
export const serenMood = new SerenMoodController();

/**
 * React binding for the central mood controller: `[mood, setMood]`.
 * Use this instead of local `useState<SerenMood>` so every screen shares the
 * same state machine.
 */
export function useSerenMood(): [SerenMood, (mood: SerenMood) => void] {
  const [mood, setMoodState] = useState<SerenMood>(serenMood.current);

  useEffect(() => serenMood.subscribe(setMoodState), []);

  const setMood = (m: SerenMood) => serenMood.set(m);
  return [mood, setMood];
}

/**
 * Keep the mic lifecycle in sync with a component's `isRecording` state.
 * While `isRecording` is true the mood is forced to 'listening'; when it
 * flips false (or the component unmounts) the mic override is released.
 */
export function useMicMoodSync(isRecording: boolean): void {
  useEffect(() => {
    if (isRecording) {
      serenMood.micOpened();
      return () => serenMood.micClosed();
    }
    serenMood.micClosed();
  }, [isRecording]);
}

/**
 * LLM replies may only express greeting/speaking/encouraging/celebrating.
 * A model returning 'listening' is coerced to 'speaking' — that mood is
 * mic-driven only.
 */
export function normalizeReplyMood(mood: any): SerenMood {
  return mood === 'listening' ? 'speaking' : ((mood as SerenMood) || 'speaking');
}