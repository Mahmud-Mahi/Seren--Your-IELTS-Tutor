import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  BookOpen,
  CheckCircle2,
  Play,
  Sparkles,
  ArrowRight,
  Mic,
  MicOff,
  Flame,
  Award,
  Volume2,
  Clock,
  Lightbulb,
  Check,
  ChevronRight,
  Send,
  Menu
} from 'lucide-react';
import { LessonRoadmapModule, UserProfile, SpeakingEvaluation, LumiMood, SavedLessonPlan } from '../types';
import { lessonPlanFingerprint } from '../utils/lessonHistory';
import { LumiAvatar } from './LumiAvatar';
import { createSpeechRecognizer, lumiVoice, soundFX, activeAudioRecorder, transcribeAudioWithAI, SUPPORTED_SPEECH_LOCALES } from '../utils/speech';
import { useLumiMood, useMicMoodSync, normalizeReplyMood } from '../utils/lumiMood';
import confetti from 'canvas-confetti';
import { lessonModuleIntro, lessonModuleIntroSpeech } from '../utils/greetings';

interface LessonStudioProps {
  evaluation: SpeakingEvaluation;
  userProfile: UserProfile;
  voiceEnabled: boolean;
  onToggleVoice: () => void;
  // Custom Lesson history (lumi_lesson_history): roadmap of EVERY completed
  // test / practice session, newest first. Tick marks persist in the store.
  lessonPlans: SavedLessonPlan[];
  onMarkLessonComplete: (planId: string, moduleId: string) => void;
}

export const LessonStudio: React.FC<LessonStudioProps> = ({
  evaluation,
  userProfile,
  voiceEnabled,
  onToggleVoice,
  lessonPlans,
  onMarkLessonComplete,
}) => {
  // Lesson plans shown in the sidebar: the persisted history of all tests
  // (newest first). Fallback: if the store is somehow empty (e.g. the active
  // evaluation predates it), still show the current roadmap.
  const plans: SavedLessonPlan[] =
    lessonPlans.length > 0
      ? lessonPlans
      : evaluation.lessonRoadmap?.length
        ? [
            {
              id: 'plan-current',
              savedAt: Date.now(),
              source: 'cambridge',
              testId: evaluation.testId,
              testLabel: evaluation.testLabel || 'Current Roadmap',
              fingerprint: lessonPlanFingerprint(evaluation.lessonRoadmap),
              modules: evaluation.lessonRoadmap,
            },
          ]
        : [];

  const [selectedPlanId, setSelectedPlanId] = useState<string>(plans[0]?.id || '');
  const [selectedModule, setSelectedModule] = useState<LessonRoadmapModule>(
    plans[0]?.modules?.[0] || ({} as LessonRoadmapModule)
  );
  // Optimistic tick marks for completions not yet reflected by the store
  // (covers the non-persisted fallback plan above).
  const [localCompleted, setLocalCompleted] = useState<Record<string, boolean>>({});
  const [userSpokenText, setUserSpokenText] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [isEvaluatingDrill, setIsEvaluatingDrill] = useState(false);
  // AI speech modification (Whisper): while true the recorded audio is being
  // transcribed/refined by the AI and the transcript box may update.
  const [isRefiningTranscript, setIsRefiningTranscript] = useState(false);
  const refiningRef = useRef(false);
  const [drillFeedback, setDrillFeedback] = useState<any>(null);
  // Central mood state machine (src/utils/lumiMood.ts) — 'listening' is
  // mic-driven only; see useMicMoodSync below.
  const [lumiMood, setLumiMood] = useLumiMood();
  const [lumiSpeech, setLumiSpeech] = useState('');
  // Audio Lumi actually READS ALOUD. Normally undefined (= speak lumiSpeech
  // verbatim via LumiAvatar's fallback), but for the module intro it carries
  // the practice prompt so she READS the question aloud while her speech box
  // only shows the welcome text up to "Let's master this concept."
  const [lumiSpokenAudio, setLumiSpokenAudio] = useState<string | undefined>(undefined);
  /** Single helper so displayed text and spoken audio never drift apart. */
  const sayLumi = (displayed: string, spoken?: string) => {
    setLumiSpeech(displayed);
    setLumiSpokenAudio(spoken);
  };

  // Mic lifecycle → mood: while the mic is open the mood is ALWAYS
  // 'listening'; the moment it closes the previous base mood returns.
  useMicMoodSync(isRecording);

  // Custom Lessons sidebar (the 4-module roadmap panel): collapsible via the
  // hamburger toggle in the banner so the practice workspace can go full width.
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const [conversationHistory, setConversationHistory] = useState<any[]>([]);
  const [isSubmittingReply, setIsSubmittingReply] = useState(false);

  const [selectedLanguage, setSelectedLanguage] = useState('en-US');
  const recognizerRef = useRef<any>(null);

  useEffect(() => {
    recognizerRef.current = createSpeechRecognizer({
      initialText: userSpokenText,
      lang: selectedLanguage,
      onResult: (text) => setUserSpokenText(text),
      onStart: () => setIsRecording(true),
      onEnd: () => setIsRecording(false),
    });

    return () => {
      recognizerRef.current?.stop();
      void activeAudioRecorder.stop().catch(() => {});
    };
  }, [selectedLanguage]);

  // When selected module changes
  useEffect(() => {
    setUserSpokenText('');
    setDrillFeedback(null);
    setConversationHistory([]);
    setIsRecording(false);
    recognizerRef.current?.stop();
    void activeAudioRecorder.stop().catch(() => {});
    recognizerRef.current?.reset();

    if (selectedModule?.title) {
      const intro = lessonModuleIntro(selectedModule.title, userProfile.nickname);
      // Show ONLY the welcome in Lumi's box, but READ the practice prompt aloud.
      const introSpoken = lessonModuleIntroSpeech(selectedModule.title, userProfile.nickname, selectedModule.practiceDrill.prompt);
      sayLumi(intro, introSpoken);
      setLumiMood('speaking');
    }
  }, [selectedModule, userProfile.nickname]);

  const handleSelectModule = (planId: string, mod: LessonRoadmapModule) => {
    soundFX.playChime('start');
    setSelectedPlanId(planId);
    setSelectedModule(mod);
  };

  // A lesson is done if the persisted store says so (mod.completed) or the
  // user just finished it this session (optimistic tick).
  const isModuleDone = (planId: string, mod: LessonRoadmapModule) =>
    !!mod.completed || !!localCompleted[`${planId}:${mod.id}`];

  const totalDone = plans.reduce(
    (n, p) => n + p.modules.filter((m) => isModuleDone(p.id, m)).length,
    0
  );
  const totalLessons = plans.reduce((n, p) => n + p.modules.length, 0);

  const handleStartRecording = () => {
    soundFX.playChime('start');
    // 'listening' mood comes automatically via useMicMoodSync when the
    // recognizer's onStart flips isRecording true — do NOT set it directly.
    // Lumi's current message (including any follow-up questions) STAYS in her
    // box while you speak; the LISTENING badge + mic icon signal the state.
    lumiVoice.stop();
    // Native high-fidelity recorder feeding the AI transcript refinement.
    activeAudioRecorder.start();
    recognizerRef.current?.setBaseTranscript(userSpokenText);
    recognizerRef.current?.start();
  };

  const handleStopRecording = () => {
    recognizerRef.current?.stop();
    setIsRecording(false);
    // No "I heard you." filler and no mood override: useMicMoodSync releases
    // the listening override and restores the previous base mood, and Lumi's
    // last message stays in her box. The AI refines the transcript instead.
    void refineTranscriptWithAI(userSpokenText);
  };

  // AI speech modification — the SAME Whisper refinement pipeline the chat and
  // the Cambridge test use: recorded audio + the raw browser draft are sent to
  // /api/stt and the polished transcript replaces the draft in the answer box.
  const refineTranscriptWithAI = async (draftTranscript: string) => {
    if (refiningRef.current) return;
    refiningRef.current = true;
    setIsRefiningTranscript(true);
    try {
      const recordResult = await activeAudioRecorder.stop().catch(() => null);
      const draft = draftTranscript.trim();
      if ((recordResult?.base64 && recordResult.base64.length > 50) || draft.length > 5) {
        const refinedText = await transcribeAudioWithAI({
          audioBase64: recordResult?.base64 || '',
          mimeType: recordResult?.mimeType || 'audio/webm',
          draftTranscript: draft,
        });
        const clean = (refinedText || '').trim();
        if (clean) {
          setUserSpokenText(clean);
          recognizerRef.current?.setBaseTranscript(clean);
        }
      }
    } catch (e) {
      console.warn('Transcript AI refinement notice:', e);
    } finally {
      refiningRef.current = false;
      setIsRefiningTranscript(false);
    }
  };

  const handleUserTextChange = (text: string) => {
    setUserSpokenText(text);
    recognizerRef.current?.setBaseTranscript(text);
  };

  const handleListenModelSample = () => {
    if (!selectedModule?.practiceDrill?.modelBand9Sample) return;
    soundFX.playChime('start');
    setLumiMood('speaking');
    sayLumi(selectedModule.practiceDrill.modelBand9Sample);
  };

  const handleSubmitDrillAnswer = async () => {
    if (!userSpokenText.trim()) return;
    recognizerRef.current?.stop();
    setIsRecording(false);
    // Release the native mic capture too (the AI refinement may not have run
    // if the user submitted straight from the listening state).
    void activeAudioRecorder.stop().catch(() => {});
    setIsEvaluatingDrill(true);
    setLumiMood('evaluating');
    sayLumi(`Analyzing your practice response...`);

    const userMsg = `Drill topic: "${selectedModule.practiceDrill.prompt}". My answer: "${userSpokenText}"`;

    try {
      const res = await fetch('/api/lumi-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userProfile,
          evaluation,
          conversationHistory: [],
          message: userMsg,
          mode: `Lesson Practice: ${selectedModule.title}`,
        }),
      });

      const data = await res.json();
      setIsEvaluatingDrill(false);

      if (data.success && data.reply) {
        setDrillFeedback({
          ...data.reply.feedback,
          originalAnswer: userSpokenText,
        });
        setLumiMood(normalizeReplyMood(data.reply.mood) || 'celebrating');
        sayLumi(data.reply.replyText);
        soundFX.playChime('success');
        
        setConversationHistory([
          { sender: 'user', text: userMsg },
          { sender: 'lumi', text: data.reply.replyText }
        ]);
        
        setUserSpokenText('');

        // Mark the lesson as completed: optimistic tick for instant feedback,
        // then persist it to the lesson history store (lumi_lesson_history)
        // via App so the ✓ survives reloads and new tests.
        setLocalCompleted((prev) => ({ ...prev, [`${selectedPlanId}:${selectedModule.id}`]: true }));
        onMarkLessonComplete(selectedPlanId, selectedModule.id);

        try {
          confetti({
            particleCount: 50,
            spread: 60,
            origin: { y: 0.7 },
          });
        } catch (e) {}
      }
    } catch (e) {
      setIsEvaluatingDrill(false);
      setLumiMood('encouraging');
      sayLumi(`Excellent effort, ${userProfile.nickname}! You used great vocabulary flow.`);
      setDrillFeedback({
        originalAnswer: userSpokenText,
        correctedSentence: userSpokenText,
        lexicalBoost: ['Remarkable delivery', 'Nuanced perspective', 'Substantiated idea'],
        ieltsTip: 'Keep your intonation lively to engage the examiner naturally.',
      });
      soundFX.playChime('success');
    }
  };

  const handleReplyToLumi = async () => {
    if (!userSpokenText.trim()) return;
    recognizerRef.current?.stop();
    setIsRecording(false);
    setIsSubmittingReply(true);
    sayLumi('');

    const userMsg = userSpokenText;
    const currentHist = [...conversationHistory];

    try {
      const res = await fetch('/api/lumi-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userProfile,
          evaluation,
          conversationHistory: currentHist,
          message: userMsg,
          mode: `Lesson Practice: ${selectedModule.title}`,
        }),
      });

      const data = await res.json();
      setIsSubmittingReply(false);

      if (data.success && data.reply) {
        setLumiMood(normalizeReplyMood(data.reply.mood) || 'speaking');
        sayLumi(data.reply.replyText);
        soundFX.playChime('success');

        if (data.reply.feedback) {
           setDrillFeedback(data.reply.feedback);
        }

        setConversationHistory([
          ...currentHist,
          { sender: 'user', text: userMsg },
          { sender: 'lumi', text: data.reply.replyText }
        ]);
        
        setUserSpokenText('');
      } else {
        sayLumi("I didn't quite catch that. Could you try replying again?");
      }
    } catch (e) {
      setIsSubmittingReply(false);
      sayLumi("I had trouble sending that reply. Let's try once more.");
    }
  };

  return (
    <div id="lesson-studio-view" className="w-full max-w-6xl mx-auto space-y-6">
      {/* Top Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-2xl bg-[#21222c] border border-[#44475a] backdrop-blur-md">
        <div className="flex items-center gap-3">
          {/* 3-bar hamburger toggle in the top-left corner: show / hide the module side panel */}
          <button
            id="lesson-sidebar-toggle"
            type="button"
            onClick={() => setSidebarOpen((open) => !open)}
            title={sidebarOpen ? 'Hide module panel' : 'Show module panel'}
            aria-label={sidebarOpen ? 'Hide module panel' : 'Show module panel'}
            className={`shrink-0 p-2 rounded-xl border transition-all ${
              sidebarOpen
                ? 'bg-[#bd93f9]/20 border-[#bd93f9]/50 text-[#bd93f9] hover:bg-[#bd93f9]/30'
                : 'bg-[#282a36] border-[#44475a] text-[#6272a4] hover:text-[#f8f8f2] hover:bg-[#44475a]'
            }`}
          >
            <Menu className="w-4 h-4" />
          </button>

          <div>
            <h2 className="text-base font-bold text-[#f8f8f2] flex items-center gap-2">
              <BookOpen className="w-4 h-4 text-[#8be9fd]" />
              Personalized Speaking Practice Studio
            </h2>
            <p className="text-xs text-[#6272a4]">
              Curated modules for {userProfile.nickname} (Target Band {userProfile.targetBand})
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold px-3 py-1 rounded-full bg-[#282a36] border border-[#bd93f9]/40 text-[#bd93f9]">
            {totalDone} of {totalLessons} Completed
          </span>
        </div>
      </div>

      {/* Main Grid: Modules list + Active Drill Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Side: Module Cards Selector (3 cols when open, hidden when collapsed) */}
        {sidebarOpen && (
          <div className="lg:col-span-3 space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[#6272a4] px-1">
            Your Custom Learning Roadmap
          </h3>

          {plans.length > 1 && (
            <p className="text-[10px] text-[#6272a4] px-1 leading-relaxed">
              Lessons from every test — newest first. Finish a drill to earn the ✓.
            </p>
          )}

          {plans.map((plan) => (
            <div key={plan.id} className="space-y-2.5">
              {/* Test group header — only shown once there is more than one test */}
              {plans.length > 1 && (
                <div className="flex items-center justify-between gap-2 px-1 pt-1">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-[#bd93f9] truncate">
                    {plan.testLabel || 'Custom Lessons'}
                  </span>
                  <span className="text-[10px] text-[#6272a4] font-mono shrink-0">
                    {new Date(plan.savedAt).toLocaleDateString()}
                  </span>
                </div>
              )}

              <div className="space-y-2.5">
                {plan.modules.map((mod, idx) => {
                  const isSelected = selectedPlanId === plan.id && selectedModule.id === mod.id;
                  const isDone = isModuleDone(plan.id, mod);
                  return (
                    <button
                      key={`${plan.id}-${mod.id}`}
                      id={`module-select-${plan.id}-${mod.id}`}
                      type="button"
                      onClick={() => handleSelectModule(plan.id, mod)}
                      className={`w-full p-4 rounded-2xl border text-left transition-all relative overflow-hidden ${
                        isSelected
                          ? 'bg-[#44475a] border-[#bd93f9] text-[#f8f8f2] ring-1 ring-[#bd93f9]/40 shadow-lg shadow-[#bd93f9]/10'
                          : isDone
                            ? 'bg-[#282a36] border-[#50fa7b]/30 text-[#f8f8f2]/90 hover:border-[#50fa7b]/50'
                            : 'bg-[#282a36] border-[#44475a] text-[#f8f8f2]/90 hover:border-[#6272a4]'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="w-6 h-6 rounded-lg bg-[#21222c] border border-[#44475a] flex items-center justify-center text-xs font-bold font-mono text-[#8be9fd]">
                            {idx + 1}
                          </span>
                          <span className="text-[11px] font-semibold uppercase px-2 py-0.5 rounded bg-[#21222c] text-[#6272a4]">
                            {mod.category}
                          </span>
                        </div>

                        {isDone ? (
                          <span className="flex items-center gap-1 text-[11px] font-semibold text-[#50fa7b] shrink-0">
                            <span className="w-4 h-4 rounded-full bg-[#50fa7b] flex items-center justify-center">
                              <Check className="w-3 h-3 text-[#282a36]" strokeWidth={3.5} />
                            </span>
                            Done
                          </span>
                        ) : (
                          <span className="text-[11px] text-[#6272a4] font-mono flex items-center gap-1">
                            <Clock className="w-3 h-3" /> {mod.duration}
                          </span>
                        )}
                      </div>

                      <h4 className={`text-sm font-bold text-[#f8f8f2] mt-2 line-clamp-1 ${isDone ? 'opacity-80' : ''}`}>
                        {mod.title}
                      </h4>

                      <p className="text-[11px] text-[#6272a4] mt-1 line-clamp-2 leading-relaxed">
                        {mod.description}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          {/* Quick Mock Room Card */}
          <div className="p-4 rounded-2xl bg-[#282a36] border border-[#bd93f9]/30 text-xs space-y-2">
            <div className="font-semibold text-[#bd93f9] flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5" />
              Lumi's Study Recommendation:
            </div>
            <p className="text-[#f8f8f2]/80 text-[11px] leading-relaxed">
              Complete each drill by speaking out loud into your microphone. Lumi will analyze your sentence structures and offer Band 9 upgrades!
            </p>
          </div>
        </div>
        )}

        {/* Right Side: Active Drill & Practice Stage with Lumi (full width when panel hidden) */}
        <div className={`${sidebarOpen ? 'lg:col-span-9' : 'lg:col-span-12'} space-y-5`}>
          <div className="p-5 sm:p-7 rounded-3xl bg-[#282a36] border border-[#44475a] shadow-2xl backdrop-blur-md space-y-6">
            {/* Header of Active Module */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-4 border-b border-[#44475a]">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-[#21222c] text-[#8be9fd] border border-[#8be9fd]/30">
                    {selectedModule.category}
                  </span>
                  <span className="text-xs font-bold text-[#bd93f9] font-mono">{selectedModule.level}</span>
                </div>
                <h3 className="text-xl font-bold text-[#f8f8f2] mt-1.5">{selectedModule.title}</h3>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleListenModelSample}
                  className="px-3 py-1.5 rounded-xl border border-[#bd93f9]/40 bg-[#21222c] hover:bg-[#44475a] text-[#bd93f9] text-xs font-semibold flex items-center gap-1.5 transition-colors"
                  title="Hear Lumi speak the Band 9 model response"
                >
                  <Volume2 className="w-3.5 h-3.5" />
                  <span>Band 9 Sample</span>
                </button>
              </div>
            </div>

            {/* Lumi Visual Coach Stage in Lesson */}
            <div className="grid grid-cols-1 md:grid-cols-12 gap-5 items-start">
              <div className="md:col-span-5">
                {/* Width wrapper: keeps the avatar AND the objectives panel at
                    the avatar's native 320/340px width, centered, so the image
                    ratio is untouched and both blocks align in every sidebar
                    state. */}
                <div className="w-full max-w-[320px] sm:max-w-[340px] mx-auto space-y-3">
                  <LumiAvatar
                    mood={lumiMood}
                    currentSpeech={lumiSpeech}
                    spokenAudioText={lumiSpokenAudio}
                    isUserSpeaking={isRecording}
                    voiceEnabled={voiceEnabled}
                    onToggleVoice={onToggleVoice}
                  />

                  {/* Key Learning Objectives — directly under Lumi's voice box */}
                  <div className="p-4 rounded-2xl bg-[#21222c] border border-[#44475a] space-y-2 text-xs">
                    <div className="font-semibold text-[#f8f8f2] flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-[#8be9fd]" />
                      Key Learning Objectives:
                    </div>
                    <ul className="space-y-1 pl-4 list-disc text-[#f8f8f2]/80 text-[11px]">
                      {selectedModule.objectives?.map((obj, i) => (
                        <li key={i}>{obj}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>

              <div className="md:col-span-7 space-y-3">
                <div className="p-4 rounded-2xl bg-[#21222c] border border-[#bd93f9]/30 text-xs space-y-2">
                  <span className="text-[10px] uppercase font-bold text-[#bd93f9] tracking-wider">
                    Interactive Drill Prompt:
                  </span>
                  <p className="text-[#f8f8f2] font-semibold text-sm">
                    "{selectedModule.practiceDrill?.prompt}"
                  </p>
                  {selectedModule.practiceDrill?.tips && selectedModule.practiceDrill.tips.length > 0 && (
                    <div className="pt-2 border-t border-[#44475a] space-y-1">
                      <span className="text-[11px] font-semibold text-[#ffb86c] flex items-center gap-1">
                        <Lightbulb className="w-3 h-3 text-[#f1fa8c]" />
                        Examiner Tips & Technique:
                      </span>
                      <ul className="pl-4 list-disc text-[#f8f8f2]/80 text-[11px]">
                        {selectedModule.practiceDrill.tips.map((t, i) => (
                          <li key={i}>{t}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                {/* Speaking Terminal & Feedback Box */}
            {!drillFeedback && !isEvaluatingDrill && (
              <div className="space-y-3 pt-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-[#f8f8f2] flex items-center gap-1.5">
                      <Mic className="w-3.5 h-3.5 text-[#8be9fd]" />
                      Your Practice Response:
                    </span>
                    <span className="text-[11px] text-[#6272a4]">
                      {userSpokenText.split(/\s+/).filter(Boolean).length} words
                    </span>
                    {isRefiningTranscript && (
                      <span className="text-[11px] text-[#bd93f9] flex items-center gap-1 animate-pulse">
                        <Sparkles className="w-3 h-3" />
                        AI is refining your transcript…
                      </span>
                    )}
                  </div>

                <div className="flex items-center gap-1 text-[11px]">
                  <span className="text-[#6272a4] text-[10px] uppercase font-mono mr-1">Mic Accent:</span>
                  {SUPPORTED_SPEECH_LOCALES.slice(0, 5).map((acc) => (
                    <button
                      key={acc.code}
                      type="button"
                      onClick={() => {
                        setSelectedLanguage(acc.code);
                        recognizerRef.current?.setLanguage(acc.code);
                      }}
                      className={`px-2 py-0.5 rounded-md text-[10px] font-medium border transition-colors ${
                        selectedLanguage === acc.code
                          ? 'bg-[#bd93f9]/25 border-[#bd93f9] text-[#bd93f9]'
                          : 'bg-[#21222c] border-[#44475a] text-[#6272a4] hover:text-[#f8f8f2]'
                      }`}
                      title={acc.name}
                    >
                      {acc.flag} {acc.code.replace('en-', '')}
                    </button>
                  ))}
                  {userSpokenText && (
                    <button
                      type="button"
                      onClick={() => handleUserTextChange('')}
                      className="ml-1 text-[10px] text-[#6272a4] hover:text-[#ff5555] transition-colors"
                      title="Clear text"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>

              <textarea
                id="lesson-drill-transcript-input"
                rows={3}
                value={userSpokenText}
                onChange={(e) => handleUserTextChange(e.target.value)}
                placeholder="Click 'Record Answer' and speak (pauses are safely handled), or type your practice response here..."
                className="w-full p-3.5 rounded-2xl bg-[#21222c] border border-[#44475a] text-[#f8f8f2] text-xs sm:text-sm leading-relaxed placeholder-[#6272a4] focus:outline-none focus:ring-2 focus:ring-[#bd93f9]/50"
              />

              {/* Action Buttons */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  {!isRecording ? (
                    <button
                      id="drill-start-mic-btn"
                      type="button"
                      onClick={handleStartRecording}
                      className="px-5 py-2.5 rounded-xl bg-[#50fa7b] hover:bg-[#50fa7b]/90 text-[#282a36] font-bold text-xs flex items-center gap-2 transition-all shadow-md shadow-[#50fa7b]/20"
                    >
                      <Mic className="w-4 h-4 text-[#282a36]" />
                      <span>Record Answer</span>
                    </button>
                  ) : (
                    <button
                      id="drill-stop-mic-btn"
                      type="button"
                      onClick={handleStopRecording}
                      className="px-5 py-2.5 rounded-xl bg-[#ff5555] hover:bg-[#ff5555]/90 text-[#f8f8f2] font-bold text-xs flex items-center gap-2 transition-all animate-pulse"
                    >
                      <MicOff className="w-4 h-4" />
                      <span>Stop Recording</span>
                    </button>
                  )}

                  <button
                    id="drill-sample-btn"
                    type="button"
                    onClick={() =>
                      handleUserTextChange(
                        selectedModule.practiceDrill?.modelBand9Sample ||
                          "In my perspective, this approach is fundamentally transformative."
                      )
                    }
                    className="px-3 py-2.5 rounded-xl bg-[#21222c] hover:bg-[#44475a] border border-[#44475a] text-[#f8f8f2] text-xs transition-colors flex items-center gap-1.5"
                  >
                    <Flame className="w-3.5 h-3.5 text-[#ffb86c]" />
                    <span>Try Sample Answer</span>
                  </button>
                </div>

                <button
                  id="drill-evaluate-btn"
                  type="button"
                  onClick={handleSubmitDrillAnswer}
                  disabled={!userSpokenText.trim() || isEvaluatingDrill || isRefiningTranscript}
                  className="px-6 py-2.5 rounded-xl bg-[#bd93f9] hover:bg-[#bd93f9]/90 disabled:opacity-40 disabled:pointer-events-none text-[#282a36] font-bold text-xs sm:text-sm shadow-lg shadow-[#bd93f9]/25 transition-all flex items-center gap-2"
                >
                  <Sparkles className="w-4 h-4" />
                  <span>{isEvaluatingDrill ? 'Lumi is Evaluating...' : 'Get Feedback'}</span>
                </button>
              </div>
            </div>
            )}

            {/* Instant Drill Feedback Panel */}
            <AnimatePresence>
              {drillFeedback && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="p-5 rounded-3xl bg-[#21222c] border border-[#bd93f9]/40 shadow-xl space-y-4"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-[#bd93f9] uppercase tracking-wider flex items-center gap-1.5">
                      <Sparkles className="w-4 h-4 text-[#bd93f9]" />
                      Lumi's Real-Time Drill Feedback
                    </span>
                    <span className="text-xs font-semibold text-[#50fa7b] flex items-center gap-1">
                      <CheckCircle2 className="w-3.5 h-3.5" /> Module Complete!
                    </span>
                  </div>

                  {/* Original Answer */}
                  {drillFeedback.originalAnswer && (
                    <div className="p-3.5 rounded-2xl bg-[#282a36] border border-[#44475a] text-xs space-y-1">
                      <span className="text-[10px] uppercase font-bold text-[#6272a4]">
                        Your Answer:
                      </span>
                      <p className="text-[#f8f8f2]/80 font-medium text-sm italic">
                        "{drillFeedback.originalAnswer}"
                      </p>
                    </div>
                  )}

                  {/* Upgraded version */}
                  <div className="p-3.5 rounded-2xl bg-[#282a36] border border-[#bd93f9]/30 text-xs space-y-1">
                    <span className="text-[10px] uppercase font-bold text-[#8be9fd]">
                      Polished Band 8.5 Phrasing:
                    </span>
                    <p className="text-[#f8f8f2] font-medium text-sm">
                      "{drillFeedback.correctedSentence}"
                    </p>
                  </div>

                  {/* Lexical Boost Chips */}
                  {drillFeedback.lexicalBoost && (
                    <div className="space-y-1.5">
                      <span className="text-[11px] font-semibold text-[#6272a4] uppercase">
                        Recommended Vocabulary Upgrades:
                      </span>
                      <div className="flex flex-wrap gap-1.5">
                        {drillFeedback.lexicalBoost.map((w: string, i: number) => (
                          <span
                            key={i}
                            className="text-xs px-2.5 py-1 rounded-lg bg-[#44475a] border border-[#bd93f9]/40 text-[#bd93f9] font-medium"
                          >
                            + {w}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Examiner Tip */}
                  {drillFeedback.ieltsTip && (
                    <div className="p-3 rounded-2xl bg-[#282a36] border border-[#44475a] text-xs text-[#f8f8f2] flex items-start gap-2">
                      <Lightbulb className="w-4 h-4 text-[#f1fa8c] shrink-0 mt-0.5" />
                      <div>
                        <strong className="text-[#f8f8f2]">Examiner Advice: </strong>
                        {drillFeedback.ieltsTip}
                      </div>
                    </div>
                  )}

                  {/* Reply to Lumi Section */}
                  <div className="pt-4 border-t border-[#44475a] space-y-3">
                    <span className="text-xs font-semibold text-[#f8f8f2] flex items-center gap-1.5">
                      <Mic className="w-3.5 h-3.5 text-[#8be9fd]" />
                      Reply to Lumi:
                    </span>
                    <textarea
                      value={userSpokenText}
                      onChange={(e) => handleUserTextChange(e.target.value)}
                      placeholder="Continue the conversation..."
                      className="w-full p-3 rounded-xl bg-[#282a36] border border-[#44475a] text-[#f8f8f2] text-xs sm:text-sm focus:outline-none focus:border-[#bd93f9]"
                      rows={2}
                    />
                    <div className="flex items-center gap-2">
                      {!isRecording ? (
                        <button
                          type="button"
                          onClick={handleStartRecording}
                          className="px-4 py-2 rounded-xl bg-[#50fa7b] hover:bg-[#50fa7b]/90 text-[#282a36] font-bold text-xs flex items-center gap-2"
                        >
                          <Mic className="w-4 h-4" />
                          <span>Record Reply</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={handleStopRecording}
                          className="px-4 py-2 rounded-xl bg-[#ff5555] hover:bg-[#ff5555]/90 text-[#f8f8f2] font-bold text-xs flex items-center gap-2 animate-pulse"
                        >
                          <MicOff className="w-4 h-4" />
                          <span>Stop Recording</span>
                        </button>
                      )}
                      
                      {userSpokenText.trim() && (
                        <button
                          type="button"
                          onClick={handleReplyToLumi}
                          disabled={isSubmittingReply}
                          className="px-5 py-2 rounded-xl bg-[#8be9fd] hover:bg-[#8be9fd]/90 disabled:opacity-40 disabled:cursor-not-allowed text-[#282a36] font-bold text-xs flex items-center gap-2 ml-auto"
                        >
                          <Send className="w-4 h-4" />
                          <span>{isSubmittingReply ? 'Sending...' : 'Send'}</span>
                        </button>
                      )}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
