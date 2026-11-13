import React, { useEffect, useState } from 'react';
import {
  Sparkles,
  Award,
  BookOpen,
  MessageSquare,
  Speech,
  Volume2,
  VolumeX,
  UserCheck,
  Settings,
  Cloud,
  CloudOff,
  RefreshCw,
  Check,
} from 'lucide-react';
import { UserProfile, SpeakingEvaluation } from '../types';
import { getSyncStatus, subscribeSyncStatus, syncNow, type SyncStatus } from '../auth/sync';
import { USER_AVATAR_IMAGE, SEREN_PROFILE_IMAGE } from '../assets/characterAssets';
import { useShortcutHint } from '../hooks/useShortcut';

interface HeaderProps {
  currentView: 'diagnostic' | 'solutions' | 'report' | 'lessons' | 'chat';
  onSelectView: (view: 'diagnostic' | 'solutions' | 'report' | 'lessons' | 'chat') => void;
  userProfile?: UserProfile | null;
  evaluation?: SpeakingEvaluation | null;
  voiceEnabled: boolean;
  onToggleVoice: () => void;
  onOpenSettings: () => void;
  onOpenProfile: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  currentView,
  onSelectView,
  userProfile,
  evaluation,
  voiceEnabled,
  onToggleVoice,
  onOpenSettings,
  onOpenProfile,
}) => {
  // Shortcut hints for the tooltips (bindings are user-customizable in Settings).
  const diagnosticHint = useShortcutHint('nav.diagnostic');
  const solutionsHint = useShortcutHint('nav.solutions');
  const reportHint = useShortcutHint('nav.report');
  const lessonsHint = useShortcutHint('nav.lessons');
  const chatHint = useShortcutHint('nav.chat');
  const voiceHint = useShortcutHint('global.toggleVoice');
  const settingsHint = useShortcutHint('global.openSettings');
  const withHint = (label: string, hint: string) => (hint ? `${label} (${hint})` : label);

  // Cloud-sync indicator. A failed upload used to be completely invisible, so
  // the learner had no idea their progress was not reaching the cloud. The
  // badge shows the real state and offers a one-click retry.
  const [sync, setSync] = useState<SyncStatus>(() => getSyncStatus());
  const [syncBusy, setSyncBusy] = useState(false);
  useEffect(() => subscribeSyncStatus(setSync), []);
  const handleSyncNow = async () => {
    setSyncBusy(true);
    try {
      await syncNow();
    } finally {
      setSyncBusy(false);
    }
  };
  const syncBroken = sync.phase === 'error' && !!sync.message;
  const syncPending = sync.phase === 'syncing' || sync.pending > 0;

  return (
    <header className="sticky top-0 z-40 w-full bg-[#21222c]/90 backdrop-blur-xl border-b border-[#44475a]/80">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
        {/* Brand & Character beacon */}
        <div className="flex items-center gap-3">
          <div className="relative flex items-center justify-center w-10 h-10 rounded-2xl bg-gradient-to-tr from-[#ff79c6] via-[#bd93f9] to-[#8be9fd] p-[1.5px] shadow-lg shadow-[#bd93f9]/25">
            <div className="w-full h-full rounded-[14px] overflow-hidden bg-[#282a36]">
              <img
                src={SEREN_PROFILE_IMAGE}
                alt="Seren"
                className="w-full h-full object-cover"
                draggable={false}
              />
            </div>
            <span className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-[#50fa7b] ring-2 ring-[#282a36] animate-pulse" />
          </div>
        </div>

        {/* Center View Navigation Tabs (Desktop) */}
        {userProfile && (
          <nav className="hidden md:flex items-center gap-1 p-1 rounded-2xl bg-[#21222c] border border-[#44475a]">
            <button
              id="nav-diagnostic-btn"
              type="button"
              onClick={() => onSelectView('diagnostic')}
              title={withHint('Cambridge Test — full speaking test', diagnosticHint)}
              className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5 ${
                currentView === 'diagnostic'
                  ? 'bg-[#bd93f9] text-[#282a36] shadow-md shadow-[#bd93f9]/30 font-bold'
                  : 'text-[#6272a4] hover:text-[#f8f8f2] hover:bg-[#44475a]/50'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>Cambridge Test</span>
            </button>

            <button
              id="nav-solutions-btn"
              type="button"
              onClick={() => onSelectView('solutions')}
              className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5 ${
                currentView === 'solutions'
                  ? 'bg-[#bd93f9] text-[#282a36] shadow-md shadow-[#bd93f9]/30 font-bold'
                  : 'text-[#6272a4] hover:text-[#f8f8f2] hover:bg-[#44475a]/50'
              }`}
              title={withHint('Cambridge Solutions — Seren answers Cambridge questions live', solutionsHint)}
            >
              <Speech className="w-3.5 h-3.5" />
              <span>Solutions</span>
            </button>

            <button
              id="nav-report-btn"
              type="button"
              onClick={() => evaluation && onSelectView('report')}
              disabled={!evaluation}
              title={withHint('Score Report — band, strengths & next steps', reportHint)}
              className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5 ${
                currentView === 'report'
                  ? 'bg-[#bd93f9] text-[#282a36] shadow-md shadow-[#bd93f9]/30 font-bold'
                  : evaluation
                  ? 'text-[#6272a4] hover:text-[#f8f8f2] hover:bg-[#44475a]/50'
                  : 'text-[#6272a4]/40 opacity-40 cursor-not-allowed'
              }`}
            >
              <Award className="w-3.5 h-3.5" />
              <span>Score Report</span>
              {evaluation && (
                <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-[#282a36] text-[#50fa7b] border border-[#44475a]">
                  {evaluation.overallCEFR}
                </span>
              )}
            </button>

            <button
              id="nav-lessons-btn"
              type="button"
              onClick={() => evaluation && onSelectView('lessons')}
              disabled={!evaluation}
              title={withHint('Custom Lessons — your personalized roadmap', lessonsHint)}
              className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5 ${
                currentView === 'lessons'
                  ? 'bg-[#bd93f9] text-[#282a36] shadow-md shadow-[#bd93f9]/30 font-bold'
                  : evaluation
                  ? 'text-[#6272a4] hover:text-[#f8f8f2] hover:bg-[#44475a]/50'
                  : 'text-[#6272a4]/40 opacity-40 cursor-not-allowed'
              }`}
            >
              <BookOpen className="w-3.5 h-3.5" />
              <span>Custom Lessons</span>
            </button>

            <button
              id="nav-chat-btn"
              type="button"
              onClick={() => onSelectView('chat')}
              title={withHint('1v1 Chat — interview & casual practice', chatHint)}
              className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5 ${
                currentView === 'chat'
                  ? 'bg-[#bd93f9] text-[#282a36] shadow-md shadow-[#bd93f9]/30 font-bold'
                  : 'text-[#6272a4] hover:text-[#f8f8f2] hover:bg-[#44475a]/50'
              }`}
            >
              <MessageSquare className="w-3.5 h-3.5" />
              <span>1v1 Chat</span>
            </button>
          </nav>
        )}

        {/* Right Tools: Profile Badge & Audio Toggle */}
        <div className="flex items-center gap-2">
          {userProfile && (
            <button
              type="button"
              onClick={onOpenProfile}
              className="hidden sm:flex items-center gap-2 px-3 py-1 rounded-xl bg-[#21222c] border border-[#44475a] hover:border-[#bd93f9] hover:bg-[#44475a]/40 transition-colors text-left text-xs"
              title="Edit your profile and learning preferences"
            >
              <span className="w-7 h-7 rounded-full border-2 border-[#ff79c6]/50 overflow-hidden bg-[#282a36] shrink-0">
                <img
                  src={userProfile.avatarUrl || USER_AVATAR_IMAGE}
                  alt={userProfile.nickname}
                  className="w-full h-full object-cover"
                  draggable={false}
                />
              </span>
              <span className="font-semibold text-[#f8f8f2]">{userProfile.nickname}</span>
              <span className="text-[#ffb86c] font-mono font-medium">Band {userProfile.targetBand}</span>
            </button>
          )}

          <button
            id="header-voice-toggle"
            type="button"
            onClick={onToggleVoice}
            className={`p-2 rounded-xl border transition-all ${
              voiceEnabled
                ? 'bg-[#bd93f9]/20 border-[#bd93f9]/50 text-[#bd93f9] hover:bg-[#bd93f9]/30'
                : 'bg-[#21222c] border-[#44475a] text-[#6272a4] hover:text-[#f8f8f2]'
            }`}
            title={voiceEnabled
              ? withHint('Mute Voice Audio', voiceHint)
              : withHint('Unmute Voice Audio', voiceHint)}
          >
            {voiceEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
          </button>

          {/* Cloud sync state — visible, actionable, and honest about failures. */}
          {userProfile && (
            <button
              id="header-sync-status"
              type="button"
              onClick={() => void handleSyncNow()}
              disabled={syncBusy}
              title={
                syncBroken
                  ? sync.message
                  : syncPending
                    ? `Uploading ${sync.pending} item(s) to the cloud…`
                    : sync.lastSyncedAt
                      ? 'Cloud sync is up to date — click to sync now'
                      : 'Sync your progress to the cloud'
              }
              className={`p-2 rounded-xl border transition-all ${
                syncBroken
                  ? 'bg-[#ff5555]/15 border-[#ff5555]/60 text-[#ff5555] hover:bg-[#ff5555]/25'
                  : syncPending
                    ? 'bg-[#ffb86c]/15 border-[#ffb86c]/50 text-[#ffb86c] hover:bg-[#ffb86c]/25'
                    : 'bg-[#21222c] border-[#44475a] text-[#50fa7b] hover:bg-[#44475a]'
              }`}
            >
              {syncBroken ? (
                <CloudOff className="w-4 h-4" />
              ) : syncPending ? (
                <RefreshCw className="w-4 h-4 animate-spin" />
              ) : (
                <Cloud className="w-4 h-4" />
              )}
            </button>
          )}

          <button
            id="header-settings"
            type="button"
            onClick={onOpenSettings}
            className="p-2 rounded-xl border border-[#44475a] bg-[#21222c] hover:bg-[#44475a] text-[#6272a4] hover:text-[#8be9fd] transition-colors"
            title={withHint('App Settings', settingsHint)}
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Mobile Navigation Sub-bar */}
      {userProfile && (
        <div className="md:hidden flex items-center justify-around px-2 py-2 border-t border-[#44475a] bg-[#21222c]/95 text-xs">
          <button
            type="button"
            onClick={() => onSelectView('diagnostic')}
            className={`px-2.5 py-1 rounded-lg ${currentView === 'diagnostic' ? 'bg-[#bd93f9] text-[#282a36] font-bold' : 'text-[#6272a4]'}`}
          >
            Cambridge
          </button>
          <button
            type="button"
            onClick={() => onSelectView('solutions')}
            className={`px-2.5 py-1 rounded-lg ${currentView === 'solutions' ? 'bg-[#bd93f9] text-[#282a36] font-bold' : 'text-[#6272a4]'}`}
          >
            Solutions
          </button>
          <button
            type="button"
            onClick={() => evaluation && onSelectView('report')}
            disabled={!evaluation}
            className={`px-2.5 py-1 rounded-lg ${currentView === 'report' ? 'bg-[#bd93f9] text-[#282a36] font-bold' : evaluation ? 'text-[#6272a4]' : 'text-[#6272a4]/40'}`}
          >
            Report
          </button>
          <button
            type="button"
            onClick={() => evaluation && onSelectView('lessons')}
            disabled={!evaluation}
            className={`px-2.5 py-1 rounded-lg ${currentView === 'lessons' ? 'bg-[#bd93f9] text-[#282a36] font-bold' : evaluation ? 'text-[#6272a4]' : 'text-[#6272a4]/40'}`}
          >
            Lessons
          </button>
          <button
            type="button"
            onClick={() => onSelectView('chat')}
            className={`px-2.5 py-1 rounded-lg ${currentView === 'chat' ? 'bg-[#bd93f9] text-[#282a36] font-bold' : 'text-[#6272a4]'}`}
          >
            1v1 Chat
          </button>
        </div>
      )}
    </header>
  );
};
