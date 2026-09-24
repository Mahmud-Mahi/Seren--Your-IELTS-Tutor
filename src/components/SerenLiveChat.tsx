import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Mic,
  Send,
  Sparkles,
  Lightbulb,
  Square,
  Zap,
  Loader2,
  Info,
  Pencil,
  Trash2,
  Check,
  X,
} from 'lucide-react';
import { ChatMessage, UserProfile, SpeakingEvaluation, SerenMood, UpgradedExpression } from '../types';
import { ChatInputBox } from './ChatInputBox';
import { SerenAvatar } from './SerenAvatar';
import { ScrollArea } from './ScrollArea';
import { serenVoice, soundFX, activeAudioRecorder, transcribeAudio } from '../utils/speech';
import { getAutoMicEnabled } from '../utils/preferences';
import { useSerenMood, useMicMoodSync, normalizeReplyMood } from '../utils/serenMood';
import { pickRandomTopic, getQuestionsByTopic, type IELTSPart1Question } from '../data/ieltsQuestionsP1';
import { SEREN_PROFILE_IMAGE, USER_AVATAR_IMAGE } from '../assets/characterAssets';
import { loadMessagesByMode, saveMessagesByMode, loadInterviewSession, saveInterviewSession } from '../utils/chatHistory';
import { greetInterview, casualSessionOpener, casualFallbackOpener } from '../utils/greetings';
import { useShortcut, useShortcutHint } from '../hooks/useShortcut';

interface SerenLiveChatProps {
  userProfile: UserProfile;
  evaluation?: SpeakingEvaluation | null;
  voiceEnabled: boolean;
  onToggleVoice: () => void;
  onPracticeEvaluationComplete?: (evaluation: SpeakingEvaluation) => void;
}

// Absolute ceiling for waiting on Seren's speech before forcing the handoff —
// guards against a stalled TTS stream that never fires onEnd (90s).
const SPEECH_HANDOFF_CAP_MS = 90_000;

// The chat is a two-mode messenger (Interview / Casual Chat). New users land
// directly in the 1v1 Interview right after onboarding, and the last-used mode
// is remembered so returning users never lose their place when they come back
// to the chat tab.
const CHAT_MODE_KEY = 'seren_chat_mode';

function loadSavedChatMode(): 'Interview' | 'Casual Chat' {
  try {
    const saved = localStorage.getItem(CHAT_MODE_KEY);
    if (saved === 'Interview' || saved === 'Casual Chat') return saved;
  } catch {}
  // No saved preference yet (fresh user / onboarding just completed) → the
  // interview is the post-onboarding experience.
  return 'Interview';
}

export const SerenLiveChat: React.FC<SerenLiveChatProps> = ({
  userProfile,
  evaluation,
  voiceEnabled,
  onToggleVoice,
  onPracticeEvaluationComplete,
}) => {
  const [inputText, setInputText] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  // Central mood state machine (src/utils/serenMood.ts) — 'listening' is
  // mic-driven only; see useMicMoodSync below.
  const [serenMood, setSerenMood] = useSerenMood();
  const [currentSpeech, setCurrentSpeech] = useState('');
  // Tracks whether Seren is currently speaking (casual + interview audio), so the
  // chat avatar shows the "speaking" image while she talks and falls back to the
  // greeting image when idle.
  const [serenTalking, setSerenTalking] = useState(false);
  const [selectedTopicMode, setSelectedTopicMode] = useState<'Interview' | 'Casual Chat'>(loadSavedChatMode);

  // Inline message editing (WhatsApp-style). `editingMessageId` tracks which
  // bubble is being edited and `editingText` holds its live draft content.
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');

  // TWO separate chat threads — one per mode — that never mix (like two
  // distinct WhatsApp chats). `messages` is the active thread for the current
  // mode, derived from `messagesByMode`.
  const [messagesByMode, setMessagesByMode] = useState<Record<'Interview' | 'Casual Chat', ChatMessage[]>>(
    () => {
      try {
        return loadMessagesByMode();
      } catch {
        return { Interview: [], 'Casual Chat': [] };
      }
    }
  );
  const messages = messagesByMode[selectedTopicMode];
  const interviewMessages = messagesByMode['Interview'];

  // bootedRef guards the first-visit greeting against StrictMode's double
  // effect invocation.
  const bootedRef = useRef(false);

  // Mic lifecycle → mood: while the mic is open the mood is ALWAYS
  // 'listening'; the moment it closes the previous base mood returns.
  useMicMoodSync(isRecording);

  // Interview mode state
  const [usedTopics, setUsedTopics] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('seren_used_topics') || '[]'); } catch { return []; }
  });
  const [currentTopic, setCurrentTopic] = useState<string | null>(null);
  const [topicQuestions, setTopicQuestions] = useState<IELTSPart1Question[]>([]);
  const [currentQuestionIdx, setCurrentQuestionIdx] = useState(0);
  const [userAnswers, setUserAnswers] = useState<Record<number, string>>({});
  const [isInterviewActive, setIsInterviewActive] = useState(false);
  const [isSerenSpeakingQ, setIsSerenSpeakingQ] = useState(false);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [greetingDone, setGreetingDone] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatWindowRef = useRef<HTMLDivElement>(null);
  const [messageAreaHeight, setMessageAreaHeight] = useState<number | null>(null);
  const [chatWindowHeight, setChatWindowHeight] = useState<number | null>(null);
  const isRecordingRef = useRef(false);
  const stoppingInterviewRef = useRef(false);
  const currentQuestionIdxRef = useRef(0);
  const lastAnsweredIdxRef = useRef(-1);
  const isInterviewActiveRef = useRef(false);
  const modeRef = useRef(selectedTopicMode);
  // Holds the latest askQuestion so the async recording-finalize callback
  // (useCallback with [] deps) never calls a stale closure over an old topic.
  const askQuestionRef = useRef<(idx: number) => void>(() => {});

  currentQuestionIdxRef.current = currentQuestionIdx;
  isInterviewActiveRef.current = isInterviewActive;
  modeRef.current = selectedTopicMode;

  // ---- Single continuous chat thread ----
  // First-ever visit (post-onboarding): land straight in the 1v1 INTERVIEW —
  // Seren greets and immediately starts a Part 1 topic from the question bank
  // (3-6 questions from one topic, then evaluation). Returning visits: the
  // full history is already in the scroll area and the user simply continues
  // (an in-progress interview rehydrates its topic/question/answer state).
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;

    if (modeRef.current === 'Interview') {
      const session = loadInterviewSession();
      if (interviewMessages.length > 0 && session && session.questions.length > 0) {
        // Returning to an in-progress interview: the chat bubbles alone are
        // NOT enough — rehydrate the question-flow state machine (topic,
        // question list, index, answers) that only lives in React state +
        // the persisted interview session.
        const finished = session.currentQuestionIdx >= session.questions.length;
        setCurrentTopic(session.topic);
        setTopicQuestions(session.questions);
        setCurrentQuestionIdx(session.currentQuestionIdx);
        setUserAnswers(session.userAnswers);
        lastAnsweredIdxRef.current = session.lastAnsweredIdx;
        finalizingInterviewRef.current = false;
        setIsInterviewActive(!finished);
        setIsSerenSpeakingQ(false);
        setGreetingDone(true);
        setIsEvaluating(false);
      } else {
        // Fresh user right after onboarding (or the last run finished & was
        // cleared) → jump straight into a new Part 1 topic interview.
        void startInterview();
      }
    } else if (messages.length === 0) {
      // Casual thread empty — Seren opens the friendly conversation.
      setGreetingDone(true);
      void handleStartCasualSession();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist BOTH chat threads after every message so each mode's history
  // survives reloads and app restarts — kept separate, never mixed.
  useEffect(() => {
    saveMessagesByMode(messagesByMode);
  }, [messagesByMode]);

  // Remember the user's last-used mode so the chat tab reopens where they
  // left off (Interview is the default for new/post-onboarding users).
  useEffect(() => {
    try { localStorage.setItem(CHAT_MODE_KEY, selectedTopicMode); } catch {}
  }, [selectedTopicMode]);

  // Write helper: appends/replaces the CURRENT mode's thread only, so the two
  // threads never bleed into each other.
  //
  // This deliberately reads `modeRef.current` (not the `selectedTopicMode` state
  // variable) because `handleModeSwitch` calls `startInterview()` synchronously
  // right after `setSelectedTopicMode(mode)` — the state variable is still the
  // OLD mode in that closure, which previously dumped the interview greeting
  // into the Casual chat thread. `modeRef.current` is updated immediately.
  const setMessagesForActiveMode = useCallback((updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
    setMessagesByMode((prev) => {
      const mode = modeRef.current;
      const current = prev[mode];
      const next = typeof updater === 'function' ? (updater as (p: ChatMessage[]) => ChatMessage[])(current) : updater;
      return { ...prev, [mode]: next };
    });
  }, []);

  // Persist used topics
  useEffect(() => {
    try { localStorage.setItem('seren_used_topics', JSON.stringify(usedTopics)); } catch {}
  }, [usedTopics]);

  // Persist the interview session state machine (topic, question list, current
  // index, answers) so a page reload or an Interview ⇌ Casual round-trip can
  // resume the SAME question flow. Without this only the chat bubbles survived
  // while `topicQuestions` reset to [] — so the very next answer jumped
  // straight to "That was the last question" after a single response.
  useEffect(() => {
    if (!currentTopic || topicQuestions.length === 0) return;
    saveInterviewSession({
      topic: currentTopic,
      questions: topicQuestions,
      currentQuestionIdx,
      userAnswers,
      lastAnsweredIdx: lastAnsweredIdxRef.current,
    });
  }, [currentTopic, topicQuestions, currentQuestionIdx, userAnswers]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      serenVoice.stop();
      void activeAudioRecorder.stop().catch(() => {});
    };
  }, []);

  // ---- INTERVIEW MODE ----

  // The composer's editable answer box — the Whisper transcript lands here
  // after the user stops recording, and doubles as the typed-answer input
  // (Discord/WhatsApp style).
  const [answerText, setAnswerText] = useState('');
  const answerTextRef = useRef('');
  const updateAnswerText = (text: string) => {
    answerTextRef.current = text;
    setAnswerText(text);
  };
  // Surfaces transcription problems (mic denied, Whisper unavailable, unclear
  // speech) so an empty text box is never a silent mystery.
  const [sttNotice, setSttNotice] = useState('');
  // Guards against double-finalizing when the user submits twice.
  const finalizingInterviewRef = useRef(false);
  // Transcribing indicator for the stop/sending flows (Whisper only runs
  // AFTER the user stops recording — no live text, no AI modification).
  const [isTranscribing, setIsTranscribing] = useState(false);

  // Stop the interview recording WITHOUT submitting: releases the microphone
  // and transcribes the recording with local Whisper so the user sees their
  // words in the composer. The user then reviews (optionally edits) and presses
  // Send to actually send the answer — stopping alone never submits.
  // NOTE: no AI modification of the transcript — Whisper's raw transcription
  // is what lands in the composer.
  const stopInterviewRecording = useCallback(async () => {
    // Mutual exclusion with finalize: if a Send is already in progress, never
    // let a second stop interleave (which could double-stop the recorder
    // mid-advance).
    if (stoppingInterviewRef.current || finalizingInterviewRef.current) return;
    stoppingInterviewRef.current = true;

    setIsRecording(false);
    isRecordingRef.current = false;

    const recordResult = await activeAudioRecorder.stop().catch(() => null);
    stoppingInterviewRef.current = false;

    if (recordResult?.base64 && recordResult.base64.length > 50) {
      setIsTranscribing(true);
      try {
        const transcript = await transcribeAudio({
          audioBase64: recordResult.base64,
          mimeType: recordResult?.mimeType || 'audio/webm',
        });
        const clean = transcript.trim();
        if (clean) {
          // Append after any typed draft; a fresh recording lands in an empty
          // composer on its own.
          updateAnswerText(answerTextRef.current.trim() ? `${answerTextRef.current.trim()} ${clean}` : clean);
          setSttNotice('');
        } else {
          setSttNotice('I couldn\u2019t make out any clear speech in that recording — try speaking a little closer to the mic, or type your answer.');
        }
      } catch (e) {
        console.warn('Interview transcription notice:', e);
        setSttNotice('Transcription failed (is the local Whisper engine running?) — you can type your answer instead.');
      } finally {
        setIsTranscribing(false);
      }
    }
  }, []);

  const startInterviewRecording = useCallback(() => {
    // Already recording / finalizing — never start a second recorder.
    if (isRecordingRef.current || finalizingInterviewRef.current) return;

    // Self-heal: if the interview session isn't flagged active (e.g. after
    // navigating Casual ⇌ Interview), restore it so the mic always works.
    if (!isInterviewActiveRef.current) {
      setIsInterviewActive(true);
      setIsSerenSpeakingQ(false);
      setGreetingDone(true);
    }

    // If Seren is still reading the question aloud, cut her off so the user's
    // answer doesn't overlap the question audio.
    serenVoice.stop();

    soundFX.playChime('start');
    // Mood: 'listening' comes automatically from useMicMoodSync when
    // isRecording flips true (do NOT set it directly — the controller
    // ignores it). Keep the mic-driven rule intact.
    // A new recording clears any previous transcription notice.
    setSttNotice('');

    // Arm the mic as soon as the start-chime's attack has passed (200 ms) so
    // the opening phrase of the answer is still captured. The chime tail that
    // remains is suppressed by echoCancellation on the mic stream.
    setIsRecording(true);
    isRecordingRef.current = true;
    setTimeout(async () => {
      const ok = await activeAudioRecorder.start();
      if (!ok && isRecordingRef.current) {
        setIsRecording(false);
        isRecordingRef.current = false;
        setSttNotice('Microphone unavailable — check browser permissions, or type your answer.');
      }
    }, 200);
  }, []);

  // Finalize the current interview answer: stops the media recorder completely
  // (releasing the microphone), then saves the response and advances to the
  // next question. If the user typed/edited their answer in the composer,
  // overrideText takes priority over the transcription.
  const finalizeInterviewAnswer = useCallback(async (overrideText?: string) => {
    if (finalizingInterviewRef.current) return;
    finalizingInterviewRef.current = true;

    // Keep the mic-free moment visible: stop the recorder first.
    setIsRecording(false);
    const wasRecording = isRecordingRef.current;
    isRecordingRef.current = false;

    const recordResult = await activeAudioRecorder.stop().catch(() => null);
    const typed = (overrideText || '').trim();

    let finalText = typed;
    // If the user hits Send mid-recording, the recording has not been
    // transcribed yet (the stop button was skipped) — transcribe it now so
    // their spoken answer is what gets sent. Typed text always wins.
    if (wasRecording && recordResult?.base64 && recordResult.base64.length > 50 && !typed) {
      setIsTranscribing(true);
      try {
        const transcript = await transcribeAudio({
          audioBase64: recordResult.base64,
          mimeType: recordResult?.mimeType || 'audio/webm',
        });
        if (transcript && transcript.trim()) {
          finalText = transcript.trim();
        }
      } catch (e) {
        console.warn('Interview transcription notice:', e);
      } finally {
        setIsTranscribing(false);
      }
    }

    const idx = currentQuestionIdxRef.current;
    // Idempotency guard: never re-answer / re-advance a question that has
    // already been finalized. This makes skipping (e.g. Q1 -> "last question")
    // impossible even if a duplicate/stale submit slips past the ref guard.
    if (idx <= lastAnsweredIdxRef.current) {
      finalizingInterviewRef.current = false;
      return;
    }
    lastAnsweredIdxRef.current = idx;
    setUserAnswers((prev) => ({ ...prev, [idx]: finalText }));
    updateAnswerText('');

    // Add user message to chat
    if (finalText.trim()) {
      const userMsg: ChatMessage = {
        id: `msg-user-${Date.now()}`,
        sender: 'user',
        text: finalText,
        timestamp: Date.now(),
      };
      setMessagesForActiveMode((prev) => [...prev, userMsg]);
    }

    // Move to next question after brief pause
    setTimeout(() => {
      askQuestionRef.current(idx + 1);
    }, 500);
  }, []);

  // Send handler for the interview composer: sends whatever the user typed
  // (or the live-transcript text if editing) and submits the answer.
  const submitInterviewAnswer = useCallback(() => {
    if (!isInterviewActiveRef.current && topicQuestions.length === 0) return;
    if (!greetingDone) return;
    if (finalizingInterviewRef.current) return;
    // The user can answer even while Seren is still reading the question —
    // cut her speech off and submit their answer.
    if (isSerenSpeakingQ) {
      serenVoice.stop();
      setIsSerenSpeakingQ(false);
    }
    void finalizeInterviewAnswer(answerText);
  }, [answerText, isSerenSpeakingQ, greetingDone, topicQuestions.length]);

  // Speech-aware handoff: wait until Seren has ACTUALLY finished speaking before
  // advancing to the next stage (first question / mic handover). The previous
  // blind 9-second timers fired while she was still mid-sentence on longer
  // greetings/questions, and the follow-up speak() call instantly cancelled
  // the in-flight audio. Fires when:
  //   • speech has been active and then finished (covers a missed onEnd), or
  //   • TTS never started within `graceMs` (autoplay block / engine failure), or
  //   • a stalled stream exceeds the hard cap.
  const armSpeechHandoff = useCallback((fire: () => void, graceMs = 8000) => {
    const startedAt = Date.now();
    let sawSpeaking = false;
    const poll = window.setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const speaking = serenVoice.getIsSpeaking();
      if (speaking) sawSpeaking = true;
      // Still inside the pre-speech grace window and nothing has played yet —
      // keep waiting for the engine to start (the first /api/tts request can
      // take a moment).
      if (!sawSpeaking && elapsed < graceMs) return;
      // Still speaking — keep waiting, up to the hard cap for stalled streams.
      if (speaking && elapsed < SPEECH_HANDOFF_CAP_MS) return;
      window.clearInterval(poll);
      fire();
    }, 350);
  }, []);

  const askQuestion = useCallback((idx: number) => {
    if (idx >= topicQuestions.length) {
      // All questions done
      setIsInterviewActive(false);
      setSerenMood('encouraging');
      const doneMsg: ChatMessage = {
        id: `msg-done-${Date.now()}`,
        sender: 'seren',
        text: `Great job, ${userProfile.nickname}! That was the last question. Let's see how you did!`,
        timestamp: Date.now(),
        mood: 'encouraging',
      };
      setMessagesForActiveMode((prev) => [...prev, doneMsg]);
      setCurrentSpeech(doneMsg.text);
      if (voiceEnabled) {
        serenVoice.speak(doneMsg.text, {});
      }
      setSerenMood('encouraging');
      return;
    }

    // A fresh question cycle starts here: clear the finalize guard so the user's
    // NEXT answer can be submitted (it must NOT be cleared in startInterviewRecording,
    // which runs mid-cycle and would let a duplicate/stale submit double-advance).
    finalizingInterviewRef.current = false;

    setCurrentQuestionIdx(idx);
    const q = topicQuestions[idx];
    setSerenMood('speaking');
    setIsSerenSpeakingQ(true);

    // Seren asks the question as a chat bubble (messaging UI) and reads it aloud
    setCurrentSpeech(q.instruction);
    setMessagesForActiveMode((prev) => [
      ...prev,
      {
        id: `msg-q-${idx}-${Date.now()}`,
        sender: 'seren',
        text: q.instruction,
        timestamp: Date.now(),
        mood: 'speaking',
      },
    ]);

    let advanced = false;

    const beginAnswering = () => {
      // Guard: only ever transition to "your turn" once per question, so the
      // onEnd and the safety-net timer (or an early manual answer) can't both
      // start recording / double-fire.
      if (advanced) return;
      advanced = true;
      setIsSerenSpeakingQ(false);
      setCurrentSpeech('');
      setSerenMood('speaking');
      // Respect the mic preference: automatic opens the mic by itself after
      // Seren reads the question; manual waits for the user to press the mic.
      if (getAutoMicEnabled()) {
        startInterviewRecording();
      }
    };

    if (voiceEnabled && q.instruction.trim()) {
      serenVoice.speak(q.instruction, { onEnd: beginAnswering });
      // Safety net: if onEnd never fires (autoplay block / same-phrase short-
      // circuit), still hand the turn to the user so the mic is never stuck
      // disabled — but ONLY once she has genuinely finished (or failed to
      // start), never mid-sentence.
      armSpeechHandoff(beginAnswering);
    } else {
      // Voice muted: no onEnd will fire, so advance to recording after a beat
      setTimeout(beginAnswering, 600);
    }
  }, [topicQuestions, userProfile.nickname, voiceEnabled, startInterviewRecording, armSpeechHandoff]);

  const startInterview = useCallback(() => {
    // Never start behind a stale mount-mode timer when the user switched away
    if (modeRef.current !== 'Interview') return;

    let topic = pickRandomTopic(usedTopics);
    if (!topic) {
      setUsedTopics([]);
      topic = pickRandomTopic([]);
    }
    if (!topic) return;

    const questions = getQuestionsByTopic(topic);
    setCurrentTopic(topic);
    setTopicQuestions(questions);
    setCurrentQuestionIdx(0);
    setUserAnswers({});
    lastAnsweredIdxRef.current = -1;
    finalizingInterviewRef.current = false;
    setIsInterviewActive(true);
    setGreetingDone(false);

    // Guards the greeting→Q1 handoff so it can only fire once even if the TTS
    // onEnd and the safety-net timer both trigger.
    let begun = false;

    // Seren greets as a chat bubble (messaging UI) and reads it aloud.
    // Single-thread rule: the greeting is APPENDED to the continuous history,
    // never replacing what came before.
    const greetText = greetInterview(userProfile.nickname);
    setSerenMood('greeting');
    setCurrentSpeech(greetText);
    setMessagesForActiveMode((prev) => [
      ...prev,
      {
        id: `msg-greet-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        sender: 'seren',
        text: greetText,
        timestamp: Date.now(),
        mood: 'greeting',
      },
    ]);

    const beginQuestions = () => {
      // Guard: onEnd may fire more than once (or the fallback timer + onEnd
      // may both run). Only ever advance to Q1 a single time.
      if (begun) return;
      begun = true;
      setGreetingDone(true);
      setCurrentSpeech('');
      setSerenMood('speaking');
      setTimeout(() => {
        askQuestionRef.current(0);
      }, 800);
    };

    if (voiceEnabled && greetText.trim()) {
      serenVoice.speak(greetText, {
        onEnd: beginQuestions,
      });
      // Safety net: if the speech engine never fires onEnd (autoplay block /
      // same-phrase short-circuit), guarantee we still advance to Q1 — but
      // only once she has genuinely finished speaking. The old blind 9-second
      // timer fired mid-greeting on longer intros and Q1's speak() call then
      // cancelled her sentence halfway through.
      armSpeechHandoff(beginQuestions);
    } else {
      // Voice muted: no onEnd will fire — advance to Q1 after a short beat
      setTimeout(beginQuestions, 600);
    }
  }, [usedTopics, userProfile.nickname, voiceEnabled, armSpeechHandoff]);

  // Keep the ref pointed at the latest askQuestion every render so async
  // recording-finalize callbacks always advance to the correct next question.
  askQuestionRef.current = askQuestion;

  const handleEvaluate = useCallback(async () => {
    if (!onPracticeEvaluationComplete || !currentTopic) return;
    setIsEvaluating(true);
    soundFX.playChime('start');

    const totalWords = Object.values(userAnswers)
      .join(' ')
      .split(/\s+/)
      .filter(Boolean).length;
    const estimatedWPM = totalWords > 0 ? Math.round((totalWords / (topicQuestions.length * 0.75)) * 1.5) : 0;

    try {
      const res = await fetch('/api/evaluate-practice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userProfile,
          topic: currentTopic,
          questions: topicQuestions.map((q, i) => ({
            question: q.instruction,
            userAnswer: userAnswers[i] || '',
            sampleResponse: q.response,
          })),
          stats: { totalWords, estimatedWPM },
        }),
      });

      const data = await res.json();
      if (data.success && data.evaluation) {
        // Sentence solutions are sourced from the JSON question-bank `response`
        // field (the model sample answers), NOT from the API — the API only
        // supplies the band score, pillars & pronunciation tips.
        const jsonUpgrades: UpgradedExpression[] = topicQuestions.flatMap((q, i) => {
          const answer = (userAnswers[i] || '').trim();
          if (!answer) return [];
          return [{
            index: i + 1,
            original: answer,
            upgraded: q.response,
            ieltsBand: 'Band 8+ Model',
            explanation:
              'Model answer sourced directly from the IELTS question bank for this topic. Notice the natural collocations, discourse markers and precise academic register examiners look for at Band 8+.',
            part: 1,
          }];
        });

        const finalEval: SpeakingEvaluation = {
          ...data.evaluation,
          upgradedExpressions:
            jsonUpgrades.length > 0 ? jsonUpgrades : data.evaluation.upgradedExpressions,
        };
        soundFX.playChime('success');
        setUsedTopics((prev) => [...prev, currentTopic]);
        // This interview run is complete: drop the persisted session so the
        // next time the user enters Interview mode they get a fresh topic
        // instead of resuming a finished question list.
        saveInterviewSession(null);
        onPracticeEvaluationComplete(finalEval);
      } else {
        throw new Error(data.error || 'Evaluation failed');
      }
    } catch (err) {
      console.error('Practice evaluation failed:', err);
      setIsEvaluating(false);
      const errorMsg: ChatMessage = {
        id: `msg-err-${Date.now()}`,
        sender: 'seren',
        text: `Sorry, something went wrong with the evaluation. Please try again.`,
        timestamp: Date.now(),
        mood: 'speaking',
      };
      setMessagesForActiveMode((prev) => [...prev, errorMsg]);
    }
  }, [onPracticeEvaluationComplete, currentTopic, topicQuestions, userAnswers, userProfile]);

  // ---- CASUAL CHAT MODE ----
  // The avatar renders with autoSpeak={false} (SerenLiveChat owns all audio to
  // avoid double-speak races), so casual replies are voiced explicitly here.
  const speakText = useCallback(
    (text: string) => {
      if (voiceEnabled && text && text.trim()) {
        setSerenTalking(true);
        serenVoice.speak(text, {
          onStart: () => setSerenTalking(true),
          onEnd: () => setSerenTalking(false),
        });
      }
    },
    [voiceEnabled]
  );

  const handleInputChange = (text: string) => {
    setInputText(text);
  };

  const handleSendMessage = async (textToSend?: string) => {
    const text = (textToSend || inputText).trim();
    if (!text || isLoading) return;

    if (isRecording) {
      setIsRecording(false);
      isRecordingRef.current = false;
      // Fully release the mic — the MediaRecorder keeps its stream alive
      // (browser mic indicator stays on) unless stopped too.
      void activeAudioRecorder.stop().catch(() => {});
    }

    soundFX.playChime('start');
    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      sender: 'user',
      text,
      timestamp: Date.now(),
    };

    setMessagesForActiveMode((prev) => [...prev, userMsg]);
    setInputText('');
    setIsLoading(true);
    // Never fake 'listening' here — that mood means the mic is recording.
    // The chat area already shows "Seren is typing..." while we wait.
    setSerenMood('speaking');

    try {
      const res = await fetch('/api/seren-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userProfile,
          evaluation,
          conversationHistory: [...messages, userMsg],
          message: text,
          mode: selectedTopicMode,
        }),
      });

      const data = await res.json();
      setIsLoading(false);

      if (data.success && data.reply) {
        const serenMsg: ChatMessage = {
          id: `msg-seren-${Date.now()}`,
          sender: 'seren',
          text: data.reply.replyText,
          timestamp: Date.now(),
          mood: normalizeReplyMood(data.reply.mood),
          feedback: data.reply.feedback,
        };

        setMessagesForActiveMode((prev) => [...prev, serenMsg]);
        setSerenMood(serenMsg.mood || 'speaking');
        setCurrentSpeech(serenMsg.text);
        speakText(serenMsg.text);
        soundFX.playChime('ding');
      }
    } catch (e) {
      setIsLoading(false);
      const isCasual = selectedTopicMode !== 'Interview';
      const fallbackMsg: ChatMessage = {
        id: `msg-seren-${Date.now()}`,
        sender: 'seren',
        text: isCasual
          ? `Ah, I didn't catch that, ${userProfile.nickname} — my connection hiccuped. What were you saying?`
          : `That is an insightful point, ${userProfile.nickname}! Could you elaborate on what factors might influence this in the near future?`,
        timestamp: Date.now(),
        mood: 'speaking',
        feedback: isCasual
          ? undefined
          : {
              correctedSentence: `From my perspective, ${text.replace(/^i think/i, '').trim()}.`,
              lexicalBoost: ['From my perspective', 'Profound implication', 'Substantiate'],
              ieltsTip: 'Support your answer with a concrete hypothetical or personal example.',
            },
      };
      setMessagesForActiveMode((prev) => [...prev, fallbackMsg]);
      setSerenMood('speaking');
      setCurrentSpeech(fallbackMsg.text);
      speakText(fallbackMsg.text);
      soundFX.playChime('ding');
    }
  };
// ---- EDIT & DELETE (WhatsApp-style message management) ----
  // Both operate ONLY on the current mode's thread via setMessagesForActiveMode,
  // so edits/deletes never bleed across the two chat boxes (and the existing
  // `messagesByMode` effect persists the change automatically).
  const handleEditMessage = useCallback(
    (msgId: string, newText: string) => {
      const text = newText.trim();
      if (!text) {
        setEditingMessageId(null);
        setEditingText('');
        return;
      }
      setMessagesForActiveMode((prev) =>
        prev.map((m) => (m.id === msgId ? { ...m, text, edited: true } : m))
      );
      // Keep a freshly-edited Seren bubble in sync with the spoken subtext.
      setCurrentSpeech('');
      setEditingMessageId(null);
      setEditingText('');
    },
    []
  );

  const handleDeleteMessage = useCallback(
    (msgId: string) => {
      setMessagesForActiveMode((prev) => prev.filter((m) => m.id !== msgId));
      if (editingMessageId === msgId) {
        setEditingMessageId(null);
        setEditingText('');
      }
    },
    [editingMessageId]
  );

  const startEditingMessage = useCallback((msg: ChatMessage) => {
    setEditingText(msg.text);
    setEditingMessageId(msg.id);
  }, []);

  // Casual-chat mic: record with the box showing the live equalizer; stop
  // transcribes with local Whisper (no AI modification) and drops the text
  // into the composer. Stop never auto-sends — the user presses Send.
  const handleToggleMic = async () => {
    // Whisper runs after recording stops. Keep the mic action locked for the
    // whole async transcription so a second recorder cannot start in parallel.
    if (isTranscribing) return;

    if (isRecording) {
      setIsRecording(false);
      isRecordingRef.current = false;

      const recordResult = await activeAudioRecorder.stop().catch(() => null);
      if (recordResult?.base64 && recordResult.base64.length > 50) {
        setIsTranscribing(true);
        try {
          const transcript = await transcribeAudio({
            audioBase64: recordResult.base64,
            mimeType: recordResult.mimeType,
          });
          const clean = transcript.trim();
          if (clean) {
            // Append after any typed draft (mirrors the old combined behavior).
            setInputText((prev) => (prev.trim() ? `${prev.trim()} ${clean}` : clean));
            setSttNotice('');
          } else {
            setSttNotice('I couldn\u2019t make out any clear speech in that recording — try speaking a little closer to the mic, or type your message.');
          }
        } catch (e) {
          console.warn('Chat transcription notice:', e);
          setSttNotice('Transcription failed (is the local Whisper engine running?) — please type your message instead.');
        } finally {
          setIsTranscribing(false);
        }
      }
    } else {
      soundFX.playChime('start');
      // Cut off Seren's still-streaming speech BEFORE arming the mic. If her
      // TTS is playing when the MediaRecorder opens, her voice gets recorded
      // from the speakers and Whisper then transcribes HER words — a
      // completely out-of-context transcript.
      serenVoice.stop();
      setSttNotice('');
      // Arm the mic as soon as the start-chime's attack has passed. The chime
      // tail is suppressed by echoCancellation on the mic stream.
      setIsRecording(true);
      isRecordingRef.current = true;
      setTimeout(async () => {
        const ok = await activeAudioRecorder.start();
        if (!ok && isRecordingRef.current) {
          setIsRecording(false);
          isRecordingRef.current = false;
          setSttNotice('Microphone unavailable — check browser permissions, or type your message.');
        }
      }, 200);
    }
  };

  const handleStartCasualSession = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/seren-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userProfile,
          evaluation,
          conversationHistory: [],
          message: casualSessionOpener(),
          mode: 'Casual Chat',
        }),
      });
      const data = await res.json();
      setIsLoading(false);
      if (data.success && data.reply) {
        const serenMsg: ChatMessage = {
          id: `msg-starter-${Date.now()}`,
          sender: 'seren',
          text: data.reply.replyText,
          timestamp: Date.now(),
          mood: normalizeReplyMood(data.reply.mood),
          feedback: data.reply.feedback,
        };
        setMessagesForActiveMode((prev) => [...prev, serenMsg]);
        setSerenMood(serenMsg.mood || 'speaking');
        setCurrentSpeech(serenMsg.text);
        speakText(serenMsg.text);
        soundFX.playChime('ding');
      }
    } catch (e) {
      console.warn('Casual starter question unavailable:', e);
      setIsLoading(false);
      // Fall back to a built-in opener so the session still begins
      const fallbackMsg: ChatMessage = {
        id: `msg-starter-${Date.now()}`,
        sender: 'seren',
        text: casualFallbackOpener(userProfile.nickname),
        timestamp: Date.now(),
        mood: 'speaking',
      };
      setMessagesForActiveMode((prev) => [...prev, fallbackMsg]);
      setCurrentSpeech(fallbackMsg.text);
      speakText(fallbackMsg.text);
    }
  }, [userProfile, evaluation, speakText]);

  // Mode switch between TWO separate chat threads. Nothing is ever cleared —
  // each mode keeps its own history. Casual: Seren keeps chatting as a friend.
  // Interview: she starts a practice run ONLY if the interview thread is empty
  // (switching back to an in-progress interview just resumes it).
  const handleModeSwitch = (mode: 'Interview' | 'Casual Chat') => {
    if (mode === selectedTopicMode) return;
    serenVoice.stop();
    void activeAudioRecorder.stop().catch(() => {});
    setIsRecording(false);
    setIsLoading(false);
    setInputText('');
    setAnswerText('');
    setSttNotice('');
    setSelectedTopicMode(mode);
    modeRef.current = mode; // immediate — startInterview() checks this ref

    if (mode === 'Interview') {
      // Fresh interview only when the interview thread has no messages yet.
      if (interviewMessages.length === 0) {
        startInterview();
      } else {
        // Resuming an interview thread that already has history. The saved
        // bubbles alone are NOT enough: the question state machine (topic,
        // questions, index, answers) is React state and is lost on reload or
        // on the Casual round-trip above. Without restoring it, the next
        // submitted answer called askQuestion() against an EMPTY question
        // list, which instantly printed "That was the last question" after a
        // single response. Rehydrate the persisted session instead.
        const session = loadInterviewSession();
        if (session && session.questions.length > 0) {
          const finished = session.currentQuestionIdx >= session.questions.length;
          setCurrentTopic(session.topic);
          setTopicQuestions(session.questions);
          setCurrentQuestionIdx(session.currentQuestionIdx);
          setUserAnswers(session.userAnswers);
          lastAnsweredIdxRef.current = session.lastAnsweredIdx;
          finalizingInterviewRef.current = false;
          setIsInterviewActive(!finished);
          setIsSerenSpeakingQ(false);
          setGreetingDone(true);
          setIsEvaluating(false);
        } else {
          // Nothing resumable (e.g. the run was finished and evaluated, which
          // clears the session): start a fresh interview appended to history.
          startInterview();
        }
      }
    } else {
      // Back to the friendly chat — history intact, Seren stays available.
      setCurrentTopic(null);
      setTopicQuestions([]);
      setUserAnswers({});
      setCurrentQuestionIdx(0);
      setIsInterviewActive(false);
      setIsSerenSpeakingQ(false);
      setIsEvaluating(false);
      setGreetingDone(true);
      setSerenMood('speaking');
      setCurrentSpeech('');
    }
  };

  const handleMessageAreaResizeStart = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const resizeHandle = event.currentTarget;
    const scrollArea = resizeHandle.previousElementSibling as HTMLElement | null;
    const chatWindow = chatWindowRef.current;
    const composer = resizeHandle.nextElementSibling as HTMLElement | null;
    if (!scrollArea || !chatWindow || !composer) return;

    const startY = event.clientY;
    const startHeight = scrollArea.getBoundingClientRect().height;
    const minHeight = 180;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      // Measure the composer on every move: its height changes between typed,
      // recording, transcription, and evaluation states.
      const reservedHeight =
        composer.getBoundingClientRect().height + resizeHandle.getBoundingClientRect().height;
      const nextHeight = Math.max(minHeight, startHeight + moveEvent.clientY - startY);
      setMessageAreaHeight(nextHeight);
      setChatWindowHeight(nextHeight + reservedHeight);
    };
    const handleMouseUp = () => {
      document.body.style.removeProperty('cursor');
      document.body.style.removeProperty('user-select');
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const isInterviewMode = selectedTopicMode === 'Interview';

  // Keyboard shortcut (customizable in Settings) for the mode switch above.
  // The shortcut stays active; its visual hint is only revealed on hover over
  // the tab headers (the native tooltip on each tab also mentions it).
  const modeShortcutHint = useShortcutHint('chat.toggleMode');
  const [isModeSelectorHovered, setIsModeSelectorHovered] = useState(false);
  useShortcut('chat.toggleMode', () => {
    handleModeSwitch(modeRef.current === 'Interview' ? 'Casual Chat' : 'Interview');
  });

  return (
    <div id="seren-live-chat-view" className="w-full max-w-6xl mx-auto flex flex-col flex-1 h-full min-h-0 space-y-2.5 sm:space-y-3">
      {/* Top Banner */}
      <div className="shrink-0 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 sm:gap-4 px-3.5 py-2 sm:px-4 sm:py-2.5 rounded-xl sm:rounded-2xl bg-[#21222c] border border-[#44475a] backdrop-blur-md">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-full border-2 border-[#bd93f9]/60 overflow-hidden shadow-md bg-[#21222c] shrink-0">
            <img
              src={SEREN_PROFILE_IMAGE}
              alt="Seren"
              className="w-full h-full object-cover"
              draggable={false}
            />
          </div>
          <div>
            <h2 className="text-sm sm:text-base font-bold text-[#f8f8f2] flex items-center gap-2">
              1v1 Chat with Seren
            </h2>
            <p className="text-[11px] sm:text-xs text-[#6272a4]">
              {isInterviewMode
                ? currentTopic
                  ? `Topic: ${currentTopic} — Question ${Math.min(currentQuestionIdx + 1, topicQuestions.length)} of ${topicQuestions.length}`
                  : 'Starting your interview...'
                : 'Relaxed conversation, just like a friend'}
            </p>
          </div>
        </div>

        {/* Mode Selector */}
        <div
          className="relative flex items-center gap-1.5 p-1 rounded-xl bg-[#282a36] border border-[#44475a] self-start sm:self-auto"
          onMouseEnter={() => setIsModeSelectorHovered(true)}
          onMouseLeave={() => setIsModeSelectorHovered(false)}
        >
          {(['Interview', 'Casual Chat'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => handleModeSwitch(m)}
              title={modeShortcutHint ? `Switch to ${m} (${modeShortcutHint})` : `Switch to ${m}`}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${
                selectedTopicMode === m
                  ? 'bg-[#bd93f9] text-[#282a36] font-bold shadow-sm'
                  : 'text-[#6272a4] hover:text-[#f8f8f2]'
              }`}
            >
              {m}
            </button>
          ))}
          {/* Hover-only shortcut hint — floats below the tabs so it never
              shifts layout, and is invisible unless the mouse is over the tabs */}
          {modeShortcutHint && (
            <kbd
              className={`hidden sm:block pointer-events-none absolute right-0 top-full mt-1 px-1.5 py-0.5 rounded border border-[#44475a] bg-[#21222c] font-mono text-[10px] text-[#8be9fd] transition-opacity duration-150 ${
                isModeSelectorHovered ? 'opacity-100' : 'opacity-0'
              }`}
            >
              {modeShortcutHint}
            </kbd>
          )}
        </div>
      </div>

      {/* Main Grid: Avatar & Chat Window */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5 sm:gap-4 items-stretch flex-1 min-h-0">
        {/* Seren Avatar & Tips Column (4 cols) — tips keep their natural height
            and the chat terminal stretches to match, so tips are never cut */}
        <div className="lg:col-span-4 flex flex-col min-h-0 space-y-2.5 sm:space-y-3">
          <div className="shrink-0 flex justify-center">
            <SerenAvatar
              mood={serenMood}
              currentSpeech={currentSpeech}
              isUserSpeaking={isRecording}
              speaking={serenTalking || isSerenSpeakingQ}
              idleMood="greeting"
              voiceEnabled={voiceEnabled}
              onToggleVoice={onToggleVoice}
              autoSpeak={false}
              hideSubtitle={true}
              className="w-full"
            />
          </div>

          {/* 1v1 Interview tips — fixed content, always fully visible */}
          {isInterviewMode && (
            <div className="w-full max-w-[320px] sm:max-w-[340px] mx-auto shrink-0 p-3 sm:p-3.5 rounded-2xl bg-[#282a36] border border-[#44475a] space-y-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-[#8be9fd] flex items-center gap-1.5">
                <Lightbulb className="w-3.5 h-3.5 text-[#f1fa8c]" />
                Examiner Tips for Your Interview
              </span>
              <ul className="space-y-1.5 text-[11px] leading-relaxed text-[#f8f8f2]/90 list-disc pl-4">
                <li>
                  Answer in <strong className="text-[#f8f8f2]">2–3 sentences</strong>: give your point, then back it up with a reason or a short example.
                </li>
                <li>
                  Buy think-time naturally — <em className="text-[#f8f8f2]">"That's an interesting question…"</em> is perfectly natural for examiners.
                </li>
                <li>
                  Link your ideas with one device per answer: <em className="text-[#f8f8f2]">Actually…</em>, <em className="text-[#f8f8f2]">As a matter of fact…</em>, <em className="text-[#f8f8f2]">On top of that…</em>.
                </li>
                <li>
                  Keep a steady, natural pace — clarity beats speed, and a calm pause is never penalised.
                </li>
                <li>
                  Sprinkle in one complex structure, e.g. <em className="text-[#f8f8f2]">"If I had to choose, I'd say…"</em>.
                </li>
              </ul>
            </div>
          )}

          {/* Casual chat quick prompts — fixed content, always fully visible */}
          {!isInterviewMode && (
            <div className="w-full max-w-[320px] sm:max-w-[340px] mx-auto shrink-0 p-3 sm:p-3.5 rounded-2xl bg-[#282a36] border border-[#44475a] space-y-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-[#6272a4] flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5 text-[#8be9fd]" />
                Quick Conversation Starters:
              </span>
              <div className="space-y-1.5">
                {[
                  "What's the best thing that happened to you this week?",
                  "If you could travel anywhere tomorrow, where would you go and why?",
                  "What hobby have you been enjoying lately?",
                  "Tell me a funny little story from your day.",
                ].map((p, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => handleSendMessage(p)}
                    className="w-full text-left p-2 rounded-xl bg-[#21222c] hover:bg-[#44475a] border border-[#44475a] hover:border-[#bd93f9]/50 text-[11px] text-[#f8f8f2]/90 transition-colors"
                  >
                    "{p}"
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Chat History & Input Terminal (8 cols) — height-capped so the
            messages ScrollArea scrolls internally; tips column is never clipped */}
        <div
          ref={chatWindowRef}
          className="lg:col-span-8 flex flex-col h-full min-h-0 rounded-2xl sm:rounded-3xl bg-[#282a36] border border-[#44475a] shadow-2xl backdrop-blur-md overflow-hidden"
          style={chatWindowHeight === null ? undefined : { height: `${chatWindowHeight}px` }}
        >

          {/* Messages Stream — bounded scroll area: the window keeps a fixed
              height and old messages scroll away instead of stretching the page */}
          <ScrollArea
            className={`${messageAreaHeight === null ? 'flex-1 max-h-[55vh] lg:max-h-none' : 'flex-none max-h-none'} p-3.5 sm:p-5 space-y-3 sm:space-y-4`}
            style={messageAreaHeight === null ? undefined : { height: `${messageAreaHeight}px` }}
          >
            {messages.map((msg, msgIdx) => {
              const isUser = msg.sender === 'user';
              const prevMsg = messages[msgIdx - 1];
              const showHeader = !prevMsg || prevMsg.sender !== msg.sender;

              // Small round avatar beside each message (messenger-style):
              // Seren uses her fixed profile picture; the user uses their photo.
              const AvatarBadge = isUser ? (
                <div
                  className="w-9 h-9 sm:w-10 sm:h-10 shrink-0 rounded-full border-2 border-[#ff79c6]/60 overflow-hidden shadow-md bg-[#21222c]"
                  title={userProfile.nickname}
                >
                  <img
                    src={userProfile.avatarUrl || USER_AVATAR_IMAGE}
                    alt={userProfile.nickname}
                    className="w-full h-full object-cover"
                    draggable={false}
                  />
                </div>
              ) : (
                <div className="w-9 h-9 sm:w-10 sm:h-10 shrink-0 rounded-full border-2 border-[#bd93f9]/50 overflow-hidden shadow-md bg-[#21222c]">
                  <img
                    src={SEREN_PROFILE_IMAGE}
                    alt="Seren"
                    className="w-full h-full object-cover"
                    draggable={false}
                  />
                </div>
              );

              return (
                <div
                  key={msg.id}
                  className={`group relative flex items-end gap-2 sm:gap-2.5 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}
                >
                  {/* Main avatar image beside the message */}
                  {AvatarBadge}

                  {/* Avatar image & text block under the avatar column */}
                  <div className={`flex flex-col max-w-[85%] sm:max-w-[80%] space-y-1.5 ${isUser ? 'items-end' : 'items-start'}`}>
                    {/* Name + timestamp above the message (only on first bubble of a run) */}
                    {showHeader ? (
                      <div
                        className={`flex items-center gap-1.5 text-[11px] text-[#6272a4] px-1 ${
                          isUser ? 'flex-row-reverse' : ''
                        }`}
                      >
                        <span className={`font-semibold ${isUser ? 'text-[#ff79c6]' : 'text-[#bd93f9]'}`}>
                          {isUser ? userProfile.nickname : 'Seren'}
                        </span>
                        <span>• {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        {msg.edited ? <span className="text-[10px] italic opacity-70">(edited)</span> : null}
                      </div>
                    ) : null}

                    {/* Inline editor when the user is editing this message (WhatsApp-style) */}
                    {editingMessageId === msg.id ? (
                      <div className="w-full p-2 rounded-2xl bg-[#21222c] border border-[#bd93f9]/50 shadow-md">
                        <textarea
                          autoFocus
                          value={editingText}
                          onChange={(e) => setEditingText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              handleEditMessage(msg.id, editingText);
                            }
                            if (e.key === 'Escape') {
                              setEditingMessageId(null);
                              setEditingText('');
                            }
                          }}
                          rows={2}
                          className="w-full resize-none bg-transparent text-xs sm:text-sm text-[#f8f8f2] outline-none placeholder-[#6272a4]"
                          placeholder="Edit your message..."
                        />
                        <div className="flex items-center justify-end gap-1.5 mt-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              setEditingMessageId(null);
                              setEditingText('');
                            }}
                            className="p-1.5 rounded-lg bg-[#282a36] border border-[#44475a] text-[#6272a4] hover:text-[#f8f8f2] transition-colors"
                            title="Cancel (Esc)"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleEditMessage(msg.id, editingText)}
                            disabled={!editingText.trim()}
                            className="p-1.5 rounded-lg bg-[#bd93f9]/20 border border-[#bd93f9]/50 text-[#bd93f9] hover:bg-[#bd93f9]/35 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                            title="Save (Enter)"
                          >
                            <Check className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div
                        className={`p-3.5 rounded-2xl text-xs sm:text-sm leading-relaxed ${
                          isUser
                            ? 'bg-[#bd93f9] text-[#282a36] font-medium rounded-br-none shadow-md shadow-[#bd93f9]/20'
                            : 'bg-[#21222c] border border-[#44475a] text-[#f8f8f2] rounded-bl-none shadow-md'
                        }`}
                      >
                        <p>{msg.text}</p>
                      </div>
                    )}

                    {/* WhatsApp-style hover actions (edit & delete) — reveal on
                        hover,tap-focused,or when editing */}
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                      <button
                        type="button"
                        onClick={() => startEditingMessage(msg)}
                        className="p-1 rounded-md bg-[#282a36] border border-[#44475a] text-[#6272a4] hover:text-[#bd93f9] hover:border-[#bd93f9]/50 transition-colors"
                        title="Edit message"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteMessage(msg.id)}
                        className="p-1 rounded-md bg-[#282a36] border border-[#44475a] text-[#6272a4] hover:text-[#ff5555] hover:border-[#ff5555]/50 transition-colors"
                        title="Delete message"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}

            {isLoading && (
              <div className="flex items-center gap-2 text-xs text-[#6272a4] italic">
                <span className="w-2 h-2 rounded-full bg-[#bd93f9] animate-ping" />
                {isInterviewMode
                  ? 'Seren is formulating your examiner feedback...'
                  : 'Seren is typing...'}
              </div>
            )}
            <div ref={messagesEndRef} />
          </ScrollArea>

          <div
            role="separator"
            aria-label="Resize chat messages area"
            aria-orientation="horizontal"
            onMouseDown={handleMessageAreaResizeStart}
            className="group flex h-2 shrink-0 cursor-ns-resize items-center justify-center border-y border-[#44475a]/60 bg-[#21222c] hover:bg-[#44475a]"
            title="Drag to resize the messages area"
          >
            <span className="h-0.5 w-10 rounded-full bg-[#6272a4] transition-colors group-hover:bg-[#bd93f9]" />
          </div>

          {/* Bottom Bar — messenger-style composer (Discord/WhatsApp-like) */}
          {isInterviewMode ? (
            <div className="shrink-0 p-3 sm:p-4 bg-[#21222c] border-t border-[#44475a]">
              <div className="flex items-end gap-2">
                {/* Mic / Stop / Ready button — always visible (disabled until
                    the interview is ready) so users always see the mic action,
                    like in Casual chat. */}
                {isEvaluating ? (
                  <div
                    className="p-3 rounded-2xl bg-[#282a36] border border-[#44475a] text-[#6272a4] opacity-60 shrink-0"
                    title="Generating your report..."
                  >
                    <Mic className="w-5 h-5" />
                  </div>
                ) : isRecording ? (
                  <button
                    id="interview-stop-btn"
                    type="button"
                    onClick={() => stopInterviewRecording()}
                    className="p-3 rounded-2xl bg-[#ff5555] border border-[#ff5555] text-[#f8f8f2] animate-pulse shadow-lg shadow-[#ff5555]/25 transition-all shrink-0"
                    title="Stop recording — Whisper transcribes, then press Send to send your answer"
                  >
                    <Square className="w-5 h-5" />
                  </button>
                ) : isTranscribing ? (
                  <div
                    className="p-3 rounded-2xl bg-[#282a36] border border-[#44475a] text-[#bd93f9] shrink-0"
                    title="Whisper is transcribing your recording..."
                  >
                    <Loader2 className="w-5 h-5 animate-spin" />
                  </div>
                ) : (
                  <button
                    id="interview-start-mic-btn"
                    type="button"
                    onClick={() => startInterviewRecording()}
                    disabled={false}
                    className="p-3 rounded-2xl bg-[#282a36] border border-[#44475a] text-[#50fa7b] hover:bg-[#44475a] transition-all shrink-0"
                    title={isSerenSpeakingQ ? 'Click to answer now (Seren will stop reading)' : 'Speak your answer'}
                  >
                    <Mic className="w-5 h-5" />
                  </button>
                )}

                {/* Always-visible multi-line composer (like WhatsApp / Discord) —
                    Equalizer while recording, Whisper transcript after;
                    Enter submits, Shift+Enter adds a newline */}
                <ChatInputBox
                  inputId="chat-text-input"
                  value={answerText}
                  onChange={updateAnswerText}
                  onSend={submitInterviewAnswer}
                  isRecording={isRecording}
                  isTranscribing={isTranscribing}
                  recordingHint="Listening — press stop, then Whisper transcribes your answer"
                  disabled={isEvaluating || !greetingDone || (!isInterviewActive && topicQuestions.length > 0)}
                  placeholder={
                    isEvaluating
                      ? 'Generating your report...'
                      : !isInterviewActive && topicQuestions.length > 0
                      ? 'Click "Evaluate My English" to see your results...'
                      : 'Type your answer (Enter to send) or use the mic...'
                  }
                  containerClassName="flex-1"
                />

                {/* Send button — always visible like Casual chat. Submits the
                    typed answer (or live-transcript text) to Seren. */}
                <button
                  id="interview-send-btn"
                  type="button"
                  onClick={() => submitInterviewAnswer()}
                  disabled={!answerText.trim() || isEvaluating || !greetingDone}
                  className={`p-3 rounded-2xl transition-all shrink-0 ${
                    answerText.trim() && !isEvaluating && greetingDone
                      ? 'bg-[#50fa7b] hover:bg-[#50fa7b]/90 text-[#282a36] shadow-md shadow-[#50fa7b]/25 scale-100'
                      : 'bg-[#44475a] text-[#6272a4] scale-95'
                  } disabled:cursor-not-allowed disabled:pointer-events-none`}
                  title="Send your answer (Enter)"
                >
                  <Send className="w-5 h-5" />
                </button>

                {/* Evaluate button (topic done) */}
                {!isInterviewActive && !isEvaluating && topicQuestions.length > 0 ? (
                  <button
                    id="evaluate-btn"
                    type="button"
                    onClick={handleEvaluate}
                    className="px-5 py-3 rounded-2xl bg-[#50fa7b] hover:bg-[#50fa7b]/90 text-[#282a36] font-bold text-xs sm:text-sm shadow-lg shadow-[#50fa7b]/25 transition-all flex items-center gap-2 shrink-0"
                  >
                    <Sparkles className="w-4 h-4" />
                    <span>Evaluate</span>
                  </button>
                ) : isEvaluating ? (
                  <div className="px-5 py-3 rounded-2xl bg-[#282a36] border border-[#44475a] flex items-center gap-2 shrink-0">
                    <Loader2 className="w-4 h-4 animate-spin text-[#bd93f9]" />
                    <span className="text-xs text-[#6272a4]">Evaluating...</span>
                  </div>
                ) : null}
              </div>

              {/* Speech-to-text status notice (mic blocked, Whisper unavailable,
                  unclear speech, etc.) — an empty box is never a silent mystery */}
              {sttNotice && (
                <p className="px-1 pt-2 text-[10px] leading-relaxed text-[#ffb86c] flex items-start gap-1.5">
                  <Info className="w-3 h-3 shrink-0 mt-0.5" />
                  <span>{sttNotice}</span>
                </p>
              )}
            </div>
          ) : (
            /* Casual chat mode: mic + text input + send */
            <div className="shrink-0 p-3 sm:p-4 bg-[#21222c] border-t border-[#44475a] space-y-2">
              <div className="flex items-end gap-2">
                <button
                  id="chat-toggle-mic-btn"
                  type="button"
                  onClick={handleToggleMic}
                  disabled={isTranscribing || isLoading}
                  className={`p-3 rounded-2xl border transition-all ${
                    isRecording
                      ? 'bg-[#ff5555] border-[#ff5555] text-[#f8f8f2] animate-pulse shadow-lg shadow-[#ff5555]/25'
                      : 'bg-[#282a36] border-[#44475a] text-[#50fa7b] hover:bg-[#44475a] disabled:opacity-50 disabled:cursor-not-allowed'
                  }`}
                  title={isTranscribing ? 'Transcribing your speech...' : isRecording ? 'Stop Recording' : 'Speak into microphone'}
                >
                  {isRecording ? <Square className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
                </button>

                {/* Multi-line composer — shows the live mic equalizer while
                    recording; Enter sends, Shift+Enter newlines */}
                <ChatInputBox
                  inputId="chat-text-input"
                  value={inputText}
                  onChange={handleInputChange}
                  onSend={() => handleSendMessage()}
                  isRecording={isRecording}
                  isTranscribing={isTranscribing}
                  recordingHint="Listening — press stop, then Whisper transcribes your speech"
                  disabled={isLoading}
                  placeholder="Type or speak your answer to Seren..."
                  autoFocus
                  containerClassName="flex-1"
                />

                <button
                  id="chat-send-btn"
                  type="button"
                  onClick={() => handleSendMessage()}
                  disabled={!inputText.trim() || isLoading}
                  className={`p-3 rounded-2xl transition-all shrink-0 ${
                    inputText.trim() && !isLoading
                      ? 'bg-[#bd93f9] hover:bg-[#bd93f9]/90 text-[#282a36] shadow-md shadow-[#bd93f9]/25 scale-100'
                      : 'bg-[#44475a] text-[#6272a4] scale-95'
                  } disabled:cursor-not-allowed disabled:pointer-events-none`}
                  title="Send (Enter)"
                >
                  <Send className="w-5 h-5" />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
