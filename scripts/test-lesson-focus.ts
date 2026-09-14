/**
 * Quick harness: verifies backfillLessonFocus anchors every roadmap module to
 * ONE specific skill + a real error, even when the evaluation LLM omits them.
 * Mirrors the pattern of test-normalize.ts.
 */
import { backfillLessonFocus } from '../src/server/evaluation';

const ev: any = {
  pillars: {
    fluency: { growthAreas: ['Reduce mid-sentence filler pauses'] },
    lexical: { growthAreas: ['Replace generic adjectives with precise Band 8+ terms'] },
    grammar: { growthAreas: ['Use third conditionals for hypotheticals'] },
    pronunciation: { growthAreas: ['Master sentence stress'] },
  },
  upgradedExpressions: [
    { original: 'If I would have known, I will come.', upgraded: 'Had I known, I would have come.' },
    { original: 'It was very very good.', upgraded: 'It was absolutely remarkable.' },
  ],
  lessonRoadmap: [
    { id: 'module-1', title: 'Conditionals', category: 'Grammar', objectives: ['Fix conditionals'] },
    { id: 'module-2', title: 'Precision Vocab', category: 'Vocabulary' },
    { id: 'module-3', title: 'Already focused', category: 'Fluency', focusArea: 'Custom focus', exampleError: 'Custom error' },
  ],
};
backfillLessonFocus(ev);
console.log(JSON.stringify(ev.lessonRoadmap.map((m: any) => ({ id: m.id, focusArea: m.focusArea, exampleError: m.exampleError })), null, 2));
if (!ev.lessonRoadmap[0].focusArea.includes('conditionals')) throw new Error('backfill failed: focusArea');
if (ev.lessonRoadmap[0].exampleError !== 'If I would have known, I will come.') throw new Error('backfill failed: exampleError');
if (ev.lessonRoadmap[1].exampleError !== 'It was very very good.') throw new Error('backfill failed: round-robin');
if (ev.lessonRoadmap[2].focusArea !== 'Custom focus') throw new Error('backfill overwrote existing focus');
if (ev.lessonRoadmap[2].exampleError !== 'Custom error') throw new Error('backfill overwrote existing error');
console.log('BACKFILL TEST: PASS');
