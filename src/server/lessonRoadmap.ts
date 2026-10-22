/**
 * Lesson-roadmap generation, validation and repair.
 *
 * Two problems this module solves:
 *
 * 1. ALL-OR-NOTHING VALIDATION — the old roadmap pass rejected the WHOLE
 *    roadmap when a single module failed the "grounded mistake" check, so one
 *    sloppy module threw away three good ones. Validation is now PER MODULE:
 *    valid modules survive, broken ones are repaired deterministically, and
 *    only modules that cannot be grounded in the learner's own words are
 *    dropped (and reported).
 *
 * 2. VALIDATION BEFORE REPAIR — the old pass validated the raw LLM JSON and
 *    only afterwards ran the deterministic backfill, so a module that merely
 *    MISSED a field was thrown away instead of being completed. The order is
 *    now: repair → validate.
 *
 * The repair is strictly deterministic and NEVER invents a learner mistake:
 * every correction/error it writes comes from real evidence the learner
 * produced (their own sentences and their upgraded versions).
 */
import { callLLMWithCascade, parseJsonLoose } from './llm';
import {
  buildLessonRoadmapPrompt,
  LESSON_ROADMAP_SCHEMA,
  isUsableSpeakingQuestion,
} from './prompts';

export const MAX_ROADMAP_MODULES = 4;

const VALID_CATEGORIES = [
  'Fluency',
  'Vocabulary',
  'Grammar',
  'Part 2 Cue Card',
  'Pronunciation',
  'Examiner Strategy',
];

const CATEGORY_DRILL_TYPE: Record<string, string> = {
  Fluency: 'rapid_fire',
  Vocabulary: 'lexical_boost',
  Grammar: 'rapid_fire',
  'Part 2 Cue Card': 'cue_card',
  Pronunciation: 'shadowing',
  'Examiner Strategy': 'mock_exam',
};

const text = (v: any): string => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();

/**
 * Everything the repair is allowed to draw on. All of it originates from the
 * learner's own speech, so a repaired module stays honestly grounded.
 */
export interface LessonEvidence {
  /** The learner's own words (transcripts) + examiner priority-error quotes. */
  text: string;
  /** upgradedExpressions: { original (learner's words), upgraded (correction) } */
  upgrades: any[];
  /** priorityErrors: { quote, whyWrong, fix } */
  priorityErrors: any[];
}

export interface LessonModuleRepairResult {
  module: any | null;
  /** True when at least one field was filled in deterministically. */
  repaired: boolean;
  /** Human-readable notes about what was repaired/dropped. */
  notes: string[];
}

export interface RoadmapSanitizeResult {
  modules: any[];
  /** Modules that were completed by the deterministic repair. */
  repaired: number;
  /** Modules dropped because they could not be grounded in real evidence. */
  dropped: number;
  notes: string[];
}

/** Does this exact string appear in the learner's own words? */
function isGrounded(candidate: string, evidenceText: string): boolean {
  if (!candidate || !evidenceText) return false;
  return evidenceText.includes(candidate);
}

/** Loose match: same words, different casing/punctuation/whitespace. */
function looseMatch(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  return !!a && !!b && norm(a) === norm(b);
}

/**
 * Deterministically complete ONE module using the learner's real evidence.
 * Returns `module: null` when the module cannot be grounded at all (i.e. it
 * would teach a mistake the learner never made) — such a module is dropped.
 */
export function repairLessonModule(
  rawModule: any,
  evidence: LessonEvidence,
  index: number
): LessonModuleRepairResult {
  const notes: string[] = [];
  let repaired = false;
  if (!rawModule || typeof rawModule !== 'object') {
    return { module: null, repaired: false, notes: ['module was not an object'] };
  }

  const m: any = { ...rawModule };
  const upgrades = Array.isArray(evidence.upgrades) ? evidence.upgrades : [];
  const priorityErrors = Array.isArray(evidence.priorityErrors) ? evidence.priorityErrors : [];
  const evidenceText = evidence.text || '';

  // ---- identity / presentation fields -----------------------------------
  if (!text(m.id)) {
    m.id = `module-${index + 1}`;
    repaired = true;
  }
  if (!text(m.title)) {
    m.title = text(m.focusArea) || 'Focused speaking practice';
    repaired = true;
  }
  if (!text(m.level)) {
    m.level = 'Band 7.0+';
    repaired = true;
  }
  if (!VALID_CATEGORIES.includes(m.category)) {
    if (text(rawModule.category)) {
      notes.push(
        `category "${text(rawModule.category)}" is not a supported category — defaulted to Fluency`
      );
    }
    m.category = 'Fluency';
    repaired = true;
  }
  if (!text(m.duration)) {
    m.duration = '10-20 Mins';
    repaired = true;
  }
  if (!text(m.description)) {
    m.description = text(m.focusArea)
      ? `Fix "${text(m.focusArea)}" in your own spoken answers.`
      : 'A focused drill on your most common spoken error.';
    repaired = true;
  }
  if (!Array.isArray(m.objectives) || m.objectives.length === 0) {
    m.objectives = [
      text(m.focusArea)
        ? `Fix ${text(m.focusArea)} under speaking pressure`
        : 'Fix your most common spoken error',
      'Say the corrected version out loud before moving on',
      'Use the same fix in one fresh answer',
    ];
    repaired = true;
  }

  // ---- practice drill shape --------------------------------------------
  const drill = (m.practiceDrill =
    m.practiceDrill && typeof m.practiceDrill === 'object' ? { ...m.practiceDrill } : {});
  if (!text(drill.type)) {
    drill.type = CATEGORY_DRILL_TYPE[m.category] || 'rapid_fire';
    repaired = true;
  }
  if (!Array.isArray(drill.tips)) drill.tips = [];
  if (drill.tips.length === 0) {
    drill.tips = [
      'Notice the slip while you are speaking, not afterwards',
      'Say the corrected version out loud once before your next answer',
    ];
    repaired = true;
  }
  if (!text(drill.modelBand9Sample)) {
    drill.modelBand9Sample = m.correction
      ? `A natural Band 8+ answer would use: "${text(m.correction)}"`
      : '';
    repaired = true;
  }

  // ---- the anchor: the learner's own mistake ----------------------------
  let exampleError = text(m.exampleError);
  let correction = text(m.correction);
  let errorAnalysis = text(m.errorAnalysis);

  if (!isGrounded(exampleError, evidenceText)) {
    // Re-anchor the module on a REAL sentence the learner produced.
    //
    // The anchor must be the SAME error the module is about: a module whose
    // correction matches one of the learner's real upgrades keeps that
    // upgrade's original sentence. Only a module with NO correction at all
    // (a vague, lazy module) may be anchored onto any real error.
    const matchingUpgrade = upgrades.find(
      (u: any) =>
        text(u?.original) &&
        isGrounded(text(u.original), evidenceText) &&
        text(u.original) !== text(u.upgraded) &&
        correction &&
        looseMatch(text(u.upgraded), correction)
    );
    const anchor =
      matchingUpgrade ||
      (!correction &&
        (upgrades.find(
          (u: any) =>
            text(u?.original) &&
            isGrounded(text(u.original), evidenceText) &&
            text(u.original) !== text(u.upgraded)
        ) ||
          priorityErrors.find(
            (p: any) => text(p?.quote) && isGrounded(text(p.quote), evidenceText)
          )));

    if (anchor) {
      const original = text(anchor.original) || text(anchor.quote);
      if (original && original !== exampleError) {
        notes.push('re-anchored the module on a real learner sentence');
        exampleError = original;
        repaired = true;
      }
      if (!correction) {
        const fixed = text(anchor.upgraded) || text(anchor.fix);
        if (fixed) {
          correction = fixed;
          notes.push("filled in the missing correction from the learner's own upgraded sentence");
          repaired = true;
        }
      }
      if (!errorAnalysis) {
        const why = text(anchor.explanation) || text(anchor.whyWrong);
        if (why) {
          errorAnalysis = why;
          notes.push('filled in the missing rule explanation from the examiner pass');
          repaired = true;
        }
      }
    }
  }

  if (!exampleError || !isGrounded(exampleError, evidenceText)) {
    return {
      module: null,
      repaired,
      notes: [...notes, "dropped: the module could not be grounded in the learner's own words"],
    };
  }

  if (!correction) {
    // A grounded mistake with no correction is not actionable — we refuse to
    // fabricate a "correct" sentence, so the module is dropped.
    return {
      module: null,
      repaired,
      notes: [...notes, "dropped: no real correction was available for the learner's sentence"],
    };
  }

  if (!errorAnalysis) {
    errorAnalysis = `Your sentence "${exampleError}" should be "${correction}".`;
    notes.push('filled in a missing rule explanation');
    repaired = true;
  }

  m.exampleError = exampleError;
  m.correction = correction;
  m.errorAnalysis = errorAnalysis;
  if (!text(m.focusArea)) {
    m.focusArea = errorAnalysis.split('.')[0] || text(m.title);
    repaired = true;
  }

  // ---- drill prompt + exercises -----------------------------------------
  if (!text(drill.prompt)) {
    drill.prompt = `Say the corrected version of "${exampleError}" aloud, then make one new sentence using the same rule.`;
    notes.push('filled in the missing drill prompt');
    repaired = true;
  }
  if (!Array.isArray(drill.exerciseItems)) drill.exerciseItems = [];
  const hasPair = drill.exerciseItems.some(
    (item: any) => text(item?.faulty) === exampleError && text(item?.correction) === correction
  );
  if (!hasPair) {
    drill.exerciseItems = [
      { faulty: exampleError, correction, note: 'Re-say it with the fix' },
      ...drill.exerciseItems.filter(
        (item: any) => text(item?.faulty) && text(item?.faulty) !== exampleError
      ),
    ];
    notes.push('added the missing "fix this sentence" exercise');
    repaired = true;
  }

  // ---- transfer question -------------------------------------------------
  if (!isUsableSpeakingQuestion(drill.transferQuestion)) {
    const focus = text(m.focusArea).replace(/\?/g, '').trim();
    drill.transferQuestion = `Can you give me an example of ${focus || 'this speaking skill'} in your own work or study?`;
    notes.push('replaced the missing/invalid transfer question with a spoken-practice question');
    repaired = true;
  }

  return { module: m, repaired, notes };
}

/**
 * Validate a (already repaired) module. A module is valid when it teaches ONE
 * real mistake the learner made, with a real correction, a rule explanation,
 * a matching exercise and a spoken transfer question.
 */
export function validateLessonModule(
  module: any,
  evidenceText: string
): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!module) return { valid: false, reasons: ['module is empty'] };

  const exampleError = text(module.exampleError);
  const correction = text(module.correction);
  const analysis = text(module.errorAnalysis);
  const drill = module.practiceDrill || {};
  const exercises = Array.isArray(drill.exerciseItems) ? drill.exerciseItems : [];

  if (!exampleError) reasons.push('missing exampleError');
  else if (!isGrounded(exampleError, evidenceText))
    reasons.push('exampleError is not a verbatim learner sentence');
  if (!correction) reasons.push('missing correction');
  if (!analysis) reasons.push('missing errorAnalysis');
  if (!text(drill.prompt)) reasons.push('missing practiceDrill.prompt');
  if (
    !exercises.some(
      (item: any) => text(item?.faulty) === exampleError && text(item?.correction) === correction
    )
  ) {
    reasons.push('missing the matching fix-this-sentence exercise');
  }
  if (!isUsableSpeakingQuestion(drill.transferQuestion)) {
    reasons.push('missing a usable spoken transfer question');
  }

  return { valid: reasons.length === 0, reasons };
}

/**
 * Repair + validate EVERY module independently. Valid modules are always
 * kept; broken ones are repaired when possible and dropped otherwise.
 */
export function sanitizeLessonRoadmap(
  rawModules: any[],
  evidence: LessonEvidence
): RoadmapSanitizeResult {
  const modules: any[] = [];
  const notes: string[] = [];
  let repaired = 0;
  let dropped = 0;
  const seenErrors = new Set<string>();

  const list = Array.isArray(rawModules) ? rawModules : [];
  for (let i = 0; i < list.length; i++) {
    if (modules.length >= MAX_ROADMAP_MODULES) {
      dropped++;
      notes.push(`module ${i + 1} dropped: more than ${MAX_ROADMAP_MODULES} modules were returned`);
      continue;
    }
    const result = repairLessonModule(list[i], evidence, i);
    if (result.notes.length) {
      notes.push(`module ${i + 1}: ${result.notes.join('; ')}`);
    }
    if (!result.module) {
      dropped++;
      continue;
    }
    const check = validateLessonModule(result.module, evidence.text);
    if (!check.valid) {
      dropped++;
      notes.push(`module ${i + 1} dropped: ${check.reasons.join(', ')}`);
      continue;
    }
    // Never teach the same mistake twice.
    const key = text(result.module.exampleError).toLowerCase();
    if (seenErrors.has(key)) {
      dropped++;
      notes.push(`module ${i + 1} dropped: it repeats an earlier mistake`);
      continue;
    }
    seenErrors.add(key);
    if (result.repaired) repaired++;
    modules.push(result.module);
  }

  return { modules, repaired, dropped, notes };
}

// ---------------------------------------------------------------------------
// The shared roadmap pass (used by evaluate-speech, evaluate-practice and the
// lesson-only regeneration endpoint).
// ---------------------------------------------------------------------------

export interface LessonRoadmapPassResult {
  modules: any[];
  /** True when the LLM pass itself failed (transport/parse error). */
  failed: boolean;
  /** True when modules had to be repaired or some were dropped. */
  degraded: boolean;
  repaired: number;
  dropped: number;
  notes: string[];
  provider?: string;
  model?: string;
}

export async function runLessonRoadmapPass(opts: {
  userProfile: any;
  pillars: any;
  priorityErrors: any[];
  transcriptsBlock: string;
  /**
   * upgradedExpressions — the learner's real sentences + their corrections.
   * May be a FUNCTION (returning an array or a PROMISE of one) so the caller
   * can hand over a lane that is still running: it is resolved right before
   * the repair, never captured too early.
   */
  upgrades: any[] | (() => any[] | Promise<any[]>);
  pinnedProvider: string | null;
}): Promise<LessonRoadmapPassResult> {
  const { userProfile, pillars, priorityErrors, transcriptsBlock, pinnedProvider } = opts;
  const resolveUpgrades = async (): Promise<any[]> => {
    const value = typeof opts.upgrades === 'function' ? await opts.upgrades() : opts.upgrades;
    return Array.isArray(value) ? value : [];
  };

  const pillarsDigest = (['fluency', 'lexical', 'grammar', 'pronunciation'] as const)
    .map((k) => {
      const p = pillars?.[k];
      if (!p) return null;
      const growth = (Array.isArray(p.growthAreas) ? p.growthAreas : []).slice(0, 3).join('; ');
      return `${k}: ${p.score} (${p.cefr}) - growth: ${growth || '-'}`;
    })
    .filter(Boolean)
    .join('\n');

  const evidenceText = [
    transcriptsBlock,
    ...priorityErrors.map((error: any) => text(error?.quote)),
  ]
    .filter(Boolean)
    .join('\n');

  const priorityErrorsBlock = priorityErrors.length
    ? priorityErrors
        .map(
          (e: any, i: number) =>
            `[E${i + 1}|${e?.category || 'General'}] "${text(e?.quote)}" - ${text(e?.whyWrong)} -> fix: "${text(e?.fix)}"`
        )
        .join('\n')
    : '(none flagged - read the transcripts and pick the most damaging real errors yourself)';

  let validationFeedback = '';
  let lastError: any = null;
  let degraded = false;
  let repaired = 0;
  let dropped = 0;
  const notes: string[] = [];
  let provider: string | undefined;
  let model: string | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await callLLMWithCascade({
        systemInstruction:
          'You are Seren, an expert IELTS Speaking coach who designs hyper-personalized micro-lessons from a learner\u2019s own transcript.',
        userPrompt: [
          buildLessonRoadmapPrompt({ userProfile, pillarsDigest, priorityErrorsBlock, transcriptsBlock }),
          validationFeedback,
        ]
          .filter(Boolean)
          .join('\n\n'),
        json: true,
        jsonSchemaHint: LESSON_ROADMAP_SCHEMA,
        temperature: attempt === 0 ? 0.4 : 0.65,
        maxTokens: 3200,
        pinnedProvider,
      });
      provider = result.provider;
      model = result.model;

      const lp = parseJsonLoose(result.text);
      const rawModules = Array.isArray(lp?.lessonRoadmap)
        ? lp.lessonRoadmap
        : Array.isArray(lp)
          ? lp
          : [];

      // An EMPTY roadmap is a legitimate answer (no genuine errors to teach),
      // not a failure — the report must not be blocked by lessons.
      if (rawModules.length === 0) {
        return {
          modules: [],
          failed: false,
          degraded: false,
          repaired: 0,
          dropped: 0,
          notes,
          provider,
          model,
        };
      }

      const sanitized = sanitizeLessonRoadmap(rawModules, {
        text: evidenceText,
        // Resolved NOW (not at call time) so a concurrent sentence-upgrade
        // lane has finished filling the corrections the repair relies on.
        upgrades: await resolveUpgrades(),
        priorityErrors,
      });
      repaired = sanitized.repaired;
      dropped = sanitized.dropped;
      notes.push(...sanitized.notes);
      degraded = sanitized.repaired > 0 || sanitized.dropped > 0;

      // Enough survived the repair → ship them.
      if (sanitized.modules.length > 0) {
        return {
          modules: sanitized.modules,
          failed: false,
          degraded,
          repaired,
          dropped,
          notes,
          provider,
          model,
        };
      }

      validationFeedback = `VALIDATION FAILURE: Every module was rejected. Module 1 must contain an exampleError copied verbatim from the learner evidence, its correction and explanation, an exerciseItem with that exact faulty/correction pair, and a natural transferQuestion. Do not replace the mistake activity with a generic question.`;
      console.warn(`[lesson-roadmap] every module was rejected: ${validationFeedback}`);
    } catch (e: any) {
      lastError = e;
      console.warn('[lesson-roadmap] pass failed:', e?.message || e);
    }
  }

  return {
    modules: [],
    failed: true,
    degraded: true,
    repaired,
    dropped,
    notes: [
      ...notes,
      lastError ? `generation failed: ${lastError?.message || lastError}` : 'generation failed',
    ],
    provider,
    model,
  };
}
