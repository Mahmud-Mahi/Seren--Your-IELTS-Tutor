import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Award,
  Sparkles,
  TrendingUp,
  BookOpen,
  CheckCircle2,
  AlertCircle,
  Volume2,
  ArrowRight,
  RefreshCw,
  Zap,
  Mic,
  Activity,
  Layers,
  History,
  CalendarDays
} from 'lucide-react';
import { SpeakingEvaluation, UserProfile, SerenMood, SavedReport } from '../types';
import { SerenAvatar } from './SerenAvatar';
import { serenVoice, soundFX } from '../utils/speech';

interface EvaluationReportProps {
  evaluation: SpeakingEvaluation;
  history?: SavedReport[];
  activeReportId?: string;
  onSelectReport?: (id: string) => void;
  userProfile: UserProfile;
  voiceEnabled: boolean;
  onToggleVoice: () => void;
  onNavigateToLessons: () => void;
  onRetakeTest: () => void;
}

export const EvaluationReport: React.FC<EvaluationReportProps> = ({
  evaluation,
  history = [],
  activeReportId = '',
  onSelectReport,
  userProfile,
  voiceEnabled,
  onToggleVoice,
  onNavigateToLessons,
  onRetakeTest,
}) => {
  const [activeTab, setActiveTab] = useState<'overview' | 'pillars' | 'upgrades' | 'pronunciation'>('overview');
  const [playingAudioKey, setPlayingAudioKey] = useState<string | null>(null);
  const [partFilter, setPartFilter] = useState<'all' | 1 | 2 | 3>('all');

  // Full-coverage data: dedupe pronunciation words, apply the Part filter
  const allUpgrades = evaluation.upgradedExpressions || [];
  const filteredUpgrades =
    partFilter === 'all' ? allUpgrades : allUpgrades.filter((u) => (u.part ?? 0) === partFilter);

  const allTipsDeduped = (() => {
    const seen = new Set<string>();
    return (evaluation.pronunciationTips || []).filter((t) => {
      const key = t.word?.toLowerCase().trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  })();
  const filteredTips =
    partFilter === 'all' ? allTipsDeduped : allTipsDeduped.filter((t) => (t.part ?? 0) === partFilter);

  const hasParts = allUpgrades.some((u) => u.part !== undefined) || allTipsDeduped.some((t) => t.part !== undefined);

  const cefrColors: Record<string, { bg: string; text: string; border: string; glow: string }> = {
    A1: { bg: 'bg-[#21222c]', text: 'text-[#6272a4]', border: 'border-[#44475a]', glow: 'shadow-[#6272a4]/20' },
    A2: { bg: 'bg-[#21222c]', text: 'text-[#50fa7b]', border: 'border-[#50fa7b]/50', glow: 'shadow-[#50fa7b]/20' },
    B1: { bg: 'bg-[#21222c]', text: 'text-[#8be9fd]', border: 'border-[#8be9fd]/50', glow: 'shadow-[#8be9fd]/20' },
    B2: { bg: 'bg-[#21222c]', text: 'text-[#bd93f9]', border: 'border-[#bd93f9]/50', glow: 'shadow-[#bd93f9]/20' },
    C1: { bg: 'bg-[#21222c]', text: 'text-[#ff79c6]', border: 'border-[#ff79c6]/50', glow: 'shadow-[#ff79c6]/20' },
    C2: { bg: 'bg-[#21222c]', text: 'text-[#ffb86c]', border: 'border-[#ffb86c]/50', glow: 'shadow-[#ffb86c]/20' },
  };

  const currentCEFRStyle = cefrColors[evaluation.overallCEFR] || cefrColors.B2;

  // Render-safe accessors: a normalized evaluation always has these, but a
  // malformed one must degrade gracefully instead of blanking the page
  const bandScore = Number(evaluation.predictedIeltsBand ?? 0);

  // Compact, locale-aware date for the history list (e.g. "1 Jan 2026")
  const formatDate = (ts: number) => {
    try {
      return new Date(ts).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
    } catch {
      return '';
    }
  };

  const reportDisplayLabel = (entry: SavedReport) =>
    entry.testLabel || (entry.source === 'practice' ? '1v1 Chat Practice' : 'Cambridge Test');

  const handleSpeakText = (key: string, text: string) => {
    soundFX.playChime('start');
    setPlayingAudioKey(key);
    serenVoice.speak(text, {
      onEnd: () => setPlayingAudioKey(null),
    });
  };

  const pillarsList = [
    {
      id: 'fluency',
      title: 'Fluency & Coherence',
      data: evaluation.pillars?.fluency,
      desc: 'Speech rate, linking devices, and natural transition flow',
      color: 'from-[#8be9fd] to-[#bd93f9]',
    },
    {
      id: 'lexical',
      title: 'Lexical Resource',
      data: evaluation.pillars?.lexical,
      desc: 'Vocabulary range, collocations, and idiomatic precision',
      color: 'from-[#bd93f9] to-[#ff79c6]',
    },
    {
      id: 'grammar',
      title: 'Grammatical Range & Accuracy',
      data: evaluation.pillars?.grammar,
      desc: 'Complex clause variety, tenses, and structural mastery',
      color: 'from-[#ffb86c] to-[#ff5555]',
    },
    {
      id: 'pronunciation',
      title: 'Pronunciation & Intonation',
      data: evaluation.pillars?.pronunciation,
      desc: 'Rhythm, syllable stress, and connected speech clarity',
      color: 'from-[#50fa7b] to-[#8be9fd]',
    },
  ];

  return (
    <div id="evaluation-report-view" className="w-full max-w-6xl mx-auto space-y-6">
      {/* Top Header Card */}
      <div className="relative overflow-hidden p-6 sm:p-8 rounded-3xl bg-[#282a36] border border-[#44475a] shadow-2xl backdrop-blur-xl">
        <div className="absolute top-0 right-0 w-96 h-96 bg-gradient-to-br from-[#8be9fd]/10 via-[#bd93f9]/10 to-transparent rounded-full blur-3xl pointer-events-none" />

        <div className="relative z-10 grid grid-cols-1 lg:grid-cols-12 gap-6 items-center">
          {/* Summary Text */}
          <div className="lg:col-span-8 space-y-3">
            <div className="flex items-center gap-2">
              <span className="px-3 py-1 rounded-full bg-[#21222c] border border-[#bd93f9]/40 text-[#bd93f9] font-mono text-xs font-semibold uppercase tracking-wider flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5" />
                {evaluation.testLabel ? 'IELTS Speaking Test Result' : 'IELTS Speaking Diagnostic Result'}
              </span>
              {evaluation.testLabel && (
                <span className="px-2.5 py-1 rounded-full bg-[#8be9fd]/10 border border-[#8be9fd]/40 text-[#8be9fd] font-mono text-xs font-semibold whitespace-nowrap">
                  {evaluation.testLabel}
                </span>
              )}
              <span className="text-xs text-[#6272a4]">for {userProfile.nickname}</span>
            </div>

            <h1 className="text-2xl sm:text-3xl font-extrabold text-[#f8f8f2] tracking-tight">
              Evaluation for <span className="text-[#bd93f9]">{userProfile.nickname}</span>
            </h1>

            <p className="text-sm text-[#f8f8f2]/90 leading-relaxed font-normal">
              {evaluation.executiveSummary}
            </p>

            {/* Speaking Stats Row */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2">
              <div className="p-3 rounded-2xl bg-[#21222c] border border-[#44475a]">
                <div className="text-[11px] text-[#6272a4] font-medium">Estimated Band</div>
                <div className="text-xl font-bold text-[#8be9fd] font-mono">Band {bandScore.toFixed(1)}</div>
              </div>
              <div className="p-3 rounded-2xl bg-[#21222c] border border-[#44475a]">
                <div className="text-[11px] text-[#6272a4] font-medium">CEFR Level</div>
                <div className="text-xl font-bold text-[#bd93f9] font-mono">{evaluation.overallCEFR}</div>
              </div>
              <div className="p-3 rounded-2xl bg-[#21222c] border border-[#44475a]">
                <div className="text-[11px] text-[#6272a4] font-medium">Speech Rate</div>
                <div className="text-xl font-bold text-[#50fa7b] font-mono">{evaluation.stats?.estimatedWPM ?? '—'} WPM</div>
              </div>
              <div className="p-3 rounded-2xl bg-[#21222c] border border-[#44475a]">
                <div className="text-[11px] text-[#6272a4] font-medium">Target Band</div>
                <div className="text-xl font-bold text-[#ffb86c] font-mono">Band {userProfile.targetBand}</div>
              </div>
            </div>
          </div>

          {/* CEFR & IELTS Hero Badge */}
          <div className="lg:col-span-4 flex flex-col items-center justify-center p-6 rounded-3xl bg-[#21222c] border border-[#44475a] text-center relative shadow-xl">
            <div className="text-xs uppercase font-semibold text-[#6272a4] tracking-wider mb-2">
              Overall Proficiency
            </div>

            <div
              className={`w-28 h-28 rounded-3xl border-2 flex flex-col items-center justify-center shadow-2xl transition-all duration-500 ${currentCEFRStyle.bg} ${currentCEFRStyle.border} ${currentCEFRStyle.glow}`}
            >
              <span className={`text-4xl font-extrabold font-mono tracking-tight ${currentCEFRStyle.text}`}>
                {evaluation.overallCEFR}
              </span>
              <span className="text-[11px] font-bold text-[#f8f8f2] mt-0.5">
                Band {bandScore.toFixed(1)}
              </span>
            </div>

            <div className="mt-3 text-xs font-semibold text-[#f8f8f2]">
              {evaluation.cefrDescriptor}
            </div>
          </div>
        </div>
      </div>

      {/* Report History — jump back into any previous test's report */}
      {history.length > 0 && (
        <div className="relative overflow-hidden p-5 sm:p-6 rounded-3xl bg-[#21222c] border border-[#44475a] shadow-xl">
          <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
            <div className="flex items-center gap-2.5">
              <span className="p-2 rounded-xl bg-[#bd93f9]/20 text-[#bd93f9]">
                <History className="w-4 h-4" />
              </span>
              <div>
                <h3 className="text-sm font-bold text-[#f8f8f2]">Report History</h3>
                <p className="text-[11px] text-[#6272a4]">
                  Your past tests — tap one to reopen its full report.
                </p>
              </div>
            </div>
            <span className="text-xs font-mono font-bold px-2.5 py-1 rounded-full bg-[#282a36] border border-[#44475a] text-[#8be9fd]">
              {history.length} saved report{history.length === 1 ? '' : 's'}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {history.map((entry) => {
              const isActive = onSelectReport
                ? entry.id === activeReportId
                : entry.evaluation === evaluation;
              const style = cefrColors[entry.evaluation?.overallCEFR] || cefrColors.B2;
              return (
                <button
                  key={entry.id}
                  id={`history-report-${entry.id}`}
                  type="button"
                  onClick={() => onSelectReport?.(entry.id)}
                  className={`p-4 rounded-2xl border text-left transition-all flex flex-col gap-2 ${
                    isActive
                      ? 'bg-[#282a36] border-[#bd93f9] ring-1 ring-[#bd93f9]/40 shadow-lg shadow-[#bd93f9]/10'
                      : 'bg-[#21222c] border-[#44475a] hover:border-[#6272a4]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`text-[11px] font-bold font-mono px-2 py-0.5 rounded-md border ${style.border} ${style.text} ${style.bg}`}
                    >
                      {entry.evaluation?.overallCEFR || '—'} · Band{' '}
                      {(Number(entry.evaluation?.predictedIeltsBand) || 0).toFixed(1)}
                    </span>
                    {isActive && (
                      <span className="text-[10px] font-bold uppercase tracking-wider text-[#bd93f9]">
                        Viewing
                      </span>
                    )}
                  </div>
                  <span className="text-sm font-bold text-[#f8f8f2] leading-snug line-clamp-2">
                    {reportDisplayLabel(entry)}
                  </span>
                  <span className="text-[11px] text-[#6272a4] flex items-center gap-1">
                    <CalendarDays className="w-3 h-3" />
                    {formatDate(entry.completedAt)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Navigation Tabs */}
      <div className="flex items-center gap-2 p-1.5 rounded-2xl bg-[#21222c] border border-[#44475a] backdrop-blur-md overflow-x-auto">
        <button
          id="tab-btn-overview"
          type="button"
          onClick={() => setActiveTab('overview')}
          className={`px-4 py-2 rounded-xl text-xs font-semibold transition-all flex items-center gap-2 shrink-0 ${
            activeTab === 'overview'
              ? 'bg-[#bd93f9] text-[#282a36] shadow-md shadow-[#bd93f9]/25 font-bold'
              : 'text-[#6272a4] hover:text-[#f8f8f2]'
          }`}
        >
          <Award className="w-3.5 h-3.5" />
          <span>4-Pillar Score Cards</span>
        </button>

        <button
          id="tab-btn-upgrades"
          type="button"
          onClick={() => setActiveTab('upgrades')}
          className={`px-4 py-2 rounded-xl text-xs font-semibold transition-all flex items-center gap-2 shrink-0 ${
            activeTab === 'upgrades'
              ? 'bg-[#bd93f9] text-[#282a36] shadow-md shadow-[#bd93f9]/25 font-bold'
              : 'text-[#6272a4] hover:text-[#f8f8f2]'
          }`}
        >
          <Zap className="w-3.5 h-3.5" />
          <span>Band 8+ Sentence Upgrades ({allUpgrades.length})</span>
        </button>

        <button
          id="tab-btn-pronunciation"
          type="button"
          onClick={() => setActiveTab('pronunciation')}
          className={`px-4 py-2 rounded-xl text-xs font-semibold transition-all flex items-center gap-2 shrink-0 ${
            activeTab === 'pronunciation'
              ? 'bg-[#bd93f9] text-[#282a36] shadow-md shadow-[#bd93f9]/25 font-bold'
              : 'text-[#6272a4] hover:text-[#f8f8f2]'
          }`}
        >
          <Mic className="w-3.5 h-3.5" />
          <span>Phonetic Coaching ({allTipsDeduped.length})</span>
        </button>
      </div>

      {/* Tab Contents */}
      <AnimatePresence mode="wait">
        {activeTab === 'overview' && (
          <motion.div
            key="tab-overview"
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -15 }}
            className="space-y-6"
          >
            {/* 4 Core Pillars Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {pillarsList.map((p) => (
                <div
                  key={p.id}
                  className="p-5 sm:p-6 rounded-3xl bg-[#282a36] border border-[#44475a] shadow-xl space-y-4 hover:border-[#6272a4] transition-colors"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="text-base font-bold text-[#f8f8f2]">{p.title}</h3>
                      <p className="text-xs text-[#6272a4] mt-0.5">{p.desc}</p>
                    </div>
                    <div className="flex items-center gap-1.5 px-3 py-1 rounded-xl bg-[#21222c] border border-[#44475a] font-mono">
                      <span className="text-xs text-[#6272a4]">{p.data?.cefr ?? '—'}</span>
                      <span className="text-sm font-bold text-[#8be9fd]">Band {Number(p.data?.score ?? 0).toFixed(1)}</span>
                    </div>
                  </div>

                  {/* Strengths */}
                  <div className="space-y-2">
                    <div className="text-xs font-semibold text-[#50fa7b] flex items-center gap-1.5">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Demonstrated Strengths
                    </div>
                    <ul className="space-y-1 pl-4 list-disc text-xs text-[#f8f8f2]/80">
                      {(p.data?.strengths ?? []).map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  </div>

                  {/* Growth Areas */}
                  <div className="space-y-2 pt-1 border-t border-[#44475a]">
                    <div className="text-xs font-semibold text-[#ffb86c] flex items-center gap-1.5">
                      <AlertCircle className="w-3.5 h-3.5" />
                      Areas for Band Boost
                    </div>
                    <ul className="space-y-1 pl-4 list-disc text-xs text-[#f8f8f2]/80">
                      {(p.data?.growthAreas ?? []).map((g, i) => (
                        <li key={i}>{g}</li>
                      ))}
                    </ul>
                  </div>

                  {/* Examiner Commentary */}
                  <div className="p-3.5 rounded-2xl bg-[#21222c] border border-[#44475a] text-xs text-[#f8f8f2]/90 italic">
                    "{p.data?.examinerCommentary ?? ''}"
                  </div>
                </div>
              ))}
            </div>

            {/* Roadmap Teaser */}
            <div className="p-6 rounded-3xl bg-[#282a36] border border-[#bd93f9]/40 flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="space-y-1 text-center sm:text-left">
                <h3 className="text-base font-bold text-[#f8f8f2] flex items-center justify-center sm:justify-start gap-2">
                  <Layers className="w-4 h-4 text-[#8be9fd]" />
                  Your 4-Stage Personalized Lessons are Ready!
                </h3>
                <p className="text-xs text-[#6272a4]">
                  Seren generated dynamic interactive drills targeting your exact errors to reach Band {userProfile.targetBand}.
                </p>
              </div>

            </div>
          </motion.div>
        )}

        {activeTab === 'upgrades' && (
          <motion.div
            key="tab-upgrades"
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -15 }}
            className="space-y-4"
          >
            <div className="p-4 rounded-2xl bg-[#282a36] border border-[#44475a] text-xs text-[#f8f8f2]/90">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <p className="font-semibold text-[#8be9fd] mb-1">How Examiners Score Band 8+ Lexical Resource:</p>
                <span className="px-2.5 py-0.5 rounded-full bg-[#bd93f9]/20 border border-[#bd93f9]/50 text-[#bd93f9] font-mono text-[11px] font-bold shrink-0">
                  {filteredUpgrades.length} upgrade{filteredUpgrades.length === 1 ? '' : 's'}
                </span>
              </div>
              Examiners listen for natural collocations, idiomatic flexibility, and academic register. Each solution below is the model sample answer from the IELTS question bank for your topic — Seren can read it aloud for you. Click the audio icon to hear it spoken with native cadence!
            </div>

            {hasParts && (
              <div className="flex items-center gap-2 text-[11px]">
                {(['all', 1, 2, 3] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPartFilter(p)}
                    className={`px-3 py-1 rounded-full border font-semibold transition-colors ${
                      partFilter === p
                        ? 'bg-[#bd93f9]/25 border-[#bd93f9] text-[#bd93f9]'
                        : 'bg-[#21222c] border-[#44475a] text-[#6272a4] hover:text-[#f8f8f2]'
                    }`}
                  >
                    {p === 'all' ? 'All Parts' : `Part ${p}`}
                  </button>
                ))}
              </div>
            )}

            {filteredUpgrades.length === 0 && (
              <div className="p-6 rounded-2xl border border-[#44475a] bg-[#21222c] text-center text-xs text-[#6272a4]">
                No sentence upgrades available for this selection.
              </div>
            )}

            <div className="space-y-4">
              {filteredUpgrades.map((upg, idx) => (
                <div
                  key={idx}
                  className="p-5 rounded-3xl bg-[#282a36] border border-[#44475a] shadow-xl space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-[#6272a4] flex items-center gap-2">
                      Upgrade #{idx + 1}
                      {upg.part !== undefined && (
                        <span className="px-2 py-0.5 rounded-md bg-[#21222c] border border-[#50fa7b]/40 text-[#50fa7b] text-[10px] font-bold uppercase tracking-wider">
                          Part {upg.part}
                        </span>
                      )}
                    </span>
                    <span className="text-xs font-bold font-mono px-2.5 py-0.5 rounded-full bg-[#21222c] border border-[#bd93f9]/50 text-[#bd93f9]">
                      {upg.ieltsBand}
                    </span>
                  </div>

                  {/* Before */}
                  <div className="p-3 rounded-2xl bg-[#21222c] border border-[#ff5555]/30 text-xs space-y-1">
                    <span className="text-[10px] uppercase font-bold text-[#ff5555] tracking-wider">
                      Spoken Form:
                    </span>
                    <p className="text-[#f8f8f2]/80 font-normal">"{upg.original}"</p>
                  </div>

                  {/* After */}
                  <div className="p-3.5 rounded-2xl bg-[#21222c] border border-[#8be9fd]/40 text-xs space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] uppercase font-bold text-[#8be9fd] tracking-wider flex items-center gap-1">
                        <Sparkles className="w-3 h-3 text-[#8be9fd]" />
                        Seren's Band 8.5/9.0 Upgraded Phrasing:
                      </span>
                      <button
                        type="button"
                        onClick={() => handleSpeakText(`upg-${idx}`, upg.upgraded)}
                        className="p-1.5 rounded-lg bg-[#44475a] text-[#8be9fd] hover:bg-[#6272a4]/40 transition-colors flex items-center gap-1 text-[11px]"
                        title="Listen to Seren speak this sentence"
                      >
                        <Volume2 className="w-3.5 h-3.5" />
                        <span>Listen</span>
                      </button>
                    </div>
                    <p className="text-[#f8f8f2] font-medium leading-relaxed text-sm">
                      "{upg.upgraded}"
                    </p>
                  </div>

                  {/* Explanation */}
                  <p className="text-xs text-[#6272a4] leading-relaxed pl-1">
                    <strong className="text-[#f8f8f2]">Why it scores higher: </strong>
                    {upg.explanation}
                  </p>
                </div>
              ))}
            </div>
          </motion.div>
        )}

        {activeTab === 'pronunciation' && (
          <motion.div
            key="tab-pronunciation"
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -15 }}
            className="space-y-4"
          >
            <div className="p-4 rounded-2xl bg-[#282a36] border border-[#44475a] text-xs text-[#f8f8f2]/90">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <p className="font-semibold text-[#8be9fd] mb-1">IELTS Pronunciation Pillar Breakdown:</p>
                <span className="px-2.5 py-0.5 rounded-full bg-[#50fa7b]/20 border border-[#50fa7b]/50 text-[#50fa7b] font-mono text-[11px] font-bold shrink-0">
                  {filteredTips.length} word{filteredTips.length === 1 ? '' : 's'}
                </span>
              </div>
              In IELTS speaking, pronunciation evaluates syllable stress, vowel clarity, and natural sentence intonation. These are high-risk words detected in YOUR speech — practice shadowing each with Seren!
            </div>

            {hasParts && (
              <div className="flex items-center gap-2 text-[11px]">
                {(['all', 1, 2, 3] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPartFilter(p)}
                    className={`px-3 py-1 rounded-full border font-semibold transition-colors ${
                      partFilter === p
                        ? 'bg-[#50fa7b]/25 border-[#50fa7b] text-[#50fa7b]'
                        : 'bg-[#21222c] border-[#44475a] text-[#6272a4] hover:text-[#f8f8f2]'
                    }`}
                  >
                    {p === 'all' ? 'All Parts' : `Part ${p}`}
                  </button>
                ))}
              </div>
            )}

            {filteredTips.length === 0 && (
              <div className="p-6 rounded-2xl border border-[#44475a] bg-[#21222c] text-center text-xs text-[#6272a4]">
                No pronunciation flags for this selection.
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {filteredTips.map((tip, idx) => (
                <div
                  key={idx}
                  className="p-5 rounded-3xl bg-[#282a36] border border-[#44475a] shadow-xl space-y-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h4 className="text-lg font-bold text-[#f8f8f2] flex items-center gap-2">
                        {tip.word}
                        {tip.part !== undefined && (
                          <span className="px-1.5 py-0.5 rounded-md bg-[#21222c] border border-[#50fa7b]/40 text-[#50fa7b] text-[9px] font-bold uppercase tracking-wider">
                            P{tip.part}
                          </span>
                        )}
                      </h4>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs font-mono text-[#8be9fd]">{tip.ipa}</span>
                        <span className="text-xs font-mono text-[#6272a4]">({tip.phoneticSpelling})</span>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleSpeakText(`pron-${idx}`, `${tip.word}. ${tip.exampleSentence}`)}
                      className="p-2.5 rounded-2xl bg-[#21222c] border border-[#44475a] text-[#8be9fd] hover:bg-[#44475a] transition-colors shrink-0"
                      title="Hear phonetic pronunciation"
                    >
                      <Volume2 className={`w-4 h-4 ${playingAudioKey === `pron-${idx}` ? 'animate-pulse' : ''}`} />
                    </button>
                  </div>

                  <div className="p-3 rounded-2xl bg-[#21222c] border border-[#44475a] text-xs text-[#f8f8f2]">
                    <p className="font-semibold text-[#8be9fd] mb-0.5">Stress & Articulation Tip:</p>
                    <p className="text-[#f8f8f2]/80">{tip.tip}</p>
                  </div>

                  <div className="text-xs text-[#6272a4]">
                    <span className="text-[#f8f8f2] font-semibold">Example: </span>
                    "{tip.exampleSentence}"
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Bottom Action Row */}
      <div className="flex items-center justify-between pt-4 border-t border-[#44475a]">
        <button
          id="retake-test-btn"
          type="button"
          onClick={onRetakeTest}
          className="px-4 py-2.5 rounded-xl border border-[#44475a] bg-[#282a36] hover:bg-[#44475a] text-[#f8f8f2] text-xs font-medium transition-colors flex items-center gap-2"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Retake Diagnostic Test</span>
        </button>

        <button
          id="cta-lessons-btn-footer"
          type="button"
          onClick={onNavigateToLessons}
          className="px-6 py-2.5 rounded-xl bg-[#bd93f9] hover:bg-[#bd93f9]/90 text-[#282a36] font-bold text-xs sm:text-sm shadow-lg shadow-[#bd93f9]/25 transition-all flex items-center gap-2"
        >
          <span>Start Personalized Practice</span>
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
