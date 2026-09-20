import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Volume2, VolumeX, Sparkles, MessageSquare, Mic, Play, RefreshCw } from 'lucide-react';
import { SerenMood } from '../types';
import { SEREN_IMAGES, SEREN_STATUS_TEXT } from '../assets/characterAssets';
import { MOOD_STYLES } from '../utils/serenMood';
import { serenVoice } from '../utils/speech';
import { SoundWave } from './SoundWave';

export interface SerenAvatarProps {
  mood: SerenMood;
  currentSpeech?: string;
  spokenAudioText?: string;
  isUserSpeaking?: boolean;
  voiceEnabled?: boolean;
  onToggleVoice?: () => void;
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  className?: string;
  compact?: boolean;
  hideSubtitle?: boolean;
  autoSpeak?: boolean;
  /**
   * True when Seren is actually speaking right now. Screens that drive speech
   * themselves (e.g. the chat uses the parent's serenVoice) pass this so the
   * avatar can still show the speaking image while she talks.
   */
  speaking?: boolean;
  /**
   * Image shown while Seren is idle (not speaking / not listening). The chat
   * passes 'greeting'; other screens use 'encouraging' by default. Prevents a
   * lingering 'speaking' base mood from showing the speaking image when Seren
   * isn't saying anything.
   */
  idleMood?: SerenMood;
}

export const SerenAvatar: React.FC<SerenAvatarProps> = ({
  mood,
  currentSpeech,
  spokenAudioText,
  isUserSpeaking = false,
  voiceEnabled = true,
  onToggleVoice,
  onSpeechStart,
  onSpeechEnd,
  className = '',
  compact = false,
  hideSubtitle = false,
  // When false, the avatar only renders the subtitle text and never fires
  // serenVoice.speak() itself — the parent owns audio (avoids double-speak
  // generation invalidation between parent-driven speech and this effect).
  autoSpeak = true,
  speaking = false,
  idleMood = 'encouraging',
}) => {
  const [isSerenSpeaking, setIsSerenSpeaking] = useState(false);
  const [displayedText, setDisplayedText] = useState('');
  const lastSpokenRef = React.useRef<string>('');
  // Whether the last requested speech ever actually began playing. A request
  // can be invalidated before it starts (parent's serenVoice.stop() between
  // request and playback — notably React StrictMode's double effect invoke in
  // dev), which silently discards the utterance.
  const lastSpeakStartedRef = React.useRef<boolean>(true);

  // If the effect pass ends with a speech still pending (requested but never
  // started because something invalidated it), forget the dedup key so the
  // next pass re-requests it — otherwise the greeting is swallowed forever.
  useEffect(() => {
    return () => {
      if (!lastSpeakStartedRef.current) {
        lastSpokenRef.current = '';
      }
    };
  }, []);

  // Handle TTS and subtitle typewriter
  useEffect(() => {
    if (hideSubtitle) {
      // Hide the subtitle balloon. When the parent owns audio (autoSpeak=false)
      // there is nothing else to do here; otherwise still speak the text aloud.
      setDisplayedText('');
      setIsSerenSpeaking(false);
      if (autoSpeak) {
        const targetAudio = (spokenAudioText || currentSpeech || '').trim();
        if (voiceEnabled && targetAudio && !isUserSpeaking) {
          if (lastSpokenRef.current !== targetAudio) {
            lastSpokenRef.current = targetAudio;
            lastSpeakStartedRef.current = false;
            serenVoice.speak(targetAudio, {
              onStart: () => {
                lastSpeakStartedRef.current = true;
                setIsSerenSpeaking(true);
                onSpeechStart?.();
              },
              onEnd: () => {
                setIsSerenSpeaking(false);
                onSpeechEnd?.();
              },
            });
          }
        } else if (isUserSpeaking) {
          serenVoice.stop();
        }
      }
      return;
    }

    if (!currentSpeech) {
      setDisplayedText('');
      return;
    }

    const targetAudio = (spokenAudioText !== undefined ? spokenAudioText : currentSpeech).trim();

    if (!autoSpeak) {
      // Parent-driven audio: only mirror the subtitle text, never speak here.
      setDisplayedText(currentSpeech);
      setIsSerenSpeaking(false);
      return;
    }

    if (voiceEnabled && targetAudio && !isUserSpeaking) {
      // Only speak if this is a newly requested distinct speech text
      if (lastSpokenRef.current !== targetAudio) {
        lastSpokenRef.current = targetAudio;
        lastSpeakStartedRef.current = false;
        setDisplayedText(currentSpeech);
        serenVoice.speak(targetAudio, {
          onStart: () => {
            lastSpeakStartedRef.current = true;
            setIsSerenSpeaking(true);
            onSpeechStart?.();
          },
          onEnd: () => {
            setIsSerenSpeaking(false);
            onSpeechEnd?.();
          },
        });
      }
    } else {
      setDisplayedText(currentSpeech);
      setIsSerenSpeaking(false);
      if (isUserSpeaking) {
        serenVoice.stop();
      }
    }
  }, [currentSpeech, spokenAudioText, voiceEnabled, isUserSpeaking, onSpeechStart, onSpeechEnd, hideSubtitle, autoSpeak]);

  const handleReplaySpeech = () => {
    const targetAudio = (spokenAudioText !== undefined ? spokenAudioText : currentSpeech || '').trim();
    if (!targetAudio) return;
    lastSpokenRef.current = targetAudio;
    serenVoice.speak(targetAudio, {
      onStart: () => {
        setIsSerenSpeaking(true);
        onSpeechStart?.();
      },
      onEnd: () => {
        setIsSerenSpeaking(false);
        onSpeechEnd?.();
      },
    });
  };

  // Resolve the single authoritative mood used for BOTH the image and badge:
  // - user is talking  -> listening image
  // - Seren is talking  -> speaking image (regardless of the parent's mood)
  // - otherwise -> show the contextual "idle" image instead of carrying over a
  //   leftover 'speaking' base mood. The chat passes idleMood='greeting'; other
  //   screens default to 'encouraging'. Genuine moods (listening, evaluating,
  //   celebrating, etc.) still pass through untouched.
  const serenTalking = isSerenSpeaking || speaking;
  const displayMood: SerenMood = isUserSpeaking
    ? 'listening'
    : serenTalking
    ? 'speaking'
    : mood === 'speaking'
    ? idleMood
    : mood;

  const imageSrc = SEREN_IMAGES[displayMood] || SEREN_IMAGES.greeting;

  const statusLabel = serenTalking
    ? 'Seren is speaking...'
    : isUserSpeaking
    ? 'Seren is listening to you...'
    : mood === 'speaking'
    ? 'Seren is ready'
    : SEREN_STATUS_TEXT[displayMood] || 'AI IELTS Coach';

  const currentColors = MOOD_STYLES[displayMood] || MOOD_STYLES.greeting;

  return (
    <div
      id="seren-avatar-container"
      className={`relative flex flex-col items-center justify-center select-none w-full max-w-[320px] sm:max-w-[340px] mx-auto ${className}`}
    >
      {/* Background cybernetic aura */}
      <div
        className={`absolute inset-0 bg-gradient-to-b ${currentColors.glow} to-transparent rounded-3xl blur-2xl pointer-events-none transition-all duration-700`}
      />

      {/* Main Character Display Card */}
      <div
        className={`relative w-full overflow-hidden rounded-2xl sm:rounded-3xl border border-[#44475a] bg-[#282a36] shadow-2xl backdrop-blur-xl transition-all duration-500 ${
          isSerenSpeaking ? 'ring-2 ring-[#8be9fd]/60 shadow-[#8be9fd]/20' : isUserSpeaking ? 'ring-2 ring-[#50fa7b]/60 shadow-[#50fa7b]/20' : ''
        }`}
      >
        {/* Holographic Top Status Bar */}
        <div className="absolute top-0 inset-x-0 z-20 flex items-center justify-between px-3 py-1.5 sm:px-3.5 sm:py-2 bg-gradient-to-b from-[#21222c]/80 via-[#21222c]/40 to-transparent pointer-events-auto">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span
                className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                  isSerenSpeaking ? 'bg-[#8be9fd]' : isUserSpeaking ? 'bg-[#50fa7b]' : 'bg-[#bd93f9]'
                }`}
              />
              <span
                className={`relative inline-flex rounded-full h-2 w-2 ${
                  isSerenSpeaking ? 'bg-[#8be9fd]' : isUserSpeaking ? 'bg-[#50fa7b]' : 'bg-[#bd93f9]'
                }`}
              />
            </span>
            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[#21222c]/80 border border-[#44475a] backdrop-blur-sm">
              <span className="text-xs font-semibold tracking-wider text-[#f8f8f2]">SEREN</span>
              <span className="text-[9px] uppercase font-mono text-[#8be9fd]">
                IELTS
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {onToggleVoice && (
              <button
                id="toggle-voice-btn"
                type="button"
                onClick={onToggleVoice}
                className={`p-1.5 rounded-full border transition-all backdrop-blur-sm ${
                  voiceEnabled
                    ? 'bg-[#44475a]/80 border-[#bd93f9]/40 text-[#bd93f9] hover:bg-[#44475a]'
                    : 'bg-[#21222c]/80 border-[#44475a] text-[#6272a4] hover:text-[#f8f8f2]'
                }`}
                title={voiceEnabled ? 'Mute Seren Voice' : 'Unmute Seren Voice'}
              >
                {voiceEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
              </button>
            )}
            <span
              className={`text-[10px] font-medium px-2 py-0.5 rounded-full border backdrop-blur-sm transition-colors duration-300 ${currentColors.badge}`}
            >
              {displayMood.toUpperCase()}
            </span>
          </div>
        </div>

        {/* Character Image & Motion Viewport — preserved 3:4 portrait aspect
            ratio (non-square), scaled down 25%. Height must NEVER be clamped
            below the 3:4 ratio (e.g. a hard max-h-[285px]): object-cover would
            then upscale the image to fill the extra width, cropping the bottom
            of the portrait away and making Seren look zoomed/cropped/soft
            compared to the non-compact tabs. compact only affects the minimum
            floor and the sound-wave bar count below — both cap heights
            identically so the framing matches the Cambridge/Lessons/Chat tabs. */}
        <div
          className={`relative w-full aspect-[4/5] sm:aspect-[3/4] ${
            compact
              ? 'min-h-[225px] sm:min-h-[285px] max-h-[435px]'
              : 'min-h-[300px] sm:min-h-[345px] max-h-[435px]'
          } overflow-hidden bg-[#21222c] flex items-center justify-center`}
        >
          {(Object.keys(SEREN_IMAGES) as SerenMood[]).map((frameMood) => (
            <img
              key={frameMood}
              src={SEREN_IMAGES[frameMood]}
              alt="Seren AI Tutor"
              className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-700 ease-in-out ${
                displayMood === frameMood ? 'opacity-100' : 'opacity-0'
              } ${displayMood === 'listening' || displayMood === 'evaluating' ? 'object-center' : 'object-top'}`}
              referrerPolicy="no-referrer"
            />
          ))}

          {/* Slim Dark Translucent Status Ribbon with Minimal Blur at Bottom of Image */}
          <div className="absolute bottom-2 inset-x-2 z-20 flex items-center justify-between gap-2 px-2.5 py-1 sm:px-3 sm:py-1.5 rounded-xl bg-[#21222c]/85 border border-[#44475a] backdrop-blur-[2px] text-[#f8f8f2] shadow-md">
            <div className="flex items-center gap-2">
              {isUserSpeaking ? (
                <Mic className="w-3.5 h-3.5 text-[#50fa7b] animate-pulse" />
              ) : (
                <Sparkles className="w-3.5 h-3.5 text-[#8be9fd]" />
              )}
              <span className="text-[10px] sm:text-[11px] font-medium text-[#f8f8f2] drop-shadow-sm truncate max-w-[140px] sm:max-w-[180px]">
                {statusLabel}
              </span>
            </div>
            <SoundWave
              active={isSerenSpeaking || isUserSpeaking}
              color={isUserSpeaking ? 'bg-[#50fa7b]' : 'bg-[#8be9fd]'}
              barCount={compact ? 6 : 8}
            />
          </div>
        </div>
      </div>

      {/* Subtitle Dialogue Balloon Shifted Cleanly Outside & Below the Image */}
      {displayedText && !hideSubtitle && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="mt-2.5 w-full relative rounded-xl p-3 sm:p-3.5 bg-[#21222c]/95 border border-[#44475a] shadow-xl backdrop-blur-xl text-[#f8f8f2] text-xs leading-relaxed"
        >
          {/* Subtle Speech Bubble Indicator Triangle */}
          <div className="absolute -top-2 left-8 w-4 h-4 bg-[#21222c] border-l border-t border-[#44475a] transform rotate-45" />

          <div className="relative z-10 flex items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-[10px] font-bold font-mono uppercase tracking-wider text-[#bd93f9]">
                <Sparkles className="w-3 h-3 text-[#bd93f9]" />
                <span>Seren</span>
              </div>
              <p className="font-normal text-[#f8f8f2] text-xs sm:text-sm leading-relaxed">
                {displayedText}
              </p>
            </div>

            {voiceEnabled && (
              <button
                id="replay-speech-btn"
                type="button"
                onClick={handleReplaySpeech}
                className="p-1.5 rounded-xl bg-[#44475a]/70 hover:bg-[#44475a] border border-[#6272a4]/40 text-[#8be9fd] hover:text-[#f8f8f2] shrink-0 transition-colors"
                title="Replay Voice"
              >
                <Play className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </motion.div>
      )}
    </div>
  );
};
