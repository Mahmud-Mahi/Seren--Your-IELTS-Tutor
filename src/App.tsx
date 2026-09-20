import React, { useState, useEffect } from 'react';
import { UserProfile, SpeakingEvaluation, SavedReport, SavedLessonPlan } from './types';
import { Header } from './components/Header';
import { OnboardingModal } from './components/OnboardingModal';
import { CambridgeTest } from './components/CambridgeTest';
import { EvaluationReport } from './components/EvaluationReport';
import { LessonStudio } from './components/LessonStudio';
import { SerenLiveChat } from './components/SerenLiveChat';
import { CambridgeSolutions } from './components/CambridgeSolutions';
import { SettingsModal } from './components/SettingsModal';
import { serenVoice } from './utils/speech';
import { normalizeEvaluation } from './utils/evaluation';
import { setShortcutsSuspended } from './utils/shortcuts';
import { useShortcut } from './hooks/useShortcut';
import {
  loadLessonHistory,
  saveLessonPlan,
  markLessonComplete,
} from './utils/lessonHistory';

export default function App() {
  const [userProfile, setUserProfile] = useState<UserProfile | null>(() => {
    try {
      const saved = localStorage.getItem('seren_user_profile');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  const [evaluation, setEvaluation] = useState<SpeakingEvaluation | null>(() => {
    try {
      const saved = localStorage.getItem('seren_user_eval');
      // Normalize: a previously stored evaluation may be partial (LLM was
      // rate-limited/truncated) and must not crash the report view again
      return saved ? normalizeEvaluation(JSON.parse(saved)) : null;
    } catch {
      return null;
    }
  });

  // Score Report history: every completed Cambridge test / practice session is
  // kept so the user can jump back into any old report (seren_eval_history).
  const [history, setHistory] = useState<SavedReport[]>(() => {
    try {
      const saved = localStorage.getItem('seren_eval_history');
      const parsed = saved ? JSON.parse(saved) : null;
      if (Array.isArray(parsed)) return parsed;
    } catch {}
    return [];
  });
  const [activeReportId, setActiveReportId] = useState<string>('');

  // Custom Lesson history: the AI-generated lesson roadmap of EVERY completed
  // test / practice session is kept here (newest first) so a newer test never
  // deletes older lessons. Per-lesson tick marks persist in the same store
  // (seren_lesson_history).
  const [lessonPlans, setLessonPlans] = useState<SavedLessonPlan[]>(() => loadLessonHistory());

  const [currentView, setCurrentView] = useState<'diagnostic' | 'solutions' | 'report' | 'lessons' | 'chat'>(() => {
    try {
      // Resume exactly where the user left off — this is persisted on every
      // tab change, so a mid-diagnostic session or a specific tab survives a
      // server restart / reload.
      const saved = localStorage.getItem('seren_view');
      if (saved === 'diagnostic' || saved === 'solutions' || saved === 'report' || saved === 'lessons' || saved === 'chat') {
        return saved;
      }
      // No saved view yet: if a diagnostic was already completed, drop the
      // user into Custom Lessons; otherwise start at chat.
      if (localStorage.getItem('seren_user_eval')) return 'lessons';
    } catch {}
    return 'chat';
  });
  const [showOnboarding, setShowOnboarding] = useState<boolean>(!userProfile);
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [voiceEnabled, setVoiceEnabled] = useState<boolean>(true);

  // Sync state to localStorage
  useEffect(() => {
    if (userProfile) {
      localStorage.setItem('seren_user_profile', JSON.stringify(userProfile));
    }
  }, [userProfile]);

  useEffect(() => {
    if (evaluation) {
      localStorage.setItem('seren_user_eval', JSON.stringify(evaluation));
    }
  }, [evaluation]);

  // Persist the Score Report history so old reports survive reloads
  useEffect(() => {
    try {
      localStorage.setItem('seren_eval_history', JSON.stringify(history));
    } catch {}
  }, [history]);

  // One-time backfill: existing users who already completed a test before the
  // history feature only have seren_user_eval — seed a history entry from it so
  // the Score Report tab never shows an empty history for existing reports.
  useEffect(() => {
    if (!userProfile || !evaluation) return;
    if (history.length > 0) return;
    const legacyId = `report-legacy-${Date.now()}`;
    setHistory([
      {
        id: legacyId,
        completedAt: Date.now(),
        source: 'cambridge',
        testId: evaluation.testId,
        testLabel: evaluation.testLabel || (evaluation.testId ? 'Cambridge Test' : 'Practice Report'),
        evaluation,
      },
    ]);
    setActiveReportId(legacyId);
  }, [userProfile, evaluation, history]);

  // Self-healing sync: keep the active evaluation's Custom Lessons archived in
  // the lesson history. Whenever the active roadmap isn't in the store yet
  // (fresh test completion, legacy user, or lessons dropped by the old
  // id-based dedupe), it gets saved; otherwise this is a no-op. This replaces
  // the old one-time backfill and guarantees the lessons of the test you just
  // finished always appear in Custom Lessons.
  useEffect(() => {
    if (!userProfile || !evaluation) return;
    if (!evaluation.lessonRoadmap?.length) return;
    setLessonPlans(
      saveLessonPlan(evaluation, {
        source: evaluation.testId === 'practice-chat' ? 'practice' : 'cambridge',
        testId: evaluation.testId,
        testLabel:
          evaluation.testLabel || (evaluation.testId ? 'Cambridge Test' : 'Practice Report'),
      })
    );
  }, [userProfile, evaluation]);

  useEffect(() => {
    try {
      localStorage.setItem('seren_view', currentView);
    } catch {}
  }, [currentView]);

  // Every tab change must cut the outgoing view's voice synchronously, BEFORE
  // the new view mounts — its own greeting effects queue fresh speech only
  // after this. (A useEffect watching currentView would run too late and kill
  // the new tab's greeting instead of the old tab's voice.)
  const handleSelectView = (view: 'diagnostic' | 'solutions' | 'report' | 'lessons' | 'chat') => {
    serenVoice.stop();
    setCurrentView(view);
  };

  const handleCompleteOnboarding = (profile: UserProfile) => {
    serenVoice.stop();
    setUserProfile(profile);
    setShowOnboarding(false);
    // Post-onboarding the user lands directly in the 1v1 Interview (not
    // Casual Chat) — Seren greets and starts a fresh Part 1 topic interview.
    try {
      localStorage.setItem('seren_chat_mode', 'Interview');
    } catch {}
    setCurrentView('chat');
  };

  const handleEvaluationComplete = (newEval: SpeakingEvaluation) => {
    serenVoice.stop();
    // Fill any fields the LLM left out so the report can never blank out
    const normalized = normalizeEvaluation(newEval);
    setEvaluation(normalized);
    saveReportToHistory(normalized, {
      source: 'cambridge',
      testId: normalized.testId,
      testLabel: normalized.testLabel || 'Cambridge Test',
    });
    // Archive this test's Custom Lessons so the next test appends instead of
    // overwriting them.
    setLessonPlans(
      saveLessonPlan(normalized, {
        source: 'cambridge',
        testId: normalized.testId,
        testLabel: normalized.testLabel || 'Cambridge Test',
      })
    );
    setCurrentView('report');
  };

  // Persist a finished evaluation into the Score Report history and mark it as
  // the one currently open. Kept bounded so localStorage never balloons.
  const saveReportToHistory = (
    evaluationToSave: SpeakingEvaluation,
    opts: { source: SavedReport['source']; testId?: string; testLabel?: string }
  ) => {
    const id = `report-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const entry: SavedReport = {
      id,
      completedAt: Date.now(),
      source: opts.source,
      testId: opts.testId,
      testLabel: opts.testLabel,
      evaluation: evaluationToSave,
    };
    setHistory((prev) => [entry, ...prev].slice(0, 50));
    setActiveReportId(id);
    return id;
  };

  // Jump back into an older test's report picked from the Score Report history.
  const handleSelectReport = (id: string) => {
    const entry = history.find((h) => h.id === id);
    if (!entry) return;
    serenVoice.stop();
    setEvaluation(entry.evaluation);
    setActiveReportId(id);
  };

  const handleToggleVoice = () => {
    if (voiceEnabled) {
      serenVoice.stop();
    }
    setVoiceEnabled(!voiceEnabled);
  };

  // ---------------------------------------------------------------------------
  // Global keyboard shortcuts (all bindings are customizable in Settings)
  // ---------------------------------------------------------------------------
  // While a modal / onboarding flow owns the screen every shortcut stands down,
  // so a stray Alt+2 can never yank the user out of Settings mid-edit.
  useEffect(() => {
    setShortcutsSuspended(showSettings || showOnboarding);
    return () => setShortcutsSuspended(false);
  }, [showSettings, showOnboarding]);

  useShortcut('nav.diagnostic', () => handleSelectView('diagnostic'), Boolean(userProfile));
  useShortcut('nav.solutions', () => handleSelectView('solutions'), Boolean(userProfile));
  useShortcut(
    'nav.report',
    () => {
      if (evaluation) handleSelectView('report');
    },
    Boolean(userProfile) && Boolean(evaluation)
  );
  useShortcut(
    'nav.lessons',
    () => {
      if (evaluation) handleSelectView('lessons');
    },
    Boolean(userProfile) && Boolean(evaluation)
  );
  useShortcut('nav.chat', () => handleSelectView('chat'), Boolean(userProfile));
  useShortcut('global.toggleVoice', () => handleToggleVoice(), Boolean(userProfile));
  useShortcut('global.openSettings', () => setShowSettings(true));

  return (
    <div className="min-h-screen bg-[#282a36] text-[#f8f8f2] flex flex-col font-sans selection:bg-[#44475a] selection:text-[#8be9fd]">
      {/* Dynamic Background Dracula Glow Canvas */}
      <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
        <div className="absolute -top-40 -left-40 w-96 h-96 bg-[#bd93f9]/15 rounded-full blur-[140px]" />
        <div className="absolute top-1/3 -right-40 w-96 h-96 bg-[#ff79c6]/12 rounded-full blur-[140px]" />
        <div className="absolute -bottom-40 left-1/3 w-96 h-96 bg-[#8be9fd]/12 rounded-full blur-[140px]" />
      </div>

      {/* Main Top Header */}
      <Header
        currentView={currentView}
        onSelectView={handleSelectView}
        userProfile={userProfile}
        evaluation={evaluation}
        voiceEnabled={voiceEnabled}
        onToggleVoice={handleToggleVoice}
        onOpenSettings={() => setShowSettings(true)}
      />

      {/* Primary Workspace Viewport */}
      <main className="relative z-10 flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-8 flex flex-col">
        {userProfile && currentView === 'diagnostic' && (
          <CambridgeTest
            userProfile={userProfile}
            voiceEnabled={voiceEnabled}
            onToggleVoice={handleToggleVoice}
            onEvaluationComplete={handleEvaluationComplete}
          />
        )}

        {userProfile && currentView === 'report' && evaluation && (
          <EvaluationReport
            evaluation={evaluation}
            history={history}
            activeReportId={activeReportId}
            onSelectReport={handleSelectReport}
            userProfile={userProfile}
            voiceEnabled={voiceEnabled}
            onToggleVoice={handleToggleVoice}
            onNavigateToLessons={() => setCurrentView('lessons')}
            onRetakeTest={() => setCurrentView('diagnostic')}
          />
        )}

        {userProfile && currentView === 'lessons' && evaluation && (
          <LessonStudio
            evaluation={evaluation}
            userProfile={userProfile}
            voiceEnabled={voiceEnabled}
            onToggleVoice={handleToggleVoice}
            lessonPlans={lessonPlans}
            onMarkLessonComplete={(planId, moduleId) =>
              setLessonPlans(markLessonComplete(planId, moduleId))
            }
          />
        )}

        {userProfile && currentView === 'chat' && (
          <SerenLiveChat
            userProfile={userProfile}
            evaluation={evaluation}
            voiceEnabled={voiceEnabled}
            onToggleVoice={handleToggleVoice}
            onPracticeEvaluationComplete={(newEval) => {
              serenVoice.stop();
              const normalized = normalizeEvaluation(newEval);
              // Practice sessions (1v1 Chat interview) also land in the Score
              // Report history so they are never lost behind a Cambridge retake.
              const stamped = {
                ...normalized,
                testId: normalized.testId || 'practice-chat',
                testLabel: normalized.testLabel || '1v1 Chat Practice',
              };
              setEvaluation(stamped);
              saveReportToHistory(stamped, {
                source: 'practice',
                testLabel: stamped.testLabel,
              });
              // Archive the practice session's lessons too (newest first).
              setLessonPlans(
                saveLessonPlan(stamped, {
                  source: 'practice',
                  testLabel: stamped.testLabel,
                })
              );
              setCurrentView('report');
            }}
          />
        )}

        {userProfile && currentView === 'solutions' && (
          <CambridgeSolutions
            userProfile={userProfile}
            voiceEnabled={voiceEnabled}
            onToggleVoice={handleToggleVoice}
          />
        )}
      </main>

      {/* Initial Onboarding Modal */}
      {showOnboarding && (
        <OnboardingModal
          onComplete={handleCompleteOnboarding}
          voiceEnabled={voiceEnabled}
          onToggleVoice={handleToggleVoice}
        />
      )}

      {/* AI Engine & Voice Settings Modal */}
      <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} />
    </div>
  );
}
