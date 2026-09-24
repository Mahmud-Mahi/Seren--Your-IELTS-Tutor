import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { User, Target, Users, Award, Sparkles, ArrowRight, CheckCircle2, BookOpen, Upload, X } from 'lucide-react';
import { UserProfile } from '../types';
import { SerenAvatar } from './SerenAvatar';
import { soundFX } from '../utils/speech';
import { USER_AVATAR_IMAGE } from '../assets/characterAssets';

interface OnboardingModalProps {
  onComplete: (profile: UserProfile) => void;
  voiceEnabled: boolean;
  onToggleVoice: () => void;
}

export const OnboardingModal: React.FC<OnboardingModalProps> = ({
  onComplete,
  voiceEnabled,
  onToggleVoice,
}) => {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [nickname, setNickname] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [goal, setGoal] = useState('IELTS Academic');
  const [targetAudience, setTargetAudience] = useState('IELTS Examiners');
  const [targetBand, setTargetBand] = useState('7.5');
  const [selfAssessedLevel, setSelfAssessedLevel] = useState('B2 - Upper Intermediate');
  const [preferredFocus, setPreferredFocus] = useState<string[]>([
    'Fluency & Flow',
    'Band 8+ Vocabulary',
  ]);

  const goals = [
    { id: 'IELTS Academic', label: 'IELTS Academic Exam', desc: 'University admissions & professional registration' },
    { id: 'IELTS General', label: 'IELTS General Training', desc: 'Migration, permanent residency & workplace' },
    { id: 'Career & Job Interviews', label: 'Job Interviews & Career', desc: 'Tech, business pitches & multinational teams' },
    { id: 'Study Abroad', label: 'Study Abroad & Campus', desc: 'Lectures, seminars & academic research' },
    { id: 'Daily Conversational Fluency', label: 'Spontaneous Daily Fluency', desc: 'Confident social conversations & travel' },
  ];

  const audienceOptions = [
    { id: 'IELTS Examiners', label: 'IELTS Examiners', icon: Award },
    { id: 'Native English Speakers', label: 'Native English Speakers', icon: Users },
    { id: 'International Colleagues', label: 'Global Colleagues & Clients', icon: Target },
    { id: 'University Professors', label: 'Professors & Academics', icon: BookOpen },
  ];

  const bands = ['6.5', '7.0', '7.5', '8.0', '8.5+'];

  const levels = [
    { id: 'A2 - Elementary', label: 'A2 - Elementary', desc: 'Simple basic phrases, need time to construct sentences' },
    { id: 'B1 - Intermediate', label: 'B1 - Intermediate', desc: 'Can express main points on familiar everyday topics' },
    { id: 'B2 - Upper Intermediate', label: 'B2 - Upper Intermediate', desc: 'Clear communication, occasional hesitation or lexical gaps' },
    { id: 'C1 - Advanced', label: 'C1 - Advanced', desc: 'Fluent, flexible expression, seeking nuanced Band 8+ polish' },
  ];

  const focusOptions = [
    'Fluency & Flow',
    'Band 8+ Vocabulary',
    'Grammar Precision',
    'Pronunciation & Accent',
    'Part 2 Cue Card Mastery',
    'Part 3 Abstract Arguments',
  ];

  const toggleFocus = (item: string) => {
    if (preferredFocus.includes(item)) {
      if (preferredFocus.length > 1) {
        setPreferredFocus(preferredFocus.filter((f) => f !== item));
      }
    } else {
      setPreferredFocus([...preferredFocus, item]);
    }
  };

  const handleAvatarChange = (file: File | undefined) => {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => setAvatarUrl(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsDataURL(file);
  };

  const handleNextStep = () => {
    soundFX.unlock();
    soundFX.playChime('start');
    if (step === 1) {
      if (!nickname.trim()) return;
      setStep(2);
    } else if (step === 2) {
      setStep(3);
    } else {
      const profile: UserProfile = {
        nickname: nickname.trim() || 'Learner',
        avatarUrl: avatarUrl || undefined,
        goal,
        targetAudience,
        targetBand,
        selfAssessedLevel,
        preferredFocus,
        joinedAt: Date.now(),
      };
      soundFX.unlock();
      soundFX.playChime('success');
      onComplete(profile);
    }
  };

  const currentSerenSpeech =
    step === 1
      ? "Hi there! I'm Seren, your personal AI English and IELTS Speaking Coach. What nickname should I call you?"
      : step === 2
      ? `Wonderful to meet you, ${nickname || 'there'}! Tell me about your goals and who you'll be speaking English with.`
      : `Almost ready, ${nickname}! What is your target IELTS Band and current comfort level?`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-[#191a21]/85 backdrop-blur-xl overflow-y-auto">
      <div className="relative w-full max-w-4xl bg-[#282a36] border border-[#44475a] rounded-3xl shadow-2xl overflow-hidden grid grid-cols-1 lg:grid-cols-12 my-auto">
        {/* Left Column: Seren Character Visual */}
        <div className="lg:col-span-5 bg-gradient-to-b from-[#21222c] to-[#282a36] p-4 sm:p-6 flex flex-col justify-between border-b lg:border-b-0 lg:border-r border-[#44475a]">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-[#50fa7b] animate-pulse" />
              <span className="text-xs font-semibold uppercase tracking-wider text-[#bd93f9]">
                Seren Profile Setup
              </span>
            </div>
            <span className="text-xs text-[#6272a4] font-mono">Step {step} of 3</span>
          </div>

          <SerenAvatar
            mood={step === 1 ? 'greeting' : step === 2 ? 'speaking' : 'encouraging'}
            currentSpeech={currentSerenSpeech}
            voiceEnabled={voiceEnabled}
            onToggleVoice={onToggleVoice}
            compact={true}
          />
        </div>

        {/* Right Column: Form Steps */}
        <div className="lg:col-span-7 p-5 sm:p-8 flex flex-col justify-between bg-[#282a36]">
          <AnimatePresence mode="wait">
            {step === 1 && (
              <motion.div
                key="step-1"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="space-y-6"
              >
                <div>
                  <h2 className="text-xl sm:text-2xl font-bold text-[#f8f8f2] flex items-center gap-2">
                    <User className="w-5 h-5 text-[#8be9fd]" />
                    Let's get acquainted!
                  </h2>
                  <p className="text-sm text-[#6272a4] mt-1">
                    Seren will personalize your dialogue, voice feedback, and speaking drills.
                  </p>
                </div>

                <div className="space-y-2">
                  <label htmlFor="user-nickname-input" className="block text-xs font-semibold text-[#f8f8f2] uppercase tracking-wider">
                    What is your preferred nickname or name?
                  </label>
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-12 h-12 rounded-full overflow-hidden border-2 border-[#ff79c6]/50 bg-[#21222c] shrink-0">
                      <img src={avatarUrl || USER_AVATAR_IMAGE} alt="Your profile" className="w-full h-full object-cover" />
                    </div>
                    <label className="cursor-pointer inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-[#44475a] bg-[#21222c] text-xs font-semibold text-[#f8f8f2] hover:border-[#bd93f9] transition-colors">
                      <Upload className="w-3.5 h-3.5 text-[#8be9fd]" />
                      Change image
                      <input type="file" accept="image/*" className="hidden" onChange={(e) => handleAvatarChange(e.target.files?.[0])} />
                    </label>
                    {avatarUrl && (
                      <button type="button" onClick={() => setAvatarUrl('')} className="p-2 text-[#6272a4] hover:text-[#ff5555]" title="Use default image">
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                  <div className="relative">
                    <input
                      id="user-nickname-input"
                      type="text"
                      value={nickname}
                      onChange={(e) => setNickname(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && nickname.trim() && handleNextStep()}
                      placeholder="e.g. Alex, Sophia, Mahi..."
                      autoFocus
                      className="w-full px-4 py-3.5 rounded-xl bg-[#21222c] border border-[#44475a] text-[#f8f8f2] placeholder-[#6272a4] focus:outline-none focus:ring-2 focus:ring-[#bd93f9]/70 focus:border-[#bd93f9] text-base"
                    />
                  </div>
                </div>

                <div className="p-4 rounded-xl bg-[#21222c] border border-[#44475a] text-xs text-[#f8f8f2]/80 leading-relaxed">
                  <p className="font-semibold text-[#8be9fd] mb-1 flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-[#8be9fd]" />
                    How Seren trains your speaking:
                  </p>
                  Seren listens to your pronunciation, checks your IELTS grammatical precision, grades your vocabulary variety, and gives you instant CEFR evaluations with model Band 9 answers.
                </div>
              </motion.div>
            )}

            {step === 2 && (
              <motion.div
                key="step-2"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="space-y-5"
              >
                <div>
                  <h2 className="text-xl sm:text-2xl font-bold text-[#f8f8f2] flex items-center gap-2">
                    <Target className="w-5 h-5 text-[#8be9fd]" />
                    Why are you speaking English?
                  </h2>
                  <p className="text-sm text-[#6272a4] mt-0.5">
                    Choose your primary focus to customize the mock test questions.
                  </p>
                </div>

                <div className="space-y-2">
                  <label className="block text-xs font-semibold text-[#f8f8f2] uppercase tracking-wider">
                    Primary Goal
                  </label>
                  <div className="grid grid-cols-1 gap-2 max-h-40 overflow-y-auto pr-1">
                    {goals.map((g) => (
                      <button
                        key={g.id}
                        id={`goal-option-${g.id.replace(/\s+/g, '-').toLowerCase()}`}
                        type="button"
                        onClick={() => setGoal(g.id)}
                        className={`w-full text-left p-2.5 rounded-xl border transition-all flex items-center justify-between ${
                          goal === g.id
                            ? 'bg-[#44475a] border-[#bd93f9] text-[#f8f8f2] ring-1 ring-[#bd93f9]/50'
                            : 'bg-[#21222c] border-[#44475a] text-[#f8f8f2]/90 hover:border-[#6272a4]'
                        }`}
                      >
                        <div>
                          <div className="text-xs sm:text-sm font-semibold">{g.label}</div>
                          <div className="text-[11px] text-[#6272a4]">{g.desc}</div>
                        </div>
                        {goal === g.id && <CheckCircle2 className="w-4 h-4 text-[#50fa7b] shrink-0" />}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="block text-xs font-semibold text-[#f8f8f2] uppercase tracking-wider">
                    With whom do you primarily speak?
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    {audienceOptions.map((aud) => {
                      const Icon = aud.icon;
                      const selected = targetAudience === aud.id;
                      return (
                        <button
                          key={aud.id}
                          id={`aud-option-${aud.id.replace(/\s+/g, '-').toLowerCase()}`}
                          type="button"
                          onClick={() => setTargetAudience(aud.id)}
                          className={`p-2.5 rounded-xl border text-left transition-all ${
                            selected
                              ? 'bg-[#44475a] border-[#bd93f9] text-[#f8f8f2] ring-1 ring-[#bd93f9]/50'
                              : 'bg-[#21222c] border-[#44475a] text-[#f8f8f2]/90 hover:border-[#6272a4]'
                          }`}
                        >
                          <Icon className={`w-4 h-4 mb-1 ${selected ? 'text-[#8be9fd]' : 'text-[#6272a4]'}`} />
                          <div className="text-xs font-medium truncate">{aud.label}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </motion.div>
            )}

            {step === 3 && (
              <motion.div
                key="step-3"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="space-y-5"
              >
                <div>
                  <h2 className="text-xl sm:text-2xl font-bold text-[#f8f8f2] flex items-center gap-2">
                    <Award className="w-5 h-5 text-[#ffb86c]" />
                    Target Band & Focus
                  </h2>
                  <p className="text-sm text-[#6272a4] mt-0.5">
                    We will measure your baseline in the diagnostic speaking test right after this!
                  </p>
                </div>

                <div className="space-y-2">
                  <label className="block text-xs font-semibold text-[#f8f8f2] uppercase tracking-wider">
                    Target IELTS Speaking Band
                  </label>
                  <div className="grid grid-cols-5 gap-2">
                    {bands.map((b) => (
                      <button
                        key={b}
                        id={`band-btn-${b}`}
                        type="button"
                        onClick={() => setTargetBand(b)}
                        className={`py-2 rounded-xl border text-center font-bold text-sm transition-all ${
                          targetBand === b
                            ? 'bg-[#bd93f9] text-[#282a36] border-[#bd93f9] shadow-lg shadow-[#bd93f9]/30'
                            : 'bg-[#21222c] border-[#44475a] text-[#f8f8f2] hover:border-[#6272a4]'
                        }`}
                      >
                        {b}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="block text-xs font-semibold text-[#f8f8f2] uppercase tracking-wider">
                    Self-Assessed Speaking Comfort
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    {levels.map((lvl) => (
                      <button
                        key={lvl.id}
                        id={`lvl-btn-${lvl.id.split(' ')[0]}`}
                        type="button"
                        onClick={() => setSelfAssessedLevel(lvl.id)}
                        className={`p-2.5 rounded-xl border text-left transition-all ${
                          selfAssessedLevel === lvl.id
                            ? 'bg-[#44475a] border-[#bd93f9] text-[#f8f8f2] ring-1 ring-[#bd93f9]/50'
                            : 'bg-[#21222c] border-[#44475a] text-[#f8f8f2]/90 hover:border-[#6272a4]'
                        }`}
                      >
                        <div className="text-xs font-semibold">{lvl.label}</div>
                        <div className="text-[10px] text-[#6272a4] line-clamp-1">{lvl.desc}</div>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="block text-xs font-semibold text-[#f8f8f2] uppercase tracking-wider">
                    Priority Skill Boosters
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {focusOptions.map((f) => {
                      const active = preferredFocus.includes(f);
                      return (
                        <button
                          key={f}
                          type="button"
                          onClick={() => toggleFocus(f)}
                          className={`text-xs px-2.5 py-1 rounded-lg border transition-all ${
                            active
                              ? 'bg-[#bd93f9]/20 border-[#bd93f9] text-[#bd93f9]'
                              : 'bg-[#21222c] border-[#44475a] text-[#6272a4] hover:text-[#f8f8f2]'
                          }`}
                        >
                          {f}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Stepper Buttons */}
          <div className="pt-6 border-t border-[#44475a] flex items-center justify-between gap-3 mt-4">
            {step > 1 ? (
              <button
                id="onboarding-back-btn"
                type="button"
                onClick={() => setStep((s) => (s - 1) as any)}
                className="px-4 py-2.5 rounded-xl border border-[#44475a] text-[#f8f8f2] hover:bg-[#44475a] text-xs sm:text-sm font-medium transition-colors"
              >
                Back
              </button>
            ) : (
              <div />
            )}

            <button
              id="onboarding-continue-btn"
              type="button"
              onClick={handleNextStep}
              disabled={step === 1 && !nickname.trim()}
              className="px-6 py-2.5 rounded-xl bg-[#bd93f9] hover:bg-[#bd93f9]/90 disabled:opacity-40 disabled:pointer-events-none text-[#282a36] font-bold text-xs sm:text-sm shadow-lg shadow-[#bd93f9]/25 flex items-center gap-2 transition-all"
            >
              <span>{step === 3 ? 'Start Diagnostic Test' : 'Continue'}</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
