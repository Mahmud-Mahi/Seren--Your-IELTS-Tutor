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
import { UserProfile, DiagnosticQuestion, LumiMood } from '../types';
import {
  CAMBRIDGE_TESTS,
  getCambridgeTestById,
  CambridgeTestDefinition,
} from '../data/cambridgeTests';
import { LumiAvatar } from './LumiAvatar';
import { lumiVoice, soundFX } from '../utils/speech';

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
 * question div — then Lumi answers like an IELTS examinee by speaking the
 * Band 8+ sample answer from the question bank, which is shown below the
 * question. After a short pause the examiner asks the next question and the
 * loop continues until the last question & response of the topic. Every topic
 * carries its own Play/Pause control, and a whole part lives in one scroll
 * area so the user can read along with everything at a glance.
 */

// Fixed male neural voice for the examiner (IELTS-style British examiner).
// Lumi's answers keep the app's configured voice so the two roles stay
// audibly distinct.
const EXAMINER_VOICE = 'en-GB-RyanNeural';

// Breathing room: examiner → Lumi's answer, and answer → next question.
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

const trimSubtitle = (text: string) =>
  text.length > 260 ? `${text.slice(0, 260).trimEnd()}…` : text;

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
  const [currentSpeaker, setCurrentSpeaker] = useState<'examiner' | 'lumi' | null>(null);
  const [currentSpokenText, setCurrentSpokenText] = useState('');
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

  // ---------------------------------------------------------------------------
  // Lifecycle guards
  // ---------------------------------------------------------------------------
  useEffect(() => {
    // Leaving the tab must kill any running session.
    return () => {
      genRef.current++;
      activeTopicRef.current = null;
      pausedRef.current = false;
      lumiVoice.stop();
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Playback helpers
  // ---------------------------------------------------------------------------
  const resetPlaybackUi = () => {
    setActiveTopicKey(null);
    setIsPlaying(false);
    setCurrentQIndex(-1);
    setCurrentSpeaker(null);
    setCurrentSpokenText('');
  };

  const stopAll = () => {
    genRef.current++;
    activeTopicRef.current = null;
    pausedRef.current = false;
    lumiVoice.stop();
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
      setCurrentSpokenText(text);
      await lumiVoice.speak(text, { voice });
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
    setCurrentSpokenText('');
    lumiVoice.stop();
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

      // 2. A little pause, then Lumi reads the sample answer from the bank.
      if (!(await holdGap(TURN_PAUSE_MS, gen, topicKey))) return;
      setCurrentSpeaker('lumi');
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
    lumiVoice.stop();
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
        lumiVoice.stop();
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

  // Voice muted mid-session → stop immediately (the play button is also
  // disabled while muted).
  useEffect(() => {
    if (!voiceEnabled && activeTopicRef.current) {
      stopAll();
    }
  }, [voiceEnabled]);

  // Keep the currently spoken Q&A row visible inside the part scroll area.
  useEffect(() => {
    if (!activeTopicKey || currentQIndex < 0) return;
    const row = document.getElementById(`sols-row-${slugTopicKey(activeTopicKey)}-${currentQIndex}`);
    row?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [activeTopicKey, currentQIndex]);

  // ---------------------------------------------------------------------------
  // Derived stage state for the Lumi avatar
  // ---------------------------------------------------------------------------
  const stageMood: LumiMood = activeTopicKey
    ? currentSpeaker === 'lumi' && isPlaying
      ? 'speaking'
      : 'encouraging'
    : 'greeting';

  const stageSubtitle = activeTopicKey
    ? trimSubtitle(currentSpokenText)
    : `Hi ${userProfile.nickname}! Pick a topic below and press Play — the examiner asks, I answer, and you pick up the phrasing, pacing and fluency.`;

  const playButtonTitle = (isActive: boolean, isDone: boolean) =>
    !voiceEnabled
      ? 'Voice is muted — enable audio (speaker icon) to play the session'
      : isActive
      ? isPlaying
        ? 'Pause the session'
        : 'Resume the session'
      : isDone
      ? 'Replay this topic'
      : 'Play this topic — examiner asks, Lumi answers live';

  return (
    <div className="space-y-5">
        {/* Tab header: name, explainer, test picker */}
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-2xl bg-gradient-to-tr from-[#bd93f9]/30 to-[#8be9fd]/30 border border-[#bd93f9]/40 text-[#bd93f9] shrink-0">
              <Speech className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl sm:text-2xl font-extrabold text-[#f8f8f2] tracking-tight">
                Cambridge Solutions <span className="text-[#8be9fd]">·</span> Live with Lumi
              </h1>
              <p className="text-xs sm:text-sm text-[#6272a4] max-w-2xl leading-relaxed">
                A live Q&amp;A class on the Cambridge question bank: the examiner reads each
                question in a male voice, Lumi answers like an IELTS examinee with the Band 8+
                sample — watch the phrasing, pacing and fluency you should copy.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <label
              htmlFor="solutions-test-select"
              className="text-[10px] font-bold uppercase tracking-widest text-[#6272a4]"
            >
              Test
            </label>
            <select
              id="solutions-test-select"
              value={selectedTestId}
              onChange={(e) => handleSelectTest(e.target.value)}
              className="bg-[#282a36] text-[#f8f8f2] border border-[#44475a] rounded-xl px-3 py-2 text-sm font-semibold focus:outline-none focus:border-[#bd93f9] cursor-pointer"
            >
              {CAMBRIDGE_TESTS.map((t) => (
                <option key={t.id} value={t.id} className="bg-[#282a36]">
                  {t.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Main grid: Lumi stage + the part's scroll area */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 sm:gap-6 items-start">
          {/* Lumi stage (4 cols) */}
          <div className="lg:col-span-4">
            <LumiAvatar
              mood={stageMood}
              currentSpeech={stageSubtitle}
              speaking={!!activeTopicKey && isPlaying && currentSpeaker === 'lumi'}
              isUserSpeaking={false}
              voiceEnabled={voiceEnabled}
              onToggleVoice={onToggleVoice}
              autoSpeak={false}
              idleMood="greeting"
            />
            <div className="mt-3 rounded-2xl border border-[#44475a] bg-[#21222c]/70 p-4 text-xs text-[#6272a4] leading-relaxed space-y-2">
              <p className="flex items-center gap-2 text-[#f8f8f2] font-semibold text-[13px]">
                <Mic className="w-4 h-4 text-[#8be9fd]" /> Examiner
                <span className="text-[#6272a4] font-normal">asks ·</span>
                <Sparkles className="w-4 h-4 text-[#ff79c6]" /> Lumi
                <span className="text-[#6272a4] font-normal">answers</span>
              </p>
              <p>{PART_DESCRIPTIONS[activePart]}</p>
            </div>
          </div>

          {/* Right column (8 cols) */}
          <div className="lg:col-span-8 space-y-4 min-w-0">
            {/* Part tabs — like the Cambridge Test tab */}
            <div className="flex flex-wrap items-center gap-2">
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
                    title={`Part ${part} — ${qCount} questions`}
                  >
                    <span className="font-mono opacity-80">{part}</span>
                    <span>Part {part}</span>
                  </button>
                );
              })}
              <span className="ml-1 text-[11px] font-semibold uppercase tracking-wider text-[#6272a4]">
                {PART_TITLES[activePart]}
              </span>
            </div>

            {/* Scroll area: every topic of this part, with all Q&As at once */}
            <div className="max-h-[62vh] overflow-y-auto pr-2 space-y-5 rounded-2xl">
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
                          {group.questions.length} question{group.questions.length !== 1 ? 's' : ''} ·
                          examiner asks, Lumi answers live
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
                          title={playButtonTitle(isActive, isDone)}
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

                    {/* Live status strip while the session runs */}
                    {isActive && (
                      <div
                        className={`px-4 sm:px-5 py-2.5 flex items-center gap-2 border-b text-xs font-semibold ${
                          isPlaying
                            ? 'bg-[#bd93f9]/10 border-[#bd93f9]/30'
                            : 'bg-[#ffb86c]/10 border-[#ffb86c]/30'
                        }`}
                      >
                        <span
                          className={`w-2 h-2 rounded-full ${
                            isPlaying ? 'bg-[#50fa7b] animate-pulse' : 'bg-[#ffb86c]'
                          }`}
                        />
                        <span className={isPlaying ? 'text-[#f8f8f2]' : 'text-[#ffb86c]'}>
                          {!isPlaying
                            ? 'Paused — press Resume to continue where you left off'
                            : currentSpeaker === 'examiner'
                            ? 'Examiner is asking the question…'
                            : currentSpeaker === 'lumi'
                            ? 'Lumi is answering — listen to the pacing, linking words & fluency'
                            : 'Getting ready…'}
                        </span>
                        <span className="ml-auto font-mono text-[10px] text-[#6272a4]">
                          Question {Math.min(currentQIndex + 1, group.questions.length)} of{' '}
                          {group.questions.length}
                        </span>
                      </div>
                    )}

                    {/* Every question of the topic with its sample answer below */}
                    <div className="p-4 sm:p-5 space-y-4">
                      {group.questions[0]?.cueTips && group.questions[0].cueTips.length > 0 && (
                        <div className="flex items-start gap-2 rounded-xl bg-[#ffb86c]/10 border border-[#ffb86c]/30 p-3">
                          <Lightbulb className="w-4 h-4 text-[#ffb86c] shrink-0 mt-0.5" />
                          <div className="min-w-0">
                            <p className="text-[10px] font-bold uppercase tracking-wider text-[#ffb86c] mb-1">
                              What to notice in these answers
                            </p>
                            <ul className="text-xs text-[#f8f8f2]/80 list-disc list-inside space-y-0.5">
                              {group.questions[0].cueTips.map((tip, ti) => (
                                <li key={`tip-${ti}`}>{tip}</li>
                              ))}
                            </ul>
                          </div>
                        </div>
                      )}

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
                                <p className="text-sm text-[#f8f8f2] leading-relaxed">{q.question}</p>
                              </div>
                            </div>

                            {/* The sample answer, shown below the question */}
                            <div className="flex items-start gap-2.5 p-3 pt-0">
                              <span
                                className={`shrink-0 mt-0.5 w-6 h-6 rounded-lg flex items-center justify-center border transition-colors ${
                                  rowActive && currentSpeaker === 'lumi'
                                    ? 'bg-[#ff79c6] text-[#282a36] border-[#ff79c6]'
                                    : 'bg-[#ff79c6]/15 text-[#ff79c6] border-[#ff79c6]/40'
                                }`}
                              >
                                <Sparkles className="w-3.5 h-3.5" />
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 mb-0.5">
                                  <p className="text-[10px] font-bold uppercase tracking-wider text-[#ff79c6]">
                                    Lumi — Sample Answer
                                  </p>
                                  {rowActive && isPlaying && currentSpeaker === 'lumi' && (
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
                                  {q.sampleAnswer || '—'}
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

            </div>

          </div>
        </div>

    </div>
  );
};
