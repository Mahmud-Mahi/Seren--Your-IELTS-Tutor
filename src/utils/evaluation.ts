/**
 * Normalization for LLM-generated speaking evaluations.
 *
 * The evaluation JSON comes from an LLM that can be rate-limited or truncate
 * mid-answer, so any field may be missing or typed wrong. Rendering code
 * assumes the full SpeakingEvaluation shape (e.g. `stats.estimatedWPM`,
 * `pillar.score.toFixed(1)`) — a partial payload crashed the report view to a
 * blank page. Every entry point (server response, localStorage restore) runs
 * through here so the shape is always complete and render-safe.
 */

import {
  CEFRLevel,
  DegradationState,
  PillarScore,
  PriorityError,
  PronunciationTip,
  SpeakingEvaluation,
  UpgradedExpression,
} from '../types';

const CEFR_LEVELS: readonly string[] = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

const toText = (v: any): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

const toNumber = (v: any, fallback: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

const toTextArray = (v: any): string[] => {
  if (Array.isArray(v)) {
    return v.map(toText).map((s) => s.trim()).filter(Boolean);
  }
  // LLMs sometimes return a single string where an array was requested
  const s = toText(v).trim();
  return s ? [s] : [];
};

const clampBand = (n: number): number => Math.min(9, Math.max(0, n));

const normalizePriorityError = (raw: any): PriorityError => ({
  category: toText(raw?.category) || 'General',
  quote: toText(raw?.quote),
  whyWrong: toText(raw?.whyWrong),
  fix: toText(raw?.fix),
});

/**
 * Normalize the server's degradation block. A malformed/absent block must
 * never crash the report — it simply means "nothing went wrong".
 */
export function normalizeDegradation(raw: any): DegradationState | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const notes = Array.isArray(raw?.notes)
    ? raw.notes.map(toText).map((s: string) => s.trim()).filter(Boolean)
    : [];
  return {
    lessonsFailed: !!raw?.lessonsFailed,
    lessonsPartial: !!raw?.lessonsPartial,
    pronunciationEmpty: !!raw?.pronunciationEmpty,
    usedFallback: !!raw?.usedFallback,
    notes,
    retryable: raw?.retryable !== false,
  };
}

const normalizePillar = (raw: any, fallbackBand: number, fallbackCefr: CEFRLevel): PillarScore => ({
  score: clampBand(toNumber(raw?.score, fallbackBand)),
  cefr: (CEFR_LEVELS.includes(raw?.cefr) ? raw.cefr : fallbackCefr) as CEFRLevel,
  strengths: toTextArray(raw?.strengths),
  growthAreas: toTextArray(raw?.growthAreas),
  examinerCommentary: toText(raw?.examinerCommentary),
});

export function normalizeEvaluation(raw: any): SpeakingEvaluation {
  const band = clampBand(toNumber(raw?.predictedIeltsBand, 6.5));
  const cefr = (CEFR_LEVELS.includes(raw?.overallCEFR) ? raw.overallCEFR : 'B2') as CEFRLevel;

  const upgradedExpressions: UpgradedExpression[] = (Array.isArray(raw?.upgradedExpressions)
    ? raw.upgradedExpressions
    : []
  )
    .map((u: any) => ({
      original: toText(u?.original),
      upgraded: toText(u?.upgraded),
      ieltsBand: toText(u?.ieltsBand) || 'Band 7.0',
      explanation: toText(u?.explanation),
      ...(u?.part !== undefined ? { part: Math.round(toNumber(u.part, 1)) } : {}),
      ...(u?.index !== undefined ? { index: Math.round(toNumber(u.index, 0)) } : {}),
    }))
    .filter((u) => u.original || u.upgraded);

  const pronunciationTips: PronunciationTip[] = (Array.isArray(raw?.pronunciationTips)
    ? raw.pronunciationTips
    : []
  )
    .map((t: any) => ({
      word: toText(t?.word),
      ipa: toText(t?.ipa),
      phoneticSpelling: toText(t?.phoneticSpelling),
      tip: toText(t?.tip),
      exampleSentence: toText(t?.exampleSentence),
      ...(t?.part !== undefined ? { part: Math.round(toNumber(t.part, 1)) } : {}),
    }))
    .filter((t) => t.word);

  const pauseRaw = raw?.stats?.pauseFluencyRating;
  const varietyRaw = raw?.stats?.varietyRating;

  return {
    overallCEFR: cefr,
    predictedIeltsBand: band,
    cefrDescriptor: toText(raw?.cefrDescriptor) || 'Independent Speaker',
    executiveSummary: toText(raw?.executiveSummary),
    // Preserve provenance metadata so the report can show which test it belongs to
    ...(typeof raw?.testId === 'string' && raw.testId ? { testId: raw.testId } : {}),
    ...(typeof raw?.testLabel === 'string' && raw.testLabel ? { testLabel: raw.testLabel } : {}),
    pillars: {
      fluency: normalizePillar(raw?.pillars?.fluency, band, cefr),
      lexical: normalizePillar(raw?.pillars?.lexical, band, cefr),
      grammar: normalizePillar(raw?.pillars?.grammar, band, cefr),
      pronunciation: normalizePillar(raw?.pillars?.pronunciation, band, cefr),
    },
    upgradedExpressions,
    pronunciationTips,
    stats: {
      totalWords: Math.max(0, Math.round(toNumber(raw?.stats?.totalWords, 0))),
      estimatedWPM: Math.min(250, Math.max(40, Math.round(toNumber(raw?.stats?.estimatedWPM, 110)))),
      pauseFluencyRating: (['Smooth', 'Moderate Pauses', 'Hesitant'].includes(pauseRaw)
        ? pauseRaw
        : 'Moderate Pauses') as 'Smooth' | 'Moderate Pauses' | 'Hesitant',
      varietyRating: (['High', 'Good', 'Repetitive'].includes(varietyRaw)
        ? varietyRaw
        : 'Good') as 'High' | 'Good' | 'Repetitive',
    },
    lessonRoadmap: Array.isArray(raw?.lessonRoadmap) ? raw.lessonRoadmap : [],
    // Keep the examiner's verbatim mistakes so lessons can be regenerated
    // later without re-running the whole test.
    ...(Array.isArray(raw?.priorityErrors) && raw.priorityErrors.length
      ? { priorityErrors: raw.priorityErrors.map(normalizePriorityError) }
      : {}),
    // Preserve the degradation metadata so the report can explain what was
    // missing and offer a retry.
    ...(normalizeDegradation(raw?.degradation)
      ? { degradation: normalizeDegradation(raw?.degradation) }
      : {}),
  };
}
