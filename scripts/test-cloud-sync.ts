/**
 * Cloud-sync regression harness.
 *
 * The sync engine used to write UNCONDITIONALLY to Firestore, so a device
 * holding an older copy silently replaced the newest one in the cloud — and a
 * device that no longer had a key wrote a tombstone that DELETED it. The
 * cloud now enforces last-write-wins (see selectWritableEntries).
 *
 * Run with: npm run test:cloud-sync
 */
import { selectWritableEntries, encodeKey, decodeKey } from '../src/auth/cloud-sync';
import { mergeChatHistories } from '../src/utils/chatHistory';

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

const entry = (key: string, updatedAt: number, value: string | null = 'v') => ({
  key,
  value,
  updatedAt,
});

// --- key encoding round-trip ------------------------------------------------
check('encode/decode round-trips', decodeKey(encodeKey('seren_user_eval')) === 'seren_user_eval');
check(
  'encode escapes the characters Firestore forbids',
  !encodeKey('a/b c').includes('/')
);

// --- the last-write-wins gate ----------------------------------------------
const stored = new Map<string, number>([
  ['seren_user_eval', 1000],
  ['seren_eval_history', 2000],
]);

const selected = selectWritableEntries(
  [entry('seren_user_eval', 500), entry('seren_eval_history', 3000), entry('seren_new_key', 10)],
  stored
);
check('a STALE entry is skipped', !selected.some((e) => e.key === 'seren_user_eval'));
check('a NEWER entry is written', selected.some((e) => e.key === 'seren_eval_history'));
check('an unknown key is written', selected.some((e) => e.key === 'seren_new_key'));
check('only the winning entries are written', selected.length === 2);

// A tombstone is just a value-less entry — it must lose to a newer value too,
// otherwise a device that no longer has a key would delete live data.
const tombstone = selectWritableEntries([entry('seren_user_eval', 500, null)], stored);
check('a STALE tombstone is skipped (it cannot delete newer data)', tombstone.length === 0);

const freshTombstone = selectWritableEntries([entry('seren_user_eval', 1500, null)], stored);
check('a FRESH tombstone is written (a real delete propagates)', freshTombstone.length === 1);

// Equal timestamps are written: the value is identical, so it is idempotent.
const equal = selectWritableEntries([entry('seren_user_eval', 1000)], stored);
check('an equal timestamp is written (idempotent)', equal.length === 1);

// The realistic scenario: the desktop app holds an older evaluation than the
// one the browser already uploaded. The old one must NOT win.
const browserUpload = 1_792_643_931_050;
const desktopStale = 1_792_642_185_997;
const merged = selectWritableEntries(
  [entry('seren_user_eval', desktopStale), entry('seren_user_profile', 1_792_643_931_050)],
  new Map([['seren_user_eval', browserUpload]])
);
check('the desktop app\'s stale evaluation is rejected', !merged.some((e) => e.key === 'seren_user_eval'));
check('the browser\'s newer profile still goes through', merged.some((e) => e.key === 'seren_user_profile'));

// --- chat-history merging ---------------------------------------------------
// A thread is a transcript: the one whose LAST MESSAGE is more recent wins.
// A device holding a stale fragment must not win over the current
// conversation, and an empty thread must never erase the other one.
const msg = (id: string, ts: number, text = id) => ({
  id,
  sender: 'user',
  text,
  timestamp: ts,
});

// The real case: the desktop app has the current 37-message interview, the
// browser still holds a 2-message fragment from a session weeks older.
const desktopHistory = JSON.stringify({
  Interview: [msg('d1', 1792592924053), msg('d2', 1792632352837), msg('d3', 1792632352900)],
  'Casual Chat': [],
});
const browserHistory = JSON.stringify({
  Interview: [msg('b1', 1789881133369), msg('b2', 1789881148322)],
  'Casual Chat': [msg('c1', 1792644366364), msg('c2', 1792644366365)],
});

const mergedReal = mergeChatHistories(desktopHistory, browserHistory);
const real = mergedReal ? JSON.parse(mergedReal) : null;
check('the current interview transcript wins over the stale fragment', (real?.Interview || []).length === 3);
check('the winning transcript is the desktop one', (real?.Interview || [])[0]?.id === 'd1');
check('an empty thread never erases the other device\'s thread', (real?.['Casual Chat'] || []).length === 2);

// The other direction: the browser is the current one.
const mergedReverse = mergeChatHistories(browserHistory, desktopHistory);
const reverse = mergedReverse ? JSON.parse(mergedReverse) : null;
check('the merge is symmetric (whoever is current wins)', (reverse?.Interview || []).length === 3);
check('the stale fragment never survives as a separate conversation', (reverse?.Interview || []).every((m: any) => m.id.startsWith('d')));

// Equal recency -> union, nothing lost.
const sameA = JSON.stringify({ Interview: [msg('x1', 500)], 'Casual Chat': [] });
const sameB = JSON.stringify({ Interview: [msg('x2', 500)], 'Casual Chat': [] });
const tie = mergeChatHistories(sameA, sameB);
const tieParsed = tie ? JSON.parse(tie) : null;
check('a tie unions instead of dropping', (tieParsed?.Interview || []).length === 2);
check('a shared message is not duplicated', mergeChatHistories(sameA, sameA) ? JSON.parse(mergeChatHistories(sameA, sameA)!).Interview.length === 1 : false);
check('merging with unparseable input returns null (caller falls back)', mergeChatHistories('not json', browserHistory) === null);
check('merging with nothing local returns null', mergeChatHistories(null, browserHistory) === null);

console.log('');
console.log(fail === 0 ? `ALL PASS (${pass} checks)` : `${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
