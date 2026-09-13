import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Mic,
  MicOff,
  Send,
  Sparkles,
  Lightbulb,
  Zap,
  Loader2,
  Info,
  Pencil,
  Trash2,
  Check,
  X,
} from 'lucide-react';
import { ChatMessage, UserProfile, SpeakingEvaluation, LumiMood, UpgradedExpression } from '../types';
import { ChatInputBox } from './ChatInputBox';
import { LumiAvatar } from './LumiAvatar';
import { ScrollArea } from './ScrollArea';
import { createSpeechRecognizer, lumiVoice, soundFX, activeAudioRecorder, transcribeAudioWithAI } from '../utils/speech';
import { getAutoMicEnabled } from '../utils/preferences';
import { useLumiMood, useMicMoodSync, normalizeReplyMood } from '../utils/lumiMood';
import { pickRandomTopic, getQuestionsByTopic, type IELTSPart1Question } from '../data/ieltsQuestionsP1';
import { LUMI_PROFILE_IMAGE, USER_AVATAR_IMAGE } from '../assets/characterAssets';
import { loadMessagesByMode, saveMessagesByMode, loadInterviewSession, saveInterviewSession } from '../utils/chatHistory';
import { greetInterview, casualSessionOpener, casualFallbackOpener } from '../utils/greetings';

interface LumiLiveChatProps {
  userProfile: UserProfile;
  evaluation?: SpeakingEvaluation | null;
  voiceEnabled: boolean;
  onToggleVoice: () => void;
  onPracticeEvaluationComplete?: (evaluation: SpeakingEvaluation) => void;
}

// Absolute ceiling for waiting on Lumi's speech before forcing the handoff —
// guards against a stalled TTS stream that never fires onEnd (90s).
const SPEECH_HANDOFF_CAP_MS = 90_000;

// The chat is a two-mode messenger (Interview / Casual Chat). New users land
// directly in the 1v1 Interview right after onboarding, and the last-used mode
// is remembered so returning users never lose their place when they come back
// to the chat tab.
const CHAT_MODE_KEY = 'lumi_chat_mode';

function loadSavedChatMode(): 'Interview' | 'Casual Chat' {
  try {
    const saved = localStorage.getItem(CHAT_MODE_KEY);
    if (saved === 'Interview' || saved === 'Casual Chat') return saved;
  } catch {}
  // No saved preference yet (fresh user / onboarding just completed) → the
  // interview is the post-onboarding experience.
  return 'Interview';
}

export const LumiLiveChat: React.FC<LumiLiveChatProps> = ({
  userProfile,
  evaluation,
  voiceEnabled,
  onToggleVoice,
  onPracticeEvaluationComplete,
}) => {
  const [inputText, setInputText] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  // Central mood state machine (src/utils/lumiMood.ts) — 'listening' is
  // mic-driven only; see useMicMoodSync below.
  const [lumiMood, setLumiMood] = useLumiMood();
  const [currentSpeech, setCurrentSpeech] = useState('');
  // Tracks whether Lumi is currently speaking (casual + interview audio), so the
  // chat avatar shows the "speaking" image while she talks and falls back to the
  // greeting image when idle.
  const [lumiTalking, setLumiTalking] = useState(false);
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
    try { return JSON.parse(localStorage.getItem('lumi_used_topics') || '[]'); } catch { return []; }
  });
  const [currentTopic, setCurrentTopic] = useState<string | null>(null);
  const [topicQuestions, setTopicQuestions] = useState<IELTSPart1Question[]>([]);
  const [currentQuestionIdx, setCurrentQuestionIdx] = useState(0);
  const [userAnswers, setUserAnswers] = useState<Record<number, string>>({});
  const [isInterviewActive, setIsInterviewActive] = useState(false);
  const [isLumiSpeakingQ, setIsLumiSpeakingQ] = useState(false);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [greetingDone, setGreetingDone] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const recognizerRef = useRef<any>(null);
  const [selectedLanguage, setSelectedLanguage] = useState('en-US');
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
  // Lumi greets and immediately starts a Part 1 topic from the question bank
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
        setIsLumiSpeakingQ(false);
        setGreetingDone(true);
        setIsEvaluating(false);
      } else {
        // Fresh user right after onboarding (or the last run finished & was
        // cleared) → jump straight into a new Part 1 topic interview.
        void startInterview();
      }
    } else if (messages.length === 0) {
      // Casual thread empty — Lumi opens the friendly conversation.
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
  const setMessagesForActiveMode = (updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
    setMessagesByMode((prev) => {
      const mode = modeRef.current;
      const current = prev[mode];
      const next = typeof updater === 'function' ? (updater as (p: ChatMessage[]) => ChatMessage[])(current) : updater;
      return { ...prev, [mode]: next };
    });
  };

  // Persist used topics
  useEffect(() => {
    try { localStorage.setItem('lumi_used_topics', JSON.stringify(usedTopics)); } catch {}
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

  // Initialize speech recognizer (for casual chat input)
  useEffect(() => {
    recognizerRef.current = createSpeechRecognizer({
      initialText: inputText,
      lang: selectedLanguage,
      onResult: (text) => setInputText(text),
      onStart: () => {
        setIsRecording(true);
        isRecordingRef.current = true;
      },
      onEnd: () => {
        setIsRecording(false);
        isRecordingRef.current = false;
      },
    });
    return () => recognizerRef.current?.stop();
  }, [selectedLanguage]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      recognizerRef.current?.stop();
      interviewRecognizerRef.current?.stop();
      interviewRecognizerRef.current = null;
      lumiVoice.stop();
      void activeAudioRecorder.stop().catch(() => {});
    };
  }, []);

  // ---- INTERVIEW MODE ----

  const liveTranscriptRef = useRef('');
  // The composer's editable answer box — shows live speech while recording
  // and doubles as the typed-answer input (Discord/WhatsApp style).
  const [answerText, setAnswerText] = useState('');
  const answerTextRef = useRef('');
  const updateAnswerText = (text: string) => {
    answerTextRef.current = text;
    setAnswerText(text);
  };
  // Surfaces speech-to-text problems (unsupported browser, permission denied,
  // network blocked) so an empty text box is never a silent mystery.
  const [sttNotice, setSttNotice] = useState('');
  // Copilot-style inline suggestion: when Whisper finishes refining a stopped
  // recording, the polished text is OFFERED here instead of silently replacing
  // the composer — the user accepts it (Tab / "Use it") or keeps their draft
  // (Esc / "Keep mine"). `target` says which composer the suggestion is for.
  const [ghostSuggestion, setGhostSuggestion] = useState<{ target: 'interview' | 'casual'; text: string } | null>(null);
  const interviewRecognizerRef = useRef<any>(null);
  // Guards against double-finalizing when the recognizer auto-ends at the
  // same moment the user clicks the stop button.
  const finalizingInterviewRef = useRef(false);

  // Stop the interview recording WITHOUT submitting: releases the microphone,
  // keeps the current speech in the composer, and AI-refines it so the user
  // sees the polished text. The user then reviews (optionally edits) and presses
  // Send to actually send the answer — stopping alone never submits.
  const stopInterviewRecording = useCallback(async () => {
    // Mutual exclusion with finalize: if a Send is already in progress, never
    // let a recognizer-originated stop interleave (which could repopulate the
    // composer or double-stop the recorder mid-advance).
    if (stoppingInterviewRef.current || finalizingInterviewRef.current) return;
    stoppingInterviewRef.current = true;

    if (interviewRecognizerRef.current) {
      try { interviewRecognizerRef.current.stop(); } catch (e) {}
      interviewRecognizerRef.current = null;
    }
    setIsRecording(false);
    isRecordingRef.current = false;

    const recordResult = await activeAudioRecorder.stop().catch(() => null);
    const draft = liveTranscriptRef.current || answerTextRef.current || '';
    const applyText = (text: string) => {
      if (text && text.trim()) updateAnswerText(text.trim());
    };

    // AI-refine the recorded speech (Whisper) so the text in the composer is
    // clean before the user sends it. The refined text is offered as a
    // Copilot-style inline suggestion — the user chooses it or keeps theirs.
    if (recordResult?.base64 && recordResult.base64.length > 50) {
      try {
        const refined = await transcribeAudioWithAI({
          audioBase64: recordResult.base64,
          mimeType: recordResult?.mimeType || 'audio/webm',
          draftTranscript: draft,
        });
        const clean = (refined || '').trim();
        if (clean && clean !== (draft || '').trim()) {
          setGhostSuggestion({ target: 'interview', text: clean });
        } else {
          applyText(draft);
        }
      } catch (e) {
        console.warn('Interview transcription refinement notice:', e);
        applyText(draft);
      }
    } else {
      applyText(draft);
    }

    stoppingInterviewRef.current = false;
  }, [selectedLanguage]);

  const startInterviewRecording = useCallback(() => {
    // Already recording / finalizing — never start a second recognizer/recorder.
    if (isRecordingRef.current || finalizingInterviewRef.current) return;

    // Self-heal: if the interview session isn't flagged active (e.g. after
    // navigating Casual ⇌ Interview), restore it so the mic always works.
    if (!isInterviewActiveRef.current) {
      setIsInterviewActive(true);
      setIsLumiSpeakingQ(false);
      setGreetingDone(true);
    }

    // If Lumi is still reading the question aloud, cut her off so the user's
    // answer doesn't overlap the question audio.
    lumiVoice.stop();

    soundFX.playChime('start');
    // Mood: 'listening' comes automatically from useMicMoodSync when
    // isRecording flips true (do NOT set it directly — the controller
    // ignores it). Keep the mic-driven rule intact.
    liveTranscriptRef.current = '';
    // A new recording invalidates any pending Whisper suggestion.
    setGhostSuggestion(null);
    setSttNotice('');

    // Arm the mic as soon as the start-chime's attack has passed (200 ms) so
    // the opening phrase of the answer is still captured. The old 400 ms wait
    // meant a user who started speaking right away lost the first words to
    // Whisper, which then refined a mid-sentence/out-of-context fragment.
    // The chime tail that remains is suppressed by echoCancellation on the
    // mic stream, exactly like the Cambridge/common-lesson recorder path.
    setTimeout(() => { activeAudioRecorder.start(); }, 200);

    const rec = createSpeechRecognizer({
      initialText: answerTextRef.current,
      lang: selectedLanguage,
      onResult: (text) => {
        liveTranscriptRef.current = text;
        updateAnswerText(text);
      },
      onStart: () => {
        setIsRecording(true);
        isRecordingRef.current = true;
      },
      onEnd: () => {
        // The recognizer ended on its own (silence timeout / browser limit) or
        // after a manual stop. Stop the audio and refine the speech into the
        // composer — we NEVER auto-submit. The user presses Send to send.
        void stopInterviewRecording();
      },
      onError: (err) => {
        if (err === 'not-allowed' || err === 'service-not-allowed') {
          setSttNotice('Microphone blocked for live text — allow mic access, or just type your answer. Your speech will still be transcribed by Whisper when you stop.');
        } else if (err === 'network') {
          setSttNotice('Live speech text is unavailable right now — keep talking, Whisper will transcribe your recording when you stop.');
        } else if (err !== 'no-speech' && err !== 'aborted') {
          setSttNotice(`Live speech text issue (${err}) — keep talking, Whisper will transcribe when you stop.`);
        }
      },
    });
    interviewRecognizerRef.current = rec;

    if (!rec.isSupported) {
      // No Web Speech API in this browser: still record via MediaRecorder so
      // Whisper can transcribe after the user stops, but say so plainly.
      setIsRecording(true);
      isRecordingRef.current = true;
      setSttNotice('Live speech text isn\u2019t supported in this browser — speak now; Whisper transcribes your recording when you stop (or type your answer).');
      return;
    }

    rec.start();
  }, [selectedLanguage]);

  // Finalize the current interview answer: always stops the recognizer AND the
  // media recorder completely (releasing the microphone), then saves the
  // response and advances to the next question. If the user typed/edited their
  // answer in the composer, overrideText takes priority over the transcription.
  const finalizeInterviewAnswer = useCallback(async (overrideText?: string) => {
    if (finalizingInterviewRef.current) return;
    finalizingInterviewRef.current = true;

    // Keep the mic-free moment visible: kill recognition + recorder first.
    if (interviewRecognizerRef.current) {
      try {
        interviewRecognizerRef.current.stop();
      } catch (e) {}
      interviewRecognizerRef.current = null;
    }
    setIsRecording(false);
    isRecordingRef.current = false;

    const recordResult = await activeAudioRecorder.stop().catch(() => null);
    const draftText = liveTranscriptRef.current || '';
    const typed = (overrideText || '').trim();

    let finalText = typed;
    // Always AI-refine the recorded speech (Whisper) when audio is present, so
    // the sent answer is polished even if the user hits Send mid-recording.
    // Falls back to the typed/edited text or the Web Speech draft otherwise.
    if (recordResult?.base64 && recordResult.base64.length > 50) {
      try {
        const refined = await transcribeAudioWithAI({
          audioBase64: recordResult.base64,
          mimeType: recordResult?.mimeType || 'audio/webm',
          draftTranscript: draftText || finalText,
        });
        if (refined && refined.trim()) {
          // The composer wins over Whisper: if the user typed or edited an
          // answer, that text is what they intend to send — silently swapping
          // it for tiny.en's transcription is exactly what caused "out of
          // context" messages. Whisper only supplies the text when there is
          // no typed answer (i.e. a pure voice reply).
          if (!typed) {
            finalText = refined.trim();
          }
        }
      } catch (e) {
        console.warn('Interview transcription refinement notice:', e);
      }
    } else if (!finalText) {
      finalText = draftText;
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
    // Sending the answer consumes/invalidates any pending suggestion.
    setGhostSuggestion(null);
    setUserAnswers((prev) => ({ ...prev, [idx]: finalText }));
    liveTranscriptRef.current = '';
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
    // The user can answer even while Lumi is still reading the question —
    // cut her speech off and submit their answer.
    if (isLumiSpeakingQ) {
      lumiVoice.stop();
      setIsLumiSpeakingQ(false);
    }
    void finalizeInterviewAnswer(answerText);
  }, [answerText, isLumiSpeakingQ, greetingDone, topicQuestions.length]);

  // Speech-aware handoff: wait until Lumi has ACTUALLY finished speaking before
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
      const speaking = lumiVoice.getIsSpeaking();
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
      setLumiMood('encouraging');
      const doneMsg: ChatMessage = {
        id: `msg-done-${Date.now()}`,
        sender: 'lumi',
        text: `Great job, ${userProfile.nickname}! That was the last question. Let's see how you did!`,
        timestamp: Date.now(),
        mood: 'encouraging',
      };
      setMessagesForActiveMode((prev) => [...prev, doneMsg]);
      setCurrentSpeech(doneMsg.text);
      if (voiceEnabled) {
        lumiVoice.speak(doneMsg.text, {});
      }
      setLumiMood('encouraging');
      return;
    }

    // A fresh question cycle starts here: clear the finalize guard so the user's
    // NEXT answer can be submitted (it must NOT be cleared in startInterviewRecording,
    // which runs mid-cycle and would let a duplicate/stale submit double-advance).
    finalizingInterviewRef.current = false;

    setCurrentQuestionIdx(idx);
    const q = topicQuestions[idx];
    setLumiMood('speaking');
    setIsLumiSpeakingQ(true);

    // Lumi asks the question as a chat bubble (messaging UI) and reads it aloud
    setCurrentSpeech(q.instruction);
    setMessagesForActiveMode((prev) => [
      ...prev,
      {
        id: `msg-q-${idx}-${Date.now()}`,
        sender: 'lumi',
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
      setIsLumiSpeakingQ(false);
      setCurrentSpeech('');
      setLumiMood('speaking');
      // Respect the mic preference: automatic opens the mic by itself after
      // Lumi reads the question; manual waits for the user to press the mic.
      if (getAutoMicEnabled()) {
        startInterviewRecording();
      }
    };

    if (voiceEnabled && q.instruction.trim()) {
      lumiVoice.speak(q.instruction, { onEnd: beginAnswering });
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

    // Lumi greets as a chat bubble (messaging UI) and reads it aloud.
    // Single-thread rule: the greeting is APPENDED to the continuous history,
    // never replacing what came before.
    const greetText = greetInterview(userProfile.nickname);
    setLumiMood('greeting');
    setCurrentSpeech(greetText);
    setMessagesForActiveMode((prev) => [
      ...prev,
      {
        id: `msg-greet-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        sender: 'lumi',
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
      setLumiMood('speaking');
      setTimeout(() => {
        askQuestionRef.current(0);
      }, 800);
    };

    if (voiceEnabled && greetText.trim()) {
      lumiVoice.speak(greetText, {
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
        sender: 'lumi',
        text: `Sorry, something went wrong with the evaluation. Please try again.`,
        timestamp: Date.now(),
        mood: 'speaking',
      };
      setMessagesForActiveMode((prev) => [...prev, errorMsg]);
    }
  }, [onPracticeEvaluationComplete, currentTopic, topicQuestions, userAnswers, userProfile]);

  // ---- CASUAL CHAT MODE ----
  // The avatar renders with autoSpeak={false} (LumiLiveChat owns all audio to
  // avoid double-speak races), so casual replies are voiced explicitly here.
  const speakText = useCallback(
    (text: string) => {
      if (voiceEnabled && text && text.trim()) {
        setLumiTalking(true);
        lumiVoice.speak(text, {
          onStart: () => setLumiTalking(true),
          onEnd: () => setLumiTalking(false),
        });
      }
    },
    [voiceEnabled]
  );

  const handleInputChange = (text: string) => {
    setInputText(text);
    recognizerRef.current?.setBaseTranscript(text);
  };

  const handleSendMessage = async (textToSend?: string) => {
    const text = (textToSend || inputText).trim();
    if (!text || isLoading) return;

    if (isRecording) {
      recognizerRef.current?.stop();
      setIsRecording(false);
      // Fully release the mic — the MediaRecorder keeps its stream alive
      // (browser mic indicator stays on) unless stopped too.
      void activeAudioRecorder.stop().catch(() => {});
    }

    recognizerRef.current?.reset();
    // Sending consumes/invalidates any pending Whisper suggestion.
    setGhostSuggestion(null);
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
    // The chat area already shows "Lumi is typing..." while we wait.
    setLumiMood('speaking');

    try {
      const res = await fetch('/api/lumi-chat', {
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
        const lumiMsg: ChatMessage = {
          id: `msg-lumi-${Date.now()}`,
          sender: 'lumi',
          text: data.reply.replyText,
          timestamp: Date.now(),
          mood: normalizeReplyMood(data.reply.mood),
          feedback: data.reply.feedback,
        };

        setMessagesForActiveMode((prev) => [...prev, lumiMsg]);
        setLumiMood(lumiMsg.mood || 'speaking');
        setCurrentSpeech(lumiMsg.text);
        speakText(lumiMsg.text);
        soundFX.playChime('ding');
      }
    } catch (e) {
      setIsLoading(false);
      const isCasual = selectedTopicMode !== 'Interview';
      const fallbackMsg: ChatMessage = {
        id: `msg-lumi-${Date.now()}`,
        sender: 'lumi',
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
      setLumiMood('speaking');
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
      // Keep a freshly-edited Lumi bubble in sync with the spoken subtext.
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

  const handleToggleMic = async () => {
    if (isRecording) {
      recognizerRef.current?.stop();
      setIsRecording(false);

      const recordResult = await activeAudioRecorder.stop();
      if (recordResult?.base64 && recordResult.base64.length > 50) {
        try {
          const refined = await transcribeAudioWithAI({
            audioBase64: recordResult.base64,
            mimeType: recordResult.mimeType,
            draftTranscript: inputText,
          });
          const clean = (refined || '').trim();
          if (clean && clean !== inputText.trim()) {
            // Copilot-style: offer the Whisper text instead of overwriting.
            setGhostSuggestion({ target: 'casual', text: clean });
          } else if (clean) {
            setInputText(clean);
          }
        } catch (e) {
          console.warn('Chat AI transcription notice:', e);
        }
      }
    } else {
      soundFX.playChime('start');
      // Cut off Lumi's still-streaming speech BEFORE arming the mic. If her
      // TTS is playing when the MediaRecorder opens, her voice gets recorded
      // from the speakers and Whisper then "refines" the answer into HER
      // words — a completely out-of-context transcript. Every other recording
      // flow (Cambridge test, custom lessons, interview mode below) stops
      // Lumi first; this casual-chat path was the only one that didn't.
      lumiVoice.stop();
      // A new recording invalidates any pending Whisper suggestion.
      setGhostSuggestion(null);
      recognizerRef.current?.setBaseTranscript(inputText);
      // Arm the mic as soon as the start-chime's attack has passed. Waiting
      // a full 400 ms let the user's opening phrase slip past the recorder,
      // so Whisper only heard a mid-sentence fragment and produced a
      // truncated/out-of-context refinement. (Chime tail is suppressed by the
      // echoCancellation on the mic stream, same as the Cambridge flow.)
      setTimeout(() => { activeAudioRecorder.start(); }, 200);
      recognizerRef.current?.start();
    }
  };

  const handleStartCasualSession = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/lumi-chat', {
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
        const lumiMsg: ChatMessage = {
          id: `msg-starter-${Date.now()}`,
          sender: 'lumi',
          text: data.reply.replyText,
          timestamp: Date.now(),
          mood: normalizeReplyMood(data.reply.mood),
          feedback: data.reply.feedback,
        };
        setMessagesForActiveMode((prev) => [...prev, lumiMsg]);
        setLumiMood(lumiMsg.mood || 'speaking');
        setCurrentSpeech(lumiMsg.text);
        speakText(lumiMsg.text);
        soundFX.playChime('ding');
      }
    } catch (e) {
      console.warn('Casual starter question unavailable:', e);
      setIsLoading(false);
      // Fall back to a built-in opener so the session still begins
      const fallbackMsg: ChatMessage = {
        id: `msg-starter-${Date.now()}`,
        sender: 'lumi',
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
  // each mode keeps its own history. Casual: Lumi keeps chatting as a friend.
  // Interview: she starts a practice run ONLY if the interview thread is empty
  // (switching back to an in-progress interview just resumes it).
  const handleModeSwitch = (mode: 'Interview' | 'Casual Chat') => {
    if (mode === selectedTopicMode) return;
    lumiVoice.stop();
    recognizerRef.current?.stop();
    if (interviewRecognizerRef.current) {
      interviewRecognizerRef.current.stop();
      interviewRecognizerRef.current = null;
    }
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
          setIsLumiSpeakingQ(false);
          setGreetingDone(true);
          setIsEvaluating(false);
        } else {
          // Nothing resumable (e.g. the run was finished and evaluated, which
          // clears the session): start a fresh interview appended to history.
          startInterview();
        }
      }
    } else {
      // Back to the friendly chat — history intact, Lumi stays available.
      setCurrentTopic(null);
      setTopicQuestions([]);
      setUserAnswers({});
      setCurrentQuestionIdx(0);
      setIsInterviewActive(false);
      setIsLumiSpeakingQ(false);
      setIsEvaluating(false);
      setGreetingDone(true);
      setLumiMood('speaking');
      setCurrentSpeech('');
    }
  };

  const isInterviewMode = selectedTopicMode === 'Interview';

  return (
    <div id="lumi-live-chat-view" className="w-full max-w-6xl mx-auto flex flex-col flex-1 h-full min-h-0 space-y-2.5 sm:space-y-3">
      {/* Top Banner */}
      <div className="shrink-0 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 sm:gap-4 px-3.5 py-2 sm:px-4 sm:py-2.5 rounded-xl sm:rounded-2xl bg-[#21222c] border border-[#44475a] backdrop-blur-md">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-full border-2 border-[#bd93f9]/60 overflow-hidden shadow-md bg-[#21222c] shrink-0">
            <img
              src={LUMI_PROFILE_IMAGE}
              alt="Lumi"
              className="w-full h-full object-cover"
              draggable={false}
            />
          </div>
          <div>
            <h2 className="text-sm sm:text-base font-bold text-[#f8f8f2] flex items-center gap-2">
              1v1 Chat with Lumi
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
        <div className="flex items-center gap-1.5 p-1 rounded-xl bg-[#282a36] border border-[#44475a] self-start sm:self-auto">
          {(['Interview', 'Casual Chat'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => handleModeSwitch(m)}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${
                selectedTopicMode === m
                  ? 'bg-[#bd93f9] text-[#282a36] font-bold shadow-sm'
                  : 'text-[#6272a4] hover:text-[#f8f8f2]'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {/* Main Grid: Avatar & Chat Window */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5 sm:gap-4 items-stretch flex-1 min-h-0 overflow-hidden">
        {/* Lumi Avatar & Tips Column (4 cols) — tips keep their natural height
            and the chat terminal stretches to match, so tips are never cut */}
        <div className="lg:col-span-4 flex flex-col min-h-0 space-y-2.5 sm:space-y-3">
          <div className="shrink-0 flex justify-center">
            <LumiAvatar
              mood={lumiMood}
              currentSpeech={currentSpeech}
              isUserSpeaking={isRecording}
              speaking={lumiTalking || isLumiSpeakingQ}
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
            <div className="shrink-0 p-3 sm:p-3.5 rounded-2xl bg-[#282a36] border border-[#44475a] space-y-2">
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
            <div className="shrink-0 p-3 sm:p-3.5 rounded-2xl bg-[#282a36] border border-[#44475a] space-y-2">
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
        <div className="lg:col-span-8 flex flex-col h-full min-h-0 lg:max-h-[calc(100dvh-9rem)] rounded-2xl sm:rounded-3xl bg-[#282a36] border border-[#44475a] shadow-2xl backdrop-blur-md overflow-hidden">

          {/* Messages Stream — bounded scroll area: the window keeps a fixed
              height and old messages scroll away instead of stretching the page */}
          <ScrollArea className="flex-1 max-h-[55vh] lg:max-h-none p-3.5 sm:p-5 space-y-3 sm:space-y-4">
            {messages.map((msg, msgIdx) => {
              const isUser = msg.sender === 'user';
              const prevMsg = messages[msgIdx - 1];
              const showHeader = !prevMsg || prevMsg.sender !== msg.sender;

              // Small round avatar beside each message (messenger-style):
              // Lumi uses her fixed profile picture; the user uses their photo.
              const AvatarBadge = isUser ? (
                <div
                  className="w-9 h-9 sm:w-10 sm:h-10 shrink-0 rounded-full border-2 border-[#ff79c6]/60 overflow-hidden shadow-md bg-[#21222c]"
                  title={userProfile.nickname}
                >
                  <img
                    src={USER_AVATAR_IMAGE}
                    alt={userProfile.nickname}
                    className="w-full h-full object-cover"
                    draggable={false}
                  />
                </div>
              ) : (
                <div className="w-9 h-9 sm:w-10 sm:h-10 shrink-0 rounded-full border-2 border-[#bd93f9]/50 overflow-hidden shadow-md bg-[#21222c]">
                  <img
                    src={LUMI_PROFILE_IMAGE}
                    alt="Lumi"
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
                          {isUser ? userProfile.nickname : 'Lumi'}
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
                  ? 'Lumi is formulating your examiner feedback...'
                  : 'Lumi is typing...'}
              </div>
            )}
            <div ref={messagesEndRef} />
          </ScrollArea>

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
                    title="Stop recording (press Send to send your answer)"
                  >
                    <MicOff className="w-5 h-5" />
                  </button>
                ) : (
                  <button
                    id="interview-start-mic-btn"
                    type="button"
                    onClick={() => startInterviewRecording()}
                    disabled={false}
                    className="p-3 rounded-2xl bg-[#282a36] border border-[#44475a] text-[#50fa7b] hover:bg-[#44475a] transition-all shrink-0"
                    title={isLumiSpeakingQ ? 'Click to answer now (Lumi will stop reading)' : 'Speak your answer'}
                  >
                    <Mic className="w-5 h-5" />
                  </button>
                )}

                {/* Always-visible multi-line composer (like WhatsApp / Discord) —
                    live speech appears here while recording; Enter submits,
                    Shift+Enter adds a newline */}
                <ChatInputBox
                  inputId="chat-text-input"
                  value={answerText}
                  onChange={updateAnswerText}
                  onSend={submitInterviewAnswer}
                  ghostSuggestion={ghostSuggestion?.target === 'interview' ? ghostSuggestion.text : null}
                  onGhostAccept={() => {
                    if (ghostSuggestion?.target === 'interview') {
                      updateAnswerText(ghostSuggestion.text);
                      setGhostSuggestion(null);
                    }
                  }}
                  onGhostDismiss={() => setGhostSuggestion((g) => (g?.target === 'interview' ? null : g))}
                  disabled={isEvaluating || !greetingDone || (!isInterviewActive && topicQuestions.length > 0)}
                  placeholder={
                    isEvaluating
                      ? 'Generating your report...'
                      : isRecording
                      ? 'Listening — speak now...'
                      : !isInterviewActive && topicQuestions.length > 0
                      ? 'Click "Evaluate My English" to see your results...'
                      : 'Type your answer (Enter to send) or use the mic...'
                  }
                  containerClassName="flex-1"
                />

                {/* Send button — always visible like Casual chat. Submits the
                    typed answer (or live-transcript text) to Lumi. */}
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

              {/* Speech-to-text status notice (unsupported browser, mic blocked,
                  network error, etc.) — an empty box is never a silent mystery */}
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
                  className={`p-3 rounded-2xl border transition-all ${
                    isRecording
                      ? 'bg-[#ff5555] border-[#ff5555] text-[#f8f8f2] animate-pulse shadow-lg shadow-[#ff5555]/25'
                      : 'bg-[#282a36] border-[#44475a] text-[#50fa7b] hover:bg-[#44475a]'
                  }`}
                  title={isRecording ? 'Stop Recording' : 'Speak into microphone'}
                >
                  {isRecording ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
                </button>

                {/* Multi-line composer — grows with content, Enter sends,
                    Shift+Enter newlines; caret follows live speech */}
                <ChatInputBox
                  inputId="chat-text-input"
                  value={inputText}
                  onChange={handleInputChange}
                  onSend={() => handleSendMessage()}
                  ghostSuggestion={ghostSuggestion?.target === 'casual' ? ghostSuggestion.text : null}
                  onGhostAccept={() => {
                    if (ghostSuggestion?.target === 'casual') {
                      setInputText(ghostSuggestion.text);
                      setGhostSuggestion(null);
                    }
                  }}
                  onGhostDismiss={() => setGhostSuggestion((g) => (g?.target === 'casual' ? null : g))}
                  disabled={isLoading}
                  placeholder={
                    isRecording
                      ? 'Listening to your speech...'
                      : 'Type or speak your answer to Lumi...'
                  }
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
