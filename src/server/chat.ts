import { casualGreetingReply, tutorGreetingReply } from '../utils/greetings';

export function generateFallbackChatResponse(userProfile: any, message: string, mode: string) {
  const nickname = userProfile?.nickname || 'friend';
  const cleanMsg = (message || '').toLowerCase();

  // Casual Chat: always reply as a warm human friend — no grading, no IELTS.
  if (mode === 'Casual Chat') {
    if (cleanMsg.includes('hello') || cleanMsg.includes('hi') || cleanMsg.includes('hey') || cleanMsg.includes('good morning') || cleanMsg.includes('good afternoon')) {
      return {
        replyText: casualGreetingReply(nickname),
        mood: 'greeting',
      };
    }
    // Gentle, natural in-line rephrase when there's an obvious grammatical slip.
    const rephrased =
      /(?:i am go(?:ing|es)|i has|i likes|she go|he go|they is|i no (?:want|like|know)|i am very like)/i.test(cleanMsg)
        ? `Oh nice, so you really enjoy ${cleanMsg.replace(/^(?:i|i am|i'm)\s+(?:really\s+|very\s+|so\s+|too\s+)?(?:am\s+|is\s+|are\s+)?/, '').replace(/^(?:very|really|so|too)\s+/i, '').slice(0, 60)} — tell me more about that!`
        : null;
    return {
      replyText: rephrased || `That sounds really interesting, ${nickname}! What happened next?`,
      mood: 'speaking',
    };
  }

  if (cleanMsg.includes('hello') || cleanMsg.includes('hi') || cleanMsg.includes('hey')) {
    return {
      replyText: tutorGreetingReply(nickname),
      mood: 'greeting',
      feedback: {
        correctedSentence: `Hi Lumi, it's a pleasure to connect with you today.`,
        lexicalBoost: ['Pleasure to connect', 'Delighted to practice', 'Hit the ground running'],
        ieltsTip: 'Start your speaking responses with warmth and confident vocal projection.'
      }
    };
  }

  return {
    replyText: `That is a thoughtful perspective, ${nickname}! Expanding on that, how do you think that situation will evolve over the next ten years?`,
    mood: 'speaking',
    feedback: {
      correctedSentence: message ? `In my perspective, ${message.replace(/^i think/i, '').trim()}.` : 'I firmly believe that this trend will continue to shape our future.',
      lexicalBoost: ['In my perspective', 'Exponential growth', 'Transformative impact'],
      ieltsTip: 'Try using hypothetical structures like "If this trend persists, we might witness..." to score Band 8+.'
    }
  };
}

// Deterministic wrap-up summary for a Custom Lesson. Used when the model hits
// the follow-up cap without delivering a summary, or claims the lesson is
// complete but omits one — honest, generic-but-true content, never fabricated
// specifics.
export function buildDeterministicLessonSummary(
  lessonContext: any,
  rounds: number
): { improved: string[]; toTargetBand: string[] } {
  const ctx = lessonContext || {};
  const focus = ctx.focusArea || ctx.title || 'this speaking skill';
  const improved: string[] = [
    `Completed ${rounds} focused round${rounds === 1 ? '' : 's'} on ${focus}, working with your own answers.`,
  ];
  if (ctx.exampleError) {
    improved.push(`Re-drilled your real slip ("${String(ctx.exampleError).slice(0, 90)}") toward Band 8.5 phrasing.`);
  }
  improved.push('Practiced re-saying corrected answers immediately after feedback — the fastest way to make a fix stick.');

  const toTargetBand: string[] = [
    `Use ${focus} in 2-3 full spoken answers every day until it feels automatic.`,
    "Re-record this lesson's drill and compare your delivery with the Band 9 sample.",
    `Ask Lumi for a fresh Custom Lesson drill on ${focus} to keep the fix sharp under exam pressure.`,
  ];
  return { improved, toTargetBand };
}
