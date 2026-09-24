import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { MicEqualizer } from './MicEqualizer';

interface ChatInputBoxProps {
  value: string;
  onChange: (text: string) => void;
  onSend: () => void;
  placeholder?: string;
  disabled?: boolean;
  /** Max visible rows before the box starts scrolling. */
  maxRows?: number;
  inputId?: string;
  /** Focus the composer once when it appears (e.g. after opening a chat). */
  autoFocus?: boolean;
  /** Extra classes for the wrapping element (usually `flex-1`). */
  containerClassName?: string;
  /**
   * When true the composer shows a live ChatGPT-style mic equalizer instead of
   * the textarea (speech is transcribed by Whisper only AFTER the user stops).
   */
  isRecording?: boolean;
  /**
   * Small hint line shown under the equalizer while recording (e.g. "Listening —
   * press stop, then Whisper transcribes your speech").
   */
  recordingHint?: string;
  /** True while the stopped recording is being transcribed. */
  isTranscribing?: boolean;
}

/**
 * A professional, WhatsApp/Discord/Messenger-style message composer.
 *
 * - Multi-line <textarea> that auto-grows up to `maxRows` and then scrolls.
 * - Enter sends, Shift+Enter inserts a newline, IME composition is respected.
 * - The text caret "syncs" with externally-applied text (e.g. live speech
 *   recognition): while the user types, the native caret is preserved; when
 *   text arrives from outside (speech transcript), the caret follows to the end.
 * - After a send clears the box, focus returns to the composer automatically.
 */
export const ChatInputBox: React.FC<ChatInputBoxProps> = ({
  value,
  onChange,
  onSend,
  placeholder,
  disabled,
  maxRows = 4,
  inputId,
  autoFocus,
  containerClassName = '',
  isRecording = false,
  recordingHint,
  isTranscribing = false,
}) => {
  const ref = useRef<HTMLTextAreaElement>(null);
  // True when the latest value change came from the user typing/pasting
  // (so we don't override their native caret with the external-update logic).
  const userEditRef = useRef(false);
  const prevValueRef = useRef(value);
  const prevHadTextRef = useRef(value !== '');

  // Auto-resize the textarea to fit the content, capped at maxRows.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const style = getComputedStyle(el) as CSSStyleDeclaration & {
      lineHeight?: string;
      paddingTop?: string;
      paddingBottom?: string;
    };
    const lineHeight = parseFloat(String(style.lineHeight || '')) || 20;
    const padTop = parseFloat(String(style.paddingTop || '')) || 0;
    const padBottom = parseFloat(String(style.paddingBottom || '')) || 0;
    const maxHeight = lineHeight * maxRows + padTop + padBottom;

    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [value, maxRows, isRecording]);

  // Cursor sync: keep the caret glued to the end when text arrives from an
  // external source (live speech), but never fight the user's native caret.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const externalUpdate = prevValueRef.current !== value && !userEditRef.current;
    if (externalUpdate && el === document.activeElement) {
      const len = el.value.length;
      try { el.setSelectionRange(len, len); } catch {}
    }
    userEditRef.current = false;
    prevValueRef.current = value;

    // After a send clears the box, refocus so the user can immediately type
    // the next message (WhatsApp/Discord behaviour).
    if (value === '' && prevHadTextRef.current && el !== document.activeElement && !disabled) {
      try { el.focus({ preventScroll: true }); } catch {}
    }
    prevHadTextRef.current = value !== '';
  }, [value, disabled]);

  // Optional one-time focus when the composer appears (autoFocus only fires
  // once on mount; it must not steal focus later while disabled flips).
  const didAutoFocusRef = useRef(false);
  useEffect(() => {
    if (!autoFocus || disabled || didAutoFocusRef.current) return;
    didAutoFocusRef.current = true;
    const t = setTimeout(() => {
      try { ref.current?.focus({ preventScroll: true }); } catch {}
    }, 50);
    return () => clearTimeout(t);
  }, [autoFocus, disabled]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    userEditRef.current = true;
    onChange(e.target.value);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter makes a newline; IME composing Enter is ignored
    // so CJK/romaji input methods can confirm candidates without sending.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSend();
    }
  };

  // Recording mode: the composer becomes a ChatGPT/Gemini-style live mic
  // equalizer — no text is shown/typed while the mic is open (Whisper only
  // transcribes AFTER the user presses stop).
  if (isRecording || isTranscribing) {
    return (
      <div className={`flex flex-col ${containerClassName}`}>
        <div className="flex items-center justify-center gap-2 w-full h-[44px] min-h-[44px] max-h-[44px] px-4 py-2.5 rounded-2xl bg-[#282a36] border border-[#44475a] overflow-hidden">
          {isTranscribing ? (
            <>
              <Loader2 className="w-4 h-4 text-[#bd93f9] animate-spin" />
              <span className="text-xs text-[#bd93f9]">Transcribing your speech...</span>
            </>
          ) : (
            <MicEqualizer active />
          )}
        </div>
        {recordingHint && isRecording && (
          <p className="pt-1.5 px-1 text-[10px] text-[#6272a4]">{recordingHint}</p>
        )}
      </div>
    );
  }

  return (
    <div className={`flex flex-col ${containerClassName}`}>
      <div className="relative flex items-end w-full">
        <textarea
          ref={ref}
          id={inputId}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          rows={1}
          data-enable-grammarly="false"
          placeholder={placeholder}
          className="w-full resize-none overflow-hidden leading-relaxed min-h-[44px] max-h-[140px] px-4 py-3 rounded-2xl bg-[#282a36] border border-[#44475a] text-[#f8f8f2] text-xs sm:text-sm placeholder-[#6272a4] focus:outline-none focus:ring-2 focus:ring-[#bd93f9]/50 disabled:opacity-60 disabled:cursor-not-allowed"
        />
      </div>
    </div>
  );
};