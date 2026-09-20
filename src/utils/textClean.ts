/**
 * Shared text hygiene for speech synthesis.
 *
 * Imported by BOTH sides of the app:
 *  - the browser speech engine (src/utils/speech.ts) — cleans a line right
 *    before it is sent to /api/tts or handed to the Web Speech API, and
 *  - the neural TTS route on the server (src/server/tts.ts) — defence in depth
 *    for any caller that posts raw text.
 *
 * Why this exists: AI-written lines are full of emoji ("Great job 👏✨"), and
 * every TTS engine either reads them out ("clapping hands", "sparkles") or
 * inserts an awkward pause. Emojis carry no phonetic value, so they are
 * stripped before synthesis while the on-screen text keeps them.
 */

// Emoji, pictographs, dingbats, arrows, flags, keycaps and the invisible
// glue characters that hold multi-codepoint emoji together (ZWJ, variation
// selectors, skin-tone modifiers). Plain punctuation and ©/®/™ are left
// alone so real text is never damaged.
const EMOJI_AND_SYMBOL_PATTERN = new RegExp(
  '[' +
    '\\u{1F000}-\\u{1FAFF}' + // emoticons, pictographs, transport, symbols, objects
    '\\u{1F1E6}-\\u{1F1FF}' + // regional indicators (🇧🇩 flag letters)
    '\\u{1F3FB}-\\u{1F3FF}' + // skin-tone modifiers
    '\\u{2190}-\\u{21FF}' + // arrows
    '\\u{2300}-\\u{23FF}' + // technical symbols (⌚⏰⏸)
    '\\u{2460}-\\u{24FF}' + // enclosed alphanumerics (①)
    '\\u{25A0}-\\u{27BF}' + // geometric shapes + dingbats (✔✅✨❗)
    '\\u{2900}-\\u{297F}' + // supplemental arrows
    '\\u{2B00}-\\u{2BFF}' + // misc symbols & arrows (⭐⬆)
    '\\u{203C}\\u{2049}' + // ‼ ⁉
    '\\u{3030}\\u{303D}' +
    '\\u{3297}\\u{3299}' +
    '\\u{200D}' + // zero-width joiner
    '\\u{20E3}' + // combining enclosing keycap
    '\\u{FE00}-\\u{FE0F}' + // variation selectors (emoji/text presentation)
    '\\u{FEFF}' + // BOM / zero-width no-break space
    '\\u{200B}-\\u{200F}' + // zero-width spaces + bidi marks
    '\\u{2060}' + // word joiner
    ']',
  'gu'
);

/** Removes emoji / pictographs (and their invisible joiners) from a string. */
export function stripEmojis(text: string): string {
  if (!text) return '';
  return text.replace(EMOJI_AND_SYMBOL_PATTERN, ' ');
}

/**
 * Turns any AI-written line into clean speakable text:
 * markdown emphasis, bracketed asides, emoji and stray whitespace removed.
 * Returns '' when nothing is left to say (e.g. an emoji-only line).
 */
export function cleanSpeechText(text: string): string {
  if (!text) return '';
  return stripEmojis(
    text
      .replace(/[*_#`~]/g, '') // markdown emphasis / code ticks
      .replace(/\[.*?\]/g, '') // square-bracket asides (incl. citation ids)
      .replace(/\(.*?\)/g, '') // parenthetical stage directions
  )
    .replace(/\s+/g, ' ')
    .trim();
}