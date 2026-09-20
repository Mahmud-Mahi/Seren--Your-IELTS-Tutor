const AUTO_MIC_KEY = 'seren_auto_mic';

/**
 * Interview microphone preference (1v1 Chat):
 *  - true  → automatic: the mic opens by itself after Seren reads each question
 *  - false → manual: the user presses the mic button to start speaking
 * Persisted in localStorage so it survives reloads (default: automatic).
 */
export function getAutoMicEnabled(): boolean {
  try {
    const v = localStorage.getItem(AUTO_MIC_KEY);
    return v === null ? true : v === 'true';
  } catch {
    return true;
  }
}

export function setAutoMicEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(AUTO_MIC_KEY, String(enabled));
  } catch {}
}
