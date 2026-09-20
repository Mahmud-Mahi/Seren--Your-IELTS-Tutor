import React, { useEffect, useMemo, useRef, useState } from 'react';
import { serenVoice } from '../utils/speech';
import {
  tokenize,
  wordIndexAtProgress,
  type TokenizedText,
  type WordToken,
} from '../utils/spokenTimeline';

/**
 * Reading-along text for the Cambridge Solutions tab.
 *
 * While `spoken` is true the component follows the speech engine's progress
 * clock and:
 *  - tints the sentence currently being read with a low-opacity background, and
 *  - highlights the single word being pronounced right now.
 *
 * Only the word boundary changes trigger a re-render (the raw progress ticks
 * ~12×/second), so a long sample answer stays perfectly smooth.
 * All timeline math lives in src/utils/spokenTimeline.ts (pure & unit-tested).
 */

interface SpokenTextProps {
  /** The text exactly as displayed (and spoken) on screen. */
  text: string;
  /** True only while this text is the utterance currently being spoken. */
  spoken: boolean;
  className?: string;
}

export const SpokenText: React.FC<SpokenTextProps> = ({ text, spoken, className }) => {
  const { sentences, words, wordsBySentence } = useMemo(() => tokenize(text), [text]);

  const [activeWord, setActiveWord] = useState(-1);
  const activeWordRef = useRef(-1);

  useEffect(() => {
    if (!spoken) {
      activeWordRef.current = -1;
      setActiveWord(-1);
      return;
    }
    return serenVoice.subscribeSpeechProgress(({ progress, speaking }) => {
      const index = speaking ? wordIndexAtProgress(words, progress) : -1;
      if (index === activeWordRef.current) return; // same word — no re-render
      activeWordRef.current = index;
      setActiveWord(index);
    });
  }, [spoken, words]);

  // Fast path: nothing highlighted, render the plain string untouched.
  if (!spoken || activeWord < 0 || activeWord >= words.length) {
    return <span className={className}>{text}</span>;
  }

  const activeSentence = words[activeWord].sentence;
  const parts: React.ReactNode[] = [];
  let cursor = 0;

  sentences.forEach((sentence, si) => {
    if (sentence.start > cursor) {
      parts.push(<React.Fragment key={`gap-${si}`}>{text.slice(cursor, sentence.start)}</React.Fragment>);
    }

    const inner: React.ReactNode[] = [];
    let innerCursor = sentence.start;
    for (const wordIndex of wordsBySentence[si]) {
      const word = words[wordIndex];
      if (word.start > innerCursor) inner.push(text.slice(innerCursor, word.start));
      const raw = text.slice(word.start, word.end);
      inner.push(
        wordIndex === activeWord ? (
          <span key={`w-${wordIndex}`} className="seren-word-active">
            {raw}
          </span>
        ) : (
          <React.Fragment key={`w-${wordIndex}`}>{raw}</React.Fragment>
        )
      );
      innerCursor = word.end;
    }
    if (innerCursor < sentence.end) inner.push(text.slice(innerCursor, sentence.end));

    parts.push(
      <span key={`s-${si}`} className={si === activeSentence ? 'seren-sentence-active' : undefined}>
        {inner}
      </span>
    );
    cursor = sentence.end;
  });

  if (cursor < text.length) parts.push(<React.Fragment key="tail">{text.slice(cursor)}</React.Fragment>);

  return <span className={className}>{parts}</span>;
};
