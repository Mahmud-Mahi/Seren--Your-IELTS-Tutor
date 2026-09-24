import React, { useState } from 'react';
import { Award, Check, ImagePlus, Target, User, X } from 'lucide-react';
import { UserProfile } from '../types';
import { USER_AVATAR_IMAGE } from '../assets/characterAssets';

interface UserPrefProps {
  profile: UserProfile;
  onSave: (profile: UserProfile) => void;
  onClose: () => void;
}

const bands = ['6.5', '7.0', '7.5', '8.0', '8.5+'];
const audienceOptions = [
  'IELTS Examiners',
  'Native English Speakers',
  'International Colleagues',
  'University Professors',
];
const focusOptions = [
  'Fluency & Flow',
  'Band 8+ Vocabulary',
  'Grammar Precision',
  'Pronunciation & Accent',
  'Part 2 Cue Card Mastery',
  'Part 3 Abstract Arguments',
];

export const UserPref: React.FC<UserPrefProps> = ({ profile, onSave, onClose }) => {
  const [nickname, setNickname] = useState(profile.nickname);
  const [avatarUrl, setAvatarUrl] = useState(profile.avatarUrl || '');
  const [targetAudience, setTargetAudience] = useState(profile.targetAudience);
  const [targetBand, setTargetBand] = useState(profile.targetBand);
  const [preferredFocus, setPreferredFocus] = useState(profile.preferredFocus);

  const toggleFocus = (focus: string) => {
    setPreferredFocus((current) => {
      if (current.includes(focus)) {
        return current.length > 1 ? current.filter((item) => item !== focus) : current;
      }
      return [...current, focus];
    });
  };

  const handleImageChange = (file: File | undefined) => {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') setAvatarUrl(reader.result);
    };
    reader.readAsDataURL(file);
  };

  const handleSave = () => {
    const trimmedNickname = nickname.trim();
    if (!trimmedNickname) return;
    onSave({
      ...profile,
      nickname: trimmedNickname,
      avatarUrl: avatarUrl || undefined,
      targetAudience,
      targetBand,
      preferredFocus,
    });
  };

  return (
    <div className="fixed z-50 top-16 right-4 sm:right-6 w-[min(92vw,360px)]">
      <div className="rounded-2xl border border-[#44475a] bg-[#282a36] shadow-[0_22px_60px_rgba(0,0,0,0.45)] overflow-hidden">
        <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-[#44475a] bg-[#21222c]/70">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-full overflow-hidden border border-[#ff79c6]/60 bg-[#21222c] shrink-0">
              <img src={avatarUrl || USER_AVATAR_IMAGE} alt={nickname || 'Your profile'} className="w-full h-full object-cover" />
            </div>
            <div className="min-w-0">
              <h2 className="flex items-center gap-1.5 text-[13px] font-bold text-[#f8f8f2] truncate">
                <User className="w-3.5 h-3.5 text-[#8be9fd]" />
                Preferences
              </h2>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-[#6272a4] hover:text-[#f8f8f2] hover:bg-[#44475a] transition-colors"
            title="Close preferences"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="p-3.5 space-y-3.5">
          <div className="flex items-center gap-2.5">
            <div className="w-11 h-11 rounded-full overflow-hidden border-2 border-[#ff79c6]/60 bg-[#21222c] shrink-0">
              <img src={avatarUrl || USER_AVATAR_IMAGE} alt={nickname || 'Your profile'} className="w-full h-full object-cover" />
            </div>
            <label className="cursor-pointer inline-flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-lg border border-[#44475a] bg-[#21222c] text-[11px] font-semibold text-[#f8f8f2] hover:border-[#bd93f9] transition-colors flex-1">
              <ImagePlus className="w-3.5 h-3.5 text-[#8be9fd]" />
              Change image
              <input type="file" accept="image/*" className="hidden" onChange={(event) => handleImageChange(event.target.files?.[0])} />
            </label>
          </div>

          <label className="block space-y-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[#f8f8f2]">Nickname</span>
            <input
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              className="w-full px-2.5 py-2 rounded-lg bg-[#21222c] border border-[#44475a] text-xs text-[#f8f8f2] focus:outline-none focus:ring-2 focus:ring-[#bd93f9]/70 focus:border-[#bd93f9]"
            />
          </label>

          <div className="space-y-1.5">
            <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-[#f8f8f2]">
              <Target className="w-3 h-3 text-[#8be9fd]" /> Who do you speak with?
            </span>
            <div className="grid grid-cols-2 gap-1">
              {audienceOptions.map((audience) => (
                <button
                  key={audience}
                  type="button"
                  onClick={() => setTargetAudience(audience)}
                  className={`rounded-md border px-1.5 py-1.5 text-[10px] font-medium transition-colors ${targetAudience === audience ? 'bg-[#44475a] border-[#bd93f9] text-[#f8f8f2]' : 'bg-[#21222c] border-[#44475a] text-[#6272a4] hover:text-[#f8f8f2]'}`}
                >
                  {audience}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-[#f8f8f2]">
              <Award className="w-3 h-3 text-[#ffb86c]" /> Target band
            </span>
            <div className="grid grid-cols-5 gap-1">
              {bands.map((band) => (
                <button
                  key={band}
                  type="button"
                  onClick={() => setTargetBand(band)}
                  className={`py-1.5 rounded-md border text-[10px] font-bold transition-colors ${targetBand === band ? 'bg-[#bd93f9] border-[#bd93f9] text-[#282a36]' : 'bg-[#21222c] border-[#44475a] text-[#f8f8f2] hover:border-[#6272a4]'}`}
                >
                  {band}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-[#f8f8f2]">
              <Target className="w-3 h-3 text-[#8be9fd]" /> Coaching focus
            </span>
            <div className="flex flex-wrap gap-1">
              {focusOptions.map((focus) => {
                const selected = preferredFocus.includes(focus);
                return (
                  <button
                    key={focus}
                    type="button"
                    onClick={() => toggleFocus(focus)}
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border text-[10px] transition-colors ${selected ? 'bg-[#bd93f9]/20 border-[#bd93f9] text-[#bd93f9]' : 'bg-[#21222c] border-[#44475a] text-[#6272a4] hover:text-[#f8f8f2]'}`}
                  >
                    {selected && <Check className="w-2.5 h-2.5" />}
                    {focus}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 px-3.5 py-2.5 border-t border-[#44475a] bg-[#21222c]/60">
          <button type="button" onClick={onClose} className="px-2.5 py-1.5 rounded-md text-[11px] font-semibold text-[#6272a4] hover:text-[#f8f8f2] transition-colors">
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!nickname.trim()}
            className="px-3 py-1.5 rounded-md bg-[#bd93f9] text-[#282a36] text-[11px] font-bold hover:bg-[#bd93f9]/90 disabled:opacity-40 disabled:pointer-events-none transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
};
