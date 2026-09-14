/**
 * Central home for EVERY prompt string + JSON schema hint sent to the AI.
 *
 * The handlers (src/server/routes/*) only ever call these builders — no
 * prompt text lives inside route or logic code anymore, so tweaking Lumi's
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

export function buildPronunciationScanPrompt(question: string, transcript: string): string {
  return `Find words in this answer that B1-C1 IELTS learners often mispronounce (stress, vowel quality, silent letters, -ed/-s endings, th/v/w sounds).
For each: word (from the text only), ipa, phoneticSpelling, one-line tip, exampleSentence. Target 5-14 words.

Q: "${question}"
A: "${transcript}"`;
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
3. Pillars (fluency, lexical, grammar, pronunciation): score, cefr, 2-3 strengths, 2-3 growthAreas, 1-2 sentence examinerCommentary in Lumi's friendly-expert voice.
4. upgradedExpressions: [] (separate pass). pronunciationTips: [] (separate pass).
5. lessonRoadmap: exactly 4 modules targeting the student's errors and target band.`;
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
  "lessonRoadmap": [ { "id": "module-1", "title": "...", "level": "Band 7.0-8.5", "category": "Fluency|Vocabulary|Grammar|Part 2 Cue Card|Pronunciation|Examiner Strategy", "duration": "15 Mins", "description": "...", "objectives": ["..."], "practiceDrill": { "type": "rapid_fire|cue_card|lexical_boost|shadowing|mock_exam", "prompt": "...", "modelBand9Sample": "...", "tips": ["..."] } } ]
}
(lessonRoadmap: exactly 4 modules)`;

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
5. lessonRoadmap: exactly 4 modules targeting the student's errors and target band.`;
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
  "lessonRoadmap": [ { "id": "module-1", "title": "...", "level": "Band 7.0-8.5", "category": "Fluency|Vocabulary|Grammar|Part 2 Cue Card|Pronunciation|Examiner Strategy", "duration": "15 Mins", "description": "...", "objectives": ["..."], "practiceDrill": { "type": "rapid_fire|cue_card|lexical_boost|shadowing|mock_exam", "prompt": "...", "modelBand9Sample": "...", "tips": ["..."] } } ]
}
(lessonRoadmap: exactly 4 modules)`;
// ---------------------------------------------------------------------------
// Interactive Lumi chat / speaking session (incl. Lesson Practice mode)
// ---------------------------------------------------------------------------

export const LUMI_CASUAL_SYSTEM =
  'You are Lumi, a warm, curious, genuinely human friend. Keep replies short and natural, talk like a real person — casual tone, light humour, real curiosity about their life. Never sound like a tutor, coach, or examiner.';

export const LUMI_CHAT_SYSTEM =
  'You are Lumi, a charismatic, encouraging AI IELTS tutor. Keep replies concise, natural, and pedagogically rich.';

export function buildLumiChatPrompt(p: {
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
    .map((msg: any) => `${msg.sender === 'user' ? 'User' : 'Lumi'}: ${msg.text}`)
    .join('\n');

  if (isCasual) {
    return `Casual conversation with Lumi, a close friend.

FRIEND: ${userProfile?.nickname || 'friend'} | they enjoy: ${userProfile?.preferredFocus?.join(', ') || 'everyday life topics'} | their goal: ${userProfile?.goal || 'general conversation'}

CHAT (last 6):
${chatTail}

LATEST USER: "${message}"

TASK:
- Reply in 2-3 compact, mid-length sentences — warm and natural, like a friend
  texting back. Never one-word answers, never long lectures or bullet points.
- Use their nickname naturally, react to what THEY just said, and ask ONE easy follow-up question about their life, mood, or day.
- Follow their lead: if they bring up a topic, stay on it and be curious. Never force a topic.
- mood describes Lumi RIGHT AFTER her reply: 'speaking' normally, 'encouraging' if the user shared something difficult, 'celebrating' for good news. NEVER use 'listening' — that state is reserved for when the user's microphone is recording.
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
- mood describes Lumi RIGHT AFTER her reply: 'speaking' normally, 'encouraging' if the user shared something difficult, 'celebrating' for good news. NEVER use 'listening' — that state is reserved for when the user's microphone is recording.
- feedback: correctedSentence (Band 8+ phrasing), 2-3 lexicalBoost items, 1 ieltsTip.`;
}

export const LUMI_CASUAL_SCHEMA = `{
  "replyText": "Lumi's friendly reply (2-3 compact, mid-length sentences)",
  "mood": "speaking|encouraging|celebrating"
}`;

export const LUMI_CHAT_SCHEMA = `{
  "replyText": "Lumi's reply (2-4 sentences)",
  "mood": "speaking|encouraging|celebrating",
  "feedback": { "correctedSentence": "...", "lexicalBoost": ["...", "..."], "ieltsTip": "..." }
}`;

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