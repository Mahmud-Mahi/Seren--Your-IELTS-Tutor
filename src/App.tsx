import React, { useState, useEffect, useRef } from 'react';
import { CloudOff, RefreshCw } from 'lucide-react';
import { UserProfile, SpeakingEvaluation, SavedReport, SavedLessonPlan } from './types';
import { Header } from './components/Header';
import { OnboardingModal } from './components/OnboardingModal';
import { UserPref } from './components/UserPref';
import { AccountGate } from './components/AccountGate';
import {
  setSyncSession,
  hydrate,
  fetchRecoverySnapshot,
  getSyncStatus,
  subscribeSyncStatus,
  syncNow,
  type SyncStatus,
} from './auth/sync';
import { onSessionChange, isLocalOnlySession, signOut, type AuthSession } from './auth/session';
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

interface SerenAppProps {
  session: AuthSession;
  onSignOut: () => void;
  lastSyncAt: number | null;
}

const SerenApp: React.FC<SerenAppProps> = ({ session, onSignOut }) => {
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

  // The most recent evaluation that came from a REAL analysis (not a
  // degraded/fallback one). A failed attempt must never destroy the report
  // the learner already earned, so the persisted copy keeps pointing at this
  // one until a genuine result replaces it.
  const lastValidEvaluationRef = useRef<SpeakingEvaluation | null>(null);

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
  const [showProfileEditor, setShowProfileEditor] = useState<boolean>(false);
  const [showSettings, setShowSettings] = useState<boolean>(false);
  // Cloud-sync state. A failed upload MUST be visible: the learner needs to
  // know their progress is not reaching the cloud (and why).
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(() => getSyncStatus());
  const [syncBusy, setSyncBusy] = useState(false);
  useEffect(() => subscribeSyncStatus(setSyncStatus), []);
  const handleSyncNow = async () => {
    setSyncBusy(true);
    try {
      await syncNow();
    } finally {
      setSyncBusy(false);
    }
  };
  const [voiceEnabled, setVoiceEnabled] = useState<boolean>(true);

  // Sync state to localStorage
  useEffect(() => {
    if (userProfile) {
      localStorage.setItem('seren_user_profile', JSON.stringify(userProfile));
    }
  }, [userProfile]);

  useEffect(() => {
    if (!evaluation) return;
    // A degraded/fallback report (the AI engine was unavailable) must not
    // overwrite the last REAL report on disk — otherwise a transient outage
    // would permanently replace the learner's earned result with a
    // placeholder. The degraded report is still shown in the UI and kept in
    // the history, but the persisted "current" evaluation stays valid.
    const isDegraded = !!evaluation.degradation?.usedFallback;
    if (isDegraded) {
      if (lastValidEvaluationRef.current) {
        try {
          localStorage.setItem(
            'seren_user_eval',
            JSON.stringify(lastValidEvaluationRef.current)
          );
        } catch {}
      }
      return;
    }
    lastValidEvaluationRef.current = evaluation;
    try {
      localStorage.setItem('seren_user_eval', JSON.stringify(evaluation));
    } catch {}
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

  // -------------------------------------------------------------------------
  // Lesson-only regeneration.
  //
  // When the lesson pass of an evaluation degrades (rate limit, provider
  // hiccup) the learner should not have to retake the whole test. This
  // regenerates ONLY the roadmap from the answers already on record and
  // replaces the stored plan in place, keeping the tick marks.
  // -------------------------------------------------------------------------
  const [isRegeneratingLessons, setIsRegeneratingLessons] = useState(false);
  const [lessonRegenError, setLessonRegenError] = useState<string | null>(null);

  const handleRegenerateLessons = async (): Promise<boolean> => {
    if (!userProfile || !evaluation) return false;
    setIsRegeneratingLessons(true);
    setLessonRegenError(null);
    try {
      const res = await fetch('/api/generate-lessons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userProfile,
          evaluation: {
            pillars: evaluation.pillars,
            upgradedExpressions: evaluation.upgradedExpressions,
            priorityErrors: evaluation.priorityErrors,
            lessonRoadmap: evaluation.lessonRoadmap,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.success || !Array.isArray(data.lessonRoadmap)) {
        throw new Error(data?.error || 'Lesson generation failed.');
      }
      const modules = data.lessonRoadmap;
      if (modules.length === 0) {
        setLessonRegenError(
          'Seren could not find a teachable error in this attempt — try the diagnostic again for fresh lessons.'
        );
        return false;
      }
      const nextEval: SpeakingEvaluation = {
        ...evaluation,
        lessonRoadmap: modules,
        degradation: data.degradation || undefined,
      };
      setEvaluation(nextEval);
      setLessonPlans(
        saveLessonPlan(nextEval, {
          source: evaluation.testId === 'practice-chat' ? 'practice' : 'cambridge',
          testId: evaluation.testId,
          testLabel: evaluation.testLabel || 'Custom Lessons',
        })
      );
      return true;
    } catch (err: any) {
      console.error('Lesson regeneration failed:', err);
      setLessonRegenError(err?.message || 'Seren could not rebuild your lessons right now.');
      return false;
    } finally {
      setIsRegeneratingLessons(false);
    }
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
        onOpenProfile={() => setShowProfileEditor(true)}
      />

      {/* Primary Workspace Viewport */}
      <main className="relative z-10 flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-8 flex flex-col">
        {/* Cloud-sync banner — a failed upload is never silent. */}
        {syncStatus.phase === 'error' && syncStatus.message && (
          <div className="mb-4 p-3.5 rounded-2xl bg-[#ff5555]/10 border border-[#ff5555]/40 flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex items-start gap-2.5 flex-1 min-w-0">
              <CloudOff className="w-4 h-4 text-[#ff5555] shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-xs font-bold text-[#f8f8f2]">Cloud sync problem</p>
                <p className="text-xs text-[#f8f8f2]/80 mt-0.5 leading-relaxed">{syncStatus.message}</p>
                {syncStatus.pending > 0 && (
                  <p className="text-[11px] text-[#6272a4] mt-0.5">
                    {syncStatus.pending} item(s) are still waiting to upload — nothing is lost, it stays on this device.
                  </p>
                )}
              </div>
            </div>
            {syncStatus.retryable && (
              <button
                id="banner-sync-retry"
                type="button"
                onClick={() => void handleSyncNow()}
                disabled={syncBusy}
                className="px-3 py-1.5 rounded-xl bg-[#ff5555] hover:bg-[#ff5555]/90 disabled:opacity-60 text-[#f8f8f2] text-xs font-semibold flex items-center gap-1.5 transition-colors shrink-0"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${syncBusy ? 'animate-spin' : ''}`} />
                <span>Retry sync</span>
              </button>
            )}
          </div>
        )}

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
            onRegenerateLessons={handleRegenerateLessons}
            isRegeneratingLessons={isRegeneratingLessons}
            lessonRegenError={lessonRegenError}
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
            onRegenerateLessons={handleRegenerateLessons}
            isRegeneratingLessons={isRegeneratingLessons}
            lessonRegenError={lessonRegenError}
            onNavigateToDiagnostic={() => setCurrentView('diagnostic')}
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

      {showProfileEditor && userProfile && (
        <UserPref
          profile={userProfile}
          accountEmail={session.email}
          accountOffline={isLocalOnlySession(session)}
          onSignOut={onSignOut}
          onSave={(profile) => {
            setUserProfile(profile);
            setShowProfileEditor(false);
          }}
          onClose={() => setShowProfileEditor(false)}
        />
      )}

      {/* AI Engine & Voice Settings Modal */}
      <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} />
    </div>
  );
};

/**
 * Auth shell — sign in FIRST on first open (before onboarding), restore any
 * existing Firebase session, hydrate local storage from the account, and only
 * then mount the app so every useState initialiser reads the merged data.
 */
export default function App() {
  const [phase, setPhase] = useState<'boot' | 'gate' | 'ready'>('boot');
  const [session, setSession] = useState<AuthSession | null>(null);

  // Boot once: restore the Firebase session (the SDK persists it, so a
  // returning user is signed in without any prompt), then hydrate (merge
  // account data in, upload local-only keys) BEFORE mounting SerenApp.
  useEffect(() => {
    let cancelled = false;
    const unsubscribe = onSessionChange((restored) => {
      if (cancelled) return;
      if (!restored) {
        setPhase('gate');
        return;
      }
      void (async () => {
        setSyncSession(restored);
        try {
          // Best-effort recovery + cloud merge before the app reads localStorage.
          await fetchRecoverySnapshot();
          await hydrate(restored);
        } catch {}
        if (cancelled) return;
        setSession(restored);
        setPhase('ready');
      })();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const handleAuthed = async (next: AuthSession) => {
    setSyncSession(next);
    try {
      // One-time restore of wipe-bug transcripts (no-op when keys are intact),
      // then hydrate so recovered data uploads to this account too.
      await fetchRecoverySnapshot();
    } catch {}
    try {
      await hydrate(next);
    } catch {}
    setSession(next);
    setPhase('ready');
  };

  const handleSignOut = async () => {
    setSyncSession(null);
    setSession(null);
    setPhase('gate');
    try {
      await signOut();
    } catch {}
  };

  if (phase === 'gate') {
    return <AccountGate onAuthed={handleAuthed} />;
  }

  if (phase !== 'ready' || !session) {
    return (
      <div className="min-h-screen bg-[#282a36] flex items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-[#6272a4]">
          <span className="w-4 h-4 rounded-full border-2 border-[#bd93f9]/40 border-t-[#bd93f9] animate-spin" />
          Starting Seren…
        </div>
      </div>
    );
  }

  // Remount the workspace per account so all state initialisers read that
  // account's hydrated storage and never leak between accounts.
  return <SerenApp key={session.uid} session={session} onSignOut={handleSignOut} lastSyncAt={null} />;
}
