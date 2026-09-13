import React from 'react';
import { Sparkles, Award, BookOpen, MessageSquare, Speech, Volume2, VolumeX, UserCheck, Settings } from 'lucide-react';
import { UserProfile, SpeakingEvaluation } from '../types';
import { USER_AVATAR_IMAGE, LUMI_PROFILE_IMAGE } from '../assets/characterAssets';

interface HeaderProps {
  currentView: 'diagnostic' | 'solutions' | 'report' | 'lessons' | 'chat';
  onSelectView: (view: 'diagnostic' | 'solutions' | 'report' | 'lessons' | 'chat') => void;
  userProfile?: UserProfile | null;
  evaluation?: SpeakingEvaluation | null;
  voiceEnabled: boolean;
  onToggleVoice: () => void;
  onOpenSettings: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  currentView,
  onSelectView,
  userProfile,
  evaluation,
  voiceEnabled,
  onToggleVoice,
  onOpenSettings,
}) => {
  return (
    <header className="sticky top-0 z-40 w-full bg-[#21222c]/90 backdrop-blur-xl border-b border-[#44475a]/80">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
        {/* Brand & Character beacon */}
        <div className="flex items-center gap-3">
          <div className="relative flex items-center justify-center w-10 h-10 rounded-2xl bg-gradient-to-tr from-[#ff79c6] via-[#bd93f9] to-[#8be9fd] p-[1.5px] shadow-lg shadow-[#bd93f9]/25">
            <div className="w-full h-full rounded-[14px] overflow-hidden bg-[#282a36]">
              <img
                src={LUMI_PROFILE_IMAGE}
                alt="Lumi"
                className="w-full h-full object-cover"
                draggable={false}
              />
            </div>
            <span className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-[#50fa7b] ring-2 ring-[#282a36] animate-pulse" />
          </div>

          <div>
            <div className="flex items-center gap-1.5">
              <span className="font-extrabold text-base sm:text-lg tracking-tight text-[#f8f8f2] font-sans">
                LUMI
              </span>
              <span className="text-[10px] uppercase font-bold tracking-widest px-1.5 py-0.5 rounded bg-[#44475a] border border-[#6272a4]/50 text-[#8be9fd]">
                IELTS AI
              </span>
            </div>
            <p className="text-[11px] text-[#6272a4] hidden sm:block">
              Your IELTS Tutor
            </p>
          </div>
        </div>

        {/* Center View Navigation Tabs (Desktop) */}
        {userProfile && (
          <nav className="hidden md:flex items-center gap-1 p-1 rounded-2xl bg-[#21222c] border border-[#44475a]">
            <button
              id="nav-diagnostic-btn"
              type="button"
              onClick={() => onSelectView('diagnostic')}
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
              title="Cambridge Solutions — Lumi answers Cambridge questions live"
            >
              <Speech className="w-3.5 h-3.5" />
              <span>Solutions</span>
            </button>

            <button
              id="nav-report-btn"
              type="button"
              onClick={() => evaluation && onSelectView('report')}
              disabled={!evaluation}
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
            <div className="hidden sm:flex items-center gap-2 px-3 py-1 rounded-xl bg-[#21222c] border border-[#44475a] text-xs">
              <span className="w-7 h-7 rounded-full border-2 border-[#ff79c6]/50 overflow-hidden bg-[#282a36] shrink-0">
                <img
                  src={USER_AVATAR_IMAGE}
                  alt={userProfile.nickname}
                  className="w-full h-full object-cover"
                  draggable={false}
                />
              </span>
              <span className="font-semibold text-[#f8f8f2]">{userProfile.nickname}</span>
              <span className="text-[#ffb86c] font-mono font-medium">Band {userProfile.targetBand}</span>
            </div>
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
            title={voiceEnabled ? 'Mute Voice Audio' : 'Unmute Voice Audio'}
          >
            {voiceEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
          </button>

          <button
            id="header-settings"
            type="button"
            onClick={onOpenSettings}
            className="p-2 rounded-xl border border-[#44475a] bg-[#21222c] hover:bg-[#44475a] text-[#6272a4] hover:text-[#8be9fd] transition-colors"
            title="AI Engine & Voice Settings"
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
