const store = new Map();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};
async function main() {
  let pass = 0, fail = 0;
  const check = (name: string, cond: boolean) => { cond ? pass++ : (fail++, console.log('FAIL:', name)); };
  const { loadSolutionsProgress, saveSolutionsProgress } = await import('../src/autosave/solutionsProgress');

  // solutions playback round-trip
  saveSolutionsProgress({ selectedTestId: 'ielts-19', activePart: 2, finishedTopics: {}, playback: { activeTopicKey: 'ielts-19::2::Travel', currentQIndex: 2, currentSpeaker: 'seren' } });
  const sol = loadSolutionsProgress();
  check('solutions playback resume', sol?.playback?.activeTopicKey === 'ielts-19::2::Travel' && sol?.playback?.currentQIndex === 2 && sol?.playback?.currentSpeaker === 'seren');

  // examiner speaker preserved
  saveSolutionsProgress({ selectedTestId: 'ielts-19', activePart: 1, finishedTopics: {}, playback: { activeTopicKey: 'ielts-19::1::Home', currentQIndex: 0, currentSpeaker: 'examiner' } });
  check('solutions examiner speaker', loadSolutionsProgress()?.playback?.currentSpeaker === 'examiner');

  // stop clears playback position
  saveSolutionsProgress({ selectedTestId: 'ielts-19', activePart: 1, finishedTopics: {}, playback: null });
  check('stop clears playback', loadSolutionsProgress()?.playback === null);

  // invalid playback speaker → null
  (globalThis as any).localStorage.setItem('seren_autosave_solutions', JSON.stringify({ selectedTestId: 'x', activePart: 1, finishedTopics: {}, playback: { activeTopicKey: 'a::1::b', currentQIndex: 0, currentSpeaker: 'narrator' } }));
  check('invalid speaker→null', loadSolutionsProgress()?.playback === null);

  // cross-test mismatch → null
  (globalThis as any).localStorage.setItem('seren_autosave_solutions', JSON.stringify({ selectedTestId: 'ielts-19', activePart: 2, finishedTopics: {}, playback: { activeTopicKey: 'other-test::2::x', currentQIndex: 0, currentSpeaker: 'seren' } }));
  check('cross-test mismatch→null', loadSolutionsProgress()?.playback === null);

  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
main();
