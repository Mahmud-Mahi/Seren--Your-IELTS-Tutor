/**
 * Regression harness for the Edge TTS transport.
 *
 * Bug: every /api/tts request opened a brand-new WebSocket to Microsoft's
 * Edge endpoint. Two things went wrong with that:
 *
 *  1. Node's "Happy Eyeballs" (autoSelectFamily, on by default since
 *     Node 20) raced the A and AAAA records of api.msedgeservices.com.
 *     This host has no IPv6 route (ENETUNREACH) and the IPv4 connect needs
 *     ~400ms, but Happy Eyeballs abandoned the IPv4 attempt after 250ms
 *     (autoSelectFamilyAttemptTimeout). The race collapsed into a Node
 *     AggregateError with code ETIMEDOUT and an EMPTY message, which the
 *     server logged as:
 *
 *       [TTS] attempt 1/3 failed (ETIMEDOUT): Edge TTS WebSocket error:  (code=ETIMEDOUT)
 *
 *  2. Reconnecting for every utterance also tripped Microsoft's rate
 *     limiter (HTTP 429) and added ~1.5s of pure connect latency to
 *     every single spoken line.
 *
 * The fix pins the connection to a single address and keeps ONE warm
 * socket per voice, reused across utterances.
 *
 * Run with: npx tsx scripts/test-tts-connection.ts
 */
import { PassThrough } from 'stream';
import type { Response } from 'express';
import { synthesizeToResponse, closeAllTtsConnections } from '../src/server/tts';

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

/** Minimal Express-Response stand-in that records the audio it receives. */
function makeResponse() {
  const res: any = new PassThrough();
  res.setHeader = () => res;
  res.status = () => res;
  res.json = () => res;
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.bytes = () => chunks.reduce((n, c) => n + c.length, 0);
  return res as Response & { bytes: () => number };
}

const VOICE = 'en-US-JennyNeural';
const LINE = 'This is a regression test of the neural text to speech transport.';

async function speak(text = LINE, voice = VOICE) {
  const res = makeResponse();
  await synthesizeToResponse(res as any, text, voice, 1, 1.06);
  return res.bytes();
}

(async () => {
  console.log('--- 1. a single utterance produces audio ---');
  const first = await speak();
  check(`first utterance produced audio (${first} bytes)`, first > 1000);

  console.log('\n--- 2. repeated utterances reuse one warm connection ---');
  const timings: number[] = [];
  let bytes = 0;
  let failures = 0;
  for (let i = 0; i < 8; i++) {
    const t0 = Date.now();
    try {
      bytes += await speak(`Utterance number ${i} of the connection reuse test.`);
    } catch (err: any) {
      failures++;
      console.log(`   iteration ${i} failed: ${err?.message || err}`);
    }
    timings.push(Date.now() - t0);
  }
  check(`all 8 follow-up utterances succeeded (${failures} failures)`, failures === 0);
  check(`every utterance produced audio (${bytes} bytes)`, bytes > 8000);

  // The whole point of pooling: no per-utterance TLS handshake. A fresh
  // connection costs ~1.5s; a warm one ~0.5s.
  const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
  console.log(`   average utterance: ${Math.round(avg)}ms (${timings.join(', ')}ms)`);
  check(`warm utterances are fast (<1200ms avg, was ~1700ms)`, avg < 1200);

  console.log('\n--- 3. a second voice gets its own connection ---');
  try {
    const other = await speak('Testing a second neural voice.', 'en-GB-SoniaNeural');
    check(`second voice produced audio (${other} bytes)`, other > 1000);
  } catch (err: any) {
    check(`second voice produced audio (${err?.message || err})`, false);
  }

  console.log('\n--- 4. the original voice still works afterwards ---');
  try {
    const back = await speak('Back to the original voice after switching.');
    check(`original voice still works (${back} bytes)`, back > 1000);
  } catch (err: any) {
    check(`original voice still works (${err?.message || err})`, false);
  }

  console.log('\n--- 5. an aborted request does not poison the pool ---');
  // The browser aborts the request whenever a newer utterance starts. The
  // socket must survive that and serve the next request.
  const abortRes = makeResponse();
  const aborting = synthesizeToResponse(abortRes as any, 'This request is aborted.', VOICE, 1, 1.06);
  await new Promise((r) => setTimeout(r, 150));
  abortRes.destroy();
  await aborting.catch(() => {});
  try {
    const after = await speak('The utterance after an aborted request.');
    check(`pool survives an aborted request (${after} bytes)`, after > 1000);
  } catch (err: any) {
    check(`pool survives an aborted request (${err?.message || err})`, false);
  }

  console.log('\n--- 6. an abort does not corrupt the NEXT utterance ---');
  // The aborted turn is never completed on the server, so the following
  // request could in principle receive a mix of the two streams. The same
  // sentence must still come back byte-for-byte identical.
  const probe = 'Integrity check sentence for the neural voice.';
  const reference = await speak(probe);
  for (let i = 0; i < 3; i++) {
    const noiseRes = makeResponse();
    const noise = synthesizeToResponse(noiseRes as any, 'A completely different sentence.', VOICE, 1, 1.06);
    await new Promise((r) => setTimeout(r, 120));
    noiseRes.destroy();
    await noise.catch(() => {});
    const again = await speak(probe);
    check(`utterance after an abort is byte-identical to the reference (${again} vs ${reference})`, again === reference);
  }

  console.log('\n--- 7. empty text is rejected without touching the network ---');
  const emptyRes = makeResponse();
  let emptyRejected = false;
  try {
    await synthesizeToResponse(emptyRes as any, '   ', VOICE, 1, 1.06);
  } catch {
    emptyRejected = true;
  }
  check('empty text is rejected', emptyRejected);

  closeAllTtsConnections();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('harness crashed:', err);
  process.exit(1);
});