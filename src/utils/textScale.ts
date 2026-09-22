/**
 * Persisted UI zoom and text-only scaling for the whole interface.
 */

const UI_ZOOM_STORAGE_KEY = 'seren_ui_zoom';
const TEXT_SCALE_STORAGE_KEY = 'seren_text_scale';

/**
 * Base root font size the scale multiplies. Kept in sync with the `html`
 * rule in src/index.css so the very first paint already uses the default.
 */
export const BASE_FONT_PX = 17;

export const MIN_UI_ZOOM = 0.75;
export const MAX_UI_ZOOM = 1.5;
export const UI_ZOOM_STEP = 0.05;
export const DEFAULT_UI_ZOOM = 1;

export const MIN_TEXT_SCALE = 0.85;
export const MAX_TEXT_SCALE = 1.6;
export const TEXT_SCALE_STEP = 0.05;
export const DEFAULT_TEXT_SCALE = 1;

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value * 100) / 100));
}

export function clampUiZoom(value: number): number {
  return clamp(value, MIN_UI_ZOOM, MAX_UI_ZOOM, DEFAULT_UI_ZOOM);
}

export function clampTextScale(value: number): number {
  return clamp(value, MIN_TEXT_SCALE, MAX_TEXT_SCALE, DEFAULT_TEXT_SCALE);
}

function readScale(key: string, fallback: number, min: number, max: number): number {
  try {
    const parsed = Number(localStorage.getItem(key));
    if (Number.isFinite(parsed) && parsed >= min && parsed <= max) return parsed;
  } catch {
  }
  return fallback;
}

export function getUiZoom(): number {
  return readScale(UI_ZOOM_STORAGE_KEY, DEFAULT_UI_ZOOM, MIN_UI_ZOOM, MAX_UI_ZOOM);
}

export function getTextScale(): number {
  return readScale(TEXT_SCALE_STORAGE_KEY, DEFAULT_TEXT_SCALE, MIN_TEXT_SCALE, MAX_TEXT_SCALE);
}

export function applyUiZoom(zoom: number = getUiZoom()): void {
  try {
    document.documentElement.style.setProperty('--seren-ui-zoom', String(zoom));
  } catch {
  }
}

export function applyTextScale(scale: number = getTextScale()): void {
  try {
    document.documentElement.style.setProperty('--seren-text-scale', String(scale));
  } catch {
  }
}

export function setUiZoom(zoom: number): number {
  const clamped = clampUiZoom(zoom);
  try {
    localStorage.setItem(UI_ZOOM_STORAGE_KEY, String(clamped));
  } catch {
  }
  applyUiZoom(clamped);
  return clamped;
}

export function setTextScale(scale: number): number {
  const clamped = clampTextScale(scale);
  try {
    localStorage.setItem(TEXT_SCALE_STORAGE_KEY, String(clamped));
  } catch {
  }
  applyTextScale(clamped);
  return clamped;
}

export function stepUiZoom(delta: number): number {
  return setUiZoom(getUiZoom() + delta);
}

export function stepTextScale(delta: number): number {
  return setTextScale(getTextScale() + delta);
}