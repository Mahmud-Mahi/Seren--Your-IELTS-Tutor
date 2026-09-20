/**
 * One-time legacy data migration (Lumi → Seren rename).
 *
 * The app previously stored everything under `lumi_*` localStorage keys.
 * After the rename the same keys are read/written as `seren_*`. This module
 * copies any legacy `lumi_*` value into its `seren_*` counterpart — ONLY when
 * the new key is empty — so existing users keep their profile, chat history,
 * lesson history, shortcuts, evaluation reports, etc.
 *
 * The legacy keys are intentionally LEFT IN PLACE (never removed), so no data
 * is ever destroyed by this migration.
 */
export function migrateLegacyLumiData(): void {
  try {
    const legacy: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('lumi_')) legacy.push(key);
    }
    for (const oldKey of legacy) {
      const newKey = `seren_${oldKey.slice('lumi_'.length)}`;
      if (localStorage.getItem(newKey) === null) {
        const value = localStorage.getItem(oldKey);
        if (value !== null) localStorage.setItem(newKey, value);
      }
    }
  } catch {
    // Storage unavailable (private mode, etc.) — app falls back to defaults.
  }
}
