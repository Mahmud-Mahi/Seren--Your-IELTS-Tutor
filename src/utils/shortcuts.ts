/**
 * User-customizable keyboard shortcuts.
 *
 * Every action the app exposes on a key is declared once in
 * SHORTCUT_DEFINITIONS with a sensible default; the user can re-record any of
 * them in Settings → Keyboard Shortcuts. Bindings live in localStorage
 * (seren_shortcuts) and are broadcast through a tiny pub/sub so the UI (and the
 * Settings list) re-renders the moment a key is changed.
 *
 * Binding format: lowercase, canonical modifier order + the key, e.g.
 *   'alt+p', 'ctrl+shift+l', 'space', 'escape'
 * Keys are derived from `KeyboardEvent.code` (with `key` as fallback) so
 * Option/Alt combinations work identically on macOS and Windows.
 */

export const SHORTCUT_IDS = [
  'nav.diagnostic',
  'nav.solutions',
  'nav.report',
  'nav.lessons',
  'nav.chat',
  'solutions.playPause',
  'solutions.stop',
  'lessons.toggleSidebar',
  'chat.toggleMode',
  'global.toggleVoice',
  'global.openSettings',
] as const;

export type ShortcutId = (typeof SHORTCUT_IDS)[number];

export type ShortcutGroup =
  | 'Navigation'
  | 'Cambridge Solutions'
  | 'Custom Lessons'
  | '1v1 Chat'
  | 'General';

export interface ShortcutDefinition {
  id: ShortcutId;
  group: ShortcutGroup;
  label: string;
  description: string;
  /** '' means "unbound" (the action simply has no key). */
  defaultBinding: string;
}

export const SHORTCUT_DEFINITIONS: ShortcutDefinition[] = [
  {
    id: 'nav.diagnostic',
    group: 'Navigation',
    label: 'Cambridge Test tab',
    description: 'Jump to the full Cambridge speaking test',
    defaultBinding: 'alt+1',
  },
  {
    id: 'nav.solutions',
    group: 'Navigation',
    label: 'Cambridge Solutions tab',
    description: 'Jump to the listen & learn solutions class',
    defaultBinding: 'alt+2',
  },
  {
    id: 'nav.report',
    group: 'Navigation',
    label: 'Score Report tab',
    description: 'Open your latest band score report',
    defaultBinding: 'alt+3',
  },
  {
    id: 'nav.lessons',
    group: 'Navigation',
    label: 'Custom Lessons tab',
    description: 'Open your personalized lesson studio',
    defaultBinding: 'alt+4',
  },
  {
    id: 'nav.chat',
    group: 'Navigation',
    label: '1v1 Chat tab',
    description: 'Open the interview / casual chat',
    defaultBinding: 'alt+5',
  },
  {
    id: 'solutions.playPause',
    group: 'Cambridge Solutions',
    label: 'Pause / resume the session',
    description: 'Pauses the live Q&A, or resumes and replays the current turn',
    defaultBinding: 'alt+p',
  },
  {
    id: 'solutions.stop',
    group: 'Cambridge Solutions',
    label: 'Stop the session',
    description: 'Ends the running topic session immediately',
    defaultBinding: 'alt+s',
  },
  {
    id: 'lessons.toggleSidebar',
    group: 'Custom Lessons',
    label: 'Show / hide the module panel',
    description: 'Collapses or expands the roadmap sidebar',
    defaultBinding: 'alt+b',
  },
  {
    id: 'chat.toggleMode',
    group: '1v1 Chat',
    label: 'Interview ⇄ Casual Chat',
    description: 'Switches between the two chat modes',
    defaultBinding: 'alt+m',
  },
  {
    id: 'global.toggleVoice',
    group: 'General',
    label: 'Mute / unmute voice audio',
    description: "Turns Seren's spoken audio on or off",
    defaultBinding: 'alt+v',
  },
  {
    id: 'global.openSettings',
    group: 'General',
    label: 'Open settings',
    description: 'Opens the AI engine, voice & shortcut settings',
    defaultBinding: 'alt+,',
  },
];

export type ShortcutBindings = Record<ShortcutId, string>;

const STORAGE_KEY = 'seren_shortcuts';
const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'meta'] as const;

/** Keys that can never end a binding (pure modifiers / dead keys). */
const NON_BINDABLE_KEYS = new Set([
  'control',
  'alt',
  'shift',
  'meta',
  'altgraph',
  'capslock',
  'dead',
  'unidentified',
  'fn',
  'os',
]);

const KEY_LABELS: Record<string, string> = {
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  meta: 'Cmd',
  space: 'Space',
  escape: 'Esc',
  enter: 'Enter',
  tab: 'Tab',
  backspace: '⌫',
  delete: 'Del',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  ',': ',',
};

export function defaultBindings(): ShortcutBindings {
  const bindings = {} as ShortcutBindings;
  for (const def of SHORTCUT_DEFINITIONS) bindings[def.id] = def.defaultBinding;
  return bindings;
}

/** Lowercases + canonicalises a binding string ('Alt + P' → 'alt+p'). */
export function normalizeBinding(binding: string): string {
  if (typeof binding !== 'string' || !binding) return '';
  const parts = binding
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return '';
  const modifiers = MODIFIER_ORDER.filter((mod) => parts.includes(mod));
  const keys = parts.filter((part) => !(MODIFIER_ORDER as readonly string[]).includes(part));
  const key = keys[keys.length - 1];
  if (!key) return '';
  return [...modifiers, key].join('+');
}

/** The key a KeyboardEvent represents, layout-stable via `code` when possible. */
export function normalizeEventKey(event: KeyboardEvent): string {
  const code = event.code || '';
  if (code === 'Space') return 'space';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F[0-9]{1,2}$/.test(code)) return code.toLowerCase();

  const codeMap: Record<string, string> = {
    Escape: 'escape',
    Enter: 'enter',
    NumpadEnter: 'enter',
    Tab: 'tab',
    Backspace: 'backspace',
    Delete: 'delete',
    ArrowUp: 'arrowup',
    ArrowDown: 'arrowdown',
    ArrowLeft: 'arrowleft',
    ArrowRight: 'arrowright',
    Comma: ',',
    Period: '.',
    Slash: '/',
    Semicolon: ';',
    Quote: "'",
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Minus: '-',
    Equal: '=',
    Backquote: '`',
  };
  if (codeMap[code]) return codeMap[code];

  const key = event.key || '';
  if (!key || key === 'Unidentified') return '';
  return key.toLowerCase();
}

/** Builds a binding from a keydown event; '' for modifier-only presses. */
export function bindingFromEvent(event: KeyboardEvent): string {
  const key = normalizeEventKey(event);
  if (!key || NON_BINDABLE_KEYS.has(key)) return '';
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push('ctrl');
  if (event.altKey) modifiers.push('alt');
  if (event.shiftKey) modifiers.push('shift');
  if (event.metaKey) modifiers.push('meta');
  return [...modifiers, key].join('+');
}

export function matchesShortcutEvent(event: KeyboardEvent, binding: string): boolean {
  const normalized = normalizeBinding(binding);
  if (!normalized) return false;
  const parts = normalized.split('+');
  const key = parts[parts.length - 1];
  const modifiers = new Set(parts.slice(0, -1));
  if (event.ctrlKey !== modifiers.has('ctrl')) return false;
  if (event.altKey !== modifiers.has('alt')) return false;
  if (event.shiftKey !== modifiers.has('shift')) return false;
  if (event.metaKey !== modifiers.has('meta')) return false;
  return normalizeEventKey(event) === key;
}

/** True when the binding uses Ctrl / Alt / Cmd (works while typing too). */
export function hasModifier(binding: string): boolean {
  const parts = normalizeBinding(binding).split('+');
  return parts.some((part) => part === 'ctrl' || part === 'alt' || part === 'meta');
}

/** Human-readable label for a binding ('alt+p' → 'Alt + P'). */
export function formatShortcut(binding: string): string {
  const normalized = normalizeBinding(binding);
  if (!normalized) return 'Unassigned';
  return normalized
    .split('+')
    .map((part) => {
      const label = KEY_LABELS[part];
      if (label) return label;
      if (part.length === 1) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' + ');
}

/** True when focus is inside a text field (plain keys must not hijack typing). */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return el.isContentEditable === true;
}

// ---------------------------------------------------------------------------
// Store (localStorage + pub/sub)
// ---------------------------------------------------------------------------

let cachedBindings: ShortcutBindings | null = null;
let suspended = false;
let capturing = false;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch (e) {}
  }
}

export function subscribeShortcuts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function readStoredBindings(): ShortcutBindings {
  const defaults = defaultBindings();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaults;
    const merged = { ...defaults };
    for (const id of SHORTCUT_IDS) {
      const value = (parsed as Record<string, unknown>)[id];
      if (typeof value === 'string') merged[id] = normalizeBinding(value);
    }
    return merged;
  } catch (e) {
    return defaults;
  }
}

/**
 * The current bindings. Returns a cached object so React's
 * useSyncExternalStore snapshot stays referentially stable.
 */
export function getShortcutBindings(): ShortcutBindings {
  if (!cachedBindings) cachedBindings = readStoredBindings();
  return cachedBindings;
}

function persist(next: ShortcutBindings) {
  cachedBindings = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (e) {}
  notify();
}

export function setShortcutBinding(id: ShortcutId, binding: string): ShortcutBindings {
  const next = { ...getShortcutBindings(), [id]: normalizeBinding(binding) };
  persist(next);
  return next;
}

export function resetShortcutBinding(id: ShortcutId): ShortcutBindings {
  return setShortcutBinding(id, defaultBindings()[id]);
}

export function resetAllShortcuts(): ShortcutBindings {
  const next = defaultBindings();
  persist(next);
  return next;
}

export function isDefaultBinding(id: ShortcutId): boolean {
  return getShortcutBindings()[id] === defaultBindings()[id];
}

/** The other action already using this binding, if any. */
export function findShortcutConflict(
  binding: string,
  exceptId?: ShortcutId
): ShortcutDefinition | null {
  const target = normalizeBinding(binding);
  if (!target) return null;
  const bindings = getShortcutBindings();
  return (
    SHORTCUT_DEFINITIONS.find((def) => def.id !== exceptId && bindings[def.id] === target) || null
  );
}

// ---------------------------------------------------------------------------
// Global guards
// ---------------------------------------------------------------------------

/**
 * Shortcuts are ignored while a modal / onboarding flow owns the screen, so a
 * stray Alt+2 never yanks the user out of Settings.
 */
export function setShortcutsSuspended(value: boolean) {
  suspended = value;
}

export function areShortcutsSuspended(): boolean {
  return suspended;
}

/** While the Settings recorder is listening for a key, nothing else reacts. */
export function setShortcutCaptureActive(value: boolean) {
  capturing = value;
}

export function isShortcutCaptureActive(): boolean {
  return capturing;
}