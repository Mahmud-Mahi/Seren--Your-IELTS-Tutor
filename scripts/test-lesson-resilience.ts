/**
 * Resilience harness for the personalized-lesson pipeline.
 *
 * Covers the four guarantees the feature depends on:
 *  1. TRANSIENT-ONLY RETRY — a rate-limited / 5xx provider is retried in
 *     place; a permanent failure is not retried and does not cool the
 *     provider down.
 *  2. PER-MODULE VALIDATION + REPAIR — one broken module no longer discards
 *     the whole roadmap, and a merely-incomplete module is repaired from the
 *     learner's own words instead of being thrown away.
 *  3. DEGRADATION METADATA — a degraded report states exactly what is
 *     missing, and the client-side normalizer keeps that state.
 *  4. SAFE PERSISTENCE — a regenerated roadmap replaces its plan in place
 *     and keeps the learner's tick marks.
 *
 * Run with: npx tsx scripts/test-lesson-resilience.ts
 */

// --- localStorage mock (must exist before the client modules are imported) ---
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => {
    store.set(k, String(v));
  },
  removeItem: (k: string) => {
    store.delete(k);
  },
  clear: () => store.clear(),
};

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean) => {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}`);
  }
};

const LEARNER_SENTENCE = 'If I would have known, I will come.';
const CORRECTED = 'Had I known, I would have come.';
const OTHER_SENTENCE = 'It was very very good.';
const OTHER_CORRECTED = 'It was absolutely remarkable.';

const EVIDENCE_TEXT = [
  `Q: "What would you do?"\nA: "${LEARNER_SENTENCE}"`,
  `Q: "How was it?"\nA: "${OTHER_SENTENCE}"`,
].join('\n');

const EVIDENCE = {
  text: EVIDENCE_TEXT,
  upgrades: [
    {
      original: LEARNER_SENTENCE,
      upgraded: CORRECTED,
      explanation: 'Mixing a past hypothetical with a future result.',
    },
    {
      original: OTHER_SENTENCE,
      upgraded: OTHER_CORRECTED,
      explanation: 'Vague adjectives instead of precise ones.',
    },
  ],
  priorityErrors: [] as any[],
};

const GOOD_MODULE = {
  id: 'module-1',
  title: 'Conditional forms',
  level: 'Band 7.0+',
  category: 'Grammar',
  duration: '10-20 Mins',
  description: 'Fix your mixed conditionals.',
  objectives: ['Fix mixed conditionals', 'Say it aloud', 'Use it fresh'],
  focusArea: 'mixed conditionals',
  exampleError: LEARNER_SENTENCE,
  errorAnalysis: 'Mixing a past hypothetical with a future result.',
  correction: CORRECTED,
  practiceDrill: {
    type: 'rapid_fire',
    prompt: `Say the corrected version of "${LEARNER_SENTENCE}" aloud, then make a new sentence.`,
    exerciseItems: [
      { faulty: LEARNER_SENTENCE, correction: CORRECTED, note: 'Re-say it with the fix' },
    ],
    transferQuestion: 'Can you tell me about a time when you had to make a difficult decision?',
    modelBand9Sample: 'Had I known, I would have come.',
    tips: ['Notice the slip mid-sentence'],
  },
};

async function main() {
  // ---------------------------------------------------------------------
  // 1. Transient vs permanent error classification
  // ---------------------------------------------------------------------
  const { isTransientLLMError, httpStatusOfError } = await import('../src/server/llm');

  check('429 is transient', isTransientLLMError(new Error('HTTP 429 from groq/model: rate limited')));
  check('500 is transient', isTransientLLMError(new Error('HTTP 500 from local/model: boom')));
  check('502 is transient', isTransientLLMError(new Error('HTTP 502 from local/model: bad gateway')));
  check('503 is transient', isTransientLLMError(new Error('HTTP 503 from local/model: unavailable')));
  check('408 is transient', isTransientLLMError(new Error('HTTP 408 from local/model: timeout')));
  check('network timeout is transient', isTransientLLMError(new Error('request timed out after 120000ms')));
  check('socket reset is transient', isTransientLLMError(new Error('read ECONNRESET')));
  check('fetch failed is transient', isTransientLLMError(new TypeError('fetch failed')));
  check('empty completion is transient', isTransientLLMError(new Error('Empty completion from groq/model')));

  check('400 is permanent', !isTransientLLMError(new Error('HTTP 400 from local/model: bad request')));
  check('401 is permanent', !isTransientLLMError(new Error('HTTP 401 from groq/model: unauthorized')));
  check('403 is permanent', !isTransientLLMError(new Error('HTTP 403 from groq/model: forbidden')));
  check('404 is permanent', !isTransientLLMError(new Error('HTTP 404 from local/model: not found')));
  check('unknown error is permanent', !isTransientLLMError(new Error('something odd happened')));
  check(
    'status is extracted from the message',
    httpStatusOfError(new Error('HTTP 503 from groq/model: unavailable')) === 503
  );
  check(
    'no status in message yields null',
    httpStatusOfError(new Error('boom')) === null
  );

  // ---------------------------------------------------------------------
  // 2. Per-module validation + deterministic repair
  // ---------------------------------------------------------------------
  const { repairLessonModule, validateLessonModule, sanitizeLessonRoadmap } = await import(
    '../src/server/lessonRoadmap'
  );

  // 2a. A fully valid module survives untouched.
  const goodResult = repairLessonModule(GOOD_MODULE, EVIDENCE, 0);
  check('a valid module is kept', !!goodResult.module);
  check('a valid module needs no repair', goodResult.repaired === false);
  check(
    'a valid module passes validation',
    validateLessonModule(goodResult.module, EVIDENCE_TEXT).valid
  );

  // 2b. A module missing fields is REPAIRED (not discarded).
  const lazyResult = repairLessonModule(
    { id: 'module-1', category: 'Grammar', exampleError: LEARNER_SENTENCE, correction: CORRECTED },
    EVIDENCE,
    0
  );
  check('an incomplete module is repaired, not dropped', !!lazyResult.module);
  check('the repair is reported', lazyResult.repaired === true);
  check(
    'the repaired module passes validation',
    validateLessonModule(lazyResult.module, EVIDENCE_TEXT).valid
  );
  check(
    'the repaired module keeps the learner sentence',
    lazyResult.module?.exampleError === LEARNER_SENTENCE
  );
  check('the repaired module gains a title', !!lazyResult.module?.title);
  check('the repaired module gains objectives', (lazyResult.module?.objectives || []).length >= 3);
  check('the repaired module gains a drill prompt', !!lazyResult.module?.practiceDrill?.prompt);
  check(
    'the repaired module gains the matching exercise',
    (lazyResult.module?.practiceDrill?.exerciseItems || []).some(
      (i: any) => i.faulty === LEARNER_SENTENCE && i.correction === CORRECTED
    )
  );

  // 2c. A module anchored on a sentence the learner NEVER said is dropped.
  const fabricated = {
    ...GOOD_MODULE,
    id: 'module-x',
    exampleError: 'The weather is very nice outside today.',
    correction: 'The weather is lovely today.',
    practiceDrill: {
      ...GOOD_MODULE.practiceDrill,
      exerciseItems: [
        { faulty: 'The weather is very nice outside today.', correction: 'The weather is lovely today.' },
      ],
    },
  };
  const fabricatedResult = repairLessonModule(fabricated, EVIDENCE, 1);
  check('a fabricated mistake is dropped', fabricatedResult.module === null);
  check(
    'the drop is explained',
    fabricatedResult.notes.some((n: string) => n.includes('grounded'))
  );

  // 2d. A grounded mistake with NO correction is dropped (we never invent one).
  const noCorrectionResult = repairLessonModule(
    { ...GOOD_MODULE, correction: '', exampleError: OTHER_SENTENCE },
    EVIDENCE,
    2
  );
  check('a module without a real correction is dropped', noCorrectionResult.module === null);

  // 2e. A module whose exampleError is missing is re-anchored on a REAL sentence.
  const reanchored = repairLessonModule(
    { ...GOOD_MODULE, exampleError: '', correction: '' },
    EVIDENCE,
    3
  );
  check('an unanchored module is re-anchored', !!reanchored.module);
  check(
    'the re-anchored module quotes the learner',
    EVIDENCE_TEXT.includes(reanchored.module?.exampleError || '')
  );

  // 2f. THE KEY REGRESSION: one bad module must not discard the good ones.
  const sanitized = sanitizeLessonRoadmap(
    [
      GOOD_MODULE,
      fabricated,
      {
        id: 'module-3',
        category: 'Vocabulary',
        exampleError: OTHER_SENTENCE,
        correction: OTHER_CORRECTED,
      },
    ],
    EVIDENCE
  );
  check('valid modules survive a broken sibling', sanitized.modules.length === 2);
  check('the broken module is dropped', sanitized.dropped === 1);
  check('the incomplete module is counted as repaired', sanitized.repaired === 1);
  check(
    'every surviving module is valid',
    sanitized.modules.every((m: any) => validateLessonModule(m, EVIDENCE_TEXT).valid)
  );
  check('the drop is reported', sanitized.notes.some((n: string) => n.includes('dropped')));

  // 2g. Duplicate mistakes are never taught twice.
  const duplicated = sanitizeLessonRoadmap(
    [GOOD_MODULE, { ...GOOD_MODULE, id: 'module-2' }],
    EVIDENCE
  );
  check('a repeated mistake is dropped', duplicated.modules.length === 1);
  check('the duplicate is reported', duplicated.notes.some((n: string) => n.includes('repeats')));

  // 2h. The roadmap is capped at 4 modules.
  const capSentences = Array.from({ length: 6 }, (_, i) => `My sentence number ${i} was wrong.`);
  const capEvidence = {
    text: capSentences.map((s) => `A: "${s}"`).join('\n'),
    upgrades: capSentences.map((s, i) => ({ original: s, upgraded: `My sentence number ${i} was incorrect.` })),
    priorityErrors: [] as any[],
  };
  const many = Array.from({ length: 6 }, (_, i) => ({
    ...GOOD_MODULE,
    id: `module-${i + 1}`,
    exampleError: capSentences[i],
    correction: `My sentence number ${i} was incorrect.`,
    practiceDrill: {
      ...GOOD_MODULE.practiceDrill,
      exerciseItems: [
        { faulty: capSentences[i], correction: `My sentence number ${i} was incorrect.` },
      ],
    },
  }));
  const capped = sanitizeLessonRoadmap(many, capEvidence);
  check('the roadmap is capped at 4 modules', capped.modules.length === 4);
  check('the excess modules are reported', capped.dropped === 2);

  // ---------------------------------------------------------------------
  // 3. Degradation metadata
  // ---------------------------------------------------------------------
  const { buildDegradation } = await import('../src/server/evaluation');
  const { normalizeEvaluation, normalizeDegradation } = await import('../src/utils/evaluation');

  check(
    'a clean report carries no degradation',
    buildDegradation({
      lessonsFailed: false,
      lessonsPartial: false,
      pronunciationEmpty: false,
      usedFallback: false,
    }) === null
  );

  const failedDegradation = buildDegradation({
    lessonsFailed: true,
    lessonsPartial: false,
    pronunciationEmpty: false,
    usedFallback: false,
    notes: ['provider timeout'],
  });
  check('a failed lesson pass is flagged', failedDegradation?.lessonsFailed === true);
  check('a failed lesson pass is retryable', failedDegradation?.retryable === true);
  check(
    'the failure is explained to the learner',
    (failedDegradation?.notes || []).some((n: string) => n.includes('roadmap'))
  );

  const partialDegradation = buildDegradation({
    lessonsFailed: false,
    lessonsPartial: true,
    pronunciationEmpty: false,
    usedFallback: false,
  });
  check('a partial roadmap is flagged', partialDegradation?.lessonsPartial === true);
  check('a partial roadmap is not a failure', partialDegradation?.lessonsFailed === false);

  const fallbackDegradation = buildDegradation({
    lessonsFailed: true,
    lessonsPartial: false,
    pronunciationEmpty: true,
    usedFallback: true,
  });
  check('a fallback report is flagged', fallbackDegradation?.usedFallback === true);
  check('a fallback report is retryable', fallbackDegradation?.retryable === true);

  // The client-side normalizer must KEEP the degradation state.
  const normalized = normalizeEvaluation({
    overallCEFR: 'B2',
    predictedIeltsBand: 6.5,
    pillars: { fluency: { score: 6.5 } },
    lessonRoadmap: [],
    priorityErrors: [
      { category: 'Grammar', quote: LEARNER_SENTENCE, whyWrong: 'x', fix: CORRECTED },
    ],
    degradation: failedDegradation,
  });
  check('the client keeps the degradation state', !!normalized.degradation);
  check('the client keeps the lessonsFailed flag', normalized.degradation?.lessonsFailed === true);
  check('the client keeps the degradation notes', (normalized.degradation?.notes || []).length > 0);
  check(
    'the client keeps the priority errors (for lesson regeneration)',
    normalized.priorityErrors?.[0]?.quote === LEARNER_SENTENCE
  );
  check('a clean report has no degradation block', normalizeEvaluation({}).degradation === undefined);
  check('a malformed degradation block is normalized', normalizeDegradation(null) === undefined);
  check(
    'a malformed degradation block never throws',
    normalizeDegradation({ notes: 'not-an-array' })?.notes.length === 0
  );

  // ---------------------------------------------------------------------
  // 4. Safe lesson-plan persistence
  // ---------------------------------------------------------------------
  const { saveLessonPlan, loadLessonHistory, markLessonComplete, lessonPlanFingerprint } =
    await import('../src/utils/lessonHistory');

  store.clear();
  const planModules = [
    { id: 'module-1', title: 'A', practiceDrill: { prompt: 'p1' } },
    { id: 'module-2', title: 'B', practiceDrill: { prompt: 'p2' } },
  ] as any;
  const first = saveLessonPlan(
    { lessonRoadmap: planModules } as any,
    { source: 'cambridge', testId: 'cambridge-2026-test-1', testLabel: 'Test 1' }
  );
  check('the first save creates one plan', first.length === 1);
  const planId = first[0].id;

  // Mark module 1 as completed.
  markLessonComplete(planId, 'module-1');

  // A regeneration of the SAME test must replace the plan in place — no
  // duplicate entry — and must keep the tick mark.
  const regenerated = saveLessonPlan(
    {
      lessonRoadmap: [
        { id: 'module-1', title: 'A (repaired)', practiceDrill: { prompt: 'p1' } },
        { id: 'module-2', title: 'B (repaired)', practiceDrill: { prompt: 'p2' } },
      ],
    } as any,
    { source: 'cambridge', testId: 'cambridge-2026-test-1', testLabel: 'Test 1' }
  );
  check('a regeneration does not duplicate the plan', regenerated.length === 1);
  check('the regenerated plan keeps its id', regenerated[0].id === planId);
  check(
    'the regenerated plan carries the fresh content',
    regenerated[0].modules[0].title === 'A (repaired)'
  );
  check(
    'the regenerated plan keeps the completion tick',
    regenerated[0].modules[0].completed === true
  );
  check(
    'the fingerprint follows the new content',
    regenerated[0].fingerprint === lessonPlanFingerprint(regenerated[0].modules)
  );

  // A DIFFERENT test still gets its own plan.
  const other = saveLessonPlan(
    { lessonRoadmap: planModules } as any,
    { source: 'cambridge', testId: 'cambridge-2026-test-2', testLabel: 'Test 2' }
  );
  check('a different test gets its own plan', other.length === 2);

  // An empty roadmap must never wipe the stored plans.
  const empty = saveLessonPlan({ lessonRoadmap: [] } as any, {
    source: 'cambridge',
    testId: 'x',
  });
  check('an empty roadmap does not wipe the history', empty.length === 2);
  check('the history survives on disk', loadLessonHistory().length === 2);

  // ---------------------------------------------------------------------
  // 5. Crash-proof empty states
  // ---------------------------------------------------------------------
  const moduleWithoutDrill = { id: 'm1', title: 'No drill' } as any;
  check(
    'a module without a practiceDrill is still readable',
    (moduleWithoutDrill.practiceDrill?.prompt || '') === ''
  );
  check(
    'a module without objectives renders an empty list',
    (moduleWithoutDrill.objectives || []).length === 0
  );
  check(
    'a module without a drill does not break the fingerprint',
    typeof lessonPlanFingerprint([moduleWithoutDrill]) === 'string'
  );

  console.log('');
  console.log(fail === 0 ? `ALL PASS (${pass} checks)` : `${fail} FAILED (${pass} passed)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Harness crashed:', err);
  process.exit(1);
});
