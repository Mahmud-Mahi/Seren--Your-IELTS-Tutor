import React, { useEffect, useRef, useState } from 'react';
import { activeAudioRecorder } from '../utils/speech';

interface MicEqualizerProps {
  /** True while the microphone is recording. */
  active: boolean;
  /** Number of bars in the strip. */
  barCount?: number;
  /** Tailwind background class for the bars. */
  color?: string;
  className?: string;
}

/**
 * ChatGPT/Gemini-style live mic equalizer: a row of thin bars whose heights
 * follow the microphone's REAL loudness (fed by the AudioRecorderController's
 * Web Audio analyser via addLevelListener). Each bar blends the mic level with
 * its own smoothed pseudo-random jitter so the strip reads as speech rhythm
 * (peaks and troughs) rather than a single pulsing block. Bars decay smoothly
 * back to a resting sliver when the mic is quiet or recording stops.
 */
export const MicEqualizer: React.FC<MicEqualizerProps> = ({
  active,
  barCount = 36,
  color = 'bg-[#bd93f9]',
  className = '',
}) => {
  const REST = 0.1;
  const [levels, setLevels] = useState<number[]>(() => new Array(barCount).fill(REST));
  const targetRef = useRef<number[]>(new Array(barCount).fill(REST));
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      // Decay the bars to rest height, then stop animating.
      let ticks = 0;
      const decay = () => {
        ticks += 1;
        setLevels((prev) => prev.map((h) => Math.max(REST, h * 0.65)));
        if (ticks < 14) {
          rafRef.current = requestAnimationFrame(decay);
        }
      };
      rafRef.current = requestAnimationFrame(decay);
      return () => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
      };
    }

    // Feed real mic loudness into the per-bar targets. The recorder notifies
    // listeners every animation frame while a session is armed; before the
    // getUserMedia stream is up, targets simply stay at rest height.
    const unsubscribe = activeAudioRecorder.addLevelListener((level) => {
      const t = Date.now() / 90;
      for (let i = 0; i < barCount; i++) {
        // Slow per-bar phase + fast shimmer gives an organic speech look.
        const wave = Math.abs(Math.sin(i * 1.35 + t * 0.9) * 0.6 + Math.sin(i * 3.1 - t * 1.7) * 0.4);
        const boosted = Math.min(1, level * (0.45 + 0.95 * wave) * 1.8);
        targetRef.current[i] = Math.max(REST, boosted);
      }
    });

    const tick = () => {
      setLevels((prev) =>
        prev.map((h, i) => {
          const target = targetRef.current[i] ?? REST;
          // Ease toward the target fast on the way up, slower on the way down
          const ease = target > h ? 0.55 : 0.25;
          return h + (target - h) * ease;
        })
      );
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      unsubscribe();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [active, barCount]);

  return (
    <div className={`flex items-center justify-center gap-[3px] w-full px-1 ${className}`} aria-hidden>
      {levels.map((h, i) => (
        <div
          key={i}
          className={`flex-1 max-w-[5px] min-w-[2px] rounded-full ${color}`}
          style={{ height: `${Math.max(3, h * 32)}px` }}
        />
      ))}
    </div>
  );
};
