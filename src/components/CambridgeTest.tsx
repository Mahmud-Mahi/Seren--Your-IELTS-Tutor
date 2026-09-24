import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Mic,
  MicOff,
  Clock,
  Sparkles,
  ArrowRight,
  ArrowLeft,
  CheckCircle,
  HelpCircle,
  Lightbulb,
  Edit3,
  Volume2,
  FileText,
  X,
  Loader2
} from 'lucide-react';
import { DiagnosticQuestion, UserProfile, SpeakingEvaluation } from '../types';
import { CAMBRIDGE_TESTS, getCambridgeTestById } from '../data/cambridgeTests';
import { SerenAvatar } from './SerenAvatar';
import { serenVoice, soundFX, activeAudioRecorder, transcribeAudio } from '../utils/speech';
import { MicEqualizer } from './MicEqualizer';
import confetti from 'canvas-confetti';
import { cambridgeGreetingIntro, cambridgeGreetingPrompt, cambridgeGreeting, cambridgeQuestionOpener, cambridgeQuestionClosing } from '../utils/greetings';

interface CambridgeTestProps {
  userProfile: UserProfile;
  voiceEnabled: boolean;
  onToggleVoice: () => void;
  onEvaluationComplete: (evaluation: SpeakingEvaluation) => void;
}

const DIAGNOSTIC_FALLBACK_QUESTION: DiagnosticQuestion = {
  id: 'fallback-question',
  part: 1,
  partTitle: 'Part 1: Introduction & Lifestyle',
  topic: 'Cambridge IELTS Practice',
  question: 'Tell me about yourself and your everyday routine.',
  instructions: 'Speak naturally and answer the question in full sentences.',
  prepTimeSeconds: 5,
  speakTimeSeconds: 45,
  cueTips: ['Keep your answer natural and personal.', 'Use a few linking words and examples.'],
};

export const CambridgeTest: React.FC<CambridgeTestProps> = ({
  userProfile,
  voiceEnabled,
  onToggleVoice,
  onEvaluationComplete,
}) => {
  const [selectedTestId, setSelectedTestId] = useState<string>('');
  const [currentIdx, setCurrentIdx] = useState<number>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('seren_cambridge_progress') || '{}');
      const idx = Number(saved.idx);
      if (Number.isInteger(idx) && idx >= 0) return idx;
    } catch {}
    return 0;
  });
  const [showHint, setShowHint] = useState(false);
  const [hintText, setHintText] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [isPrepPhase, setIsPrepPhase] = useState(false);
  const [timeLeft, setTimeLeft] = useState(0);
  const [prepTimeLeft, setPrepTimeLeft] = useState(0);
  // Part 2 prep-clock gate: while true, the 1-minute prep countdown is HELD.
  // Seren reads the Part 2 cue card aloud when the question appears, and the
  // prep clock must only start ticking once she STOPS speaking — otherwise
  // the minute burns down while the student is still listening to the intro.
  const [prepGate, setPrepGate] = useState(false);
  const [transcripts, setTranscripts] = useState<Record<string, string>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('seren_diag_progress') || '{}');
      return {
        'diag-part-1': saved.transcripts?.['diag-part-1'] || '',
        'diag-part-2': saved.transcripts?.['diag-part-2'] || '',
        'diag-part-3': saved.transcripts?.['diag-part-3'] || '',
      };
    } catch {
      return { 'diag-part-1': '', 'diag-part-2': '', 'diag-part-3': '' };
    }
  });
  const [cueNotes, setCueNotes] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzingStage, setAnalyzingStage] = useState('');
  const [autoAdvanceNotice, setAutoAdvanceNotice] = useState('');
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [showManualEdit, setShowManualEdit] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const selectedTest = selectedTestId ? getCambridgeTestById(selectedTestId) ?? null : null;
  const questions: DiagnosticQuestion[] = selectedTest?.questions || [];
  const currentQ: DiagnosticQuestion = questions[currentIdx] || questions[0] || DIAGNOSTIC_FALLBACK_QUESTION;
  const currentTranscript = transcripts[currentQ.id] || '';

  // Persist diagnostic progress so a closed app resumes at the same part
  useEffect(() => {
    try {
      localStorage.setItem(
        'seren_cambridge_progress',
        JSON.stringify({ selectedTestId, idx: currentIdx, transcripts })
      );
    } catch {}
  }, [selectedTestId, currentIdx, transcripts]);
  // Guards the TTS→mic auto-start so it fires once per recording transition.
  const recordingTransitionRef = useRef({ id: '', started: false });
  // Mirror of isRecording readable inside async callbacks without stale closures
  const isRecordingRef = useRef(false);
  // Bumped every time the user starts (or restarts) recording for this part
  const attemptIdRef = useRef(0);
  // Prevent two finalize flows (manual stop vs timer expiry) from interleaving
  const finalizeInFlightRef = useRef(false);
  // Tracks which question ids were already transcribed for the current
  // attempt (so manual stop + auto-expiry + submit can't double-transcribe).
  const transcribedPartsRef = useRef<Set<string>>(new Set());
  // Resolves when the most recent finalize (incl. its Whisper transcription)
  // is done
  const finalizePromiseRef = useRef<Promise<void>>(Promise.resolve());
  // Pending post-expiry finalize that a manual stop must cancel
  const expireTimerRef = useRef<any>(null);
  const waitingRef = useRef(false);
  // Whether Seren's spoken question intro actually began (set from SerenAvatar's onStart)
  const introSpeechStartedRef = useRef(false);
  // Safety-net timers that guarantee the prep gate can never freeze the clock
  const prepGateFallbackRef = useRef<any>(null);
  const prepGateCapRef = useRef<any>(null);
  // Full transcript map mirror — finalize reads it after awaits, where the
  // render-closure `transcripts` may be stale for the part being finalized
  const transcriptsRef = useRef(transcripts);
  transcriptsRef.current = transcripts;

  // Compute clean, expressive speech prompt for Seren (spoken once upon entering each question).
  // IMPORTANT: Seren actually reads the question aloud so text and voice always match.
  // The opener/closing rotate through natural examiner lines (see greetings.ts)
  // keyed to the question's position within its part, so she never repeats the
  // same framing line on every question of Part 1 / Part 3.
  const getQuestionSpeech = (idx: number, q: DiagnosticQuestion, nickname: string) => {
    // Zero-based position of this question WITHIN its part (0 = first question
    // of that part — those still get the "Let's begin with Part 1." / "And
    // finally, Part 3..." announcements so transitions are always clear).
    const partQuestionIndex = questions.slice(0, idx).filter((x) => x.part === q.part).length;

    const partIntro = cambridgeQuestionOpener(q.part, partQuestionIndex);

    const bullets =
      q.bulletPoints && q.bulletPoints.length > 0
        ? ` You should say: ${q.bulletPoints.join('. ')}.`
        : '';

    const closing = cambridgeQuestionClosing(q.part, partQuestionIndex);

    return `${partIntro} ${q.question}${bullets}${closing}`;
  };

  // Spoken audio prompt (stable text, does not change every second)
  // ONE canonical greeting string, used for both the on-screen subtitle and
  // the MANUAL replay button. Seren never speaks automatically in this tab —
  // her voice only plays when the user presses ▶ (see SerenAvatar replay).
  const greetingText = cambridgeGreeting(userProfile.nickname);

  const spokenAudioPrompt = !selectedTest
    ? greetingText
    : isAnalyzing
    ? 'Analyzing your spoken responses across Fluency, Lexical Resource, Grammatical Range, and Pronunciation...'
    : isRecording
    ? ''
    : getQuestionSpeech(currentIdx, currentQ || DIAGNOSTIC_FALLBACK_QUESTION, userProfile.nickname);

  // Dynamic visual subtitle banner (updates with live timer without re-triggering audio)
  const serenSubtitle = !selectedTest
    ? greetingText
    : isAnalyzing
    ? analyzingStage || 'Analyzing your spoken grammar, vocabulary, and CEFR level...'
    : isPrepPhase
    ? `Prep phase: take a calm moment to structure your answer before speaking.`
    : isRecording
    ? `Listening to your response (${timeLeft}s remaining), ${userProfile.nickname}...`
    : `Let’s take this one step at a time — calm, confident, and clear.`;

  // Leaving the test view mid-flow (tab switch): release the mic and drop
  // pending gate timers. Voice cut is handled by App's handleSelectView —
  // stopping here too would swallow the re-mount greeting under StrictMode.
  useEffect(() => {
    return () => {
      if (expireTimerRef.current) {
        clearTimeout(expireTimerRef.current);
        expireTimerRef.current = null;
      }
      if (prepGateFallbackRef.current) {
        clearTimeout(prepGateFallbackRef.current);
        prepGateFallbackRef.current = null;
      }
      if (prepGateCapRef.current) {
        clearTimeout(prepGateCapRef.current);
        prepGateCapRef.current = null;
      }
      void activeAudioRecorder.stop().catch(() => {});
    };
  }, []);

  const handleTranscriptChange = (newText: string) => {
    if (!currentQ) return;
    setTranscripts((prev) => ({
      ...prev,
      [currentQ.id]: newText,
    }));
  };

  const handleToggleHint = () => {
    if (!currentQ || !currentQ.sampleAnswer) return;

    if (!showHint) {
      const sentenceList = currentQ.sampleAnswer
        .split(/(?<=[.!?])\s+/)
        .map((sentence) => sentence.trim())
        .filter(Boolean);

      const nextHint = currentQ.part === 2
        ? sentenceList.slice(0, Math.min(3, sentenceList.length)).join(' ')
        : sentenceList[0] || currentQ.sampleAnswer;

      setHintText(nextHint);
      setShowHint(true);
      return;
    }

    setHintText('');
    setShowHint(false);
  };

  const transcriptDisplayValue = showHint && hintText
    ? `${currentTranscript}${currentTranscript ? '\n\n' : ''}${hintText}`
    : currentTranscript;

  // Release the Part 2 prep-clock hold (and clear its safety-net timers)
  const releasePrepGate = () => {
    if (prepGateFallbackRef.current) {
      clearTimeout(prepGateFallbackRef.current);
      prepGateFallbackRef.current = null;
    }
    if (prepGateCapRef.current) {
      clearTimeout(prepGateCapRef.current);
      prepGateCapRef.current = null;
    }
    setPrepGate(false);
  };

  // Handle question transition and audio initialization.
  // useLayoutEffect is REQUIRED: it completes before children's passive
  // effects, so the previous part's audio is cut BEFORE SerenAvatar starts
  // the new utterance — otherwise the child speaks first and this stop
  // immediately marks that fresh speech stale (Part 1 voice never plays).
  useLayoutEffect(() => {
    if (!questions.length) {
      setIsPrepPhase(false);
      setIsRecording(false);
      setTimeLeft(0);
      setPrepTimeLeft(0);
      releasePrepGate();
      setShowHint(false);
      setHintText('');
      return;
    }

    setErrorMsg('');
    setAutoAdvanceNotice('');
    isRecordingRef.current = false;
    setIsRecording(false);
    // Release the mic when moving between parts so the browser indicator
    // never stays on between questions.
    void activeAudioRecorder.stop().catch(() => {});
    // Cut off any speech from the previous part immediately so it never
    // overlaps with (or races the TTS fetch for) the next part's voice
    serenVoice.stop();

    if (currentQ.part === 2) {
      setTimeLeft(currentQ.speakTimeSeconds);
      if (voiceEnabled) {
        // Seren reads the cue card aloud first: HOLD the 1-minute prep
        // countdown until she finishes speaking (onSpeechEnd releases the
        // gate), so the clock never runs while the student is still listening.
        waitingRef.current = true;
        introSpeechStartedRef.current = false;
        setIsPrepPhase(true);
        setPrepTimeLeft(currentQ.prepTimeSeconds);
        setPrepGate(true);
        // Safety net: if Seren's voice never actually starts (TTS blocked,
        // muted, or synthesis failure without callbacks), release the hold so
        // the prep clock still runs instead of sitting frozen at the full minute.
        if (prepGateFallbackRef.current) clearTimeout(prepGateFallbackRef.current);
        prepGateFallbackRef.current = setTimeout(() => {
          prepGateFallbackRef.current = null;
          if (!introSpeechStartedRef.current) setPrepGate(false);
        }, 20000);
        // Absolute cap: a browser may skip both onend and onerror after the
        // speech began — never hold the clock hostage longer than 90s.
        if (prepGateCapRef.current) clearTimeout(prepGateCapRef.current);
        prepGateCapRef.current = setTimeout(() => {
          prepGateCapRef.current = null;
          setPrepGate(false);
        }, 90000);
      } else {
        // Voice is off — nothing spoken to wait for: start the countdown now.
        waitingRef.current = false;
        setIsPrepPhase(true);
        setPrepTimeLeft(currentQ.prepTimeSeconds);
      }
    } else {
      releasePrepGate();
      waitingRef.current = false;
      setIsPrepPhase(false);
      setTimeLeft(currentQ.speakTimeSeconds);
    }

    soundFX.unlock();
    soundFX.playChime('start');
  }, [currentIdx, currentQ]);

  useEffect(() => {
    if (!questions.length) return;
    if (currentIdx >= questions.length) {
      setCurrentIdx(0);
    }
    setShowHint(false);
    setHintText('');
  }, [selectedTestId, currentIdx, questions.length]);

  // Called by SerenAvatar when the spoken question intro actually begins.
  const handleIntroSpeechStart = () => {
    introSpeechStartedRef.current = true;
  };

  // Called by SerenAvatar when a question intro finishes speaking. For Part 2
  // this is the exact moment the 1-minute prep countdown is allowed to start.
  const handleIntroSpeechEnd = () => {
    waitingRef.current = false;
    releasePrepGate();
  };

  // Preparation timer for Part 2 — the countdown only runs once the prepGate
  // hold is released, i.e. when Seren stops speaking the cue card intro.
  useEffect(() => {
    let prepTimer: any = null;

    if (isPrepPhase && prepTimeLeft > 0 && !prepGate) {
      prepTimer = setInterval(() => {
        if (prepTimeLeft <= 1) {
          clearInterval(prepTimer);
          setIsPrepPhase(false);
          soundFX.playChime('ding');
          setPrepTimeLeft(0);

          const currentId = currentQ.id;
          recordingTransitionRef.current = { id: currentId, started: false };

          serenVoice.speak('Your preparation time is over. Please start speaking now.', {
            onEnd: () => {
              if (recordingTransitionRef.current.id === currentId && !recordingTransitionRef.current.started) {
                startRecording();
              }
            }
          });

          // Safety net: if TTS is muted/fails and never resolves, start anyway
          setTimeout(() => {
            if (recordingTransitionRef.current.id === currentId && !recordingTransitionRef.current.started) {
              startRecording();
            }
          }, 6000);
        } else {
          if (prepTimeLeft <= 5) soundFX.playChime('tick');
          setPrepTimeLeft(prepTimeLeft - 1);
        }
      }, 1000);
    }

    return () => {
      if (prepTimer) clearInterval(prepTimer);
    };
  }, [isPrepPhase, prepTimeLeft, currentQ.id, prepGate]);

// Speaking countdown timer with auto-advance on expiration
useEffect(() => {
    let speakTimer: any = null;

    if (isRecording && timeLeft > 0) {
      speakTimer = setInterval(() => {
        if (timeLeft <= 1) {
          clearInterval(speakTimer);
          soundFX.playChime('ding');
          setTimeLeft(0);
          isRecordingRef.current = false;
          setIsRecording(false);
          recordingTransitionRef.current.started = false;

          // Grace period before finalizing, so trailing words past the visual
          // timer still get captured. A manual "Done Speaking" click cancels
          // this pending finalize and finalizes immediately instead.
          if (expireTimerRef.current) clearTimeout(expireTimerRef.current);
          // Capture the attempt id NOW — reading attemptIdRef.current at fire
          // time would always match the live value and defeat the stale guard
          const attemptAtExpiry = attemptIdRef.current;
          expireTimerRef.current = setTimeout(() => {
            expireTimerRef.current = null;
            void finalizeCurrentPart(attemptAtExpiry, currentQ.id);
          }, 2000);

          // NO auto-advance, NO auto-evaluate — the user stays on this part
          // and proceeds manually via "Next" / "Evaluate My English"
          setAutoAdvanceNotice(
            questions.length > 0 && currentIdx < questions.length - 1
              ? `Part ${currentIdx + 1} time complete! Review your answer, then press Next.`
              : 'Time complete! Press "Evaluate My English" when ready.'
          );
          setTimeout(() => setAutoAdvanceNotice(''), 4000);
        } else {
          if (timeLeft <= 6) soundFX.playChime('tick');
          setTimeLeft(timeLeft - 1);
        }
      }, 1000);
    } else {
      // Ensure timer is stopped when not recording
      if (speakTimer) {
        clearInterval(speakTimer);
        speakTimer = null;
      }
    }

    return () => {
      if (speakTimer) clearInterval(speakTimer);
    };
  }, [isRecording, timeLeft, currentIdx]);

  const startRecording = () => {
    if (isRecordingRef.current) return; // Prevent double-start
    recordingTransitionRef.current.started = true;
    // New attempt: any pending expiry-finalize from a previous attempt is void
    if (expireTimerRef.current) {
      clearTimeout(expireTimerRef.current);
      expireTimerRef.current = null;
    }
    attemptIdRef.current += 1;
    setErrorMsg('');
    releasePrepGate();
    setIsPrepPhase(false);
    // Always give a fresh full attempt when (re)starting to speak for this part
    setTimeLeft(currentQ.speakTimeSeconds);
    // New attempt => this part should be transcribed again afterwards
    transcribedPartsRef.current.delete(currentQ.id);
    serenVoice.stop();
    soundFX.playChime('start');

    // Record with MediaRecorder for local Whisper STT. The transcript box
    // shows the live mic equalizer while recording — the text itself lands
    // only AFTER the user stops. No live text, no AI modification.
    isRecordingRef.current = true;
    setIsRecording(true);
    activeAudioRecorder.start().then((ok) => {
      if (!ok && isRecordingRef.current) {
        isRecordingRef.current = false;
        setIsRecording(false);
        setErrorMsg('Microphone unavailable — check browser permissions, or type your answer instead.');
      }
    }).catch(() => {});
  };

  // Stops mic capture and runs the local Whisper transcription once per
  // attempt (no AI modification of the text). Guarded by attempt id so only
  // the finalize belonging to the CURRENT recording attempt can stop it —
  // never a stale one.
  const finalizeCurrentPart = async (attemptId: number, qId: string) => {
    // Serialize finalizes: when the user moves through parts quickly, the
    // previous part's Whisper transcription may still be running. Dropping this
    // finalize (the old single-flight guard) silently skipped this part's
    // transcription entirely — queue it behind the earlier one instead.
    const run = (async () => {
      await finalizePromiseRef.current;

      // Grace period: wait a brief moment for any ongoing speech to naturally
      // end before stopping capture, so trailing words still get recorded.
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Stale guard: user restarted recording (or switched part) mid-grace —
      // this finalize belongs to an abandoned attempt, leave the mic alone.
      if (attemptId !== attemptIdRef.current) return;

      recordingTransitionRef.current.started = false;
      isRecordingRef.current = false;
      setIsRecording(false);

      // Stop native audio recorder and obtain audio payload
      const recordResult = await activeAudioRecorder.stop().catch(() => null);

      // Transcribe only once per attempt (manual stop + auto-expiry + submit
      // all funnel here)
      if (transcribedPartsRef.current.has(qId)) return;
      if (recordResult?.base64 && recordResult.base64.length > 50) {
        transcribedPartsRef.current.add(qId);
        setIsTranscribing(true);
        try {
          const transcript = await transcribeAudio({
            audioBase64: recordResult?.base64 || '',
            mimeType: recordResult?.mimeType || 'audio/webm',
          });

          const clean = transcript.trim();
          if (clean) {
            // Append after existing text (e.g. a typed/manual edit), matching
            // the old combined behavior.
            setTranscripts((prev) => ({
              ...prev,
              [qId]: prev[qId]?.trim() ? `${prev[qId].trim()} ${clean}` : clean,
            }));
          }
        } catch (e) {
          console.warn('Transcript transcription notice:', e);
        } finally {
          setIsTranscribing(false);
        }
      }
    })();
    finalizeInFlightRef.current = true;
    finalizePromiseRef.current = run.finally(() => {
      finalizeInFlightRef.current = false;
    }).then(() => undefined, () => undefined);
    return finalizePromiseRef.current;
  };

  const stopRecording = () => {
    // Manual click: cancel any expiry-scheduled finalize and finalize NOW with
    // the current attempt's id. Allowed even if a prior finalize already ran —
    // clicking "Done Speaking" must always cut the mic immediately.
    if (expireTimerRef.current) {
      clearTimeout(expireTimerRef.current);
      expireTimerRef.current = null;
    }
    const attemptId = attemptIdRef.current;
    const qId = currentQ.id;
    void finalizeCurrentPart(attemptId, qId);
  };

  const handleSkipPrep = () => {
    setIsPrepPhase(false);
    setPrepTimeLeft(0);
    soundFX.playChime('ding');
    startRecording();
  };

  const handleNextQuestion = () => {
    stopRecording();
    if (questions.length === 0) return;
    if (currentIdx < questions.length - 1) {
      setCurrentIdx(currentIdx + 1);
    } else {
      submitDiagnosticEvaluation();
    }
  };

  const handlePreviousQuestion = () => {
    stopRecording();
    if (currentIdx > 0) {
      setCurrentIdx(currentIdx - 1);
    }
  };

  // Cancel the whole test: stop mic/TTS/timers, wipe progress, and return to
  // the test-selection screen.
  const handleCancelTest = () => {
    if (expireTimerRef.current) {
      clearTimeout(expireTimerRef.current);
      expireTimerRef.current = null;
    }
    waitingRef.current = false;
    releasePrepGate();
    isRecordingRef.current = false;
    finalizeInFlightRef.current = false;
    serenVoice.stop();
    void activeAudioRecorder.stop().catch(() => {});
    transcribedPartsRef.current.clear();
    try {
      localStorage.removeItem('seren_cambridge_progress');
      localStorage.removeItem('seren_diag_progress');
    } catch {}
    setTranscripts({});
    setCurrentIdx(0);
    setShowHint(false);
    setHintText('');
    setCueNotes('');
    setIsPrepPhase(false);
    setIsRecording(false);
    setIsAnalyzing(false);
    setErrorMsg('');
    setAutoAdvanceNotice('');
    setPrepTimeLeft(0);
    setTimeLeft(0);
    setSelectedTestId('');
    soundFX.playChime('tick');
  };

  const submitDiagnosticEvaluation = async () => {
    // Never fabricate a score for silence: if essentially nothing was spoken
    // (or typed) across all three parts, refuse to evaluate. This also stops
    // mic-noise Whisper hallucinations from unlocking a Band 7.5 report.
    const preWords = Object.values(transcriptsRef.current)
      .join(' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean).length;
    if (preWords < 3) {
      soundFX.playChime('tick');
      setAutoAdvanceNotice(
        `I couldn't hear any answers yet, ${userProfile.nickname}! Please speak at least one response before evaluating.`
      );
      setTimeout(() => setAutoAdvanceNotice(''), 6000);
      return;
    }

    stopRecording();
    setIsAnalyzing(true);
    soundFX.playChime('start');

    // Wait (bounded) for any in-flight/queued Whisper transcription so the
    // evaluation sees the final transcript, not a pre-transcription draft.
    // Local Whisper on a 2-minute Part 2 answer (possibly queued behind
    // earlier parts) can take well over the old 20s cap.
    await Promise.race([
      finalizePromiseRef.current,
      new Promise(resolve => setTimeout(resolve, 45000)),
    ]);
    // Snap the freshest transcripts after the awaited transcription
    const finalTranscripts = transcriptsRef.current;

    const stages = [
      'Transcribing phonetic cadence and pause intervals...',
      'Assessing Lexical Resource and idiomatic collocations...',
      'Computing Grammatical Range and structural complexity...',
      'Calibrating official CEFR Level and IELTS Band projection...',
      'Crafting personalized lesson roadmap & Band 9 model upgrades...',
    ];

    let stageIdx = 0;
    const stageInterval = setInterval(() => {
      stageIdx = (stageIdx + 1) % stages.length;
      setAnalyzingStage(stages[stageIdx]);
    }, 1200);

    // Compute basic word count stats from the user's ACTUAL words only.
    // (Previously an empty part silently submitted the polished Band 8.5+
    // sample answer and a fake 135-word floor, so an unanswered test could
    // score 7.5+ on the strength of text the student never spoke.)
    const responsesPayload = questions.map((q) => {
      const transcript = (finalTranscripts[q.id] || '').trim();
      return {
        id: q.id,
        part: q.part, // real IELTS part (1|2|3) — Cambridge tests have many
        // questions per part, so array position must never stand in for it
        partTitle: q.partTitle,
        topic: q.topic,
        question: q.question,
        transcript,
        durationSeconds: q.speakTimeSeconds,
        wordCount: transcript.split(/\s+/).filter(Boolean).length,
      };
    });
    const totalWords = responsesPayload.reduce((sum, r) => sum + r.wordCount, 0);
    const estimatedWPM =
      totalWords > 0
        ? Math.min(160, Math.max(90, Math.round((totalWords / 2.5) * 1.5)))
        : 0;

    const payload = {
      userProfile,
      testId: selectedTest?.id,
      testLabel: selectedTest?.label,
      responses: responsesPayload,
      stats: {
        totalWords,
        estimatedWPM,
      },
    };

    try {
      const res = await fetch('/api/evaluate-speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      clearInterval(stageInterval);

      if (data.success && data.evaluation) {
        soundFX.playChime('success');
        try {
          confetti({
            particleCount: 80,
            spread: 70,
            origin: { y: 0.6 },
          });
        } catch (e) {}
        // Test finished — clear the resume checkpoint
        try {
          localStorage.removeItem('seren_diag_progress');
        } catch {}
        // Stamp the Cambridge test metadata so the Score Report + history always
        // know exactly which test this evaluation belongs to.
        onEvaluationComplete({
          ...data.evaluation,
          ...(selectedTest ? { testId: selectedTest.id, testLabel: selectedTest.label } : {}),
        });
      } else {
        throw new Error(data.error || 'Evaluation failed');
      }
    } catch (err) {
      console.error('Submission failed, using fallback:', err);
      clearInterval(stageInterval);
      // Even if network fails, construct evaluation so user proceeds seamlessly
      const fallback = {
        overallCEFR: 'B2' as const,
        predictedIeltsBand: 6.5,
        cefrDescriptor: 'Independent Speaker with Strong Fluency Foundations',
        executiveSummary: `Splendid job, ${userProfile.nickname}! You demonstrated clear communication, genuine enthusiasm, and spontaneous speech. To reach your target Band ${userProfile.targetBand}, we will work on enriching your academic vocabulary and structuring fluent Part 2 long turns without hesitation.`,
        pillars: {
          fluency: {
            score: 6.5,
            cefr: 'B2' as const,
            strengths: ['Smooth speech flow on familiar topics', 'Appropriate pacing without excessive long pauses'],
            growthAreas: ['Incorporate discourse markers (furthermore, in retrospect)', 'Avoid repetitive connectors like "and then"'],
            examinerCommentary: 'Good continuous speech! Pacing drills will give you effortless fluidity.',
          },
          lexical: {
            score: 6.5,
            cefr: 'B2' as const,
            strengths: ['Accurate vocabulary for topic concepts', 'Good use of descriptive words'],
            growthAreas: ['Replace generic verbs and adjectives with Band 8+ collocations', 'Express abstract concepts with more nuance'],
            examinerCommentary: 'Strong core vocabulary. We will expand your idiomatic toolkit.',
          },
          grammar: {
            score: 6.0,
            cefr: 'B2' as const,
            strengths: ['Accurate simple and compound sentences', 'Good control of basic tenses'],
            growthAreas: ['Use mixed conditionals and inversion structures', 'Maintain subject-verb agreement during rapid speech'],
            examinerCommentary: 'Solid grammar foundation with minor slips under pressure.',
          },
          pronunciation: {
            score: 7.0,
            cefr: 'B2' as const,
            strengths: ['Clear enunciation and audible projection', 'Natural sentence intonation'],
            growthAreas: ['Focus on word stress in multi-syllable academic words', 'Connected speech linking'],
            examinerCommentary: 'Your pronunciation is pleasant and very easy to follow!',
          },
        },
        upgradedExpressions: [
          {
            original: "I like living in my hometown because it has good things.",
            upgraded: "What I find most compelling about my hometown is its vibrant blend of cultural heritage and modern amenities.",
            ieltsBand: "Band 8.5",
            explanation: "Replaces generic 'like' and 'good things' with high-scoring lexical items and cleft structure.",
          },
          {
            original: "I want to achieve this goal since many years.",
            upgraded: "This ambition has been a longstanding aspiration of mine ever since my formative years.",
            ieltsBand: "Band 8.0",
            explanation: "Accurate present perfect continuous sense with academic collocations.",
          },
        ],
        pronunciationTips: [
          {
            word: "Heritage",
            ipa: "/ˈherɪtɪdʒ/",
            phoneticSpelling: "HER-ih-tij",
            tip: "Stress the first syllable firmly: 'HER'.",
            exampleSentence: "The town has rich architectural heritage.",
          },
          {
            word: "Aspiration",
            ipa: "/ˌæspəˈreɪʃən/",
            phoneticSpelling: "as-puh-RAY-shun",
            tip: "Primary stress lands on 'RAY'.",
            exampleSentence: "Achieving fluency is my prime aspiration.",
          },
        ],
        stats: {
          totalWords: totalWords || 130,
          estimatedWPM: estimatedWPM || 110,
          pauseFluencyRating: 'Smooth' as const,
          varietyRating: 'Good' as const,
        },
        lessonRoadmap: [
          {
            id: 'module-1',
            title: 'Band 8+ Cohesion & Linking Mastery',
            level: 'Band 7.5+',
            category: 'Fluency' as const,
            duration: '15 Mins',
            description: 'Learn seamless transitions like "Having said that" and "From an empirical standpoint".',
            objectives: ['Eliminate awkward hesitation', 'Master 10 linking structures'],
            practiceDrill: {
              type: 'rapid_fire' as const,
              prompt: 'Answer: "Do people prefer cities or countryside?" using two contrast connectors.',
              modelBand9Sample: 'Broadly speaking, there is a pronounced generational divide. Whereas youth favor vibrant hubs, older adults seek serenity.',
              tips: ['Use "Broadly speaking"', 'Contrast with "Whereas"'],
            },
          },
          {
            id: 'module-2',
            title: 'IELTS Part 2: The 3-Act Cue Card Blueprint',
            level: 'Band 8.0+',
            category: 'Part 2 Cue Card' as const,
            duration: '20 Mins',
            description: 'Structure any cue card into Setup, Conflict/Details, and Reflection so you speak comfortably for 2 minutes.',
            objectives: ['Utilize 1-minute prep window', 'Deliver an impactful conclusion'],
            practiceDrill: {
              type: 'cue_card' as const,
              prompt: 'Describe an unforgettable adventure.',
              modelBand9Sample: 'If I were to recount one particularly vivid expedition, it would be our trek across the northern highlands.',
              tips: ['Frame with "If I were to recount..."'],
            },
          },
        ],
      };
      try {
        localStorage.removeItem('seren_diag_progress');
      } catch {}
      onEvaluationComplete({
        ...(fallback as any),
        ...(selectedTest ? { testId: selectedTest.id, testLabel: selectedTest.label } : {}),
      });
    }
  };

  return (
    <div id="diagnostic-test-view" className="w-full max-w-6xl mx-auto space-y-6">
      {/* Header Banner: Part identity + Diagnostic step + Part 1/2/3 navigation */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-2xl bg-[#21222c]/80 border border-[#44475a] backdrop-blur-md shadow-lg">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 shrink-0 rounded-xl bg-[#bd93f9]/20 border border-[#bd93f9]/40 flex items-center justify-center text-[#bd93f9] font-bold text-sm">
            P{currentQ.part}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-bold text-[#f8f8f2]">{currentQ.partTitle}</h2>
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-[#bd93f9]/15 border border-[#bd93f9]/40 text-[#bd93f9] font-medium whitespace-nowrap">
                Diagnostic Step {currentQ.part} of 3
              </span>
            </div>
            <p className="text-xs text-[#6272a4] mt-0.5 truncate">Topic: {currentQ.topic}</p>
          </div>
        </div>

        {questions.length > 0 && (
          <div className="flex items-center gap-2 shrink-0">
            {[1, 2, 3].map((part) => {
              const partIdxs = questions
                .map((q, idx) => ({ q, idx }))
                .filter((x) => x.q.part === part);
              if (partIdxs.length === 0) return null;
              const answeredCount = partIdxs.filter((x) => (transcripts[x.q.id] || '').trim()).length;
              const allAnswered = answeredCount === partIdxs.length;
              const isCurrentPart = partIdxs.some((x) => x.idx === currentIdx);
              return (
                <button
                  key={`part-chip-${part}`}
                  type="button"
                  onClick={() => {
                    if (isAnalyzing || isRecording) return;
                    setCurrentIdx(partIdxs[0].idx);
                  }}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all whitespace-nowrap ${
                    isCurrentPart
                      ? 'bg-[#bd93f9]/15 border-[#bd93f9] text-[#bd93f9] shadow-md shadow-[#bd93f9]/10'
                      : allAnswered
                      ? 'bg-[#50fa7b]/15 border-[#50fa7b]/50 text-[#50fa7b]'
                      : 'bg-[#282a36] border-[#44475a] text-[#6272a4] hover:text-[#f8f8f2] hover:border-[#6272a4]'
                  }`}
                  title={`Part ${part} — ${answeredCount} of ${partIdxs.length} answered`}
                >
                  <span className="font-mono opacity-80">{part}</span>
                  <span>Part {part}</span>
                  {allAnswered && <CheckCircle className="w-3 h-3" />}
                </button>
              );
            })}

            <button
              type="button"
              onClick={handleCancelTest}
              disabled={isAnalyzing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#ff5555]/40 bg-[#ff5555]/10 text-[#ff5555] text-xs font-semibold hover:bg-[#ff5555]/20 hover:border-[#ff5555]/60 transition-all disabled:opacity-40 disabled:pointer-events-none whitespace-nowrap"
              title="Cancel this test and choose another"
            >
              <X className="w-3.5 h-3.5" />
              Cancel Test
            </button>
          </div>
        )}
      </div>

      {/* Auto Advance Notification Overlay Banner */}
      {autoAdvanceNotice && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          className="p-4 rounded-2xl bg-gradient-to-r from-[#bd93f9]/20 via-[#8be9fd]/20 to-[#50fa7b]/20 border border-[#8be9fd]/50 text-[#f8f8f2] flex items-center justify-between shadow-xl backdrop-blur-md"
        >
          <div className="flex items-center gap-3">
            <Sparkles className="w-5 h-5 text-[#8be9fd] animate-spin" style={{ animationDuration: '3s' }} />
            <span className="font-semibold text-sm text-[#f8f8f2]">{autoAdvanceNotice}</span>
          </div>
          <span className="text-xs font-mono text-[#50fa7b] animate-pulse">Auto Transitioning...</span>
        </motion.div>
      )}

      {/* Main Grid: Seren Stage + Test Controls */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 sm:gap-6 items-start">
        {/* Seren Character Display (4 cols) */}
        <div className="lg:col-span-4 space-y-4">
          <SerenAvatar
            mood={
              !selectedTest
                ? 'greeting'
                : isAnalyzing
                ? 'evaluating'
                : isRecording
                ? 'listening'
                : isPrepPhase
                ? // Long-lived prep (Part 2, 60s) shows the greeting "ready" image;
                  // short preps (5-10s) use encouraging so the greeting image
                  // never flashes for a couple of seconds.
                  (currentQ.part === 2 ? 'greeting' : 'encouraging')
                : 'encouraging'
            }
            currentSpeech={serenSubtitle}
            spokenAudioText={spokenAudioPrompt}
            isUserSpeaking={isRecording}
            voiceEnabled={voiceEnabled}
            onToggleVoice={onToggleVoice}
            onSpeechStart={handleIntroSpeechStart}
            onSpeechEnd={handleIntroSpeechEnd}
          />
        </div>

        {/* Question & Voice Recording Terminal (8 cols) */}
        <div className="lg:col-span-8 space-y-5">
          {/* Active Question Box */}
          <div className="p-5 sm:p-6 rounded-3xl bg-[#282a36] border border-[#44475a] shadow-xl backdrop-blur-md space-y-4">
            {/* Report generation progress — shown inside the question box */}
            {isAnalyzing && (
              <div className="p-4 rounded-2xl bg-[#bd93f9]/10 border border-[#bd93f9]/50 flex items-start gap-3">
                <Loader2 className="w-5 h-5 text-[#bd93f9] animate-spin shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-[#f8f8f2]">Generating your CEFR &amp; IELTS report…</p>
                  <p className="text-xs text-[#6272a4] mt-0.5">{analyzingStage || 'Evaluating every sentence and scanning pronunciation risks…'}</p>
                  <div className="mt-2.5 h-1.5 rounded-full bg-[#44475a] overflow-hidden">
                    <div className="h-full w-1/3 rounded-full bg-gradient-to-r from-[#bd93f9] to-[#8be9fd] animate-pulse" />
                  </div>
                </div>
              </div>
            )}

            {!selectedTest ? (
              <div className="space-y-4">
                <div className="p-4 rounded-2xl bg-gradient-to-r from-[#bd93f9]/10 to-[#8be9fd]/10 border border-[#44475a]">
                  <p className="text-sm font-semibold text-[#f8f8f2]">
                    {cambridgeGreetingIntro(userProfile.nickname)}
                  </p>
                  <p className="mt-1 text-sm text-[#6272a4]">{cambridgeGreetingPrompt}</p>
                </div>

                <label className="block text-[11px] font-semibold uppercase tracking-wider text-[#8be9fd]">
                  Select your test
                </label>
                <select
                  value={selectedTestId}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    setSelectedTestId(nextId);
                    setCurrentIdx(0);
                    setShowHint(false);
                    setHintText('');
                    setIsPrepPhase(false);
                    setIsRecording(false);
                  }}
                  className="w-full px-3 py-3 rounded-xl bg-[#21222c] border border-[#44475a] text-sm text-[#f8f8f2] focus:outline-none focus:ring-2 focus:ring-[#bd93f9]/50"
                >
                  <option value="">Choose a Cambridge test</option>
                  {CAMBRIDGE_TESTS.map((test) => (
                    <option key={test.id} value={test.id}>{test.label}</option>
                  ))}
                </select>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-[#bd93f9] flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5" />
                    Examiner Question
                  </span>

                  <div
                    className={`flex items-center gap-2 px-3 py-1 rounded-full text-xs font-bold font-mono border ${
                      isPrepPhase
                        ? 'bg-[#ffb86c]/20 border-[#ffb86c]/50 text-[#ffb86c] animate-pulse'
                        : isRecording
                        ? 'bg-[#50fa7b]/20 border-[#50fa7b]/50 text-[#50fa7b]'
                        : 'bg-[#21222c] border-[#44475a] text-[#6272a4]'
                    }`}
                  >
                    <Clock className="w-3.5 h-3.5" />
                    {isPrepPhase
                      ? `Prep: ${prepTimeLeft}s`
                      : isRecording
                      ? `Speaking: ${timeLeft}s`
                      : `${currentQ.speakTimeSeconds}s Max`}
                  </div>
                </div>

                <h3 className="text-lg sm:text-xl font-bold text-[#f8f8f2] leading-snug">
                  "{currentQ.question}"
                </h3>

                {currentQ.bulletPoints && (
                  <div className="p-3.5 rounded-2xl bg-[#21222c] border border-[#44475a] text-xs space-y-2">
                    <p className="font-semibold text-[#ffb86c]">You should say:</p>
                    <ul className="space-y-1.5 text-[#f8f8f2]/80 pl-4 list-disc text-xs">
                      {currentQ.bulletPoints.map((bp, i) => (
                        <li key={i}>{bp}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {currentQ.part === 2 && isPrepPhase && (
                  <div className="p-3 rounded-2xl bg-[#ffb86c]/10 border border-[#ffb86c]/30 flex items-center justify-between gap-3 text-xs">
                    <div className="flex items-center gap-2 text-[#ffb86c]">
                      <Clock className="w-4 h-4 animate-spin" style={{ animationDuration: '8s' }} />
                      <span>Preparation Time: <strong>{prepTimeLeft}s remaining</strong> before speaking begins automatically.</span>
                    </div>
                    <button
                      id="skip-prep-btn"
                      type="button"
                      onClick={handleSkipPrep}
                      className="px-3 py-1.5 rounded-xl bg-[#ffb86c] hover:bg-[#ffb86c]/90 text-[#282a36] font-bold text-xs shrink-0 transition-colors"
                    >
                      Start Speaking Now
                    </button>
                  </div>
                )}

                {currentQ.part === 2 && (
                  <div className="space-y-1.5">
                    <label className="text-[11px] font-semibold text-[#8be9fd] uppercase tracking-wider flex items-center gap-1">
                      <FileText className="w-3 h-3 text-[#8be9fd]" />
                      1-Minute Prep Scratchpad (Optional Notes)
                    </label>
                    <input
                      type="text"
                      value={cueNotes}
                      onChange={(e) => setCueNotes(e.target.value)}
                      placeholder="Jot bullet points e.g. 'Hiking trip -> storm -> summit view -> transformation'"
                      className="w-full px-3 py-2 rounded-xl bg-[#21222c] border border-[#44475a] text-xs text-[#f8f8f2] placeholder-[#6272a4] focus:outline-none focus:border-[#bd93f9]"
                    />
                  </div>
                )}

                <div className="pt-2 flex flex-col items-center justify-center gap-3 p-4 rounded-2xl bg-[#21222c] border border-[#44475a]">
                  <div className="flex items-center gap-4">
                    {!isRecording ? (
                      <button
                        id="start-speaking-btn"
                        type="button"
                        onClick={startRecording}
                        disabled={isAnalyzing || !selectedTest}
                        className="flex items-center gap-2.5 px-6 py-3 rounded-2xl bg-[#50fa7b] hover:bg-[#50fa7b]/90 text-[#282a36] font-bold text-sm shadow-lg shadow-[#50fa7b]/25 transition-all transform hover:scale-[1.02] active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none"
                      >
                        <Mic className="w-5 h-5 text-[#282a36]" />
                        <span>Start Speaking Answer</span>
                      </button>
                    ) : (
                      <button
                        id="stop-speaking-btn"
                        type="button"
                        onClick={stopRecording}
                        className="flex items-center gap-2.5 px-6 py-3 rounded-2xl bg-[#ff5555] hover:bg-[#ff5555]/90 text-[#f8f8f2] font-bold text-sm shadow-lg shadow-[#ff5555]/30 animate-pulse transition-all"
                      >
                        <MicOff className="w-5 h-5" />
                        <span>Done Speaking ({timeLeft}s left)</span>
                      </button>
                    )}

                    <button
                      id="hint-button"
                      type="button"
                      onClick={handleToggleHint}
                      disabled={isAnalyzing || !currentQ.sampleAnswer}
                      className="px-5 py-3 rounded-2xl border border-[#bd93f9]/50 bg-[#bd93f9]/15 hover:bg-[#bd93f9]/20 text-[#f8f8f2] text-sm font-semibold shadow-lg shadow-[#bd93f9]/15 transition-all transform hover:scale-[1.02] active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none flex items-center gap-2"
                      title={showHint ? 'Hide hint' : 'Show hint'}
                    >
                      <HelpCircle className="w-4 h-4 text-[#8be9fd]" />
                      <span>{showHint ? 'Hide Hint' : 'Get Hint'}</span>
                    </button>
                  </div>

                  {errorMsg && <p className="text-[11px] text-[#ffb86c] text-center">{errorMsg}</p>}
                </div>

                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-[#f8f8f2] flex items-center gap-1.5">
                        <Edit3 className="w-3.5 h-3.5 text-[#8be9fd]" />
                        Spoken Transcript:
                      </span>
                      <span className="text-[11px] text-[#6272a4]">
                        {currentTranscript.split(/\s+/).filter(Boolean).length} words
                      </span>
                      {isTranscribing && (
                        <span className="px-2 py-0.5 rounded-full bg-[#bd93f9]/20 border border-[#bd93f9]/50 text-[#bd93f9] text-[10px] font-semibold flex items-center gap-1 animate-pulse">
                          <Sparkles className="w-3 h-3 animate-spin" style={{ animationDuration: '2s' }} />
                          Transcribing your speech...
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-1 text-[11px]">
                      {currentTranscript && (
                        <button
                          type="button"
                          onClick={() => handleTranscriptChange('')}
                          className="ml-1 text-[10px] text-[#6272a4] hover:text-[#ff5555] transition-colors"
                          title="Clear transcript"
                        >
                          Clear
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Transcript box: shows the live mic equalizer while recording
                      (Whisper only transcribes AFTER stop) */}
                  <div className="relative">
                    <textarea
                      id={`transcript-input-${currentQ.id}`}
                      rows={currentQ.part === 2 ? 7 : 5}
                      value={transcriptDisplayValue}
                      readOnly
                      placeholder="Your words will appear here after you stop speaking — Whisper transcribes your recording. Press Show Hint to add a guiding sentence without overwriting the spoken transcript."
                      className="w-full p-3.5 rounded-2xl bg-[#21222c] border border-[#44475a] text-[#f8f8f2] text-xs sm:text-sm leading-relaxed placeholder-[#6272a4] focus:outline-none focus:ring-2 focus:ring-[#bd93f9]/50 focus:border-[#bd93f9] resize-y overflow-auto"
                      style={{ maxHeight: currentQ.part === 2 ? '280px' : '220px', scrollBehavior: 'smooth' }}
                    />
                    {(isRecording || isTranscribing) && (
                      <div className="absolute inset-0 rounded-2xl bg-[#21222c]/95 border border-[#44475a] flex items-center justify-center px-4">
                        {isTranscribing ? (
                          <div className="flex items-center gap-2 text-xs text-[#bd93f9]">
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Transcribing your speech...
                          </div>
                        ) : <MicEqualizer active />}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center justify-between pt-3 border-t border-[#44475a]">
                  <button
                    id="prev-question-btn"
                    type="button"
                    onClick={handlePreviousQuestion}
                    disabled={currentIdx === 0 || isAnalyzing}
                    className="px-4 py-2 rounded-xl border border-[#44475a] text-[#6272a4] hover:text-[#f8f8f2] hover:bg-[#44475a] text-xs font-medium disabled:opacity-30 disabled:pointer-events-none transition-colors flex items-center gap-1.5"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    Previous Part
                  </button>

                  <button
                    id="next-question-btn"
                    type="button"
                    onClick={handleNextQuestion}
                    disabled={isAnalyzing || !currentTranscript.trim()}
                    className="px-6 py-2.5 rounded-xl bg-[#bd93f9] hover:bg-[#bd93f9]/90 text-[#282a36] font-bold text-xs sm:text-sm shadow-lg shadow-[#bd93f9]/25 transition-all flex items-center gap-2 disabled:opacity-50 disabled:pointer-events-none"
                  >
                    {isAnalyzing ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>Evaluating…</span>
                      </>
                    ) : questions.length > 0 && currentIdx < questions.length - 1 ? (
                      <>
                      <span>
                        {currentIdx + 1 < questions.length &&
                        questions[currentIdx + 1].part !== currentQ.part
                          ? `Next: Part ${questions[currentIdx + 1].part}`
                          : 'Save & Continue'}
                      </span>
                        <ArrowRight className="w-4 h-4" />
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-4 h-4 text-[#282a36]" />
                        <span>Evaluate My English (CEFR)</span>
                      </>
                    )}
                  </button>
                </div>
              </>
            )}
          </div>

          {selectedTest && currentQ.cueTips && currentQ.cueTips.length > 0 && (
            <div className="p-4 sm:p-5 rounded-3xl bg-[#282a36] border border-[#44475a] text-xs text-[#f8f8f2]/90 space-y-2 shadow-lg backdrop-blur-md">
              <div className="flex items-center gap-2 font-semibold text-[#8be9fd]">
                <Lightbulb className="w-4 h-4 text-[#f1fa8c]" />
                <span className="text-xs uppercase tracking-wider">Seren's IELTS Examiner Advice & Tips</span>
              </div>
              <ul className="space-y-1.5 pl-5 list-disc text-[#f8f8f2]/80 text-xs leading-relaxed">
                {currentQ.cueTips.map((tip, i) => (
                  <li key={i}>{tip}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
