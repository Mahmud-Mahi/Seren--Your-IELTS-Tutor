import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// sherpa-onnx Whisper STT (local, offline, no API key)
// ---------------------------------------------------------------------------
const _cjsRequire = (() => {
  try { return createRequire(import.meta.url); } catch {}
  // esbuild CJS bundle: __dirname is the dist/ folder
  try { return createRequire(path.join(__dirname || '.', 'noop.cjs')); } catch {}
  return null;
})();

if (!_cjsRequire) {
  console.warn('[stt] Cannot load sherpa-onnx: no CJS require available');
}

export let whisperSTT: { transcribe(base64: string, mime: string): Promise<string> } | null = null;
try {
  let srcDir = '';
  try {
    if (import.meta?.url) srcDir = path.dirname(fileURLToPath(import.meta.url));
  } catch {}
  const searchDirs = [
    srcDir,
    typeof __dirname !== 'undefined' ? path.resolve(__dirname || '.') : '',
    typeof __dirname !== 'undefined' ? path.resolve(__dirname || '.', '..') : '',
    process.cwd(),
  ];
  const sttModulePath = searchDirs
    .filter(Boolean)
    .map((dir) => path.join(dir!, 'stt-whisper.cjs'))
    .find((p) => fs.existsSync(p));

  if (!sttModulePath || !_cjsRequire) throw new Error('stt-whisper.cjs not found');
  whisperSTT = _cjsRequire(sttModulePath);
  console.log(`[stt] Whisper (sherpa-onnx) loaded — local offline STT enabled`);
  // Hot-start the recognizer shortly after boot so the first user utterance
  // is never decoded through a cold ONNX session. Non-blocking (unref'd).
  const sttWarmUp = (whisperSTT as any).warmUp;
  if (typeof sttWarmUp === 'function') {
    setTimeout(() => {
      try { sttWarmUp.call(whisperSTT); } catch {}
    }, 1000).unref?.();
  }
} catch (e: any) {
  console.warn('[stt] sherpa-onnx Whisper not available:', e?.message || e);
}
