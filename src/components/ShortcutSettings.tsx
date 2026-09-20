import React, { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import {
  SHORTCUT_DEFINITIONS,
  bindingFromEvent,
  findShortcutConflict,
  formatShortcut,
  isDefaultBinding,
  resetAllShortcuts,
  resetShortcutBinding,
  setShortcutBinding,
  setShortcutCaptureActive,
  type ShortcutGroup,
  type ShortcutId,
} from '../utils/shortcuts';
import { useShortcutBindings } from '../hooks/useShortcut';

const GROUP_ORDER: ShortcutGroup[] = [
  'Navigation',
  'Cambridge Solutions',
  'Custom Lessons',
  '1v1 Chat',
  'General',
];

/**
 * Settings → Keyboard Shortcuts.
 *
 * Every action Seren can run from the keyboard is listed here with its current
 * binding. Clicking a key chip starts recording: the next key combination is
 * captured globally, conflict-checked, and saved to localStorage (so it
 * survives reloads and is picked up by the running listeners instantly).
 * Esc cancels, Backspace/Delete clears the binding.
 */
export const ShortcutSettings: React.FC = () => {
  const bindings = useShortcutBindings();
  const [recording, setRecording] = useState<ShortcutId | null>(null);
  const [notice, setNotice] = useState<{ id: ShortcutId; text: string; ok: boolean } | null>(null);

  // While recording, swallow every key press (capture phase) so no shortcut
  // fires and nothing leaks into the rest of the app.
  useEffect(() => {
    if (!recording) return;
    setShortcutCaptureActive(true);

    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.code === 'Escape' || event.key === 'Escape') {
        setRecording(null);
        setNotice(null);
        return;
      }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        setShortcutBinding(recording, '');
        setNotice({ id: recording, text: 'Cleared — this action now has no shortcut.', ok: true });
        setRecording(null);
        return;
      }

      const binding = bindingFromEvent(event);
      if (!binding) return; // only modifiers held so far — keep waiting

      const conflict = findShortcutConflict(binding, recording);
      if (conflict) {
        setNotice({
          id: recording,
          text: `${formatShortcut(binding)} is already used by "${conflict.label}".`,
          ok: false,
        });
        return;
      }

      setShortcutBinding(recording, binding);
      setNotice({ id: recording, text: `Saved — ${formatShortcut(binding)}`, ok: true });
      setRecording(null);
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      setShortcutCaptureActive(false);
    };
  }, [recording]);

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-bold uppercase tracking-widest text-[#8be9fd]">
          Keyboard Shortcuts
        </h3>
        <button
          type="button"
          onClick={() => {
            setRecording(null);
            setNotice(null);
            resetAllShortcuts();
          }}
          className="flex items-center gap-1.5 text-[11px] text-[#6272a4] hover:text-[#f8f8f2] transition-colors"
        >
          <RotateCcw className="w-3 h-3" />
          Reset all
        </button>
      </div>

      <div className="p-4 rounded-2xl border border-[#44475a] bg-[#21222c] space-y-4">
        <p className="text-[10px] text-[#6272a4] leading-relaxed">
          Click a key chip and press the combination you want.{' '}
          <span className="text-[#8be9fd]">Esc</span> cancels,{' '}
          <span className="text-[#8be9fd]">Backspace</span> clears the binding. Defaults use{' '}
          <span className="font-mono text-[#8be9fd]">Alt</span> so they never interfere with typing.
        </p>

        {GROUP_ORDER.map((group) => {
          const defs = SHORTCUT_DEFINITIONS.filter((def) => def.group === group);
          if (defs.length === 0) return null;
          return (
            <div key={group} className="space-y-1.5">
              <p className="text-[10px] font-bold uppercase tracking-wider text-[#6272a4]">
                {group}
              </p>
              {defs.map((def) => (
                <div
                  key={def.id}
                  className="rounded-xl border border-[#44475a]/70 bg-[#282a36]/60 px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-semibold text-[#f8f8f2] truncate">
                        {def.label}
                      </p>
                      <p className="text-[10px] text-[#6272a4] truncate">{def.description}</p>
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        setNotice(null);
                        setRecording(def.id);
                      }}
                      title="Click, then press the keys you want to use"
                      className={`shrink-0 min-w-[96px] px-2.5 py-1.5 rounded-lg border font-mono text-[10px] font-bold transition-all ${
                        recording === def.id
                          ? 'border-[#50fa7b]/70 bg-[#50fa7b]/15 text-[#50fa7b] animate-pulse'
                          : bindings[def.id]
                          ? 'border-[#44475a] bg-[#21222c] text-[#8be9fd] hover:border-[#bd93f9]/60'
                          : 'border-dashed border-[#ffb86c]/50 bg-[#21222c] text-[#ffb86c] hover:border-[#ffb86c]'
                      }`}
                    >
                      {recording === def.id ? 'Press keys…' : formatShortcut(bindings[def.id])}
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setNotice(null);
                        resetShortcutBinding(def.id);
                      }}
                      disabled={isDefaultBinding(def.id)}
                      title="Reset to default"
                      className="shrink-0 p-1.5 rounded-lg border border-[#44475a] bg-[#21222c] text-[#6272a4] hover:text-[#f8f8f2] transition-colors disabled:opacity-30 disabled:pointer-events-none"
                    >
                      <RotateCcw className="w-3 h-3" />
                    </button>
                  </div>

                  {notice?.id === def.id && (
                    <p
                      className={`mt-1.5 text-[10px] ${
                        notice.ok ? 'text-[#50fa7b]' : 'text-[#ffb86c]'
                      }`}
                    >
                      {notice.text}
                    </p>
                  )}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
};
