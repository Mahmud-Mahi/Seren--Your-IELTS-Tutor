import React, { useEffect, useState, useCallback, useRef } from 'react';
import packageMetadata from '../../package.json';
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
  Database,
  FileJson,
  Plug,
  Flame,
  ListOrdered,
  ArrowUp,
  ArrowDown,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { serenVoice, TTSEngineMode } from '../utils/speech';
import { getAutoMicEnabled, setAutoMicEnabled } from '../utils/preferences';
import { loadMessagesByMode } from '../utils/chatHistory';
import {
  DEFAULT_UI_ZOOM,
  DEFAULT_TEXT_SCALE,
  getUiZoom,
  getTextScale,
  MAX_UI_ZOOM,
  MAX_TEXT_SCALE,
  MIN_UI_ZOOM,
  MIN_TEXT_SCALE,
  setUiZoom,
  setTextScale,
  stepUiZoom,
  stepTextScale,
  UI_ZOOM_STEP,
  TEXT_SCALE_STEP,
} from '../utils/textScale';
import { ShortcutSettings } from './ShortcutSettings';
const DEFAULT_TTS_VOICE_ID = 'google-tts-en-ca';

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
  demonroute: <Flame className="w-4 h-4" />,
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

interface MemoryPluginField {
  key: string;
  label: string;
  type?: 'text' | 'password' | 'url' | 'number';
  placeholder?: string;
  required?: boolean;
  default?: string;
  help?: string;
}

interface MemoryPluginManifest {
  id: string;
  name: string;
  version?: string;
  description?: string;
  baseUrl?: string;
  endpoints?: { search?: string; store?: string; test?: string };
  auth?: { type?: 'bearer' | 'header' | 'none'; header?: string; prefix?: string };
  request?: {
    chatIdField?: string;
    messageField?: string;
    queryField?: string;
    extra?: Record<string, string | number | boolean>;
  };
  response?: { memoriesPath?: string; summaryField?: string; scoreField?: string };
  fields?: MemoryPluginField[];
}

interface MemoryPluginStatus {
  enabled: boolean;
  ready: boolean;
  baseUrl: string;
  chatId: string;
  maxMemories: number;
  hasApiKey: boolean;
  needsKey: boolean;
  fileName: string | null;
  plugin: MemoryPluginManifest | null;
  options: Record<string, string>;
  initialSyncDone: boolean;
  builtins: MemoryPluginManifest[];
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ open, onClose }) => {
  const [appVersion, setAppVersion] = useState(packageMetadata.version);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [pinnedProvider, setPinnedProvider] = useState<string>('auto');
  const [providerPriority, setProviderPriority] = useState<string[]>([]);
  const [autoCascadeExpanded, setAutoCascadeExpanded] = useState(false);
  const [savingPriority, setSavingPriority] = useState(false);
  const [priorityMsg, setPriorityMsg] = useState<{ ok: boolean; text: string } | null>(null);
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

  const [memoryStatus, setMemoryStatus] = useState<MemoryPluginStatus | null>(null);
  const [memoryExpanded, setMemoryExpanded] = useState(false);
  const [memoryEnabled, setMemoryEnabled] = useState(false);
  const [memoryManifest, setMemoryManifest] = useState<MemoryPluginManifest | null>(null);
  const [memoryBaseUrl, setMemoryBaseUrl] = useState('');
  const [memoryApiKey, setMemoryApiKey] = useState('');
  const [memoryChatId, setMemoryChatId] = useState('');
  const [memoryFileName, setMemoryFileName] = useState('');
  const [memoryMaxMemories, setMemoryMaxMemories] = useState('8');
  const [memoryOptions, setMemoryOptions] = useState<Record<string, string>>({});
  const [casualHistoryCount, setCasualHistoryCount] = useState(0);
  const [memorySaving, setMemorySaving] = useState(false);
  const [memoryTesting, setMemoryTesting] = useState(false);
  const [memoryMsg, setMemoryMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const memoryFileRef = useRef<HTMLInputElement>(null);

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
  const voiceSaveTimeout = useRef<NodeJS.Timeout | null>(null);
  const [voiceSaveMsg, setVoiceSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<string>(serenVoice.getVoice() || DEFAULT_TTS_VOICE_ID);
  const [ttsEngine, setTtsEngine] = useState<TTSEngineMode>(serenVoice.getTtsEngine());
  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null);
  const [editingTtsFor, setEditingTtsFor] = useState<string | null>(null);
  const [savingTtsFor, setSavingTtsFor] = useState<string | null>(null);
  const [ttsProvider, setTtsProvider] = useState<string>('google');
  const [expandedTtsProvider, setExpandedTtsProvider] = useState<string>('');
  const [selectedTtsVoice, setSelectedTtsVoice] = useState<Record<string, string>>({});
  const [azureKey, setAzureKey] = useState('');
  const [azureRegion, setAzureRegion] = useState('');
  const [pollyAccessKey, setPollyAccessKey] = useState('');
  const [pollySecretKey, setPollySecretKey] = useState('');
  const [pollyRegion, setPollyRegion] = useState('');

  const [serverTtsOnline, setServerTtsOnline] = useState<boolean | null>(null);

  // Interview microphone preference (automatic vs manual mic)
  const [autoMic, setAutoMic] = useState<boolean>(() => getAutoMicEnabled());

  const handleAutoMicChange = (enabled: boolean) => {
    setAutoMicEnabled(enabled);
    setAutoMic(enabled);
  };

  // ---- Display size controls (persisted per device) ------------------------
  const [uiZoom, setUiZoomState] = useState<number>(() => getUiZoom());
  const [textScale, setTextScaleState] = useState<number>(() => getTextScale());
  const nudgeUiZoom = (delta: number) => setUiZoomState(stepUiZoom(delta));
  const nudgeTextScale = (delta: number) => setTextScaleState(stepTextScale(delta));
  const resetUiZoom = () => setUiZoomState(setUiZoom(DEFAULT_UI_ZOOM));
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
        setProviderPriority(
          Array.isArray(data.priority)
            ? data.priority.filter((key: unknown): key is string => typeof key === 'string')
            : []
        );
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

  const applyMemoryStatus = useCallback((memory: MemoryPluginStatus | null) => {
    setMemoryStatus(memory);
    if (!memory) return;
    const fallback = memory.plugin || memory.builtins?.find((plugin) => plugin.id === 'chatsorter') || null;
    setMemoryEnabled(memory.enabled);
    setMemoryManifest(fallback);
    setMemoryFileName(memory.fileName || (fallback ? `${fallback.id}.memory.json` : ''));
    setMemoryBaseUrl(memory.baseUrl || fallback?.baseUrl || '');
    setMemoryChatId(memory.chatId || '');
    setMemoryMaxMemories(String(memory.maxMemories ?? 8));
    setMemoryOptions(memory.options || {});
    setMemoryApiKey('');
  }, []);

  const loadMemoryStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/memory/status');
      const data = await res.json();
      if (data.success && data.memory) applyMemoryStatus(data.memory);
    } catch (e) {}
  }, [applyMemoryStatus]);

  useEffect(() => {
    if (!open) return;
    void loadStatus();
    void loadModelLists();
    void loadMemoryStatus();
    setCasualHistoryCount(loadMessagesByMode()['Casual Chat'].length);
    void (async () => {
      // Fetch all voices from all providers
      try {
        const res = await fetch('/api/tts/voices');
        const data = await res.json();
        if (data.success) {
          const av = data.voices || [];
          setVoices(av);
          // Default voice per provider so dropdowns and previews work before any save
          setSelectedTtsVoice((prev) => {
            const next = { ...prev };
            if (!next.google) next.google = av.find((v: any) => v.id === 'google-tts-en-ca')?.id || av.find((v: any) => v.id.startsWith('google-tts-'))?.id || '';
            if (!next.azure) next.azure = av.find((v: any) => v.id.includes('Neural'))?.id || '';
            if (!next.polly) next.polly = av.find((v: any) => !v.id.startsWith('google-tts-') && !v.id.includes('Neural'))?.id || '';
            return next;
          });
        }
      } catch (e) {}

      // Fetch saved TTS voice/provider from server and apply
      try {
        const statusRes = await fetch('/api/providers/status');
        const statusData = await statusRes.json();
        if (statusData.success && statusData.tts) {
          const { voice: savedVoice, provider: savedProvider, voices: savedVoices } = statusData.tts;

          // Apply saved provider
          if (savedProvider && ['google', 'azure', 'polly'].includes(savedProvider)) {
            setTtsProvider(savedProvider);
            // Google never needs the expanded editor/Save button; auto-saves on click/voice change
            setExpandedTtsProvider(savedProvider === 'google' ? '' : savedProvider);
          }

          // Apply saved per-provider voices from server
          if (savedVoices && typeof savedVoices === 'object') {
            setSelectedTtsVoice({ ...savedVoices });
          }

          // Apply saved voice to the speech engine
          if (savedVoice && typeof savedVoice === 'string') {
            serenVoice.setVoice(savedVoice);
            setSelectedVoice(savedVoice);
          }
        }
      } catch (err) {
        console.warn('Failed to load saved TTS settings from server:', err);
      }
    })();
    setServerTtsOnline(null);
    void serenVoice.checkServerTts().then(setServerTtsOnline);
  }, [open, loadStatus, loadModelLists, loadMemoryStatus]);

  // Apply the selected TTS provider's voice to the speech engine when provider changes
  useEffect(() => {
    if (!ttsProvider || ttsProvider === '') return;
    const v = selectedTtsVoice[ttsProvider] || voices.find((voice) => {
      if (ttsProvider === 'google') return voice.id.startsWith('google-tts-');
      if (ttsProvider === 'azure') return voice.id.includes('Neural');
      return !voice.id.startsWith('google-tts-') && !voice.id.includes('Neural');
    })?.id || '';
    if (v) {
      serenVoice.setVoice(v);
      setSelectedVoice(v);
    }
  }, [ttsProvider, selectedTtsVoice, voices]);

  useEffect(() => {
    const getAppInfo = window.serenDesktop?.getAppInfo;
    if (!open || !getAppInfo) return;
    let cancelled = false;
    void getAppInfo()
      .then(({ appVersion: runningVersion }) => {
        if (!cancelled && runningVersion) setAppVersion(runningVersion);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open]);

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

  const saveProviderPriority = async (next: string[] | null) => {
    const previous = providerPriority;
    if (next) setProviderPriority(next);
    setSavingPriority(true);
    setPriorityMsg(null);
    try {
      const res = await fetch('/api/providers/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerPriority: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!data.success) {
        setProviderPriority(previous);
        setPriorityMsg({ ok: false, text: data.error || 'Could not save priority order' });
      } else {
        void loadStatus();
        void loadModelLists();
      }
    } catch (e: any) {
      setProviderPriority(previous);
      setPriorityMsg({ ok: false, text: e?.message || 'Network error' });
    } finally {
      setSavingPriority(false);
    }
  };

  const toggleProviderPriority = (key: string) => {
    if (providerPriority.includes(key)) {
      if (providerPriority.length <= 1) return;
      void saveProviderPriority(providerPriority.filter((k) => k !== key));
    } else {
      void saveProviderPriority([...providerPriority, key]);
    }
  };

  const moveProviderPriority = (key: string, direction: -1 | 1) => {
    const index = providerPriority.indexOf(key);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= providerPriority.length) return;
    const next = [...providerPriority];
    [next[index], next[target]] = [next[target], next[index]];
    void saveProviderPriority(next);
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

  const handlePreviewVoice = async (voiceId: string, providerKey: string) => {
    // Google is always available (no config needed). Azure/Polly require config.
    if (providerKey === 'azure' && !(azureKey && azureRegion)) return;
    if (providerKey === 'polly' && !(pollyAccessKey && pollySecretKey && pollyRegion)) return;
    setPreviewingVoice(voiceId);
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `Hi! I'm Seren, your IELTS speaking coach. This is my ${voiceId} voice.`,
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
    serenVoice.setVoice(voiceId === DEFAULT_TTS_VOICE_ID ? null : voiceId);
  };
  const handleSaveTtsProvider = async (provider: string) => {
    if (provider === 'google') {
      // Google needs no API keys, but still persist provider + voice selection
      setSavingTtsFor(provider);
      try {
        const voiceId = selectedTtsVoice['google'] || '';
        await fetch('/api/providers/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
          ttsProvider: 'google',
          ttsVoice: voiceId || 'google-tts-en-ca',
          ttsVoices: voiceId ? { google: voiceId } : {},
        }),
        });
      } catch (e) {}
      finally {
        setSavingTtsFor(null);
      }
      return;
    }
    setSavingTtsFor(provider);
    try {
      const voiceId = selectedTtsVoice[provider] || '';
      const res = await fetch('/api/providers/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ttsProvider: provider,
          ttsVoice: voiceId || undefined,
          ttsAzureKey: provider === 'azure' ? azureKey.trim() || undefined : undefined,
          ttsAzureRegion: provider === 'azure' ? azureRegion.trim() || undefined : undefined,
          ttsPollyAccessKey: provider === 'polly' ? pollyAccessKey.trim() || undefined : undefined,
          ttsPollySecretKey: provider === 'polly' ? pollySecretKey.trim() || undefined : undefined,
          ttsPollyRegion: provider === 'polly' ? pollyRegion.trim() || undefined : undefined,
          ttsVoices: voiceId ? { [provider]: voiceId } : {},
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!data.success) {
        alert(`Failed to save ${provider} settings: ${data.error || 'Unknown error'}`);
      }
    } catch (e: any) {
      alert(`Network error while saving ${provider} settings: ${e?.message}`);
    } finally {
      setSavingTtsFor(null);
    }
  };
  
  const handleSaveTtsVoiceSelection = async (provider: string, voiceId: string) => {
    try {
      const res = await fetch('/api/providers/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ttsProvider: provider,
          ttsVoice: voiceId,
          ttsVoices: { [provider]: voiceId },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!data.success) {
        console.warn(`Failed to save voice preference for ${provider}:`, data.error);
      }
    } catch (e) {
      console.warn(`Network error saving voice preference for ${provider}:`, e);
    }
  };

  const memoryPluginFields = (memoryManifest?.fields || []).filter(
    (field) => field && field.key && !['apiKey', 'chatId', 'baseUrl'].includes(field.key)
  );
  const memoryNeedsKey = memoryManifest ? (memoryManifest.auth?.type || 'bearer') !== 'none' : true;
  const memoryReady = Boolean(
    memoryEnabled &&
      memoryManifest &&
      (memoryBaseUrl.trim() || memoryManifest.baseUrl) &&
      (!memoryNeedsKey || memoryStatus?.hasApiKey || memoryApiKey.trim())
  );

  const memoryDefaultsFrom = (manifest: MemoryPluginManifest): Record<string, string> => {
    const defaults: Record<string, string> = {};
    for (const field of manifest.fields || []) {
      if (field.default) defaults[field.key] = field.default;
    }
    return defaults;
  };

  const applyMemoryManifest = (manifest: MemoryPluginManifest, fileName: string) => {
    setMemoryManifest(manifest);
    setMemoryFileName(fileName);
    setMemoryBaseUrl(manifest.baseUrl || '');
    setMemoryOptions((prev) => ({ ...prev, ...memoryDefaultsFrom(manifest) }));
    setMemoryMsg({ ok: true, text: `Loaded ${manifest.name}. Review the settings and press Save.` });
  };

  const handleMemoryPluginFile = async (file: File) => {
    setMemoryMsg(null);
    if (file.size > 1024 * 1024) {
      setMemoryMsg({ ok: false, text: 'Plugin file is too large (max 1 MB).' });
      return;
    }
    try {
      const parsed = JSON.parse(await file.text());
      const candidate = parsed && typeof parsed === 'object' && parsed.plugin ? parsed.plugin : parsed;
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || !candidate.name) {
        throw new Error('Not a valid memory plugin file.');
      }
      if (candidate.baseUrl && !/^https?:\/\//i.test(String(candidate.baseUrl))) {
        throw new Error('Plugin baseUrl must start with http:// or https://.');
      }
      applyMemoryManifest(candidate as MemoryPluginManifest, file.name);
    } catch (e: any) {
      setMemoryMsg({ ok: false, text: e?.message || 'Could not read plugin file.' });
    }
  };

  const handleLoadBuiltinMemory = (pluginId: string) => {
    const manifest = memoryStatus?.builtins?.find((builtin) => builtin.id === pluginId);
    if (!manifest) return;
    applyMemoryManifest(manifest, `${manifest.id}.memory.json`);
  };

  const memoryPayload = () => {
    const payload: Record<string, any> = {
      enabled: memoryEnabled,
      manifest: memoryManifest,
      fileName: memoryFileName || undefined,
      baseUrl: memoryBaseUrl.trim(),
      chatId: memoryChatId.trim(),
      maxMemories: Number(memoryMaxMemories) || 8,
      options: memoryOptions,
    };
    const key = memoryApiKey.trim();
    if (key) payload.apiKey = key;
    return payload;
  };

  const handleSaveMemory = async (overrides: Record<string, any> = {}) => {
    setMemorySaving(true);
    setMemoryMsg(null);
    try {
      const res = await fetch('/api/memory/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...memoryPayload(), ...overrides }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || 'Could not save memory plugin settings.');
      if (data.memory) applyMemoryStatus(data.memory);
      setMemoryMsg({ ok: true, text: 'Memory plugin settings saved.' });
    } catch (e: any) {
      setMemoryMsg({ ok: false, text: e?.message || 'Network error' });
      throw e;
    } finally {
      setMemorySaving(false);
    }
  };

  const handleMemoryToggle = async (enabled: boolean) => {
    if (enabled && !memoryManifest) {
      setMemoryMsg({ ok: false, text: 'Select a memory plugin file first.' });
      return;
    }
    setMemoryEnabled(enabled);
    try {
      await handleSaveMemory({ enabled });
    } catch {
      setMemoryEnabled(!enabled);
    }
  };

  const handleTestMemory = async () => {
    setMemoryMsg(null);
    if (!memoryManifest) {
      setMemoryMsg({ ok: false, text: 'Select a memory plugin file first.' });
      return;
    }
    if (!(memoryBaseUrl.trim() || memoryManifest.baseUrl)) {
      setMemoryMsg({ ok: false, text: 'Enter the memory plugin base URL first.' });
      return;
    }
    if (memoryNeedsKey && !memoryStatus?.hasApiKey && !memoryApiKey.trim()) {
      setMemoryMsg({ ok: false, text: 'Enter the plugin API key first.' });
      return;
    }
    setMemoryTesting(true);
    try {
      const casualMessages = loadMessagesByMode()['Casual Chat'].map((message) => ({
        sender: message.sender,
        text: message.text,
        timestamp: message.timestamp,
      }));
      const res = await fetch('/api/memory/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...memoryPayload(), initialMessages: casualMessages }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || 'Memory plugin test failed.');
      if (data.memory) applyMemoryStatus(data.memory);

      let text = data.message || 'Memory plugin responded successfully.';
      const sync = data.initialSync;
      if (sync?.attempted > 0) {
        text += sync.sent > 0 ? ` Synced ${sync.sent} casual chat message(s).` : '';
        if (sync.error) text += ` History sync failed: ${sync.error}`;
      }
      setMemoryMsg({ ok: !sync?.error, text });
    } catch (e: any) {
      setMemoryMsg({ ok: false, text: e?.message || 'Network error' });
    } finally {
      setMemoryTesting(false);
    }
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
            className="w-full max-w-2xl max-h-[82vh] overflow-y-auto rounded-3xl border border-[#44475a] bg-[#282a36] shadow-2xl shadow-black/50"
          >
            {/* Header */}
            <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-4 bg-[#282a36]/95 backdrop-blur border-b border-[#44475a]">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-[#bd93f9]/20 border border-[#bd93f9]/40 text-[#bd93f9]">
                  <RadioTower className="w-4 h-4" />
                </div>
                <div>
                  <h2 className="text-base font-bold text-[#f8f8f2]">Settings</h2>
                  <p className="text-[11px] text-[#6272a4]">Configure Seren's AI, voice, memory &amp; app preferences</p>
                  <p className="text-[10px] text-[#6272a4]/80">Version {appVersion}</p>
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
                  {/* Auto cascade option + manual priority */}
                  <div
                    className={`w-full rounded-2xl border transition-all ${
                      pinnedProvider === 'auto'
                        ? 'border-[#bd93f9]/60 bg-[#bd93f9]/10'
                        : 'border-[#44475a] bg-[#21222c]'
                    }`}
                  >
                    <div className="flex items-stretch">
                      <button
                        type="button"
                        onClick={() => void handlePinProvider('auto')}
                        className="flex-1 flex items-center gap-3 p-3.5 text-left rounded-l-2xl hover:bg-[#282a36]/40 transition-colors"
                      >
                        <div className="p-2 rounded-xl bg-[#8be9fd]/15 border border-[#8be9fd]/40 text-[#8be9fd]">
                          <RadioTower className="w-4 h-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-semibold text-[#f8f8f2] flex items-center gap-2">
                            Auto (smart cascade)
                            {pinnedProvider === 'auto' && <Check className="w-4 h-4 text-[#50fa7b]" />}
                          </div>
                          <div className="text-[11px] text-[#6272a4]">
                            Tries each enabled provider in your saved priority order
                          </div>
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={() => setAutoCascadeExpanded((prev) => !prev)}
                        className="px-3 flex items-center justify-center text-[#6272a4] hover:text-[#f8f8f2] hover:bg-[#44475a]/40 rounded-r-2xl transition-colors"
                        title={autoCascadeExpanded ? 'Hide cascade priority' : 'Show cascade priority'}
                      >
                        {autoCascadeExpanded ? (
                          <ChevronDown className="w-4 h-4" />
                        ) : (
                          <ChevronRight className="w-4 h-4" />
                        )}
                      </button>
                    </div>

                    {autoCascadeExpanded && (
                      <div className="px-3.5 pb-3.5 pt-3 border-t border-[#44475a]/60">
                        <div className="flex items-center gap-2 mb-2.5">
                          <ListOrdered className="w-3.5 h-3.5 text-[#ffb86c]" />
                          <div className="text-[11px] font-semibold text-[#f8f8f2]">Cascade priority</div>
                          {savingPriority && <Loader2 className="w-3 h-3 text-[#bd93f9] animate-spin" />}
                          <span className="ml-auto text-[10px] text-[#6272a4]">Top provider is tried first</span>
                        </div>

                        <div className="space-y-1.5">
                          {providers.map((p) => {
                            const index = providerPriority.indexOf(p.key);
                            const enabled = index !== -1;
                            const canRemove = enabled && providerPriority.length > 1;
                            return (
                              <div
                                key={p.key}
                                className={`flex items-center gap-2 px-2.5 py-2 rounded-xl border ${
                                  enabled ? 'border-[#6272a4]/60 bg-[#282a36]' : 'border-[#44475a] bg-[#282a36]/40'
                                }`}
                              >
                                <button
                                  type="button"
                                  onClick={() => toggleProviderPriority(p.key)}
                                  disabled={!canRemove && enabled}
                                  className={`w-5 h-5 rounded-md border flex items-center justify-center shrink-0 transition-colors ${
                                    enabled
                                      ? 'border-[#50fa7b]/60 bg-[#50fa7b]/15 text-[#50fa7b]'
                                      : 'border-[#6272a4] text-transparent hover:border-[#bd93f9]'
                                  } ${!canRemove && enabled ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'}`}
                                  title={enabled ? 'Exclude from auto cascade' : 'Include in auto cascade'}
                                >
                                  <Check className="w-3 h-3" />
                                </button>
                                <span className={`text-[11px] font-medium truncate ${enabled ? 'text-[#f8f8f2]' : 'text-[#6272a4]'}`}>
                                  {enabled ? `${index + 1}. ` : ''}{p.label}
                                </span>
                                <div className="ml-auto flex items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => moveProviderPriority(p.key, -1)}
                                    disabled={!enabled || index === 0}
                                    className="p-1 rounded-md border border-[#44475a] text-[#6272a4] hover:text-[#f8f8f2] hover:bg-[#44475a] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                                    title="Move up"
                                  >
                                    <ArrowUp className="w-3 h-3" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => moveProviderPriority(p.key, 1)}
                                    disabled={!enabled || index === providerPriority.length - 1}
                                    className="p-1 rounded-md border border-[#44475a] text-[#6272a4] hover:text-[#f8f8f2] hover:bg-[#44475a] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                                    title="Move down"
                                  >
                                    <ArrowDown className="w-3 h-3" />
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        <div className="mt-2 flex items-center justify-between gap-2">
                          <button
                            type="button"
                            onClick={() => void saveProviderPriority(null)}
                            disabled={savingPriority}
                            className="text-[10px] font-semibold text-[#6272a4] hover:text-[#f8f8f2] transition-colors disabled:opacity-40"
                          >
                            Reset to default order
                          </button>
                          {priorityMsg && (
                            <span className={`text-[10px] ${priorityMsg.ok ? 'text-[#50fa7b]' : 'text-[#ff5555]'}`}>
                              {priorityMsg.text}
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

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
                          <select
                            value={selectedModels[p.key] || 'auto'}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => void handleSelectModel(p.key, e.target.value)}
                            className="mt-2 w-full px-2.5 py-1.5 rounded-lg border border-[#44475a] bg-[#282a36] text-[11px] text-[#f8f8f2] outline-none focus:border-[#bd93f9]/60 font-mono cursor-pointer"
                            title="Choose the exact model this provider should use"
                          >
                            <option value="auto">
                              {p.needsKey && models.length === 0
                                ? 'Auto — add an API key to load models'
                                : 'Auto — best available model'}
                            </option>
                            {models.map((id) => (
                              <option key={id} value={id}>
                                {id}
                              </option>
                            ))}
                          </select>

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
                                  Get a free key at{' '}
                                  <a
                                    href="https://console.groq.com"
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-[#8be9fd] font-mono underline decoration-dotted hover:text-[#bd93f9]"
                                  >
                                    console.groq.com
                                  </a>{' '}
                                  — no credit card needed. Paste it above.
                                </p>
                              )}
                              {p.key === 'demonroute' && (
                                <p className="text-[10px] text-[#6272a4] leading-relaxed">
                                  DemonRoute is OpenAI-compatible — the default API URL is{' '}
                                  <span className="text-[#8be9fd] font-mono">https://api.demonroute.com/v1</span>.
                                  Get an API key at{' '}
                                  <a
                                    href="https://demonroute.com"
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-[#8be9fd] font-mono underline decoration-dotted hover:text-[#bd93f9]"
                                  >
                                    demonroute.com
                                  </a>{' '}
                                  and paste it above.
                                </p>
                              )}
                              <input
                                type="password"
                                value={epApiKey}
                                onChange={(e) => setEpApiKey(e.target.value)}
                                placeholder={
                                  p.hasCustomKey
                                    ? '•••••••• (saved)'
                                    : p.key === 'demonroute'
                                    ? 'sk-dr-...'
                                    : p.key === 'groq'
                                    ? 'gsk_...'
                                    : 'none required for local servers'
                                }
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

              {/* Memory plugin */}
              <section>
                <div className="rounded-2xl border border-[#44475a] bg-[#21222c] overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setMemoryExpanded((prev) => !prev)}
                    className="w-full flex items-center gap-3 p-4 text-left hover:bg-[#282a36]/60 transition-colors"
                  >
                    <div className={`p-2 rounded-xl border ${memoryEnabled ? 'bg-[#50fa7b]/15 border-[#50fa7b]/40 text-[#50fa7b]' : 'bg-[#44475a]/40 border-[#44475a] text-[#6272a4]'}`}>
                      <Database className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="text-xs font-bold uppercase tracking-widest text-[#8be9fd]">
                        Memory Plugin (Casual Chat)
                      </h3>
                      <div className="text-[10px] text-[#6272a4] truncate">
                        {memoryManifest
                          ? `${memoryManifest.name}${memoryManifest.version ? ` v${memoryManifest.version}` : ''}`
                          : 'ChatSorter'}
                        {' · '}
                        {memoryEnabled ? 'Enabled' : 'Disabled'}
                        {memoryEnabled && !memoryReady ? ' · needs configuration' : ''}
                      </div>
                    </div>
                    {memoryExpanded ? (
                      <ChevronDown className="w-4 h-4 text-[#6272a4] shrink-0" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-[#6272a4] shrink-0" />
                    )}
                  </button>

                  {memoryExpanded && (
                    <div className="px-4 pb-4 pt-1 space-y-3 border-t border-[#44475a]/60">
                      <p className="text-[10px] text-[#6272a4] leading-relaxed">
                        Give Seren long-term memory in Casual Chat. Select a memory plugin file, add its API key and
                        configuration, and Seren will recall relevant details before each reply. Interview practice is
                        never affected.
                      </p>

                      <div className="flex items-center justify-between gap-3 p-3 rounded-xl border border-[#44475a] bg-[#282a36]">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className={`p-2 rounded-xl border ${memoryEnabled ? 'bg-[#50fa7b]/15 border-[#50fa7b]/40 text-[#50fa7b]' : 'bg-[#44475a]/40 border-[#44475a] text-[#6272a4]'}`}>
                        <Database className="w-4 h-4" />
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs font-bold text-[#f8f8f2]">
                          {memoryEnabled ? 'Memory enabled' : 'Memory disabled'}
                        </div>
                        <div className="text-[10px] text-[#6272a4] truncate">
                          {memoryManifest
                            ? `${memoryManifest.name}${memoryManifest.version ? ` v${memoryManifest.version}` : ''}`
                            : 'No plugin loaded'}
                          {memoryEnabled && !memoryReady ? ' — needs configuration' : ''}
                        </div>
                        {memoryStatus?.chatId && (
                          <div className="text-[10px] text-[#6272a4]/80 font-mono truncate">
                            {memoryStatus.chatId}
                          </div>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleMemoryToggle(!memoryEnabled)}
                      disabled={memorySaving}
                      className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-colors disabled:opacity-40 ${
                        memoryEnabled
                          ? 'bg-[#50fa7b] hover:bg-[#50fa7b]/90 text-[#282a36]'
                          : 'border border-[#44475a] bg-[#282a36] text-[#6272a4] hover:text-[#f8f8f2]'
                      }`}
                    >
                      {memorySaving ? <Loader2 className="w-3 h-3 animate-spin" /> : memoryEnabled ? 'Enabled' : 'Disabled'}
                    </button>
                  </div>

                  {memoryMsg && (
                    <div className={`p-2.5 rounded-xl border text-[11px] ${memoryMsg.ok ? 'border-[#50fa7b]/40 bg-[#50fa7b]/10 text-[#50fa7b]' : 'border-[#ff5555]/40 bg-[#ff5555]/10 text-[#ff5555]'}`}>
                      {memoryMsg.text}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => memoryFileRef.current?.click()}
                      className="px-3 py-1.5 rounded-lg border border-[#8be9fd]/50 bg-[#8be9fd]/10 text-[#8be9fd] text-[11px] font-semibold hover:bg-[#8be9fd]/20 transition-colors flex items-center gap-1.5"
                    >
                      <FileJson className="w-3.5 h-3.5" />
                      Select plugin file
                    </button>
                    {(memoryStatus?.builtins || []).map((builtin) => (
                      <button
                        key={builtin.id}
                        type="button"
                        onClick={() => handleLoadBuiltinMemory(builtin.id)}
                        className="px-3 py-1.5 rounded-lg border border-[#bd93f9]/50 bg-[#bd93f9]/10 text-[#bd93f9] text-[11px] font-semibold hover:bg-[#bd93f9]/20 transition-colors flex items-center gap-1.5"
                      >
                        <Plug className="w-3.5 h-3.5" />
                        Use {builtin.name}
                      </button>
                    ))}
                    <input
                      ref={memoryFileRef}
                      type="file"
                      accept=".json,application/json"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void handleMemoryPluginFile(file);
                        e.target.value = '';
                      }}
                    />
                  </div>

                  {memoryManifest ? (
                    <div className="p-3 rounded-xl border border-[#6272a4]/50 bg-[#21222c] space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-[11px] font-bold text-[#f8f8f2]">
                          {memoryManifest.name}
                          {memoryManifest.version ? <span className="ml-1.5 text-[10px] font-normal text-[#6272a4]">v{memoryManifest.version}</span> : null}
                        </div>
                        {memoryFileName && (
                          <span className="text-[10px] text-[#6272a4] font-mono truncate max-w-[55%]">{memoryFileName}</span>
                        )}
                      </div>
                      {memoryManifest.description && (
                        <p className="text-[10px] text-[#6272a4] leading-relaxed">{memoryManifest.description}</p>
                      )}

                      <label className="text-[10px] font-semibold uppercase tracking-wider text-[#8be9fd] block pt-1">
                        Base URL
                      </label>
                      <input
                        type="text"
                        value={memoryBaseUrl}
                        onChange={(e) => setMemoryBaseUrl(e.target.value)}
                        placeholder={memoryManifest.baseUrl || 'https://api.example.com'}
                        className="w-full px-2.5 py-1.5 rounded-lg border border-[#44475a] bg-[#282a36] text-[11px] text-[#f8f8f2] placeholder-[#6272a4]/60 outline-none focus:border-[#bd93f9]/60 font-mono"
                      />

                      {memoryNeedsKey && (
                        <>
                          <label className="text-[10px] font-semibold uppercase tracking-wider text-[#8be9fd] block pt-1">
                            API key
                          </label>
                          <input
                            type="password"
                            value={memoryApiKey}
                            onChange={(e) => setMemoryApiKey(e.target.value)}
                            placeholder={memoryStatus?.hasApiKey ? '•••••••• (saved — leave empty to keep)' : 'Paste the plugin API key'}
                            autoComplete="off"
                            autoCorrect="off"
                            spellCheck={false}
                            className="w-full px-2.5 py-1.5 rounded-lg border border-[#44475a] bg-[#282a36] text-[11px] text-[#f8f8f2] placeholder-[#6272a4]/60 outline-none focus:border-[#bd93f9]/60 font-mono"
                          />
                        </>
                      )}

                      <label className="text-[10px] font-semibold uppercase tracking-wider text-[#8be9fd] block pt-1">
                        Memories to fetch (max_memories)
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={20}
                        value={memoryMaxMemories}
                        onChange={(e) => setMemoryMaxMemories(e.target.value)}
                        placeholder="8"
                        className="w-full px-2.5 py-1.5 rounded-lg border border-[#44475a] bg-[#282a36] text-[11px] text-[#f8f8f2] placeholder-[#6272a4]/60 outline-none focus:border-[#bd93f9]/60 font-mono"
                      />
                      <p className="text-[9px] text-[#6272a4] leading-relaxed">
                        Number of memories retrieved per reply (recommended: 1-20).
                      </p>
                      <label className="text-[10px] font-semibold uppercase tracking-wider text-[#8be9fd] block pt-1">
                        Seren memory ID (chat_id)
                      </label>
                      <input
                        type="text"
                        value={memoryChatId}
                        onChange={(e) => setMemoryChatId(e.target.value)}
                        placeholder="Seren will create a dedicated ID automatically"
                        className="w-full px-2.5 py-1.5 rounded-lg border border-[#44475a] bg-[#282a36] text-[11px] text-[#f8f8f2] placeholder-[#6272a4]/60 outline-none focus:border-[#bd93f9]/60 font-mono"
                      />
                      <p className="text-[10px] text-[#6272a4] leading-relaxed">
                        This dedicated ID keeps Seren's memories separate from every other profile using the same
                        API key.
                      </p>
                      {memoryStatus && !memoryStatus.initialSyncDone && (
                        <p className="text-[10px] text-[#ffb86c] leading-relaxed">
                          Found {casualHistoryCount} Casual Chat messages. The first successful test will sync them to the plugin. This can take a minute for long chats.
                        </p>
                      )}
                      {memoryStatus?.initialSyncDone && (
                        <p className="text-[10px] text-[#50fa7b] leading-relaxed">
                          Existing Casual Chat history has already been synced.
                        </p>
                      )}

                      {memoryPluginFields.map((field) => (
                        <div key={field.key}>
                          <label className="text-[10px] font-semibold uppercase tracking-wider text-[#8be9fd] block pt-1">
                            {field.label}
                            {field.required ? ' *' : ''}
                          </label>
                          <input
                            type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
                            value={memoryOptions[field.key] || ''}
                            onChange={(e) => setMemoryOptions((prev) => ({ ...prev, [field.key]: e.target.value }))}
                            placeholder={field.placeholder || ''}
                            autoComplete="off"
                            autoCorrect="off"
                            spellCheck={false}
                            className="w-full px-2.5 py-1.5 rounded-lg border border-[#44475a] bg-[#282a36] text-[11px] text-[#f8f8f2] placeholder-[#6272a4]/60 outline-none focus:border-[#bd93f9]/60 font-mono"
                          />
                          {field.help && (
                            <p className="text-[10px] text-[#6272a4] leading-relaxed mt-1">{field.help}</p>
                          )}
                        </div>
                      ))}

                      <div className="flex items-center gap-2 pt-1">
                        <button
                          type="button"
                          disabled={memorySaving}
                          onClick={() => void handleSaveMemory().catch(() => {})}
                          className="px-3 py-1.5 rounded-lg bg-[#50fa7b] hover:bg-[#50fa7b]/90 text-[#282a36] text-[11px] font-bold transition-colors flex items-center gap-1.5 disabled:opacity-40"
                        >
                          {memorySaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                          Save
                        </button>
                        <button
                          type="button"
                          disabled={memoryTesting}
                          onClick={() => void handleTestMemory()}
                          className="px-3 py-1.5 rounded-lg border border-[#8be9fd]/50 bg-[#8be9fd]/10 text-[#8be9fd] text-[11px] font-semibold hover:bg-[#8be9fd]/20 transition-colors flex items-center gap-1.5 disabled:opacity-40"
                        >
                          {memoryTesting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                          Test connection
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-[10px] text-[#6272a4] leading-relaxed">
                      No plugin loaded yet. Select a <span className="font-mono text-[#8be9fd]">.json</span> memory
                      plugin file, or load the bundled ChatSorter plugin above.
                    </p>
                  )}
                    </div>
                  )}
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
                        {serverTtsOnline === null ? 'Checking availability…' : serverTtsOnline ? 'Online — Google neural voices' : 'Offline — will use browser voice'}
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


                </div>
              </section>

              {/* TTS Providers */}
              <section>
                <h3 className="text-xs font-bold uppercase tracking-widest text-[#8be9fd] mb-3">TTS Providers</h3>
                <div className="p-4 rounded-2xl border border-[#44475a] bg-[#21222c] space-y-3">
                  <p className="text-[10px] text-[#6272a4] leading-relaxed">
                    Choose how Seren speaks aloud. Google is free and instant — no setup needed. Azure and Amazon Polly require API keys.
                  </p>
                  <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
                    {[
                      { key: 'google', label: 'Google TTS', description: 'Free, instant, no setup required. Get voices: built-in.' },
                      { key: 'azure', label: 'Microsoft Azure', description: 'Get API key & region: Azure Portal → Create Speech resource → Keys & Endpoint ', url: 'https://portal.azure.com' },
                      { key: 'polly', label: 'Amazon Polly', description: 'Get AWS access key & secret: AWS Console → IAM → Users → Security credentials ', url: 'https://console.aws.amazon.com/iam' },
                    ].map((p) => {
                      const active = ttsProvider === p.key;
                      const statusColor = p.key === 'google' ? '#50fa7b' : p.key === 'azure' ? (azureKey ? '#50fa7b' : '#ffb86c') : (pollyAccessKey && pollySecretKey ? '#50fa7b' : '#ffb86c');
                      const icon = p.key === 'google' ? <Globe className="w-4 h-4 text-[#8be9fd]" /> : p.key === 'azure' ? <Server className="w-4 h-4 text-[#8be9fd]" /> : <Cloud className="w-4 h-4 text-[#8be9fd]" />;
                      const providerVoices = voices.filter((v) => {
                        if (p.key === 'google') return v.id.startsWith('google-tts-');
                        if (p.key === 'azure') return v.id.includes('Neural');
                        return !v.id.startsWith('google-tts-') && !v.id.includes('Neural');
                      });
                      const selectedVoice = selectedTtsVoice[p.key] || providerVoices[0]?.id || '';
                      return (
                        <div key={p.key} onClick={() => { void setTtsProvider(p.key); void setExpandedTtsProvider(p.key === 'google' ? '' : p.key); if (p.key === 'google') { void handleSaveTtsProvider(p.key); try { localStorage.setItem('seren_tts_provider', JSON.stringify('google')); localStorage.setItem('seren_tts_voice_google', selectedTtsVoice['google'] || 'google-tts-en-ca'); } catch {} } }} className={`p-3 rounded-2xl border cursor-pointer ${ttsProvider === p.key ? 'border-[#bd93f9]/60 bg-[#bd93f9]/10' : 'border-[#44475a] hover:border-[#6272a4]'}`}>
                          <div className="flex items-center gap-2">
                            {icon}
                            <div className="text-xs font-bold text-[#f8f8f2]">{p.label}</div>
                            <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: statusColor }} />
                            {ttsProvider === p.key && <Check className="w-3.5 h-3.5 text-[#50fa7b] ml-auto" />}
                          </div>
                          <div className="text-[10px] text-[#6272a4] mt-1 mb-2">
                            {p.description}
                            {p.url && (
                              <a
                                href={p.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[f8f8f2] underline underline-offset-2 hover:no-underline"
                              >
                                {p.url}
                              </a>
                            )}
                          </div>
                          <select
                            value={selectedTtsVoice[p.key] || providerVoices[0]?.id || ''}
                            onChange={(e) => {
                              const v = e.target.value;
                              setSelectedTtsVoice((prev) => ({ ...prev, [p.key]: v }));
                              setSelectedVoice(v);
                              serenVoice.setVoice(v);
                              // Persist to local storage so cloud-sync (Firestore) mirrors it
                              try {
                                localStorage.setItem(`seren_tts_voice_${p.key}`, v);
                                localStorage.setItem('seren_tts_provider', JSON.stringify(p.key));
                              } catch {}
                              void handleSaveTtsVoiceSelection(p.key, v);
                            }}
                            className="w-full px-2.5 py-1.5 rounded-lg border border-[#44475a] bg-[#282a36] text-xs text-[#f8f8f2] font-mono cursor-pointer"
                          >
                            {providerVoices.map((v) => (
                              <option key={v.id} value={v.id}>
                                {v.name} ({v.locale}) — {v.gender}
                              </option>
                            ))}
                          </select>
                          <div className="flex items-center gap-2 mt-2">
                            {!active && p.key !== 'google' && (
                              <button
                                type="button"
                                onClick={() => { void setTtsProvider(p.key); void setExpandedTtsProvider(p.key); }}
                                className="flex-1 px-2.5 py-1 rounded-lg border border-[#44475a] bg-[#282a36] hover:bg-[#44475a] text-[#8be9fd] text-[10px] font-semibold transition-colors flex items-center gap-1.5"
                              >
                                <Globe className="w-3 h-3" /> Configure
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                void handlePreviewVoice(selectedVoice, p.key);
                              }}
                              disabled={
                                (p.key === 'azure' && !(azureKey && azureRegion)) ||
                                (p.key === 'polly' && !(pollyAccessKey && pollySecretKey && pollyRegion))
                              }
                              className="px-2.5 py-1 rounded-lg border border-[#8be9fd]/50 bg-[#8be9fd]/10 text-[#8be9fd] text-[10px] font-semibold hover:bg-[#8be9fd]/20 transition-colors flex items-center gap-1.5 disabled:opacity-50"
                            >
                              {previewingVoice === selectedVoice ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <Play className="w-3 h-3" />
                              )}
                              Preview
                            </button>
                          </div>
                          {expandedTtsProvider === p.key && p.key !== 'google' && (
                            <div className="mt-2 space-y-2">
                              {p.key === 'azure' && (
                                <>
                                  <label className="text-[10px] font-semibold uppercase tracking-wider text-[#8be9fd] block pt-1">Azure Speech key</label>
                                  <input
                                    type="text"
                                    value={azureKey}
                                    onChange={(e) => setAzureKey(e.target.value)}
                                    placeholder="Azure Speech key"
                                    autoComplete="off"
                                    autoCorrect="off"
                                    spellCheck={false}
                                    className="w-full px-2.5 py-1.5 rounded-lg border border-[#44475a] bg-[#282a36] text-[11px] text-[#f8f8f2] placeholder-[#6272a4]/60 outline-none focus:border-[#bd93f9]/60"
                                  />
                                  <label className="text-[10px] font-semibold uppercase tracking-wider text-[#8be9fd] block pt-1">Azure region</label>
                                  <input
                                    type="text"
                                    value={azureRegion}
                                    onChange={(e) => setAzureRegion(e.target.value)}
                                    placeholder="e.g. eastus"
                                    autoComplete="off"
                                    autoCorrect="off"
                                    spellCheck={false}
                                    className="w-full px-2.5 py-1.5 rounded-lg border border-[#44475a] bg-[#282a36] text-[11px] text-[#f8f8f2] placeholder-[#6272a4]/60 outline-none focus:border-[#bd93f9]/60"
                                  />
                                </>
                              )}
                              {p.key === 'polly' && (
                                <>
                                  <label className="text-[10px] font-semibold uppercase tracking-wider text-[#8be9fd] block pt-1">AWS access key ID</label>
                                  <input
                                    type="text"
                                    value={pollyAccessKey}
                                    onChange={(e) => setPollyAccessKey(e.target.value)}
                                    placeholder="AKIA..."
                                    autoComplete="off"
                                    autoCorrect="off"
                                    spellCheck={false}
                                    className="w-full px-2.5 py-1.5 rounded-lg border border-[#44475a] bg-[#282a36] text-[11px] text-[#f8f8f2] placeholder-[#6272a4]/60 outline-none focus:border-[#bd93f9]/60"
                                  />
                                  <label className="text-[10px] font-semibold uppercase tracking-wider text-[#8be9fd] block pt-1">AWS secret access key</label>
                                  <input
                                    type="password"
                                    value={pollySecretKey}
                                    onChange={(e) => setPollySecretKey(e.target.value)}
                                    placeholder="••••••••"
                                    autoComplete="off"
                                    autoCorrect="off"
                                    spellCheck={false}
                                    className="w-full px-2.5 py-1.5 rounded-lg border border-[#44475a] bg-[#282a36] text-[11px] text-[#f8f8f2] placeholder-[#6272a4]/60 outline-none focus:border-[#bd93f9]/60"
                                  />
                                  <label className="text-[10px] font-semibold uppercase tracking-wider text-[#8be9fd] block pt-1">AWS region</label>
                                  <input
                                    type="text"
                                    value={pollyRegion}
                                    onChange={(e) => setPollyRegion(e.target.value)}
                                    placeholder="e.g. us-east-1"
                                    autoComplete="off"
                                    autoCorrect="off"
                                    spellCheck={false}
                                    className="w-full px-2.5 py-1.5 rounded-lg border border-[#44475a] bg-[#282a36] text-[11px] text-[#f8f8f2] placeholder-[#6272a4]/60 outline-none focus:border-[#bd93f9]/60"
                                  />
                                </>
                              )}
                              <div className="flex items-center gap-2 pt-1">
                                <button
                                  type="button"
                                  disabled={savingTtsFor === p.key}
                                  onClick={() => void handleSaveTtsProvider(p.key)}
                                  className="flex-1 px-3 py-1.5 rounded-lg bg-[#50fa7b] hover:bg-[#50fa7b]/90 text-[#282a36] text-[11px] font-bold transition-colors flex items-center gap-1.5 disabled:opacity-40"
                                >
                                  {savingTtsFor === p.key ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                                  Save
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setExpandedTtsProvider('')}
                                  className="px-3 py-1.5 rounded-lg border border-[#44475a] bg-[#282a36] text-[#6272a4] hover:text-[#f8f8f2] text-[11px] font-medium transition-colors"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
              </div>  
            </section>

              {/* Display size */}
              <section>
                <h3 className="text-xs font-bold uppercase tracking-widest text-[#f1fa8c] mb-3">Display Size</h3>
                <div className="p-4 rounded-2xl border border-[#44475a] bg-[#21222c]/80 space-y-3">
                  <p className="text-[11px] text-[#6272a4] leading-relaxed">
                    Choose whether to enlarge the complete interface or only its typography. Both settings are saved
                    on this device.
                  </p>
                  <div className="text-xs font-semibold text-[#f8f8f2]">Whole UI zoom</div>
                  <p className="text-[10px] text-[#6272a4] leading-relaxed">
                    Scales text, spacing, controls and images together.
                  </p>
                  <div className="flex items-center gap-2.5">
                    <button
                      type="button"
                      onClick={() => nudgeUiZoom(-UI_ZOOM_STEP)}
                      disabled={uiZoom <= MIN_UI_ZOOM}
                      title="Decrease whole UI zoom"
                      className="p-2.5 rounded-xl border border-[#44475a] bg-[#282a36] text-[#8be9fd] hover:bg-[#44475a] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <ZoomOut className="w-4 h-4" />
                    </button>
                    <div className="flex-1 text-center">
                      <div className="text-base font-bold text-[#f8f8f2]">{Math.round(uiZoom * 100)}%</div>
                      <div className="text-[10px] text-[#6272a4]">UI and images</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => nudgeUiZoom(UI_ZOOM_STEP)}
                      disabled={uiZoom >= MAX_UI_ZOOM}
                      title="Increase whole UI zoom"
                      className="p-2.5 rounded-xl border border-[#44475a] bg-[#282a36] text-[#8be9fd] hover:bg-[#44475a] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <ZoomIn className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={resetUiZoom}
                      disabled={uiZoom === DEFAULT_UI_ZOOM}
                      title="Reset whole UI zoom"
                      className="px-3 py-2.5 rounded-xl border border-[#44475a] bg-[#282a36] text-[#6272a4] hover:text-[#f8f8f2] hover:bg-[#44475a] transition-colors text-[11px] font-semibold flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Reset
                    </button>
                  </div>
                  <div className="pt-1 text-xs font-semibold text-[#f8f8f2]">Text scale</div>
                  <p className="text-[10px] text-[#6272a4] leading-relaxed">
                    Scales every text size by the same ratio while keeping spacing and images unchanged.
                  </p>
                  <div className="flex items-center gap-2.5">
                    <button
                      type="button"
                      onClick={() => nudgeTextScale(-TEXT_SCALE_STEP)}
                      disabled={textScale <= MIN_TEXT_SCALE}
                      title="Decrease text scale"
                      className="p-2.5 rounded-xl border border-[#44475a] bg-[#282a36] text-[#8be9fd] hover:bg-[#44475a] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <ZoomOut className="w-4 h-4" />
                    </button>
                    <div className="flex-1 text-center">
                      <div className="text-base font-bold text-[#f8f8f2]">{Math.round(textScale * 100)}%</div>
                      <div className="text-[10px] text-[#6272a4]">Text only</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => nudgeTextScale(TEXT_SCALE_STEP)}
                      disabled={textScale >= MAX_TEXT_SCALE}
                      title="Increase text scale"
                      className="p-2.5 rounded-xl border border-[#44475a] bg-[#282a36] text-[#8be9fd] hover:bg-[#44475a] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <ZoomIn className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={resetTextScale}
                      disabled={textScale === DEFAULT_TEXT_SCALE}
                      title="Reset text scale"
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
