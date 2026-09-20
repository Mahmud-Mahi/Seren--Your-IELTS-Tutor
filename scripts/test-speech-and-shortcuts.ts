/**
 * Standalone validation for the new speech & shortcut logic:
 *   npx tsx scripts/test-speech-and-shortcuts.ts
 *
 * Covers:
 *  1. emoji / markdown stripping (textClean.ts) — nothing emoji-ish is spoken
 *  2. reading-along timeline math (spokenTimeline.ts)
 *  3. shortcut bindings, matching, formatting & conflicts (shortcuts.ts)
 */

import assert from 'assert';
import { cleanSpeechText, stripEmojis } from '../src/utils/textClean';
import { tokenize, wordIndexAtProgress, wordWeight } from '../src/utils/spokenTimeline';
import {
  bindingFromEvent,
  defaultBindings,
  findShortcutConflict,
  formatShortcut,
  getShortcutBindings,
  isEditableTarget,
  matchesShortcutEvent,
  normalizeBinding,
  resetAllShortcuts,
  setShortcutBinding,
  type ShortcutId,
} from '../src/utils/shortcuts';

// ---------------------------------------------------------------- 1. textClean
console.log('1. textClean');

// Emojis (plain, ZWJ sequences, flags, keycaps, skin tones) must all vanish.
// stripEmojis swaps them for spaces (collapsed later by cleanSpeechText), so we
// assert the pictographs are gone and the real words survive.
const emojiCases: Array<[string, string[]]> = [
  ['Great job 👏!', ['Great', 'job', '!']],
  ['Well done ✨👏🏻 mate', ['Well', 'done', 'mate']],
  ['Hi 👨‍👩‍👧‍👦 there', ['Hi', 'there']],
  ['Flag 🇧🇩 and ⭐ star', ['Flag', 'and', 'star']],
  ['① number ⑩ key 3️⃣', ['number', 'key']],
  ['“Quoted — text” ✓', ['Quoted', 'text']],
];
for (const [input, words] of emojiCases) {
  const stripped = stripEmojis(input);
  assert.ok(
    !/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2460}-\u{24FF}\u{1F1E6}-\u{1F1FF}]/u.test(stripped),
    `emoji must be gone: ${input}`
  );
  for (const word of words) {
    assert.ok(stripped.includes(word), `"${word}" kept in: ${input}`);
  }
}

// © ® ™ are real text characters, never stripped.
assert.strictEqual(stripEmojis('plain text with © ® ™'), 'plain text with © ® ™');

// Emoji-only lines must clean to '' — there is nothing to pronounce.
assert.strictEqual(cleanSpeechText('🎉🎉'), '');

// Markdown, bracket asides, emoji and whitespace collapse — in one pass.
assert.strictEqual(
  cleanSpeechText('  **Band 8** answer [id-42] with (a pause) 👌\n\nnext  line  '),
  'Band 8 answer with next line'
);

// Real content is untouched.
const sample = "I'd say technology has reshaped how we communicate, hasn't it?";
assert.strictEqual(cleanSpeechText(sample), sample);
console.log('  ✔ emoji / markdown stripping OK');

// ---------------------------------------------------- 2. spokenTimeline.ts
console.log('2. spokenTimeline');

// Word weights: punctuation adds a reading pause.
assert.strictEqual(wordWeight('hello'), 5);
assert.strictEqual(wordWeight('it,'), 6);
assert.strictEqual(wordWeight('now.'), 12);

const text = 'First sentence here. Second one, with a comma! Third?';
const timeline = tokenize(text);

// Three sentences; the last one slices back exactly to "Third?".
assert.strictEqual(timeline.sentences.length, 3);
const lastSentence = timeline.sentences[2];
assert.strictEqual(text.slice(lastSentence.start, lastSentence.end), 'Third?');

// The word tokens reconstruct the original text byte for byte.
let rebuilt = '';
let cursor = 0;
for (const word of timeline.words) {
  rebuilt += text.slice(cursor, word.start) + text.slice(word.start, word.end);
  cursor = word.end;
}
assert.strictEqual(rebuilt + text.slice(cursor), text);

// progress 0 → first word, progress 1 → last word, monotonic in between.
assert.strictEqual(wordIndexAtProgress(timeline.words, 0), 0);
assert.strictEqual(wordIndexAtProgress(timeline.words, 1), timeline.words.length - 1);
let previous = -1;
for (let step = 0; step <= 10; step++) {
  const idx = wordIndexAtProgress(timeline.words, step / 10);
  assert.ok(idx >= previous, 'highlight must move forward');
  assert.ok(idx >= 0 && idx < timeline.words.length, 'index in range');
  previous = idx;
}
assert.strictEqual(wordIndexAtProgress([], 0.5), -1);

// Multi-line text: a hard line break also starts a new highlight block.
const multiline = 'Line one here.\nLine two starts fresh.';
const multilineTimeline = tokenize(multiline);
assert.strictEqual(multilineTimeline.sentences.length, 2);
assert.strictEqual(
  multiline.slice(multilineTimeline.sentences[0].start, multilineTimeline.sentences[0].end),
  'Line one here.'
);
assert.strictEqual(
  multiline.slice(multilineTimeline.sentences[1].start, multilineTimeline.sentences[1].end),
  'Line two starts fresh.'
);
console.log(
  `  ✔ timeline OK (${timeline.words.length} words, ${timeline.sentences.length} sentences)`
);

// ------------------------------------------------------- 3. shortcuts.ts
console.log('3. shortcuts');

// Normalization: canonical modifier order, lowercase, modifier-only rejected.
assert.strictEqual(normalizeBinding('Alt + P'), 'alt+p');
assert.strictEqual(normalizeBinding('SHIFT+CTRL+A'), 'ctrl+shift+a');
assert.strictEqual(normalizeBinding('Ctrl'), '');
assert.strictEqual(normalizeBinding(''), '');

// Layout-stable key extraction + matching.
const key = (code: string, keyName: string, mods: Partial<KeyboardEvent> = {}) =>
  ({
    code,
    key: keyName,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
  } as KeyboardEvent);

const target: ShortcutId = 'solutions.playPause';
const original = getShortcutBindings()[target];
assert.strictEqual(original, 'alt+p');

setShortcutBinding(target, 'alt+p');
assert.strictEqual(matchesShortcutEvent(key('KeyP', 'p', { altKey: true }), 'alt+p'), true);
assert.strictEqual(matchesShortcutEvent(key('KeyP', 'p'), 'alt+p'), false);
assert.strictEqual(matchesShortcutEvent(key('KeyP', 'p', { altKey: true }), 'alt+shift+p'), false);
// Alt+P reports key 'π' on macOS — matching still works via event.code.
assert.strictEqual(matchesShortcutEvent(key('KeyP', 'π', { altKey: true }), 'alt+p'), true);
assert.strictEqual(matchesShortcutEvent(key('Space', ' ', { altKey: true }), 'alt+space'), true);
assert.strictEqual(matchesShortcutEvent(key('Digit1', '1', { altKey: true }), 'alt+1'), true);
assert.strictEqual(matchesShortcutEvent(key('Comma', ',', { altKey: true }), 'alt+,'), true);

// bindingFromEvent
assert.strictEqual(bindingFromEvent(key('KeyS', 's', { altKey: true, shiftKey: true })), 'alt+shift+s');
assert.strictEqual(bindingFromEvent(key('ControlLeft', 'Control')), '');
assert.strictEqual(bindingFromEvent(key('Escape', 'Escape')), 'escape');

// Formatting
assert.strictEqual(formatShortcut('alt+p'), 'Alt + P');
assert.strictEqual(formatShortcut('ctrl+shift+arrowdown'), 'Ctrl + Shift + ↓');
assert.strictEqual(formatShortcut(''), 'Unassigned');

// Conflict detection + persistence round-trip + reset.
resetAllShortcuts();
assert.deepStrictEqual(getShortcutBindings(), defaultBindings());
setShortcutBinding(target, 'space');
assert.strictEqual(getShortcutBindings()[target], 'space');
assert.strictEqual(findShortcutConflict('Space')?.id, target);
assert.strictEqual(findShortcutConflict('alt+p'), null);
setShortcutBinding(target, original);
assert.strictEqual(getShortcutBindings()[target], original);

// Editable-target guard (plain keys must never hijack typing).
const fakeTarget = (tagName: string) => ({ tagName }) as unknown as EventTarget;
assert.strictEqual(isEditableTarget(fakeTarget('INPUT')), true);
assert.strictEqual(isEditableTarget(fakeTarget('TEXTAREA')), true);
assert.strictEqual(isEditableTarget(fakeTarget('P')), false);
assert.strictEqual(isEditableTarget(null), false);

console.log('  ✔ shortcuts OK');

console.log('\nAll speech & shortcut checks passed ✅');
