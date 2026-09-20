import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Speech,
  Play,
  Pause,
  Square,
  Mic,
  Sparkles,
  Lightbulb,
  CheckCircle,
  BookOpen,
} from 'lucide-react';
import { UserProfile, DiagnosticQuestion, SerenMood } from '../types';
import {
  CAMBRIDGE_TESTS,
  getCambridgeTestById,
  CambridgeTestDefinition,
} from '../data/cambridgeTests';
import { SerenAvatar } from './SerenAvatar';
import { serenVoice, soundFX } from '../utils/speech';
import { ScrollArea } from './ScrollArea';
import { SpokenText } from './SpokenText';
import { useShortcut, useShortcutHint } from '../hooks/useShortcut';

interface CambridgeSolutionsProps {
  userProfile: UserProfile;
  voiceEnabled: boolean;
  onToggleVoice: () => void;
}

/**
 * Cambridge Solutions — the "listen & learn" tab.
 *
 * A live Q&A class built on the Cambridge question bank. A MALE neural voice
 * (the examiner) reads every question aloud — the question shows up in the
 * question div — then Seren answers like an IELTS examinee by speaking the
 * Band 8+ sample answer from the question bank, which is shown below the
 * question. After a short pause the examiner asks the next question and the
 * loop continues until the last question & response of the topic. Every topic
 * carries its own Play/Pause control, and a whole part lives in one scroll
 * area so the user can read along with everything at a glance.
 */

// Fixed male neural voice for the examiner (IELTS-style British examiner).
// Seren's answers keep the app's configured voice so the two roles stay
// audibly distinct.
const EXAMINER_VOICE = 'en-GB-RyanNeural';

// Breathing room: examiner → Seren's answer, and answer → next question.
const TURN_PAUSE_MS = 2500;

const PART_TITLES: Record<number, string> = {
  1: 'Introduction & Lifestyle',
  2: 'Cue Card & Long Turn',
  3: 'Two-Way Discussion',
};

const PART_DESCRIPTIONS: Record<number, string> = {
  1: 'Short, personal answers — notice how each reply opens directly, adds one example and closes naturally.',
  2: 'One long turn — listen to how the sample stays structured from start to finish without drifting off topic.',
  3: 'Abstract discussion — opinions are balanced, supported with reasons and pushed one step further.',
};

interface TopicGroup {
  topic: string;
  questions: DiagnosticQuestion[];
}

const slugTopicKey = (value: string) => value.replace(/[^a-z0-9]+/gi, '-').toLowerCase();

export const CambridgeSolutions: React.FC<CambridgeSolutionsProps> = ({
  userProfile,
  voiceEnabled,
  onToggleVoice,
}) => {
  const [selectedTestId, setSelectedTestId] = useState<string>(CAMBRIDGE_TESTS[0]?.id || '');
  const [activePart, setActivePart] = useState<1 | 2 | 3>(1);

  // Live session state (mirrors the ref-driven loop below for rendering).
  const [activeTopicKey, setActiveTopicKey] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentQIndex, setCurrentQIndex] = useState(-1);
  const [currentSpeaker, setCurrentSpeaker] = useState<'examiner' | 'seren' | null>(null);
  const [finishedTopics, setFinishedTopics] = useState<Record<string, boolean>>({});

  // The playback loop lives in refs so the async session never closes over
  // stale UI state. `genRef` is a run token: bumping it invalidates every
  // pending await of a running session (stop / replace / unmount).
  const genRef = useRef(0);
  const activeTopicRef = useRef<string | null>(null);
  const pausedRef = useRef(false);

  const selectedTest: CambridgeTestDefinition | null = useMemo(
    () => getCambridgeTestById(selectedTestId),
    [selectedTestId]
  );

  // All topics of the active part, in question-bank order.
  const topics: TopicGroup[] = useMemo(() => {
    const questions = (selectedTest?.questions || []).filter((q) => q.part === activePart);
    const byTopic = new Map<string, DiagnosticQuestion[]>();
    for (const q of questions) {
      const key = q.topic || 'General';
      const bucket = byTopic.get(key);
      if (bucket) bucket.push(q);
      else byTopic.set(key, [q]);
    }
    return Array.from(byTopic.entries()).map(([topic, qs]) => ({ topic, questions: qs }));
  }, [selectedTest, activePart]);

  const topicKeyOf = (topic: string) => `${selectedTest?.id || 'test'}::${activePart}::${topic}`;

  // The per-part cue tips (identical for every question of the part) — shown
  // in the "What to notice" box directly under Seren's speech box.
  const partCueTips: string[] = useMemo(
    () => (selectedTest?.questions || []).find((q) => q.part === activePart)?.cueTips || [],
    [selectedTest, activePart]
  );

  // ---------------------------------------------------------------------------
  // Lifecycle guards
  // ---------------------------------------------------------------------------
  useEffect(() => {
    // Leaving the tab must kill any running session.
    return () => {
      genRef.current++;
      activeTopicRef.current = null;
      pausedRef.current = false;
      serenVoice.stop();
    };
  }, []);

  // Seren greets the user out loud when the tab opens — explaining the flow
  // by voice instead of only showing it in the speech box. Starting a session
  // (which calls serenVoice.stop()) or leaving the tab cuts it off cleanly.
  useEffect(() => {
    if (!voiceEnabled) return;
    void serenVoice.speak(
      `Hey ${userProfile.nickname}! Pick a topic below and press Play — the examiner asks, I answer, and you pick up the phrasing, pacing and idea.`
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // Playback helpers
  // ---------------------------------------------------------------------------
  const resetPlaybackUi = () => {
    setActiveTopicKey(null);
    setIsPlaying(false);
    setCurrentQIndex(-1);
    setCurrentSpeaker(null);
  };

  const stopAll = () => {
    genRef.current++;
    activeTopicRef.current = null;
    pausedRef.current = false;
    serenVoice.stop();
    resetPlaybackUi();
  };

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const waitWhilePaused = async (gen: number, topicKey: string) => {
    while (genRef.current === gen && activeTopicRef.current === topicKey && pausedRef.current) {
      await sleep(200);
    }
  };

  // Interruptible gap between turns. Returns false only when the whole run was
  // invalidated (stopped / replaced / unmounted) — pausing simply suspends it
  // and the remaining pause time resumes afterwards.
  const holdGap = async (ms: number, gen: number, topicKey: string): Promise<boolean> => {
    let remaining = ms;
    while (remaining > 0) {
      if (genRef.current !== gen || activeTopicRef.current !== topicKey) return false;
      if (pausedRef.current) {
        await waitWhilePaused(gen, topicKey);
        if (genRef.current !== gen || activeTopicRef.current !== topicKey) return false;
        continue;
      }
      await sleep(100);
      remaining -= 100;
    }
    return true;
  };

  // One spoken turn. If the user pauses mid-turn the utterance is cut short
  // and replayed from the top once the session resumes.
  const speakTurn = async (
    voice: string | undefined,
    text: string,
    gen: number,
    topicKey: string
  ): Promise<void> => {
    while (genRef.current === gen && activeTopicRef.current === topicKey) {
      if (pausedRef.current) {
        await waitWhilePaused(gen, topicKey);
        continue;
      }
      await serenVoice.speak(text, { voice });
      if (genRef.current !== gen || activeTopicRef.current !== topicKey) return;
      if (pausedRef.current) continue; // paused during the turn → replay it
      return;
    }
  };

  // ---------------------------------------------------------------------------
  // The live Q&A loop for one topic
  // ---------------------------------------------------------------------------
  const runSession = async (topicKey: string, questions: DiagnosticQuestion[]) => {
    const gen = ++genRef.current;
    activeTopicRef.current = topicKey;
    pausedRef.current = false;

    setActiveTopicKey(topicKey);
    setIsPlaying(true);
    setFinishedTopics((prev) => ({ ...prev, [topicKey]: false }));
    setCurrentQIndex(-1);
    setCurrentSpeaker(null);
    serenVoice.stop();
    soundFX.playChime('start');

    for (let i = 0; i < questions.length; i++) {
      if (genRef.current !== gen || activeTopicRef.current !== topicKey) return;
      await waitWhilePaused(gen, topicKey);
      if (genRef.current !== gen || activeTopicRef.current !== topicKey) return;

      const q = questions[i];

      // 1. The examiner asks the question (male neural voice).
      setCurrentQIndex(i);
      setCurrentSpeaker('examiner');
      await speakTurn(EXAMINER_VOICE, q.question, gen, topicKey);
      if (genRef.current !== gen || activeTopicRef.current !== topicKey) return;

      // 2. A little pause, then Seren reads the sample answer from the bank.
      if (!(await holdGap(TURN_PAUSE_MS, gen, topicKey))) return;
      setCurrentSpeaker('seren');
      await speakTurn(
        undefined,
        q.sampleAnswer?.trim() || 'Let me gather my thoughts for a moment.',
        gen,
        topicKey
      );
      if (genRef.current !== gen || activeTopicRef.current !== topicKey) return;

      // 3. Breathe, then continue the loop with the next question of the topic.
      if (!(await holdGap(TURN_PAUSE_MS, gen, topicKey))) return;
    }

    if (genRef.current !== gen || activeTopicRef.current !== topicKey) return;
    serenVoice.stop();
    activeTopicRef.current = null;
    setFinishedTopics((prev) => ({ ...prev, [topicKey]: true }));
    resetPlaybackUi();
    soundFX.playChime('success');
  };

  const handlePlayPause = (topicKey: string, questions: DiagnosticQuestion[]) => {
    if (!voiceEnabled || questions.length === 0) return;
    if (activeTopicRef.current === topicKey) {
      if (pausedRef.current) {
        // Resume
        pausedRef.current = false;
        setIsPlaying(true);
      } else {
        // Pause — cut the current utterance; the loop replays it on resume.
        pausedRef.current = true;
        serenVoice.stop();
        setIsPlaying(false);
      }
      return;
    }
    void runSession(topicKey, questions);
  };

  const handleStop = (topicKey: string) => {
    if (activeTopicRef.current !== topicKey) return;
    stopAll();
  };

  // ---------------------------------------------------------------------------
  // Keyboard shortcuts (bindings are user-customizable in Settings)
  // ---------------------------------------------------------------------------
  const pauseShortcutHint = useShortcutHint('solutions.playPause');

  // Pause / resume the running session. With nothing running, the shortcut
  // starts the first topic of the current part so the whole tab is playable
  // from the keyboard alone.
  useShortcut('solutions.playPause', () => {
    if (!voiceEnabled) return;
    const activeKey = activeTopicRef.current;
    if (activeKey) {
      const activeGroup = topics.find((group) => topicKeyOf(group.topic) === activeKey);
      if (activeGroup) handlePlayPause(activeKey, activeGroup.questions);
      return;
    }
    const first = topics[0];
    if (first && first.questions.length > 0) handlePlayPause(topicKeyOf(first.topic), first.questions);
  });

  useShortcut('solutions.stop', () => {
    if (activeTopicRef.current) stopAll();
  });

  const handleSelectTest = (id: string) => {
    stopAll();
    setFinishedTopics({});
    setSelectedTestId(id);
  };

  const handleSelectPart = (part: 1 | 2 | 3) => {
    if (part === activePart) return;
    stopAll();
    setActivePart(part);
  };

  // Voice muted → cut the idle greeting instantly, and stop any running
  // session too (the play button is also disabled while muted).
  useEffect(() => {
    if (!voiceEnabled) {
      serenVoice.stop();
      if (activeTopicRef.current) {
        stopAll();
      }
    }
  }, [voiceEnabled]);

  // Keep the currently spoken Q&A row visible inside the part scroll area.
  useEffect(() => {
    if (!activeTopicKey || currentQIndex < 0) return;
    const row = document.getElementById(`sols-row-${slugTopicKey(activeTopicKey)}-${currentQIndex}`);
    row?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [activeTopicKey, currentQIndex]);

  // ---------------------------------------------------------------------------
  // Derived stage state for the Seren avatar
  // ---------------------------------------------------------------------------
  const stageMood: SerenMood = activeTopicKey
    ? currentSpeaker === 'seren' && isPlaying
      ? 'speaking'
      : 'encouraging'
    : 'greeting';

  // The speech box always shows the greeting — during playback the live
  // question/answer text is intentionally not revealed there; what to listen
  // for is shown by the "What to notice" box under the avatar instead.
  const stageSubtitle = `Hey ${userProfile.nickname}! Pick a topic below and press Play — the examiner asks, I answer, and you pick up the phrasing, pacing and idea.`;

  const playButtonTitle = (isActive: boolean, isDone: boolean) =>
    !voiceEnabled
      ? 'Voice is muted — enable audio (speaker icon) to play the session'
      : isActive
      ? isPlaying
        ? 'Pause the session'
        : 'Resume the session'
      : isDone
      ? 'Replay this topic'
      : 'Play this topic — examiner asks, Seren answers live';

  return (
    <div className="w-full max-w-6xl mx-auto flex flex-col flex-1 min-h-0 space-y-3 sm:space-y-4">
      {/* Compact header banner — P1/P2/P3 + test selection inline, matching the
          Cambridge Test / 1v1 tabs so the scroll area gets the space below */}
      <div className="shrink-0 flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 sm:p-3.5 rounded-2xl bg-[#21222c]/80 border border-[#44475a] backdrop-blur-md shadow-lg">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 shrink-0 rounded-xl bg-[#bd93f9]/20 border border-[#bd93f9]/40 flex items-center justify-center text-[#bd93f9]">
            <Speech className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-bold text-[#f8f8f2] leading-tight">
              Cambridge Solutions <span className="text-[#8be9fd]">·</span> Live with Seren
            </h2>
            <p className="text-xs text-[#6272a4] mt-0.5 truncate">
              Part {activePart}: {PART_TITLES[activePart]} — examiner asks, Seren answers live
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {([1, 2, 3] as const).map((part) => {
            const qCount = (selectedTest?.questions || []).filter((q) => q.part === part).length;
            return (
              <button
                key={`solutions-part-${part}`}
                type="button"
                onClick={() => handleSelectPart(part)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all whitespace-nowrap ${
                  part === activePart
                    ? 'bg-[#bd93f9]/15 border-[#bd93f9] text-[#bd93f9] shadow-md shadow-[#bd93f9]/10'
                    : 'bg-[#282a36] border-[#44475a] text-[#6272a4] hover:text-[#f8f8f2] hover:border-[#6272a4]'
                }`}
                title={`Part ${part}: ${PART_TITLES[part]} — ${PART_DESCRIPTIONS[part]} (${qCount} questions)`}
              >
                <span className="font-mono opacity-80">{part}</span>
                <span>Part {part}</span>
              </button>
            );
          })}
          <select
            id="solutions-test-select"
            value={selectedTestId}
            onChange={(e) => handleSelectTest(e.target.value)}
            className="bg-[#282a36] text-[#f8f8f2] border border-[#44475a] rounded-lg px-3 py-1.5 text-xs font-semibold focus:outline-none focus:border-[#bd93f9] cursor-pointer"
          >
            {CAMBRIDGE_TESTS.map((t) => (
              <option key={t.id} value={t.id} className="bg-[#282a36]">
                {t.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Main grid: Seren stage + the part's scroll area */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 sm:gap-5 items-stretch flex-1 min-h-0">
        {/* Seren stage (4 cols) — height-capped to match the Q&A session */}
        <div className="lg:col-span-4 flex flex-col min-h-0 lg:max-h-[calc(100dvh-9rem)]">
          {/* Seren avatar section */}
          <div className="shrink-0">
            <SerenAvatar
              mood={stageMood}
              currentSpeech={stageSubtitle}
              speaking={!!activeTopicKey && isPlaying && currentSpeaker === 'seren'}
              isUserSpeaking={false}
              voiceEnabled={voiceEnabled}
              onToggleVoice={onToggleVoice}
              autoSpeak={false}
              idleMood="greeting"
            />
          </div>

          {/* The "What to notice" box, directly under Seren's speech box */}
          {partCueTips.length > 0 && (
            <div className="mt-3 shrink-0 flex items-start gap-2 rounded-xl bg-[#ffb86c]/10 border border-[#ffb86c]/30 p-3">
              <Lightbulb className="w-4 h-4 text-[#ffb86c] shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-wider text-[#ffb86c] mb-1">
                  What to notice in these answers
                </p>
                <ul className="text-xs text-[#f8f8f2]/80 list-disc list-inside space-y-0.5">
                  {partCueTips.map((tip, ti) => (
                    <li key={`sols-tip-${ti}`}>{tip}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {/* Spacer to fill remaining height and match the right panel */}
          <div className="flex-1 min-h-0" />
        </div>

          {/* Right column (8 cols) — the Q&A session fills the page height */}
          <div className="lg:col-span-8 flex flex-col min-h-0 min-w-0 lg:max-h-[calc(100dvh-9rem)]">
            {/* Scroll area: every topic of this part, with all Q&As at once.
                Height stretches to match the Seren column on the left so both
                columns end at the same line and the right column is fully used. */}
            <ScrollArea className="flex-1 min-h-0 pr-2 pb-4 space-y-5 rounded-2xl">
              {topics.length === 0 && (
                <div className="rounded-2xl border border-dashed border-[#44475a] p-8 text-center">
                  <BookOpen className="w-8 h-8 mx-auto text-[#6272a4] mb-2" />
                  <p className="text-sm text-[#6272a4]">
                    No Part {activePart} questions in this test yet — try another test or part.
                  </p>
                </div>
              )}

              {topics.map((group) => {
                const topicKey = topicKeyOf(group.topic);
                const isActive = activeTopicKey === topicKey;
                const isDone = !!finishedTopics[topicKey];
                return (
                  <div
                    key={group.topic}
                    className={`rounded-2xl border bg-[#21222c]/70 transition-all ${
                      isActive ? 'border-[#bd93f9]/60 shadow-lg shadow-[#bd93f9]/10' : 'border-[#44475a]'
                    }`}
                  >
                    {/* Topic header — reference badge row on top, controls right */}
                    <div className="flex flex-wrap items-start justify-between gap-3 p-4 sm:p-5 border-b border-[#44475a]/70">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
                          <span className="px-2 py-0.5 rounded-md bg-[#44475a]/70 border border-[#6272a4]/40 text-[10px] font-bold uppercase tracking-wider text-[#8be9fd]">
                            {selectedTest?.label || 'Cambridge Test'}
                          </span>
                          <span className="text-[#6272a4] text-[10px]">•</span>
                          <span className="px-2 py-0.5 rounded-md bg-[#bd93f9]/15 border border-[#bd93f9]/40 text-[10px] font-bold uppercase tracking-wider text-[#bd93f9]">
                            Part {activePart}
                          </span>
                          <span className="text-[#6272a4] text-[10px]">•</span>
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-[#6272a4]">
                            {PART_TITLES[activePart]}
                          </span>
                        </div>
                        <h3 className="text-base sm:text-lg font-bold text-[#f8f8f2] leading-snug">
                          {group.topic}
                        </h3>
                        <p className="text-[11px] text-[#6272a4] mt-0.5">
                          {isActive
                            ? `Question ${Math.min(currentQIndex + 1, group.questions.length)} of ${group.questions.length} · ${
                                isPlaying
                                  ? currentSpeaker === 'examiner'
                                    ? 'examiner is asking…'
                                    : currentSpeaker === 'seren'
                                    ? 'Seren is answering…'
                                    : 'getting ready…'
                                  : 'paused'
                              }`
                            : `${group.questions.length} question${group.questions.length !== 1 ? 's' : ''} · examiner asks, Seren answers live`}
                        </p>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {isDone && !isActive && (
                          <span className="hidden sm:flex items-center gap-1 px-2 py-1 rounded-lg bg-[#50fa7b]/15 border border-[#50fa7b]/40 text-[#50fa7b] text-[10px] font-bold uppercase tracking-wider">
                            <CheckCircle className="w-3 h-3" /> Completed
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => handlePlayPause(topicKey, group.questions)}
                          disabled={!voiceEnabled || group.questions.length === 0}
                          title={`${playButtonTitle(isActive, isDone)}${
                            pauseShortcutHint ? ` (${pauseShortcutHint})` : ''
                          }`}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all disabled:opacity-40 disabled:pointer-events-none ${
                            isActive && isPlaying
                              ? 'bg-[#ffb86c]/15 border border-[#ffb86c]/50 text-[#ffb86c] hover:bg-[#ffb86c]/25'
                              : 'bg-[#50fa7b]/15 border border-[#50fa7b]/50 text-[#50fa7b] hover:bg-[#50fa7b]/25'
                          }`}
                        >
                          {isActive && isPlaying ? (
                            <Pause className="w-3.5 h-3.5" />
                          ) : (
                            <Play className="w-3.5 h-3.5" />
                          )}
                          <span>
                            {!isActive ? (isDone ? 'Replay' : 'Play') : isPlaying ? 'Pause' : 'Resume'}
                          </span>
                        </button>
                        {isActive && (
                          <button
                            type="button"
                            onClick={() => handleStop(topicKey)}
                            title="Stop session"
                            className="p-2 rounded-lg border border-[#ff5555]/40 bg-[#ff5555]/10 text-[#ff5555] hover:bg-[#ff5555]/20 transition-all"
                          >
                            <Square className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Every question of the topic with its sample answer below */}
                    <div className="p-4 sm:p-5 space-y-4">
                      {group.questions.map((q, qi) => {
                        const rowActive = isActive && currentQIndex === qi;
                        return (
                          <div
                            key={q.id}
                            id={`sols-row-${slugTopicKey(topicKey)}-${qi}`}
                            className={`rounded-xl border transition-all ${
                              rowActive
                                ? 'border-[#bd93f9]/70 bg-[#bd93f9]/10 shadow-md shadow-[#bd93f9]/10'
                                : 'border-[#44475a]/70 bg-[#282a36]/60'
                            }`}
                          >
                            {/* The question div */}
                            <div className="flex items-start gap-2.5 p-3">
                              <span
                                className={`shrink-0 mt-0.5 w-6 h-6 rounded-lg flex items-center justify-center border transition-colors ${
                                  rowActive && currentSpeaker === 'examiner'
                                    ? 'bg-[#8be9fd] text-[#282a36] border-[#8be9fd]'
                                    : 'bg-[#8be9fd]/15 text-[#8be9fd] border-[#8be9fd]/40'
                                }`}
                              >
                                <Mic className="w-3.5 h-3.5" />
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 mb-0.5">
                                  <p className="text-[10px] font-bold uppercase tracking-wider text-[#8be9fd]">
                                    Examiner — Question {qi + 1}
                                  </p>
                                  {rowActive && isPlaying && currentSpeaker === 'examiner' && (
                                    <span className="px-1.5 py-0.5 rounded bg-[#8be9fd]/20 text-[#8be9fd] text-[9px] font-bold uppercase tracking-wider animate-pulse">
                                      Asking now
                                    </span>
                                  )}
                                </div>
                                <p className="text-sm text-[#f8f8f2] leading-relaxed">
                                  <SpokenText
                                    text={q.question}
                                    spoken={rowActive && isPlaying && currentSpeaker === 'examiner'}
                                  />
                                </p>
                              </div>
                            </div>

                            {/* The sample answer, shown below the question */}
                            <div className="flex items-start gap-2.5 p-3 pt-0">
                              <span
                                className={`shrink-0 mt-0.5 w-6 h-6 rounded-lg flex items-center justify-center border transition-colors ${
                                  rowActive && currentSpeaker === 'seren'
                                    ? 'bg-[#ff79c6] text-[#282a36] border-[#ff79c6]'
                                    : 'bg-[#ff79c6]/15 text-[#ff79c6] border-[#ff79c6]/40'
                                }`}
                              >
                                <Sparkles className="w-3.5 h-3.5" />
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 mb-0.5">
                                  <p className="text-[10px] font-bold uppercase tracking-wider text-[#ff79c6]">
                                    Seren — Sample Answer
                                  </p>
                                  {rowActive && isPlaying && currentSpeaker === 'seren' && (
                                    <span className="px-1.5 py-0.5 rounded bg-[#ff79c6]/20 text-[#ff79c6] text-[9px] font-bold uppercase tracking-wider animate-pulse">
                                      Answering now
                                    </span>
                                  )}
                                  {rowActive && !isPlaying && (
                                    <span className="px-1.5 py-0.5 rounded bg-[#ffb86c]/20 text-[#ffb86c] text-[9px] font-bold uppercase tracking-wider">
                                      Paused
                                    </span>
                                  )}
                                </div>
                                <p className="text-sm text-[#f8f8f2]/85 leading-relaxed">
                                  <SpokenText
                                    text={q.sampleAnswer || '—'}
                                    spoken={rowActive && isPlaying && currentSpeaker === 'seren'}
                                  />
                                </p>
                              </div>
                            </div>

                          </div>
                        );
                      })}
                    </div>


                  </div>
                );
              })}

            </ScrollArea>

          </div>
        </div>

    </div>
  );
};
