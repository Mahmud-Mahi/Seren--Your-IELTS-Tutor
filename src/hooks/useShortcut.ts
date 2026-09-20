import { useEffect, useRef, useSyncExternalStore } from 'react';
import {
  areShortcutsSuspended,
  formatShortcut,
  getShortcutBindings,
  hasModifier,
  isEditableTarget,
  isShortcutCaptureActive,
  matchesShortcutEvent,
  subscribeShortcuts,
  type ShortcutBindings,
  type ShortcutId,
} from '../utils/shortcuts';

/**
 * Live view of the user's shortcut bindings. Re-renders the caller whenever a
 * binding is changed in Settings (the store is a module-level pub/sub).
 */
export function useShortcutBindings(): ShortcutBindings {
  return useSyncExternalStore(subscribeShortcuts, getShortcutBindings, getShortcutBindings);
}

/**
 * Runs `handler` when the user presses the key bound to `actionId`.
 *
 * Safety rails (all shared with the rest of the app):
 *  - ignored while a modal is open (setShortcutsSuspended) or while the
 *    Settings recorder is capturing a key,
 *  - ignored inside text fields for modifier-less bindings, so typing a plain
 *    "p" in the chat box never pauses playback (Ctrl/Alt/Cmd combos still work).
 */
export function useShortcut(
  actionId: ShortcutId,
  handler: (event: KeyboardEvent) => void,
  enabled = true
): void {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });

  const binding = useShortcutBindings()[actionId] || '';

  useEffect(() => {
    if (!enabled || !binding) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (areShortcutsSuspended() || isShortcutCaptureActive()) return;
      if (isEditableTarget(event.target) && !hasModifier(binding)) return;
      if (!matchesShortcutEvent(event, binding)) return;
      event.preventDefault();
      event.stopPropagation();
      handlerRef.current(event);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [binding, enabled]);
}

/** Formatted key label for a UI hint ('' when the action is unbound). */
export function useShortcutHint(actionId: ShortcutId): string {
  const binding = useShortcutBindings()[actionId] || '';
  return binding ? formatShortcut(binding) : '';
}
