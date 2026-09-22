/**
 * Text & UI scaling — a persisted zoom for the whole interface.
 *
 * Tailwind sizes everything in rem, so scaling the root font-size scales the
 * entire UI (text, spacing, controls) proportionally — in the browser AND the
 * desktop app. The choice is stored under `seren_text_scale` (a plain number,
 * 1 = 100%) so it survives reloads and is applied before React first paints.
 */

const STORAGE_KEY = 'seren_text_scale';

/**
 * Base root font size the scale multiplies. Kept in sync with the `html`
 * rule in src/index.css so the very first paint already uses the default.
 */
export const BASE_FONT_PX = 17;

export const MIN_TEXT_SCALE = 0.85;
export const MAX_TEXT_SCALE = 1.6;
export const TEXT_SCALE_STEP = 0.05;
export const DEFAULT_TEXT_SCALE = 1;

export function clampTextScale(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TEXT_SCALE;
  return Math.min(MAX_TEXT_SCALE, Math.max(MIN_TEXT_SCALE, Math.round(value * 100) / 100));
}

/** Current scale (1 = 100%). Falls back to the default when unset/invalid. */
export function getTextScale(): number {
  try {
    const parsed = Number(localStorage.getItem(STORAGE_KEY));
    if (Number.isFinite(parsed) && parsed >= MIN_TEXT_SCALE && parsed <= MAX_TEXT_SCALE) return parsed;
  } catch {
    // storage unavailable — fall through to the default
  }
  return DEFAULT_TEXT_SCALE;
}

/** Applies the scale to the document root; every rem-based size follows. */
export function applyTextScale(scale: number = getTextScale()): void {
  try {
    document.documentElement.style.setProperty('--seren-text-scale', String(scale));
    document.documentElement.style.fontSize = `${(BASE_FONT_PX * scale).toFixed(2)}px`;
  } catch {
    // no document — nothing to do
  }
}

/** Persists AND applies the scale. Returns the clamped value actually used. */
export function setTextScale(scale: number): number {
  const clamped = clampTextScale(scale);
  try {
    localStorage.setItem(STORAGE_KEY, String(clamped));
  } catch {
    // storage may be full/blocked — still apply for this session
  }
  applyTextScale(clamped);
  return clamped;
}

/** Nudge helper for − / + controls (e.g. stepTextScale(-TEXT_SCALE_STEP)). */
export function stepTextScale(delta: number): number {
  return setTextScale(getTextScale() + delta);
}