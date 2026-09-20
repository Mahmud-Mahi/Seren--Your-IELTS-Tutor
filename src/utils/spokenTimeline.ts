/**
 * Reading-along timeline math (pure, no React).
 *
 * Used by src/components/SpokenText.tsx: it tokenizes the text exactly as it is
 * displayed on screen into sentences and words, weights each word by how long
 * it "feels" when read aloud, and maps a 0..1 progress value from the speech
 * engine onto the word that should be highlighted at that moment.
 *
 * Weights are proportional to the real audio duration, which keeps the
 * highlight in step with the voice without needing word-timing metadata from
 * the TTS server.
 */

export interface WordToken {
  start: number;
  end: number;
  weight: number;
  sentence: number;
}

export interface SentenceToken {
  start: number;
  end: number;
}

export interface TokenizedText {
  sentences: SentenceToken[];
  words: WordToken[];
  /** Indices into `words`, grouped per sentence. */
  wordsBySentence: number[][];
}

/**
 * How long a word "feels" when reading aloud: its letters plus a pause for the
 * punctuation that follows it.
 */
export function wordWeight(raw: string): number {
  const letters = (raw.match(/[A-Za-z0-9]/g) || []).length;
  let weight = Math.max(1, letters);
  if (/[,;:–—-]$/.test(raw)) weight += 4;
  if (/[.!?…]$/.test(raw)) weight += 9;
  return weight;
}

export function tokenize(text: string): TokenizedText {
  const sentences: SentenceToken[] = [];
  const words: WordToken[] = [];
  const wordsBySentence: number[][] = [];
  const wordPattern = /\S+/g;
  let match: RegExpExecArray | null;
  let sentence = -1;
  let previousRaw = '';
  let previousEnd = 0;

  while ((match = wordPattern.exec(text))) {
    const start = match.index;
    const end = start + match[0].length;
    // A new sentence starts when the previous word ended in terminal
    // punctuation (the \S+ token swallows it: "here.") or on a hard line break.
    if (
      sentence < 0 ||
      /[.!?…]$/.test(previousRaw) ||
      text.slice(previousEnd, start).includes('\n')
    ) {
      sentence += 1;
      sentences.push({ start, end });
      wordsBySentence.push([]);
    } else {
      sentences[sentence].end = end;
    }
    words.push({ start, end, weight: wordWeight(match[0]), sentence });
    wordsBySentence[sentence].push(words.length - 1);
    previousRaw = match[0];
    previousEnd = end;
  }

  return { sentences, words, wordsBySentence };
}

/** Which word the given 0..1 progress lands on (weights are proportional). */
export function wordIndexAtProgress(words: WordToken[], progress: number): number {
  if (words.length === 0) return -1;
  let total = 0;
  for (const word of words) total += word.weight;
  if (total <= 0) return -1;
  const target = Math.min(Math.max(progress, 0), 1) * total;
  let accumulated = 0;
  for (let i = 0; i < words.length; i++) {
    accumulated += words[i].weight;
    if (target <= accumulated) return i;
  }
  return words.length - 1;
}
