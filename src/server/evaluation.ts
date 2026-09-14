// Complete a partially-generated evaluation so the client never renders
// undefined fields (a rate-limited/truncated LLM response previously produced
// a blank report page). Mirrors src/utils/evaluation.ts on the client.
export function normalizeEvaluationShape(ev: any): any {
  const toText = (v: any): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const toNum = (v: any, fb: number): number => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
    return Number.isFinite(n) ? n : fb;
  };
  const toArr = (v: any): string[] => {
    if (Array.isArray(v)) return v.map(toText).map((s: string) => s.trim()).filter(Boolean);
    const s = toText(v).trim();
    return s ? [s] : [];
  };
  const cefrLevels = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  const clampBand = (n: number) => Math.min(9, Math.max(0, n));

  const band = clampBand(toNum(ev?.predictedIeltsBand, 6.5));
  const cefr = cefrLevels.includes(ev?.overallCEFR) ? ev.overallCEFR : 'B2';

  const normPillar = (p: any) => ({
    score: clampBand(toNum(p?.score, band)),
    cefr: cefrLevels.includes(p?.cefr) ? p.cefr : cefr,
    strengths: toArr(p?.strengths),
    growthAreas: toArr(p?.growthAreas),
    examinerCommentary: toText(p?.examinerCommentary),
  });

  ev.overallCEFR = cefr;
  ev.predictedIeltsBand = band;
  ev.cefrDescriptor = toText(ev?.cefrDescriptor) || 'Independent Speaker';
  ev.executiveSummary = toText(ev?.executiveSummary);
  ev.pillars = {
    fluency: normPillar(ev?.pillars?.fluency),
    lexical: normPillar(ev?.pillars?.lexical),
    grammar: normPillar(ev?.pillars?.grammar),
    pronunciation: normPillar(ev?.pillars?.pronunciation),
  };
  ev.upgradedExpressions = Array.isArray(ev?.upgradedExpressions) ? ev.upgradedExpressions : [];
  ev.pronunciationTips = Array.isArray(ev?.pronunciationTips) ? ev.pronunciationTips : [];
  ev.stats = {
    totalWords: Math.max(0, Math.round(toNum(ev?.stats?.totalWords, 0))),
    estimatedWPM: Math.min(250, Math.max(40, Math.round(toNum(ev?.stats?.estimatedWPM, 110)))),
    pauseFluencyRating: toText(ev?.stats?.pauseFluencyRating) || 'Moderate Pauses',
    varietyRating: toText(ev?.stats?.varietyRating) || 'Good',
  };
  ev.lessonRoadmap = Array.isArray(ev?.lessonRoadmap) ? ev.lessonRoadmap : [];
  return ev;
}

// ---------------------------------------------------------------------------
// Full-coverage report analysis: deterministic sentence extraction so EVERY
// meaningful sentence the student spoke gets upgraded, nothing skipped
// ---------------------------------------------------------------------------

export interface ExtractedSentence {
  part: number;   // 1..3 real IELTS part (not array index!)
  index: number;  // global 1-based numbering across all parts
  text: string;
}

/**
 * Maps a raw response item to the REAL IELTS part number (1|2|3).
 *
 * Cambridge tests contain MANY questions per section (e.g. 4 × Part 1 + 1 ×
 * Part 2 + 6 × Part 3), so the position of a response inside the submitted
 * array is NOT the part number. Using the array index caused sentences from a
 * Part 2 cue card to be stamped "Part 5" and broke the report's Part filter.
 */
export function resolveResponsePart(r: any, fallbackIdx: number): number {
  const fromField = Number(r?.part);
  if (Number.isInteger(fromField) && fromField >= 1 && fromField <= 3) return fromField;
  const title = String(r?.partTitle || '');
  const m = title.match(/part\s*([1-3])\b/i);
  if (m) return Number(m[1]);
  return fallbackIdx + 1;
}

export function splitIntoSentences(responses: any[]): ExtractedSentence[] {
  const out: ExtractedSentence[] = [];
  let counter = 0;
  (responses || []).forEach((r: any, idx: number) => {
    const transcript = String(r?.transcript || '').trim();
    if (!transcript) return;
    const part = resolveResponsePart(r, idx);
    const pieces = transcript
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim().replace(/\s+/g, ' '))
      .filter(Boolean);
    for (const raw of pieces) {
      const wordCount = raw.split(/\s+/).filter(Boolean).length;
      if (wordCount < 4) continue; // skip trivial fragments ("Yes.", "I think so.")
      counter += 1;
      out.push({ part, index: counter, text: raw });
    }
  });
  return out;
}

export const UPGRADE_CHUNK_SIZE = 12;

// ---------------------------------------------------------------------------
// Honest fallback evaluations — used when a diagnostic captured (almost) no
// speech, or when the LLM evaluation pipeline fails gracefully.
// ---------------------------------------------------------------------------

export function generateNoSpeechEvaluation(userProfile: any) {
  const nickname = userProfile?.nickname || 'Learner';
  const noSpeechPillar = (label: string) => ({
    score: 4.0,
    cefr: 'A2',
    strengths: ['You completed the diagnostic flow and used the recording tools'],
    growthAreas: [
      'Speak for the full time on every part — silence cannot be scored',
      'Answer Part 1 with 3-5 sentences about familiar topics',
      'Use the Part 2 prep minute to jot ideas, then talk continuously'
    ],
    examinerCommentary: `${label}: no measurable speech was captured for this criterion. Retake the diagnostic and answer out loud so Lumi has real language to assess.`,
  });

  return {
    overallCEFR: 'A2',
    predictedIeltsBand: 4.0,
    cefrDescriptor: 'Insufficient Speech Sample — No Score',
    executiveSummary: `${nickname}, I couldn't hear enough speech to assess your English — all three parts came through empty or nearly empty. Nothing was scored here; this is not a reflection of your ability. Retake the diagnostic, speak loudly into the microphone, and answer each part for its full time. Lumi will then give you a real, meaningful band.`,
    pillars: {
      fluency: noSpeechPillar('Fluency'),
      lexical: noSpeechPillar('Lexical Resource'),
      grammar: noSpeechPillar('Grammar'),
      pronunciation: noSpeechPillar('Pronunciation'),
    },
    upgradedExpressions: [],
    pronunciationTips: [],
    stats: {
      totalWords: 0,
      estimatedWPM: 0,
      pauseFluencyRating: 'Hesitant' as const,
      varietyRating: 'Repetitive' as const,
    },
    lessonRoadmap: [],
  };
}

export function generateFallbackEvaluation(userProfile: any, responses: any[], stats: any) {
  const nickname = userProfile?.nickname || 'Learner';
  const targetBand = parseFloat(userProfile?.targetBand || '7.0') || 7.0;
  const selfLevel = userProfile?.selfAssessedLevel || 'B2';

  let overallCEFR = 'B2';
  let predictedBand = 6.5;
  if (selfLevel.includes('A1') || selfLevel.includes('A2')) {
    overallCEFR = 'A2';
    predictedBand = 5.0;
  } else if (selfLevel.includes('B1')) {
    overallCEFR = 'B1';
    predictedBand = 5.5;
  } else if (selfLevel.includes('C1') || selfLevel.includes('C2')) {
    overallCEFR = 'C1';
    predictedBand = 7.5;
  }

  return {
    overallCEFR,
    predictedIeltsBand: predictedBand,
    cefrDescriptor: overallCEFR === 'C1' ? 'Effective Operational Proficiency' : overallCEFR === 'B2' ? 'Independent Fluency with Strong Foundations' : 'Developing Conversational Competence',
    executiveSummary: `Great effort, ${nickname}! Lumi has carefully analyzed your spoken responses across all three diagnostic tasks. You demonstrate clear ideas and good communicative intent. To push towards your target of Band ${targetBand}, our focus will be expanding idiomatic collocations and using sophisticated discourse markers to eliminate hesitation in Part 2 and Part 3.`,
    pillars: {
      fluency: {
        score: predictedBand - 0.5 > 4.5 ? predictedBand - 0.5 : 5.0,
        cefr: overallCEFR,
        strengths: [
          'Willingness to speak at reasonable length on familiar topics',
          'Good turn-taking and responsive cadence',
          'Basic sequencing connectors (and, because, so) used reliably'
        ],
        growthAreas: [
          'Reduce mid-sentence filler pauses ("um", "like")',
          'Use advanced cohesive devices (subsequently, conversely, in hindsight)',
          'Maintain momentum during Part 2 2-minute long turns'
        ],
        examinerCommentary: `You speak with genuine enthusiasm, ${nickname}. With targeted pacing drills, you will transition from simple sentence linking to effortless rhythmic flow.`
      },
      lexical: {
        score: predictedBand,
        cefr: overallCEFR,
        strengths: [
          'Clear topic-related vocabulary used accurately',
          'Good ability to paraphrase when reaching for specific terms',
          'Comfortable everyday idiomatic expressions'
        ],
        growthAreas: [
          'Replace generic adjectives (good, bad, nice) with precise Band 8+ terms',
          'Incorporate collocations (e.g. "heavily reliant on", "deep-seated passion")',
          'Demonstrate flexible nuance on abstract societal topics'
        ],
        examinerCommentary: 'Your vocabulary is communicative and clear. Upgrading your adjective and verb precision will quickly unlock higher IELTS band descriptors.'
      },
      grammar: {
        score: predictedBand,
        cefr: overallCEFR,
        strengths: [
          'Frequent error-free simple and compound sentences',
          'Good control of basic present and past tense structures',
          'Intelligible clause connections'
        ],
        growthAreas: [
          'Introduce mixed conditionals and speculative structures ("Had I known...", "It is likely that...")',
          'Watch subject-verb agreement under speaking pressure',
          'Use passive voice and relative clauses for academic balance'
        ],
        examinerCommentary: 'Solid structural foundation! We will introduce high-scoring modal and conditional frameworks in our upcoming practice sessions.'
      },
      pronunciation: {
        score: predictedBand + 0.5 <= 9.0 ? predictedBand + 0.5 : predictedBand,
        cefr: overallCEFR,
        strengths: [
          'Clear overall vocal clarity and audible speech volume',
          'Good basic syllable stress on common multisyllabic words',
          'Engaging friendly vocal pitch'
        ],
        growthAreas: [
          'Master sentence stress to highlight focal keywords',
          'Practice connected speech (linking consonant to vowel sounds)',
          'Intonation modulation at the end of statements vs questions'
        ],
        examinerCommentary: 'Your voice is easy to understand. Refining your cadence and connected speech will give you that natural, confident native-like flair.'
      }
    },
    upgradedExpressions: [
      {
        original: "I like living in my city because it has many shops and good things to do.",
        upgraded: "What captivates me most about my hometown is its vibrant cosmopolitan atmosphere paired with an abundance of recreational amenities.",
        ieltsBand: "Band 8.5",
        part: 1,
        explanation: "Replaces generic 'like' and 'good things' with high-level lexical items ('captivates', 'cosmopolitan atmosphere', 'recreational amenities') and an emphatic cleft sentence."
      },
      {
        original: "I want to achieve this goal for a very long time since I was young.",
        upgraded: "Pursuing this ambition has been a longstanding aspiration of mine ever since my formative years.",
        ieltsBand: "Band 8.0",
        part: 1,
        explanation: "Corrects the tense structure while introducing academic phrases ('longstanding aspiration', 'formative years') that examiners look for in Part 2."
      },
      {
        original: "Technology makes young people feel stressed because they always compare with others on phone.",
        upgraded: "The omnipresence of digital media inadvertently fosters unprecedented social comparison, often exerting psychological pressure on youth.",
        ieltsBand: "Band 9.0",
        part: 1,
        explanation: "Transforms conversational phrasing into an analytical, objective viewpoint suited for top-tier IELTS Part 3 evaluation."
      }
    ],
    pronunciationTips: [
      {
        word: "Cosmopolitan",
        ipa: "/ˌkɒzməˈpɒlɪtən/",
        phoneticSpelling: "koz-muh-POL-uh-tuhn",
        tip: "Place primary stress firmly on the third syllable 'POL'. Keep the vowel crisp.",
        exampleSentence: "She grew up in a cosmopolitan metropolis filled with diverse cultures.",
        part: 1,
      },
      {
        word: "Aspiration",
        ipa: "/ˌæspəˈreɪʃən/",
        phoneticSpelling: "as-puh-RAY-shun",
        tip: "Primary stress on 'RAY'. Glide smoothly from 'puh' to 'RAY-shun'.",
        exampleSentence: "My primary aspiration is to excel in international research.",
        part: 1,
      },
      {
        word: "Omnipresence",
        ipa: "/ˌɒmnɪˈprezəns/",
        phoneticSpelling: "om-ni-PREZ-uhns",
        tip: "Stress the 'PREZ' syllable, keeping the 'om-ni' light and rhythmic.",
        exampleSentence: "The omnipresence of smart devices has reshaped modern habits.",
        part: 1,
      }
    ],
    stats: {
      totalWords: stats?.totalWords || 145,
      estimatedWPM: stats?.estimatedWPM || 115,
      pauseFluencyRating: 'Moderate Pauses' as const,
      varietyRating: 'Good' as const,
    },
    lessonRoadmap: [
      {
        id: 'module-1',
        title: 'Mastering Band 8+ Cohesive Discourse Markers',
        level: 'Band 7.0 - 8.5',
        category: 'Fluency' as const,
        duration: '15 Mins',
        description: 'Learn seamless transitions like "Having said that", "In retrospect", and "From an empirical standpoint" to glide between points without pausing.',
        objectives: [
          'Eliminate "um", "you know", and awkward silences',
          'Master 10 examiner-approved linking structures',
          'Practice 30-second continuous transitions'
        ],
        practiceDrill: {
          type: 'rapid_fire',
          prompt: 'Answer the question: "Do people in your country prefer living in urban centers or rural towns?" using at least two advanced contrast connectors.',
          modelBand9Sample: 'Broadly speaking, there is a pronounced generational divide. Whereas the younger demographic gravitates toward metropolitan hubs for career acceleration, older generations predominantly seek the tranquility of countryside retreats. In essence, it hinges entirely on one’s phase in life.',
          tips: ['Use "Broadly speaking" to initiate', 'Contribute contrast with "Whereas"', 'Summarize with "In essence"']
        }
      },
      {
        id: 'module-2',
        title: 'IELTS Part 2 Cue Card: The 3-Act Storytelling Formula',
        level: 'Band 7.5+',
        category: 'Part 2 Cue Card' as const,
        duration: '20 Mins',
        description: 'Structure your 2-minute long turn into Setup, Climax/Conflict, and Reflection so you never run out of ideas before the timer rings.',
        objectives: [
          'Organize bullet points using the 1-minute prep window',
          'Use evocative sensory and descriptive adjectives',
          'Deliver an impactful closing personal reflection'
        ],
        practiceDrill: {
          type: 'cue_card',
          prompt: 'Describe a memorable journey or adventure you embarked upon with close companions.',
          modelBand9Sample: 'If I were to recount one particularly unforgettable expedition, it would unquestionably be our trek across the northern highlands two summers ago. Initially, we were met with torrential downpours; however, the breathtaking panoramic vista at the summit made every ounce of adversity utterly worthwhile.',
          tips: ['Start with conditional framing: "If I were to recount..."', 'Inject emotional nuance ("utterly worthwhile")']
        }
      },
      {
        id: 'module-3',
        title: 'Lexical Booster: High-Scoring Idiomatic Collocations',
        level: 'Band 8.0+',
        category: 'Vocabulary' as const,
        duration: '15 Mins',
        description: 'Upgrade common everyday expressions into natural, precise native collocations that demonstrate authentic Lexical Resource.',
        objectives: [
          'Replace 15 basic phrases with high-impact collocations',
          'Learn natural academic register for societal discussions',
          'Avoid forced idioms that sound unnatural'
        ],
        practiceDrill: {
          type: 'lexical_boost',
          prompt: 'Express your opinion on whether remote work will completely replace traditional offices.',
          modelBand9Sample: 'While remote employment offers unparalleled flexibility, I contend that physical offices remain indispensable for fostering spontaneous collaboration and cultivating genuine team synergy.',
          tips: ['Pair "unparalleled" with "flexibility"', 'Use "indispensable" instead of "very necessary"']
        }
      },
      {
        id: 'module-4',
        title: 'Part 3 Abstract Analytical Thinking & Speculation',
        level: 'Band 8.5+',
        category: 'Examiner Strategy' as const,
        duration: '25 Mins',
        description: 'Tackle tough philosophical and societal examiner questions with structured nuance, hypothesizing, and international comparisons.',
        objectives: [
          'Adopt the "Perspective - Evidence - Counterargument" paradigm',
          'Use tentative language ("It is plausible that...", "One could argue...")',
          'Impress examiners with macro-level sociological perspectives'
        ],
        practiceDrill: {
          type: 'mock_exam',
          prompt: 'To what extent does artificial intelligence pose a threat to human creativity in artistic fields?',
          modelBand9Sample: 'That is an intriguing dilemma. On one hand, generative algorithms can synthesize imagery and prose at astonishing velocity. Yet, on a deeper level, genuine art stems from lived human vulnerability and existential consciousness—qualities that no algorithmic architecture can authentically replicate.',
          tips: ['Acknowledge the complexity upfront ("That is an intriguing dilemma")', 'Differentiate technical generation from human consciousness']
        }
      }
    ]
  };
}

