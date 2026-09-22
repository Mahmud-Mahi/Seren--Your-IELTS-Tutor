import React, { useEffect, useState, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  X,
  Server,
  Cloud,
  Cpu,
  KeyRound,
  Volume2,
  Play,
  Check,
  Loader2,
  RefreshCw,
  AlertTriangle,
  RadioTower,
  Globe,
  Mic,
  Brain,
  Zap,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Download,
  Upload,
  FolderOpen,
} from 'lucide-react';
import { serenVoice, TTSEngineMode } from '../utils/speech';
import { getAutoMicEnabled, setAutoMicEnabled } from '../utils/preferences';
import {
  BASE_FONT_PX,
  DEFAULT_TEXT_SCALE,
  getTextScale,
  MAX_TEXT_SCALE,
  MIN_TEXT_SCALE,
  setTextScale,
  stepTextScale,
  TEXT_SCALE_STEP,
} from '../utils/textScale';
import { ShortcutSettings } from './ShortcutSettings';

interface ProviderStatus {
  key: string;
  label: string;
  baseUrl: string;
  configuredModel: string;
  resolvedModel: string | null;
  reachable: boolean;
  latencyMs: number | null;
  needsKey: boolean;
  ready: boolean;
  customEndpoint?: boolean;
  hasCustomKey?: boolean;
}

interface TtsVoice {
  id: string;
  name: string;
  locale: string;
  gender: string;
  personality: string;
}

interface ProviderModelsInfo {
  key: string;
  label: string;
  reachable: boolean;
  models: string[];
}

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

const providerIcons: Record<string, React.ReactNode> = {
  local: <Cpu className="w-4 h-4" />,
  ollama: <Server className="w-4 h-4" />,
  groq: <Cloud className="w-4 h-4" />,
};

interface SttEngineInfo {
  key: string;
  label: string;
  description: string;
  needsKey: boolean;
  hasKey: boolean;
  reachable: boolean;
  model: string;
  models: string[];
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ open, onClose }) => {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [pinnedProvider, setPinnedProvider] = useState<string>('auto');
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [sttEngineSel, setSttEngineSel] = useState<string>('local');
  const [sttEngines, setSttEngines] = useState<SttEngineInfo[]>([]);
  const [selectedSttModels, setSelectedSttModels] = useState<Record<string, string>>({});
  const [savingSttEngine, setSavingSttEngine] = useState(false);
  const [savingSttModelFor, setSavingSttModelFor] = useState<string | null>(null);
  const [sttKeyInputs, setSttKeyInputs] = useState<Record<string, string>>({ groq: '', assemblyai: '', deepgram: '' });
  const [savingSttKeyFor, setSavingSttKeyFor] = useState<string | null>(null);
  const [sttMsg, setSttMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [editingSttEndpointFor, setEditingSttEndpointFor] = useState<string | null>(null);
  const [sttEpBaseUrl, setSttEpBaseUrl] = useState('');
  const [sttEpApiKey, setSttEpApiKey] = useState('');
  const [savingSttEndpointFor, setSavingSttEndpointFor] = useState<string | null>(null);
  const [sttEndpointMsg, setSttEndpointMsg] = useState<{ key: string; ok: boolean; text: string } | null>(null);

  const [modelLists, setModelLists] = useState<Record<string, string[]>>({});
  const [selectedModels, setSelectedModels] = useState<Record<string, string>>(() => {
    // Read from localStorage if available, otherwise empty object
    try {
      const stored = localStorage.getItem('seren_model_selections');
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  });
  const [savingModelFor, setSavingModelFor] = useState<string | null>(null);

  const [editingEndpointFor, setEditingEndpointFor] = useState<string | null>(null);
  const [epBaseUrl, setEpBaseUrl] = useState('');
  const [epApiKey, setEpApiKey] = useState('');
  const [savingEndpointFor, setSavingEndpointFor] = useState<string | null>(null);
  const [endpointMsg, setEndpointMsg] = useState<{ key: string; ok: boolean; text: string } | null>(null);

  const [confirmingWipe, setConfirmingWipe] = useState(false);
  const [wiping, setWiping] = useState(false);

  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<string>(serenVoice.getVoice() || 'en-US-JennyNeural');
  const [ttsEngine, setTtsEngine] = useState<TTSEngineMode>(serenVoice.getTtsEngine());
  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null);
  const [serverTtsOnline, setServerTtsOnline] = useState<boolean | null>(null);

  // Interview microphone preference (automatic vs manual mic)
  const [autoMic, setAutoMic] = useState<boolean>(() => getAutoMicEnabled());

  const handleAutoMicChange = (enabled: boolean) => {
    setAutoMicEnabled(enabled);
    setAutoMic(enabled);
  };

  // ---- Text & UI size (whole-UI zoom, persisted per device) ----------------
  const [textScale, setTextScaleState] = useState<number>(() => getTextScale());
  const nudgeTextScale = (delta: number) => setTextScaleState(stepTextScale(delta));
  const resetTextScale = () => setTextScaleState(setTextScale(DEFAULT_TEXT_SCALE));

  // ---- Your data (export / import a JSON backup of everything) -------------
  const [backupMsg, setBackupMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const importFileRef = useRef<HTMLInputElement>(null);

  /** Download every seren_* localStorage key as a JSON backup file. */
  const exportUserData = () => {
    try {
      const dump: Record<string, string> = {};
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith('seren_')) continue;
        const value = localStorage.getItem(key);
        if (value !== null) dump[key] = value;
      }
      const payload = JSON.stringify(
        { app: 'seren', kind: 'backup', exportedAt: new Date().toISOString(), data: dump },
        null,
        2
      );
      const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `seren-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setBackupMsg({ ok: true, text: `Backup created with ${Object.keys(dump).length} key(s).` });
    } catch (e) {
      setBackupMsg({ ok: false, text: e instanceof Error ? e.message : 'Export failed' });
    }
  };

  /** Restore a backup: overwrite matching keys, then reload so the app re-reads everything. */
  const handleImportFile = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text());
      const dump = parsed && typeof parsed === 'object' && parsed.data ? parsed.data : parsed;
      if (!dump || typeof dump !== 'object' || Array.isArray(dump)) {
        throw new Error('Not a Seren backup file');
      }
      let count = 0;
      for (const [key, value] of Object.entries(dump)) {
        if (key.startsWith('seren_') && typeof value === 'string') {
          localStorage.setItem(key, value);
          count += 1;
        }
      }
      if (count === 0) throw new Error('No Seren keys found in that file');
      window.location.reload();
    } catch (e) {
      setBackupMsg({ ok: false, text: e instanceof Error ? e.message : 'Import failed' });
    }
  };



  const loadStatus = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const res = await fetch('/api/providers/status');
      const data = await res.json();
      if (data.success) {
        setProviders(data.providers || []);
        setPinnedProvider(data.pinnedProvider || 'auto');
        const sel: Record<string, string> = {};
        for (const p of data.providers || []) {
          sel[p.key] = p.configuredModel || 'auto';
        }
        setSelectedModels((prev) => ({ ...sel, ...prev }));
        if (data.stt) {
          if (typeof data.stt.engine === 'string') setSttEngineSel(data.stt.engine);
          if (Array.isArray(data.stt.engines)) {
            setSttEngines(data.stt.engines);
            const sttSel: Record<string, string> = {};
            for (const e of data.stt.engines) sttSel[e.key] = e.model || '';
            setSelectedSttModels((prev) => ({ ...sttSel, ...prev }));
          }
        }
      }
    } catch (e) {
      setProviders([]);
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  const loadModelLists = useCallback(async () => {
    try {
      const res = await fetch('/api/providers/models');
      const data = await res.json();
      if (data.success) {
        const map: Record<string, string[]> = {};
        for (const p of data.providers || []) map[p.key] = p.models || [];
        setModelLists((prev) => ({ ...prev, ...map }));
      }
    } catch (e) {}
  }, []);

  useEffect(() => {
    if (!open) return;
    void loadStatus();
    void loadModelLists();
    void (async () => {
      try {
        const res = await fetch('/api/tts/voices');
        const data = await res.json();
        if (data.success) setVoices(data.voices || []);
      } catch (e) {}
    })();
    setServerTtsOnline(null);
    void serenVoice.checkServerTts().then(setServerTtsOnline);
  }, [open, loadStatus, loadModelLists]);

  // Persist model selections to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('seren_model_selections', JSON.stringify(selectedModels));
    } catch {
    }
  }, [selectedModels]);

  const handleSelectModel = async (providerKey: string, modelId: string) => {
    setSavingModelFor(providerKey);
    try {
      await fetch('/api/providers/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ models: { [providerKey]: modelId } }),
      });
      setSelectedModels((prev) => ({ ...prev, [providerKey]: modelId }));
      void loadStatus();
    } catch (e) {
    } finally {
      setSavingModelFor(null);
    }
  };

  const handleFactoryReset = async () => {
    setWiping(true);
    try {
      await fetch('/api/system/reset', { method: 'POST' });
    } catch (e) {}
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith('seren_'))
        .forEach((k) => localStorage.removeItem(k));
      sessionStorage.clear();
    } catch (e) {}
    // Full reload → app boots from the very beginning (fresh onboarding)
    window.location.href = '/';
  };

  const openEndpointEditor = (p: ProviderStatus) => {
    setEditingEndpointFor(p.key);
    setEpBaseUrl(p.baseUrl);
    setEpApiKey('');
    setEndpointMsg(null);
  };

  const handleSaveEndpoint = async (providerKey: string) => {
    setSavingEndpointFor(providerKey);
    setEndpointMsg(null);
    try {
      const res = await fetch('/api/providers/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: { provider: providerKey, baseUrl: epBaseUrl.trim(), apiKey: epApiKey.trim() },
        }),
      });
      const data = await res.json();
      if (data.success) {
        setEndpointMsg({ key: providerKey, ok: true, text: 'Endpoint saved — models list refreshed.' });
        setEditingEndpointFor(null);
        void loadStatus();
        void loadModelLists();
      } else {
        setEndpointMsg({ key: providerKey, ok: false, text: data.error || 'Save failed' });
      }
    } catch (e: any) {
      setEndpointMsg({ key: providerKey, ok: false, text: e?.message || 'Network error' });
    } finally {
      setSavingEndpointFor(null);
    }
  };

  const handlePinProvider = async (value: string) => {
    setPinnedProvider(value);
    try {
      await fetch('/api/providers/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinnedProvider: value }),
      });
    } catch (e) {}
  };

  const handleSelectSttEngine = async (value: string) => {
    setSttEngineSel(value);
    setSttMsg(null);
    setSavingSttEngine(true);
    try {
      const res = await fetch('/api/providers/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sttEngine: value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!data.success) setSttMsg({ ok: false, text: data.error || 'Could not switch STT engine' });
      else void loadStatus();
    } catch (e: any) {
      setSttMsg({ ok: false, text: e?.message || 'Network error' });
    } finally {
      setSavingSttEngine(false);
    }
  };

  const handleSelectSttModel = async (engineKey: string, modelId: string) => {
    setSavingSttModelFor(engineKey);
    setSttMsg(null);
    try {
      const res = await fetch('/api/providers/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sttModels: { [engineKey]: modelId } }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.success) {
        setSelectedSttModels((prev) => ({ ...prev, [engineKey]: modelId }));
        void loadStatus();
      } else {
        setSttMsg({ ok: false, text: data.error || 'Could not save STT model' });
      }
    } catch (e: any) {
      setSttMsg({ ok: false, text: e?.message || 'Network error' });
    } finally {
      setSavingSttModelFor(null);
    }
  };

  const handleSaveSttKey = async (engineKey: string) => {
    const raw = (sttKeyInputs[engineKey] || '').trim();
    if (!raw) {
      setSttMsg({ ok: false, text: 'Paste an API key first.' });
      return;
    }
    setSavingSttKeyFor(engineKey);
    setSttMsg(null);
    try {
      const body: Record<string, string> =
        engineKey === 'groq' ? { groqApiKey: raw } : engineKey === 'deepgram' ? { deepgramApiKey: raw } : { assemblyAiApiKey: raw };
      const res = await fetch('/api/providers/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (data.success) {
        const msg = engineKey === 'groq' ? 'Groq key saved — Groq STT is ready.' : engineKey === 'deepgram' ? 'Deepgram key saved — Deepgram STT is ready.' : 'AssemblyAI key saved — AssemblyAI STT is ready.';
        setSttMsg({ ok: true, text: msg });
        setSttKeyInputs((prev) => ({ ...prev, [engineKey]: '' }));
        void loadStatus();
        void loadModelLists();
      } else {
        setSttMsg({ ok: false, text: data.error || 'Key was rejected' });
      }
    } catch (e: any) {
      setSttMsg({ ok: false, text: e?.message || 'Network error' });
    } finally {
      setSavingSttKeyFor(null);
    }
  };

  const sttEngineDefaults: Record<string, { baseUrl: string; keyUrl: string; keyLabel: string }> = {
    groq: { baseUrl: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com', keyLabel: 'console.groq.com' },
    assemblyai: { baseUrl: 'https://api.assemblyai.com', keyUrl: 'https://assemblyai.com', keyLabel: 'assemblyai.com' },
    deepgram: { baseUrl: 'https://api.deepgram.com', keyUrl: 'https://console.deepgram.com', keyLabel: 'console.deepgram.com' },
  };

  const openSttEndpointEditor = (engine: SttEngineInfo) => {
    setEditingSttEndpointFor(engine.key);
    setSttEpBaseUrl(sttEngineDefaults[engine.key]?.baseUrl || '');
    setSttEpApiKey('');
    setSttEndpointMsg(null);
  };

  const handleSaveSttEndpoint = async (engineKey: string) => {
    setSavingSttEndpointFor(engineKey);
    setSttEndpointMsg(null);
    try {
      const body: Record<string, any> = { sttEndpoint: { engine: engineKey, baseUrl: sttEpBaseUrl.trim(), apiKey: sttEpApiKey.trim() } };
      const res = await fetch('/api/providers/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (data.success) {
        setSttEndpointMsg({ key: engineKey, ok: true, text: 'Endpoint & key saved.' });
        setEditingSttEndpointFor(null);
        void loadStatus();
        void loadModelLists();
      } else {
        setSttEndpointMsg({ key: engineKey, ok: false, text: data.error || 'Save failed' });
      }
    } catch (e: any) {
      setSttEndpointMsg({ key: engineKey, ok: false, text: e?.message || 'Network error' });
    } finally {
      setSavingSttEndpointFor(null);
    }
  };

  const handleEngineChange = (mode: TTSEngineMode) => {
    setTtsEngine(mode);
    serenVoice.setTtsEngine(mode);
    if (mode === 'server') {
      setServerTtsOnline(null);
      void serenVoice.checkServerTts().then(setServerTtsOnline);
    }
  };

  const handlePreviewVoice = async (voiceId: string) => {
    setPreviewingVoice(voiceId);
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `Hi! I'm Seren, your IELTS speaking coach. This is my ${voiceId.split('-')[2]} voice.`,
          voice: voiceId,
        }),
      });
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = () => URL.revokeObjectURL(url);
        await audio.play();
      }
    } catch (e) {
      console.warn('Voice preview failed:', e);
    } finally {
      setTimeout(() => setPreviewingVoice(null), 3000);
    }
  };

  const applyVoice = (voiceId: string) => {
    setSelectedVoice(voiceId);
    serenVoice.setVoice(voiceId === 'en-US-JennyNeural' ? null : voiceId);
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.94, y: 20, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.94, y: 20, opacity: 0 }}
            transition={{ type: 'spring', damping: 26, stiffness: 320 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-2xl max-h-[88vh] overflow-y-auto rounded-3xl border border-[#44475a] bg-[#282a36] shadow-2xl shadow-black/50"
          >
            {/* Header */}
            <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-4 bg-[#282a36]/95 backdrop-blur border-b border-[#44475a]">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-[#bd93f9]/20 border border-[#bd93f9]/40 text-[#bd93f9]">
                  <RadioTower className="w-4 h-4" />
                </div>
                <div>
                  <h2 className="text-base font-bold text-[#f8f8f2]">AI Engine Settings</h2>
                  <p className="text-[11px] text-[#6272a4]">Configure Seren's brain &amp; voice — all free, no paid APIs</p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="p-2 rounded-xl border border-[#44475a] bg-[#21222c] text-[#6272a4] hover:text-[#f8f8f2] hover:bg-[#44475a] transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 space-y-7">
              {/* LLM Providers */}
              <section>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs font-bold uppercase tracking-widest text-[#8be9fd]">AI Provider</h3>
                  <button
                    type="button"
                    onClick={() => {
                      void loadStatus();
                      void loadModelLists();
                    }}
                    className="flex items-center gap-1.5 text-[11px] text-[#6272a4] hover:text-[#f8f8f2] transition-colors"
                  >
                    <RefreshCw className={`w-3 h-3 ${loadingStatus ? 'animate-spin' : ''}`} />
                    Refresh
                  </button>
                </div>

                <div className="space-y-2.5">
                  {/* Auto cascade option */}
                  <button
                    type="button"
                    onClick={() => void handlePinProvider('auto')}
                    className={`w-full flex items-center gap-3 p-3.5 rounded-2xl border text-left transition-all ${
                      pinnedProvider === 'auto'
                        ? 'border-[#bd93f9]/60 bg-[#bd93f9]/10'
                        : 'border-[#44475a] bg-[#21222c] hover:border-[#6272a4]'
                    }`}
                  >
                    <div className="p-2 rounded-xl bg-[#8be9fd]/15 border border-[#8be9fd]/40 text-[#8be9fd]">
                      <RadioTower className="w-4 h-4" />
                    </div>
                    <div className="flex-1">
                      <div className="text-sm font-semibold text-[#f8f8f2]">Auto (smart cascade)</div>
                      <div className="text-[11px] text-[#6272a4]">
                        Tries each provider in order and uses the first one that answers
                      </div>
                    </div>
                    {pinnedProvider === 'auto' && <Check className="w-4 h-4 text-[#50fa7b]" />}
                  </button>

                  {providers.map((p) => {
                    const isPinned = pinnedProvider === p.key;
                    const statusColor = p.ready ? '#50fa7b' : p.needsKey ? '#ffb86c' : '#ff5555';
                    const statusText = p.ready
                      ? `Online • ${p.resolvedModel || p.configuredModel}${p.latencyMs ? ` • ${p.latencyMs}ms` : ''}`
                      : p.needsKey
                      ? 'Needs API key'
                      : 'Offline / unreachable';
                    const models = modelLists[p.key] || [];
                    return (
                      <div
                        key={p.key}
                        onClick={() => void handlePinProvider(p.key)}
                        className={`w-full flex items-start gap-3 p-3.5 rounded-2xl border text-left cursor-pointer transition-all ${
                          isPinned ? 'border-[#bd93f9]/60 bg-[#bd93f9]/10' : 'border-[#44475a] bg-[#21222c] hover:border-[#6272a4]'
                        }`}
                      >
                        <div className="p-2 rounded-xl bg-[#44475a]/40 border border-[#44475a] text-[#bd93f9] mt-0.5">
                          {providerIcons[p.key] || <Cpu className="w-4 h-4" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-[#f8f8f2]">{p.label}</span>
                            <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: statusColor }} />
                            {p.customEndpoint && (
                              <span className="px-1.5 py-0.5 rounded-md bg-[#8be9fd]/15 border border-[#8be9fd]/40 text-[#8be9fd] text-[9px] font-bold uppercase tracking-wider flex items-center gap-1">
                                <Globe className="w-2.5 h-2.5" /> Custom
                              </span>
                            )}
                            {savingModelFor === p.key && <Loader2 className="w-3 h-3 text-[#bd93f9] animate-spin" />}
                          </div>
                          <div className="text-[11px] text-[#6272a4] truncate">{statusText}</div>
                          <div className="text-[10px] text-[#6272a4]/70 truncate font-mono">{p.baseUrl}</div>
                          {!p.needsKey && (
                            <select
                              value={selectedModels[p.key] || 'auto'}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => void handleSelectModel(p.key, e.target.value)}
                              className="mt-2 w-full px-2.5 py-1.5 rounded-lg border border-[#44475a] bg-[#282a36] text-[11px] text-[#f8f8f2] outline-none focus:border-[#bd93f9]/60 font-mono cursor-pointer"
                              title="Choose the exact model this provider should use"
                            >
                              <option value="auto">Auto — best available model</option>
                              {models.map((id) => (
                                <option key={id} value={id}>
                                  {id}
                                </option>
                              ))}
                            </select>
                          )}

                          {/* Endpoint editor toggle */}
                          {editingEndpointFor === p.key ? (
                            <div
                              onClick={(e) => e.stopPropagation()}
                              className="mt-2.5 p-3 rounded-xl border border-[#6272a4]/50 bg-[#21222c] space-y-2"
                            >
                              <label className="text-[10px] font-semibold uppercase tracking-wider text-[#8be9fd] block">
                                OpenAI-compatible base URL
                              </label>
                              <input
                                type="text"
                                value={epBaseUrl}
                                onChange={(e) => setEpBaseUrl(e.target.value)}
                                placeholder="https://host:port/v1"
                                className="w-full px-2.5 py-1.5 rounded-lg border border-[#44475a] bg-[#282a36] text-[11px] text-[#f8f8f2] placeholder-[#6272a4]/60 outline-none focus:border-[#bd93f9]/60 font-mono"
                              />
                              <label className="text-[10px] font-semibold uppercase tracking-wider text-[#8be9fd] block pt-1">
                                API key (leave empty to keep current)
                              </label>
                              {p.key === 'groq' && (
                                <p className="text-[10px] text-[#6272a4] leading-relaxed">
                                  Get a free key at <span className="text-[#8be9fd] font-mono">console.groq.com</span> — no credit card needed. Paste it above.
                                </p>
                              )}
                              <input
                                type="password"
                                value={epApiKey}
                                onChange={(e) => setEpApiKey(e.target.value)}
                                placeholder={p.hasCustomKey ? '•••••••• (saved)' : 'none required for local servers'}
                                className="w-full px-2.5 py-1.5 rounded-lg border border-[#44475a] bg-[#282a36] text-[11px] text-[#f8f8f2] placeholder-[#6272a4]/60 outline-none focus:border-[#bd93f9]/60 font-mono"
                              />
                              <div className="flex items-center gap-2 pt-1">
                                <button
                                  type="button"
                                  disabled={savingEndpointFor === p.key}
                                  onClick={() => void handleSaveEndpoint(p.key)}
                                  className="px-3 py-1.5 rounded-lg bg-[#50fa7b] hover:bg-[#50fa7b]/90 text-[#282a36] text-[11px] font-bold transition-colors flex items-center gap-1.5 disabled:opacity-40"
                                >
                                  {savingEndpointFor === p.key ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                                  Save
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingEndpointFor(null)}
                                  className="px-3 py-1.5 rounded-lg border border-[#44475a] bg-[#282a36] text-[#6272a4] hover:text-[#f8f8f2] text-[11px] font-medium transition-colors"
                                >
                                  Cancel
                                </button>
                                {endpointMsg?.key === p.key && (
                                  <span className={`text-[10px] ${endpointMsg.ok ? 'text-[#50fa7b]' : 'text-[#ff5555]'}`}>
                                    {endpointMsg.text}
                                  </span>
                                )}
                              </div>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                openEndpointEditor(p);
                              }}
                              className="mt-2 px-2.5 py-1 rounded-lg border border-[#44475a] bg-[#282a36] hover:bg-[#44475a] text-[#8be9fd] text-[10px] font-semibold transition-colors flex items-center gap-1.5"
                              title="Set a custom OpenAI-compatible endpoint URL and API key"
                            >
                              <Globe className="w-3 h-3" />
                              Endpoint / Key
                            </button>
                          )}
                        </div>
                        {isPinned && <Check className="w-4 h-4 text-[#50fa7b] shrink-0 mt-1" />}
                      </div>
                    );
                  })}

                  {providers.length === 0 && !loadingStatus && (
                    <div className="flex items-center gap-2 p-3.5 rounded-2xl border border-[#ff5555]/40 bg-[#ff5555]/10 text-[#ff5555] text-xs">
                      <AlertTriangle className="w-4 h-4 shrink-0" />
                      Could not reach the server status endpoint.
                    </div>
                  )}
                </div>

                <p className="mt-2.5 text-[11px] text-[#6272a4] leading-relaxed">
                  If every provider is offline, Seren falls back to built-in rule-based responses so the app keeps working.
                </p>
              </section>

              {/* Speech-to-Text engine */}
              <section>
                <h3 className="text-xs font-bold uppercase tracking-widest text-[#8be9fd] mb-3">Speech-to-Text Engine</h3>
                <div className="p-4 rounded-2xl border border-[#44475a] bg-[#21222c] space-y-3">
                  <p className="text-[10px] text-[#6272a4] leading-relaxed">
                    Choose how Seren transcribes your voice. Local is offline and always free. Cloud engines are faster — add keys below. Missing, expired, or out-of-credit keys fall back to local automatically.
                  </p>
                  {sttMsg && (
                    <div className={`p-2.5 rounded-xl border text-[11px] ${sttMsg.ok ? 'border-[#50fa7b]/40 bg-[#50fa7b]/10 text-[#50fa7b]' : 'border-[#ff5555]/40 bg-[#ff5555]/10 text-[#ff5555]'}`}>
                      {sttMsg.text}
                    </div>
                  )}
                  <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
                    {sttEngines.map((e) => {
                      const active = sttEngineSel === e.key;
                      const sttStatusColor = !e.needsKey ? '#50fa7b' : e.hasKey && e.reachable ? '#50fa7b' : e.hasKey && !e.reachable ? '#ff5555' : '#ffb86c';
                      return (
                        <div key={e.key} onClick={() => void handleSelectSttEngine(e.key)} className={`p-3 rounded-2xl border cursor-pointer ${active ? 'border-[#bd93f9]/60 bg-[#bd93f9]/10' : 'border-[#44475a] hover:border-[#6272a4]'}`}>
                          <div className="flex items-center gap-2">
                            <Mic className="w-4 h-4 text-[#8be9fd]" />
                            <div className="text-xs font-bold text-[#f8f8f2]">{e.label}</div>
                            <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: sttStatusColor }} />
                            {active && <Check className="w-3.5 h-3.5 text-[#50fa7b] ml-auto" />}
                          </div>
                          <div className="text-[10px] text-[#6272a4] mt-1">{e.description}</div>
                          {e.key !== 'local' && (
                            <div className="mt-2 space-y-2" onClick={(ev) => ev.stopPropagation()}>
                              <select value={selectedSttModels[e.key] || e.model} onChange={(ev) => void handleSelectSttModel(e.key, ev.target.value)} className="w-full px-2 py-2 rounded-xl border border-[#44475a] bg-[#282a36] text-xs text-[#f8f8f2] font-mono cursor-pointer">
                                {e.models.map((m) => (<option key={m} value={m}>{m}</option>))}
                              </select>

                              {editingSttEndpointFor === e.key ? (
                                <div className="p-3 rounded-xl border border-[#6272a4]/50 bg-[#21222c] space-y-2">
                                  <label className="text-[10px] font-semibold uppercase tracking-wider text-[#8be9fd] block">
                                    OpenAI-compatible base URL
                                  </label>
                                  <input
                                    type="text"
                                    value={sttEpBaseUrl}
                                    onChange={(ev) => setSttEpBaseUrl(ev.target.value)}
                                    className="w-full px-2.5 py-1.5 rounded-lg border border-[#44475a] bg-[#282a36] text-[11px] text-[#f8f8f2] placeholder-[#6272a4]/60 outline-none focus:border-[#bd93f9]/60 font-mono"
                                  />
                                  <label className="text-[10px] font-semibold uppercase tracking-wider text-[#8be9fd] block pt-1">
                                    API key {e.hasKey ? '(leave empty to keep current)' : ''}
                                  </label>
                                  {sttEngineDefaults[e.key] && (
                                    <p className="text-[10px] text-[#6272a4] leading-relaxed">
                                      Get a free key at <span className="text-[#8be9fd] font-mono">{sttEngineDefaults[e.key].keyLabel}</span> — paste it below.
                                    </p>
                                  )}
                                  <input
                                    type="password"
                                    value={sttEpApiKey}
                                    onChange={(ev) => setSttEpApiKey(ev.target.value)}
                                    placeholder={e.hasKey ? '•••••••• (saved)' : e.key === 'groq' ? 'gsk_...' : 'AssemblyAI key'}
                                    className="w-full px-2.5 py-1.5 rounded-lg border border-[#44475a] bg-[#282a36] text-[11px] text-[#f8f8f2] placeholder-[#6272a4]/60 outline-none focus:border-[#bd93f9]/60 font-mono"
                                  />
                                  <div className="flex items-center gap-2 pt-1">
                                    <button
                                      type="button"
                                      disabled={savingSttEndpointFor === e.key}
                                      onClick={() => void handleSaveSttEndpoint(e.key)}
                                      className="px-3 py-1.5 rounded-lg bg-[#50fa7b] hover:bg-[#50fa7b]/90 text-[#282a36] text-[11px] font-bold transition-colors flex items-center gap-1.5 disabled:opacity-40"
                                    >
                                      {savingSttEndpointFor === e.key ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                                      Save
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setEditingSttEndpointFor(null)}
                                      className="px-3 py-1.5 rounded-lg border border-[#44475a] bg-[#282a36] text-[#6272a4] hover:text-[#f8f8f2] text-[11px] font-medium transition-colors"
                                    >
                                      Cancel
                                    </button>
                                    {sttEndpointMsg?.key === e.key && (
                                      <span className={`text-[10px] ${sttEndpointMsg.ok ? 'text-[#50fa7b]' : 'text-[#ff5555]'}`}>
                                        {sttEndpointMsg.text}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => openSttEndpointEditor(e)}
                                  className="px-2.5 py-1 rounded-lg border border-[#44475a] bg-[#282a36] hover:bg-[#44475a] text-[#8be9fd] text-[10px] font-semibold transition-colors flex items-center gap-1.5"
                                  title="Set a custom endpoint URL and API key for this STT engine"
                                >
                                  <Globe className="w-3 h-3" />
                                  Endpoint / Key
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {sttEngines.length === 0 && (<div className="text-[11px] text-[#6272a4]">Loading STT engines...</div>)}
                  </div>


                  {/* Interview microphone mode */}
                  <div className="pt-1">
                    <label className="text-[11px] font-semibold text-[#6272a4] mb-1.5 block">
                      Interview microphone (1v1 Chat)
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => handleAutoMicChange(true)}
                        className={`p-3 rounded-xl border text-left transition-all ${
                          autoMic
                            ? 'border-[#50fa7b]/60 bg-[#50fa7b]/10'
                            : 'border-[#44475a] hover:border-[#6272a4]'
                        }`}
                      >
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-[#f8f8f2]">
                          <Zap className="w-3.5 h-3.5 text-[#50fa7b]" />
                          Automatic
                        </div>
                        <div className="text-[10px] text-[#6272a4] mt-1">
                          Mic opens by itself after Seren finishes each question
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleAutoMicChange(false)}
                        className={`p-3 rounded-xl border text-left transition-all ${
                          !autoMic
                            ? 'border-[#bd93f9]/60 bg-[#bd93f9]/10'
                            : 'border-[#44475a] hover:border-[#6272a4]'
                        }`}
                      >
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-[#f8f8f2]">
                          <Mic className="w-3.5 h-3.5 text-[#bd93f9]" />
                          Manual
                        </div>
                        <div className="text-[10px] text-[#6272a4] mt-1">
                          You press the mic button when you're ready to speak
                        </div>
                      </button>
                    </div>
                  </div>
                </div>
              </section>

              {/* Voice / TTS */}
              <section>
                <h3 className="text-xs font-bold uppercase tracking-widest text-[#8be9fd] mb-3">Seren's Voice</h3>
                <div className="p-4 rounded-2xl border border-[#44475a] bg-[#21222c] space-y-4">
                  {/* Engine mode */}
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => handleEngineChange('server')}
                      className={`p-3 rounded-xl border text-left transition-all ${
                        ttsEngine === 'server'
                          ? 'border-[#50fa7b]/60 bg-[#50fa7b]/10'
                          : 'border-[#44475a] hover:border-[#6272a4]'
                      }`}
                    >
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-[#f8f8f2]">
                        <Volume2 className="w-3.5 h-3.5 text-[#50fa7b]" />
                        Neural Voice
                      </div>
                      <div className="text-[10px] text-[#6272a4] mt-1">
                        {serverTtsOnline === null ? 'Checking availability…' : serverTtsOnline ? 'Online — Microsoft Edge neural voices' : 'Offline — will use browser voice'}
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleEngineChange('browser')}
                      className={`p-3 rounded-xl border text-left transition-all ${
                        ttsEngine === 'browser'
                          ? 'border-[#bd93f9]/60 bg-[#bd93f9]/10'
                          : 'border-[#44475a] hover:border-[#6272a4]'
                      }`}
                    >
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-[#f8f8f2]">
                        <Cpu className="w-3.5 h-3.5 text-[#bd93f9]" />
                        Browser Voice
                      </div>
                      <div className="text-[10px] text-[#6272a4] mt-1">Built-in system voice (robotic)</div>
                    </button>
                  </div>

                  {/* Voice picker */}
                  <div>
                    <label className="text-[11px] font-semibold text-[#6272a4] mb-1.5 block">Neural voice</label>
                    <div className="flex gap-2">
                      <select
                        value={selectedVoice}
                        onChange={(e) => applyVoice(e.target.value)}
                        className="flex-1 px-3 py-2 rounded-xl border border-[#44475a] bg-[#282a36] text-xs text-[#f8f8f2] outline-none focus:border-[#bd93f9]/60"
                      >
                        {voices.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.name} ({v.locale}, {v.gender}) — {v.personality}
                          </option>
                        ))}
                        {voices.length === 0 && <option value={selectedVoice}>{selectedVoice}</option>}
                      </select>
                      <button
                        type="button"
                        onClick={() => void handlePreviewVoice(selectedVoice)}
                        disabled={previewingVoice === selectedVoice}
                        className="px-3 py-2 rounded-xl border border-[#8be9fd]/50 bg-[#8be9fd]/10 text-[#8be9fd] text-xs font-bold hover:bg-[#8be9fd]/20 transition-colors flex items-center gap-1.5 disabled:opacity-50"
                      >
                        {previewingVoice === selectedVoice ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Play className="w-3.5 h-3.5" />
                        )}
                        Preview
                      </button>
                    </div>
                  </div>
                </div>
              </section>

              {/* Text & UI Size */}
              <section>
                <h3 className="text-xs font-bold uppercase tracking-widest text-[#f1fa8c] mb-3">Text &amp; UI Size</h3>
                <div className="p-4 rounded-2xl border border-[#44475a] bg-[#21222c]/80 space-y-3">
                  <p className="text-[11px] text-[#6272a4] leading-relaxed">
                    Zoom the whole interface — text, buttons and spacing scale together. The choice is saved on this
                    device. In the desktop app, <span className="text-[#6272a4] font-semibold">Ctrl + / Ctrl −</span>{' '}
                    work too.
                  </p>
                  <div className="flex items-center gap-2.5">
                    <button
                      type="button"
                      onClick={() => nudgeTextScale(-TEXT_SCALE_STEP)}
                      disabled={textScale <= MIN_TEXT_SCALE}
                      title="Zoom out"
                      className="p-2.5 rounded-xl border border-[#44475a] bg-[#282a36] text-[#8be9fd] hover:bg-[#44475a] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <ZoomOut className="w-4 h-4" />
                    </button>
                    <div className="flex-1 text-center">
                      <div className="text-base font-bold text-[#f8f8f2]">{Math.round(textScale * 100)}%</div>
                      <div className="text-[10px] text-[#6272a4]">
                        {(BASE_FONT_PX * textScale).toFixed(1)}px base text
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => nudgeTextScale(TEXT_SCALE_STEP)}
                      disabled={textScale >= MAX_TEXT_SCALE}
                      title="Zoom in"
                      className="p-2.5 rounded-xl border border-[#44475a] bg-[#282a36] text-[#8be9fd] hover:bg-[#44475a] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <ZoomIn className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={resetTextScale}
                      disabled={textScale === DEFAULT_TEXT_SCALE}
                      title="Reset to default"
                      className="px-3 py-2.5 rounded-xl border border-[#44475a] bg-[#282a36] text-[#6272a4] hover:text-[#f8f8f2] hover:bg-[#44475a] transition-colors text-[11px] font-semibold flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Reset
                    </button>
                  </div>
                </div>
              </section>

              {/* Your Data — backup / restore */}
              <section>
                <h3 className="text-xs font-bold uppercase tracking-widest text-[#50fa7b] mb-3">Your Data</h3>
                <div className="p-4 rounded-2xl border border-[#44475a] bg-[#21222c]/80 space-y-3">
                  <p className="text-[11px] text-[#6272a4] leading-relaxed">
                    Your profile, reports, lessons and chats live only on this device. Export them to a JSON file to
                    back them up or move them to another machine — importing restores the keys and reloads Seren.
                  </p>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <button
                      type="button"
                      onClick={exportUserData}
                      className="flex-1 py-2.5 px-4 rounded-xl border border-[#50fa7b]/60 bg-[#50fa7b]/10 hover:bg-[#50fa7b]/20 text-[#50fa7b] font-bold text-xs transition-colors flex items-center justify-center gap-2"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Export backup
                    </button>
                    <button
                      type="button"
                      onClick={() => importFileRef.current?.click()}
                      className="flex-1 py-2.5 px-4 rounded-xl border border-[#8be9fd]/60 bg-[#8be9fd]/10 hover:bg-[#8be9fd]/20 text-[#8be9fd] font-bold text-xs transition-colors flex items-center justify-center gap-2"
                    >
                      <Upload className="w-3.5 h-3.5" />
                      Import backup
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const desktop = (window as unknown as {
                          serenDesktop?: { openDataFolder?: () => Promise<boolean> };
                        }).serenDesktop;
                        if (desktop?.openDataFolder) void desktop.openDataFolder();
                      }}
                      className="flex-1 py-2.5 px-4 rounded-xl border border-[#44475a] bg-[#282a36] hover:bg-[#44475a] text-[#6272a4] hover:text-[#f8f8f2] font-bold text-xs transition-colors flex items-center justify-center gap-2"
                    >
                      <FolderOpen className="w-3.5 h-3.5" />
                      Data folder
                    </button>
                    <input
                      ref={importFileRef}
                      type="file"
                      accept="application/json,.json"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void handleImportFile(file);
                        e.target.value = '';
                      }}
                    />
                  </div>
                  {backupMsg && (
                    <p className={`text-[11px] ${backupMsg.ok ? 'text-[#50fa7b]' : 'text-[#ff5555]'}`}>
                      {backupMsg.text}
                    </p>
                  )}
                </div>
              </section>

              {/* Keyboard Shortcuts */}
              <ShortcutSettings />

              {/* Danger Zone */}
              <section>
                <h3 className="text-xs font-bold uppercase tracking-widest text-[#ff5555] mb-3">Danger Zone</h3>
                <div className="p-4 rounded-2xl border border-[#ff5555]/40 bg-[#ff5555]/10 space-y-3">
                  <p className="text-[11px] text-[#f8f8f2]/80 leading-relaxed">
                    Erases <strong>everything</strong>: your profile, diagnostic results, lesson progress, and every AI
                    preference (custom endpoints, API keys, models, voices). Seren restores factory defaults and restarts
                    from the very beginning.
                  </p>
                  {!confirmingWipe ? (
                    <button
                      type="button"
                      onClick={() => setConfirmingWipe(true)}
                      className="w-full py-2.5 px-4 rounded-xl border border-[#ff5555]/60 bg-[#ff5555]/15 hover:bg-[#ff5555]/25 text-[#ff5555] font-bold text-xs transition-colors flex items-center justify-center gap-2"
                    >
                      <AlertTriangle className="w-3.5 h-3.5" />
                      Restore Defaults &amp; Delete All App Data
                    </button>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-[11px] font-bold text-[#ff5555]">
                        Are you sure? This cannot be undone.
                      </p>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={wiping}
                          onClick={() => void handleFactoryReset()}
                          className="flex-1 py-2.5 px-4 rounded-xl bg-[#ff5555] hover:bg-[#ff5555]/90 text-white font-bold text-xs transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                        >
                          {wiping ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <AlertTriangle className="w-3.5 h-3.5" />}
                          Yes, erase everything
                        </button>
                        <button
                          type="button"
                          disabled={wiping}
                          onClick={() => setConfirmingWipe(false)}
                          className="px-4 py-2.5 rounded-xl border border-[#44475a] bg-[#282a36] text-[#6272a4] hover:text-[#f8f8f2] font-medium text-xs transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </section>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
