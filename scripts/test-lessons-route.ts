/**
 * In-process integration check for the lesson endpoints.
 *
 * Boots the Express app in-memory (no port binding) and drives the routes
 * with real HTTP requests, so the wiring of /api/generate-lessons and the
 * degradation metadata of the evaluation endpoints is verified end-to-end.
 *
 * The LLM is not reachable in CI, so the assertions focus on the parts that
 * must hold REGARDLESS of the provider: the route exists, the request is
 * validated, and the response always states its degradation explicitly.
 *
 * Run with: npx tsx scripts/test-lessons-route.ts
 */
import express from 'express';
import type { AddressInfo } from 'net';
import { Server } from 'http';

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

async function main() {
  const { registerLessonRoutes } = await import('../src/server/routes/lesson');
  const { registerEvaluationRoutes } = await import('../src/server/routes/evaluation');

  const app = express();
  app.use(express.json());
  registerLessonRoutes(app);
  registerEvaluationRoutes(app);

  const server: Server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  const post = async (path: string, body: any) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  };

  // 1. /api/generate-lessons must exist and validate its input.
  const noEvidence = await post('/api/generate-lessons', {
    userProfile: { nickname: 'Test' },
    evaluation: {},
  });
  check('generate-lessons is registered', noEvidence.status !== 404);
  check(
    'generate-lessons rejects a request with no recorded answers',
    noEvidence.status === 400
  );
  check(
    'the rejection explains itself',
    typeof noEvidence.json?.error === 'string' && noEvidence.json.error.length > 0
  );
  check(
    'the rejection carries no roadmap',
    Array.isArray(noEvidence.json?.lessonRoadmap) && noEvidence.json.lessonRoadmap.length === 0
  );

  // 2. A request WITH evidence reaches the generator. Whether a provider is
  //    reachable depends on the environment, so the assertions cover the
  //    invariants that hold in BOTH cases: the response is always well
  //    formed, and the degradation block always states the outcome.
  const learnerSentence = 'If I would have known, I will come.';
  const withEvidence = await post('/api/generate-lessons', {
    userProfile: { nickname: 'Test', targetBand: '7.0' },
    evaluation: {
      pillars: {
        fluency: { score: 6, cefr: 'B2', growthAreas: ['Reduce filler pauses'] },
        lexical: { score: 6, cefr: 'B2', growthAreas: ['Precise collocations'] },
        grammar: { score: 6, cefr: 'B2', growthAreas: ['Subject-verb agreement'] },
        pronunciation: { score: 6, cefr: 'B2', growthAreas: ['Sentence stress'] },
      },
      upgradedExpressions: [
        {
          original: learnerSentence,
          upgraded: 'Had I known, I would have come.',
        },
      ],
      priorityErrors: [
        {
          category: 'Grammar',
          quote: learnerSentence,
          whyWrong: 'Mixing a past hypothetical with a future result.',
          fix: 'Had I known, I would have come.',
        },
      ],
    },
  });
  check('generate-lessons answers a valid request', withEvidence.status === 200);
  check(
    'the response always carries a roadmap array',
    Array.isArray(withEvidence.json?.lessonRoadmap)
  );
  const modules = withEvidence.json?.lessonRoadmap || [];
  const degradation = withEvidence.json?.degradation;
  if (modules.length === 0) {
    // No provider was reachable: the failure MUST be stated explicitly.
    check(
      'a failed generation is reported through the degradation block',
      degradation?.lessonsFailed === true
    );
    check(
      'a failed generation is retryable',
      degradation?.retryable === true
    );
    check(
      'the degradation block explains what happened',
      (degradation?.notes || []).length > 0
    );
  } else {
    // A provider answered: the modules must be grounded in the learner's own
    // words. Whether the roadmap needed a repair depends on the model, so the
    // degradation block must simply be CONSISTENT with the outcome.
    check(
      'a generated module quotes the learner verbatim',
      modules.some((m: any) => m?.exampleError === learnerSentence)
    );
    check(
      'a generated module carries its drill',
      !!modules[0]?.practiceDrill?.prompt
    );
    check(
      'a successful generation is never reported as a failure',
      degradation?.lessonsFailed !== true
    );
    if (degradation) {
      check(
        'a partial generation is reported as partial',
        degradation?.lessonsPartial === true
      );
      check(
        'a partial generation stays retryable',
        degradation?.retryable === true
      );
    }
  }

  // 3. The evaluation endpoints must ALWAYS state their degradation.
  const noSpeech = await post('/api/evaluate-speech', {
    userProfile: { nickname: 'Test' },
    responses: [{ question: 'Hi?', transcript: '' }],
    stats: { totalWords: 0, estimatedWPM: 0 },
  });
  check('evaluate-speech answers a too-short test', noSpeech.status === 200);
  check(
    'a too-short test is flagged as insufficient speech',
    noSpeech.json?.insufficientSpeech === true
  );
  check(
    'the insufficient-speech report is a normal evaluation',
    !!noSpeech.json?.evaluation?.overallCEFR
  );

  server.close();
  console.log('');
  console.log(fail === 0 ? `ALL PASS (${pass} checks)` : `${fail} FAILED (${pass} passed)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Harness crashed:', err);
  process.exit(1);
});
