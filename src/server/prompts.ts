/**
 * Central home for EVERY prompt string + JSON schema hint sent to the AI.
 *
 * The handlers (src/server/routes/*) only ever call these builders — no
 * prompt text lives inside route or logic code anymore, so tweaking Seren's
 * behaviour (lesson focus, follow-up limits, schema) means editing this file
 * and nowhere else.
 */

// ---------------------------------------------------------------------------
// Sentence-upgrade pass
// ---------------------------------------------------------------------------

export function buildUpgradeChunkPrompt(chunk: { index: number; part: number; text: string }[]): string {
  return `Upgrade every sentence below to Band 8+/9 IELTS standard.
For each: keep the meaning, copy "original" verbatim, output the upgraded version, its band label (e.g. Band 8.0), and a one-line explanation of the improvement.
One entry per sentence, in order. Never skip, merge, or invent.

SENTENCES (${chunk.length}):
${chunk.map((s) => `[S${s.index}|P${s.part}] "${s.text}"`).join('\n')}`;
}

export const UPGRADE_CHUNK_SCHEMA = `{
  "upgradedExpressions": [ { "index": 1, "part": 1, "original": "verbatim input", "upgraded": "band 8+ version", "ieltsBand": "Band 8.0", "explanation": "one-line upgrade rationale" } ]
}
Array length = number of input sentences, same order.`;

// ---------------------------------------------------------------------------
// Pronunciation scan (shared by evaluate-speech and evaluate-practice)
// ---------------------------------------------------------------------------

export function buildPronunciationScanPrompt(transcriptsBlock: string): string {
  return `Review ALL of this learner's answers and pick ONLY the words that are genuinely hard to pronounce for B1-C1 IELTS learners.

SELECTION RUBRIC (a word must match at least one):
- 3+ syllables with irregular/unpredictable stress (e.g. agricultural, unforgettable)
- Deceptive spelling / silent letters (e.g. receipt, psychology, comb)
- Tricky sound clusters: -ed/-s endings, th-, vowel length contrasts, /v/ vs /w/, /l/ vs /r/
- Uncommon or topic-specific vocabulary the learner actually used (e.g. meteor, infrastructure)

HARD EXCLUSIONS - never include:
- Everyday high-frequency words (people, traffic, friends, road, water, government, think...) even if accented - they are not worth a coaching entry
- Any word you cannot back with real IPA - if unsure, skip it

Return AT MOST 8 entries for the WHOLE test, ranked by teaching value (hardest/most useful first). Returning fewer - or zero - is completely fine; never invent entries to fill a quota.
Each word must appear VERBATIM in the transcripts below. For each: word, ipa, phoneticSpelling, one-line tip (the concrete fix), exampleSentence (a fresh IELTS-style sentence using the word).

TRANSCRIPTS:
${transcriptsBlock}`;
}

export const PRONUNCIATION_TIPS_SCHEMA = `{
  "pronunciationTips": [ { "word": "mispronounced", "ipa": "/ˌmɪsprəˈnaʊnst/", "phoneticSpelling": "mis-pruh-NOWNST", "tip": "Stress the third syllable -NOWN.", "exampleSentence": "He often mispronounces technical terms." } ]
}`;

// ---------------------------------------------------------------------------
// Full IELTS diagnostic evaluation (Cambridge / cue-card test)
// ---------------------------------------------------------------------------

export function buildEvaluateSpeechPrompt(p: {
  userProfile: any;
  transcriptsBlock: string;
  stats: any;
}): string {
  const { userProfile, transcriptsBlock, stats } = p;
  return `Evaluate this IELTS Speaking test (official criteria + CEFR A1-C2).

PROFILE: ${userProfile?.nickname || 'Learner'} | goal: ${userProfile?.goal || 'IELTS Speaking'} | audience: ${userProfile?.targetAudience || 'Examiners & Native Speakers'} | target: Band ${userProfile?.targetBand || '7.5'} | self: ${userProfile?.selfAssessedLevel || 'B1'} | focus: ${userProfile?.preferredFocus?.join(', ') || 'Fluency & Vocabulary'}

TRANSCRIPTS:
${transcriptsBlock}

STATS: ${stats?.totalWords || 120} words, ~${stats?.estimatedWPM || 110} wpm.

SCORING RULES:
1. overallCEFR ∈ [A1,A2,B1,B2,C1,C2]; predictedIeltsBand between 4.0 and 9.0.
2. Score from the transcript ONLY. Empty or near-empty parts get NO credit and pull the band toward 4.0; a near-empty test scores 4.0-5.0, never 7.0+, never the target band.
3. Pillars (fluency, lexical, grammar, pronunciation): score, cefr, 2-3 strengths, 2-3 growthAreas, 1-2 sentence examinerCommentary in Seren's friendly-expert voice.
4. upgradedExpressions: [] (separate pass). pronunciationTips: [] (separate pass).
5. priorityErrors: EXACTLY 3-5 entries = the MOST damaging REAL errors visible in THIS transcript (the raw material for the separate Custom-Lesson pass). Never invent errors the learner didn't make; quote their words VERBATIM.`;
}

export const EVALUATE_SPEECH_SCHEMA = `{
  "overallCEFR": "A1|A2|B1|B2|C1|C2",
  "predictedIeltsBand": 6.5,
  "cefrDescriptor": "short label e.g. Upper Intermediate",
  "executiveSummary": "2-3 sentence warm assessment",
  "pillars": {
    "fluency": { "score": 6.5, "cefr": "B2", "strengths": ["..."], "growthAreas": ["..."], "examinerCommentary": "..." },
    "lexical": { "score": 6.5, "cefr": "B2", "strengths": ["..."], "growthAreas": ["..."], "examinerCommentary": "..." },
    "grammar": { "score": 6.5, "cefr": "B2", "strengths": ["..."], "growthAreas": ["..."], "examinerCommentary": "..." },
    "pronunciation": { "score": 6.5, "cefr": "B2", "strengths": ["..."], "growthAreas": ["..."], "examinerCommentary": "..." }
  },
  "upgradedExpressions": [],
  "pronunciationTips": [],
  "stats": { "totalWords": 145, "estimatedWPM": 115, "pauseFluencyRating": "Smooth|Moderate Pauses|Hesitant", "varietyRating": "High|Good|Repetitive" },
  "priorityErrors": [ { "category": "Grammar|Vocabulary|Fluency|Pronunciation", "quote": "verbatim learner sentence", "whyWrong": "the rule in one line", "fix": "corrected version" } ]
}`;

// ---------------------------------------------------------------------------
// Interview-practice evaluation (JSON-based Cambridge practice questions)
// ---------------------------------------------------------------------------

export function buildInterviewPracticePrompt(p: {
  userProfile: any;
  topic: string;
  questions: any[];
  stats: any;
}): string {
  const { userProfile, topic, questions, stats } = p;
  return `Evaluate this IELTS interview practice (official criteria + CEFR A1-C2).

PROFILE: ${userProfile?.nickname || 'Learner'} | goal: ${userProfile?.goal || 'IELTS Speaking'} | target: Band ${userProfile?.targetBand || '7.5'} | self: ${userProfile?.selfAssessedLevel || 'B1'}
TOPIC: ${topic || 'General'}

Q&A:
${(questions || []).map((q: any, i: number) => `[Q${i + 1}] Q: "${q.question}"\nA: "${q.userAnswer || '(no answer)'}"`).join('\n')}

STATS: ${stats?.totalWords || 0} words, ~${stats?.estimatedWPM || 0} wpm.

SCORING RULES:
1. overallCEFR ∈ [A1,A2,B1,B2,C1,C2]; predictedIeltsBand between 4.0 and 9.0.
2. Score from the ACTUAL answers ONLY; empty answers get NO credit.
3. Pillars (fluency, lexical, grammar, pronunciation): score, cefr, 2-3 strengths, 2-3 growthAreas, 1-2 sentence examinerCommentary.
4. upgradedExpressions: [] (built server-side from the model answer bank). pronunciationTips: [] (separate pass).
5. priorityErrors: EXACTLY 3-5 entries = the MOST damaging REAL errors visible in THESE answers (the raw material for the separate Custom-Lesson pass). Never invent errors the learner didn't make; quote their words VERBATIM.`;
}

export const INTERVIEW_PRACTICE_SCHEMA = `{
  "overallCEFR": "A1|A2|B1|B2|C1|C2",
  "predictedIeltsBand": 6.5,
  "cefrDescriptor": "short label",
  "executiveSummary": "2-3 sentence warm assessment",
  "pillars": {
    "fluency": { "score": 6.5, "cefr": "B2", "strengths": ["..."], "growthAreas": ["..."], "examinerCommentary": "..." },
    "lexical": { "score": 6.5, "cefr": "B2", "strengths": ["..."], "growthAreas": ["..."], "examinerCommentary": "..." },
    "grammar": { "score": 6.5, "cefr": "B2", "strengths": ["..."], "growthAreas": ["..."], "examinerCommentary": "..." },
    "pronunciation": { "score": 6.5, "cefr": "B2", "strengths": ["..."], "growthAreas": ["..."], "examinerCommentary": "..." }
  },
  "upgradedExpressions": [],
  "pronunciationTips": [],
  "stats": { "totalWords": 100, "estimatedWPM": 110, "pauseFluencyRating": "Smooth|Moderate Pauses|Hesitant", "varietyRating": "High|Good|Repetitive" },
  "priorityErrors": [ { "category": "Grammar|Vocabulary|Fluency|Pronunciation", "quote": "verbatim learner sentence", "whyWrong": "the rule in one line", "fix": "corrected version" } ]
}`;
// ---------------------------------------------------------------------------
// Interactive Seren chat / speaking session (incl. Lesson Practice mode)
// ---------------------------------------------------------------------------

export const SEREN_CASUAL_SYSTEM =
  'You are Seren, a warm, curious, genuinely human friend. Keep replies short and natural, talk like a real person — casual tone, light humour, real curiosity about their life. Never sound like a tutor, coach, or examiner.';

export const SEREN_CHAT_SYSTEM =
  'You are Seren, a charismatic, encouraging AI IELTS tutor. Keep replies concise, natural, and pedagogically rich.';

export function buildSerenChatPrompt(p: {
  isCasual: boolean;
  userProfile: any;
  evaluation?: any;
  conversationHistory?: any[];
  message: string;
  mode?: string;
}): string {
  const { isCasual, userProfile, evaluation, conversationHistory, message, mode } = p;
  const chatTail = (conversationHistory || [])
    .slice(-6)
    .map((msg: any) => `${msg.sender === 'user' ? 'User' : 'Seren'}: ${msg.text}`)
    .join('\n');

  if (isCasual) {
    return `Casual conversation with Seren, a close friend.

FRIEND: ${userProfile?.nickname || 'friend'} | they enjoy: ${userProfile?.preferredFocus?.join(', ') || 'everyday life topics'} | their goal: ${userProfile?.goal || 'general conversation'}

CHAT (last 6):
${chatTail}

LATEST USER: "${message}"

TASK:
- Reply in 2-3 compact, mid-length sentences — warm and natural, like a friend
  texting back. Never one-word answers, never long lectures or bullet points.
- Use their nickname naturally, react to what THEY just said, and ask ONE easy follow-up question about their life, mood, or day.
- Follow their lead: if they bring up a topic, stay on it and be curious. Never force a topic.
- mood describes Seren RIGHT AFTER her reply: 'speaking' normally, 'encouraging' if the user shared something difficult, 'celebrating' for good news. NEVER use 'listening' — that state is reserved for when the user's microphone is recording.
- IMPORTANT — English rephrasing is allowed ONLY when they make an obvious grammatical slip, and ONLY as a gentle, in-line reflection (e.g. "Oh nice, so you're really into hiking? Tell me more!") — never label it, never say "actually", never grade, never call it a correction. If their English is fine, say nothing about language.
- You are a FRIEND, not a tutor or examiner. Never talk about IELTS, band scores, grading, practice, exams, or language learning UNLESS the user brings it up first. If they ask a test question, act like a curious friend, not a judge.`;
  }

  return `Live IELTS speaking session.

USER: ${userProfile?.nickname || 'Learner'} | ${userProfile?.goal || 'IELTS Speaking'} | target Band ${userProfile?.targetBand || '7.5'} | current ${evaluation?.overallCEFR || 'B2'} (${evaluation?.predictedIeltsBand || '6.5'}) | mode: ${mode || 'IELTS Mock Practice'}

CHAT (last 6):
${chatTail}

LATEST USER: "${message}"

TASK:
- Reply in 2-4 sentences, warm and natural.
- Ask a short IELTS Part 1/2/3-style follow-up.
- mood describes Seren RIGHT AFTER her reply: 'speaking' normally, 'encouraging' if the user shared something difficult, 'celebrating' for good news. NEVER use 'listening' — that state is reserved for when the user's microphone is recording.
- feedback: correctedSentence (Band 8+ phrasing), 2-3 lexicalBoost items, 1 ieltsTip.`;
}

export const SEREN_CASUAL_SCHEMA = `{
  "replyText": "Seren's friendly reply (2-3 compact, mid-length sentences)",
  "mood": "speaking|encouraging|celebrating"
}`;

export const SEREN_CHAT_SCHEMA = `{
  "replyText": "Seren's reply (2-4 sentences)",
  "mood": "speaking|encouraging|celebrating",
  "feedback": { "correctedSentence": "...", "lexicalBoost": ["...", "..."], "ieltsTip": "..." }
}`;

// ---------------------------------------------------------------------------
// Dedicated Custom-Lesson roadmap pass
//
// The roadmap used to be squeezed into the scoring prompt, which diluted BOTH
// the score AND the drills (models emitted generic textbook exercises instead
// of fixing the learner's real mistakes). It now runs as its OWN call with the
// transcripts + the examiner's priority errors, so every module quotes the
// learner's own sentences and ships "fix this sentence" exercises built from
// them.
// ---------------------------------------------------------------------------

export function buildLessonRoadmapPrompt(p: {
  userProfile: any;
  pillarsDigest: string;
  priorityErrorsBlock: string;
  transcriptsBlock: string;
}): string {
  const { userProfile, pillarsDigest, priorityErrorsBlock, transcriptsBlock } = p;
  return `Design up to 4 Custom-Lesson modules for this IELTS Speaking learner. Create a module ONLY when the evidence contains a genuine, teachable learner error.

PROFILE: ${userProfile?.nickname || 'Learner'} | goal: ${userProfile?.goal || 'IELTS Speaking'} | target: Band ${userProfile?.targetBand || '7.5'}

PILLARS (score + top growth areas):
${pillarsDigest}

PRIORITY ERRORS (from the examiner pass):
${priorityErrorsBlock}

TRANSCRIPTS (the learner's own words):
${transcriptsBlock}

ROADMAP RULES:
1. Return between 1 and 4 modules, one per distinct, high-impact REAL error. If there are no genuine errors, return an empty lessonRoadmap. Never create a module merely to reach a quota.
2. Ground every module in the learner's OWN sentences:
  - exampleError: a VERBATIM quote from a real error in the transcript or priorityErrors
  - errorAnalysis: why that exact quote is wrong
  - correction: a minimal, accurate correction preserving the learner's meaning
3. practiceDrill.exerciseItems MUST include the module's exampleError verbatim and its correction. Add only other distinct real errors from the evidence. Do not include correct sentences, stylistic upgrades, or fabricated examples as mistakes.
4. The FIRST learner activity is fixing the displayed mistake: practiceDrill.prompt must tell the learner to say the corrected version of the shown sentence, then make one new sentence using the same rule. It must reference the displayed example, never unseen examples.
5. Only after that error-correction activity, include transferQuestion: one natural IELTS-style speaking question that gives the learner a chance to use the same correction in a fresh answer. The transfer question is secondary practice, not a replacement for the mistake.
6. modelBand9Sample answers transferQuestion. objectives: 3 short bullets. tips: 3 concrete techniques for noticing and correcting this exact error in spontaneous speech.`;
}

export const LESSON_ROADMAP_SCHEMA = `{
  "lessonRoadmap": [
    {
      "id": "module-1",
      "title": "Concise Skill-Drill Title",
      "level": "Band X.Y-Z.W",
      "category": "Grammar|Vocabulary|Fluency|Pronunciation|Part 2 Cue Card|Examiner Strategy",
      "duration": "10-20 Mins",
      "description": "one sentence",
      "focusArea": "ONE micro-skill this lesson fixes",
      "exampleError": "verbatim learner sentence showing the error",
      "errorAnalysis": "why it's wrong - the rule in 1-2 sentences",
      "correction": "the corrected sentence",
      "objectives": ["3 short bullets"],
      "practiceDrill": {
        "type": "rapid_fire|cue_card|lexical_boost|shadowing|mock_exam",
        "prompt": "say the displayed correction aloud, then make a new sentence using the rule",
        "exerciseItems": [ { "faulty": "required verbatim learner mistake", "correction": "minimal fixed version", "note": "why it was wrong" } ],
        "transferQuestion": "one natural IELTS-style question for applying the correction",
        "modelBand9Sample": "natural spoken answer to transferQuestion",
        "tips": ["3 concrete technique bullets"]
      }
    }
  ]
}
Return 0-4 modules. Every "faulty" / "exampleError" string must be a verbatim quote from the transcript or a priority error.`;

const NON_SPEAKING_TASK_PATTERN = /\b(?:complete\s+(?:\d+\s+)?sentences?|fill\s+in\s+(?:the\s+)?blanks?|read\s+each\s+sentence|spot\s+the\s+error|identify\s+the\s+error|correct\s+each\s+sentence|rewrite\s+each\s+sentence|state\s+the\s+rule|choose\s+the\s+correct)\b/i;

export function isUsableSpeakingQuestion(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const question = value.trim();
  const questionMarks = question.match(/\?/g) || [];
  return (
    question.length >= 12 &&
    question.length <= 320 &&
    questionMarks.length === 1 &&
    question.endsWith('?') &&
    !NON_SPEAKING_TASK_PATTERN.test(question)
  );
}

/**
 * Lesson replies are 2-4 coaching sentences that END with one spoken question,
 * so validating the WHOLE reply with isUsableSpeakingQuestion() rejects almost
 * every real reply (multi-sentence, often >320 chars) and forces the same
 * deterministic fallback text every round — which the client's speech dedup
 * then swallows. Only the trailing question sentence must be usable.
 */
export function endsWithUsableSpeakingQuestion(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const reply = value.trim();
  if (!reply.endsWith('?')) return false;
  const lastBreak = Math.max(
    reply.lastIndexOf('. '),
    reply.lastIndexOf('! '),
    reply.lastIndexOf('? '),
    reply.lastIndexOf('\n')
  );
  const trailingQuestion = lastBreak === -1 ? reply : reply.slice(lastBreak + 2);
  return isUsableSpeakingQuestion(trailingQuestion);
}

// NOTE: the "is this module a grounded mistake?" check used to live here as
// isGroundedMistakeModule(). It now lives in src/server/lessonRoadmap.ts as
// validateLessonModule(), because validation must run AFTER the deterministic
// repair — and because a second, divergent validator is exactly how modules
// used to be rejected wholesale. Kept out of this file on purpose: prompt
// text and prompt-only helpers live here, lesson logic lives with the
// lesson-roadmap module.

// ---------------------------------------------------------------------------
// Lesson drill generator
// ---------------------------------------------------------------------------

export function buildLessonDrillPrompt(p: {
  nickname: string;
  targetBand: string;
  lessonModule: any;
}): string {
  const { nickname, targetBand, lessonModule } = p;
  return `Make a 3-step IELTS speaking drill for ${nickname} (target Band ${targetBand}).
Lesson: ${lessonModule?.title} | Category: ${lessonModule?.category} | ${lessonModule?.description}`;
}

export const LESSON_DRILL_SCHEMA = `{
  "warmupQuestion": "an easy opener question on the lesson topic",
  "keyVocabulary": ["4-6 band 8+ words/phrases with short glosses"],
  "challengeQuestion": "a harder IELTS-style challenge question",
  "band9Guidance": "how a band 9 answer would be structured"
}`;

// ---------------------------------------------------------------------------
// Custom Lesson session protocol — bounded, error-focused micro-coaching.
//
// One lesson = ONE skill = ONE real error from the student's evaluation.
// Round 0: feedback on the drill answer. Rounds 1-4: each follow-up re-drills
// the SAME fix one layer deeper. Round 5 (or earlier when the fix lands): a
// wrap-up summary (what improved / what to fix for the target band) and the
// lesson is complete. The server enforces the cap; the client mirrors it.
// ---------------------------------------------------------------------------

export const LESSON_CHAT_SYSTEM =
  "You are Seren, a focused IELTS Speaking micro-coach. You fix exactly ONE skill per lesson and never drift to other topics. Be warm but precise — always quote the learner's own words when correcting.";

export const LESSON_MAX_FOLLOW_UPS = 5;

export function buildLessonChatPrompt(p: {
  lessonContext: any;
  followUpIndex: number;
  conversationHistory?: any[];
  message: string;
}): string {
  const { lessonContext, followUpIndex, conversationHistory, message } = p;
  const chatTail = (conversationHistory || [])
    .slice(-6)
    .map((msg: any) => `${msg.sender === 'user' ? 'User' : 'Seren'}: ${msg.text}`)
    .join('\n');
  const ctx = lessonContext || {};
  const focus = ctx.focusArea || ctx.title || 'this speaking skill';
  const errorLine = ctx.exampleError
    ? `\n- The error we are fixing, from THEIR own words: "${ctx.exampleError}"`
    : '';
  const analysisLine = ctx.errorAnalysis ? `\n- Why it is wrong (the rule): ${ctx.errorAnalysis}` : '';
  const correctionLine = ctx.correction ? `\n- The corrected version to steer toward: "${ctx.correction}"` : '';
  const objectives = (ctx.objectives || []).map((o: string) => `  • ${o}`).join('\n');
  const tips = (ctx.tips || []).map((t: string) => `  • ${t}`).join('\n');
  const isFinalRound = followUpIndex >= LESSON_MAX_FOLLOW_UPS;

  return `Focused Custom Lesson: ${ctx.title || 'Speaking drill'} | ${ctx.category || 'Speaking'} | learner: ${ctx.nickname || 'Learner'} | target Band ${ctx.targetBand || '7.5'} | current band ${ctx.currentBand || '—'}

LESSON FOCUS — stay on THIS ONE skill only:
- Skill: ${focus}${errorLine}${analysisLine}${correctionLine}
- Objectives:
${objectives || '  • Fix the error above'}
- Drill tips:
${tips || '  • Re-say the answer using the fix'}
- Drill prompt they answered: "${ctx.drillPrompt || ''}"

ROUND: follow-up #${followUpIndex} of max ${LESSON_MAX_FOLLOW_UPS}.${isFinalRound ? ' THIS IS THE FINAL ROUND — you may NOT ask any question.' : ''}

TASK:
- Reply in 2-4 sentences, warm and natural.
- When there is a real error in this lesson's focus, quote the learner's exact phrase and give ONE concise reframe (it goes in feedback.correctedSentence). If there is no such error, do not manufacture one.
- If their answer contains no error in this lesson's focus, do not invent one. Praise the accurate use briefly and give one specific next challenge.
- End with exactly ONE natural, open-ended IELTS-style speaking question they can answer aloud in 30-60 seconds. The question must give them another chance to use this lesson's focus and relate naturally to the current topic.
- Never ask them to complete a worksheet, list sentences, identify an error, state a grammar rule, or repeat an answer mechanically. Do not use meta-instructions as the follow-up question.
- Go one layer deeper each round; never repeat earlier advice or switch away from the lesson focus.
- Stay on ${focus}. Never pivot topics, never add a second skill, never give generic advice.
- mood describes Seren RIGHT AFTER her reply: 'speaking' normally, 'encouraging' if they struggled, 'celebrating' when the fix lands. NEVER use 'listening'.
- From round 3 on: if their latest answer already lands the fix, stop early — celebrate it, set lessonComplete to true and fill summary instead of asking another question.${isFinalRound ? `\n- FINAL ROUND: do NOT ask any question. Write a 2-4 sentence wrap-up, set lessonComplete to true and fill summary.improved (what concretely got better across the rounds) + summary.toTargetBand (the 2-3 fixes still needed to reach Band ${ctx.targetBand || '7.5'}).` : '\n- End your reply with exactly ONE natural spoken question that gives them another chance to use the SAME fix.'}

CHAT (last 6):
${chatTail}

LATEST USER: "${message}"`;
}

export const LESSON_CHAT_SCHEMA = `{
  "replyText": "Seren's reply (2-4 sentences; on the final round = wrap-up summary with NO question)",
  "mood": "speaking|encouraging|celebrating",
  "followUpNumber": 1,
  "lessonComplete": false,
  "feedback": { "correctedSentence": "...", "lexicalBoost": ["...", "..."], "ieltsTip": "..." },
  "summary": { "improved": ["what concretely got better across the rounds"], "toTargetBand": ["the 2-3 fixes still needed for the target band"] }
}`;