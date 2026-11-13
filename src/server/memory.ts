import { randomUUID } from 'crypto';
import { fetchWithTimeout } from './llm';
import { loadStoredSettings, saveStoredSettings } from './config';

export interface MemoryPluginField {
  key: string;
  label: string;
  type?: 'text' | 'password' | 'url' | 'number';
  placeholder?: string;
  required?: boolean;
  default?: string;
  help?: string;
}

export interface MemoryPluginManifest {
  id: string;
  name: string;
  version?: string;
  description?: string;
  baseUrl?: string;
  endpoints?: {
    search?: string;
    store?: string;
    test?: string;
  };
  auth?: {
    type?: 'bearer' | 'header' | 'none';
    header?: string;
    prefix?: string;
  };
  request?: {
    chatIdField?: string;
    messageField?: string;
    queryField?: string;
    roleField?: string;
    maxMemoriesField?: string;
    extra?: Record<string, string | number | boolean>;
  };
  response?: {
    memoriesPath?: string;
    summaryField?: string;
    scoreField?: string;
  };
  fields?: MemoryPluginField[];
}

export interface MemoryPluginConfig {
  enabled: boolean;
  manifest: MemoryPluginManifest | null;
  fileName?: string;
  baseUrl: string;
  apiKey: string;
  chatId: string;
  maxMemories: number;
  options: Record<string, string>;
  initialSyncDone: boolean;
  initialSyncCursor: number;
}

export const BUILTIN_MEMORY_PLUGINS: MemoryPluginManifest[] = [
  {
    id: 'chatsorter',
    name: 'ChatSorter Memory',
    version: '1.0.0',
    description: 'Long-term memory for casual chat using the ChatSorter API.',
    baseUrl: 'https://api.chatsorter.com',
    endpoints: {
      search: '/search',
      store: '/process',
      test: '/search',
    },
    auth: {
      type: 'bearer',
      header: 'Authorization',
      prefix: 'Bearer ',
    },
    request: {
      chatIdField: 'chat_id',
      messageField: 'message',
      queryField: 'query',
      roleField: 'role',
      maxMemoriesField: 'max_memories',
      extra: {},
    },
    response: {
      memoriesPath: 'memories',
      summaryField: 'summary',
      scoreField: 'score',
    },
    fields: [],
  },
];

const FIELD_TYPES = new Set(['text', 'password', 'url', 'number']);
const RESERVED_OPTION_KEYS = new Set(['apiKey', 'chatId', 'baseUrl']);
const DEFAULT_SEARCH_ENDPOINT = '/search';
const DEFAULT_STORE_ENDPOINT = '/process';
const MEMORY_SEARCH_TIMEOUT_MS = 60000;
const MEMORY_STORE_TIMEOUT_MS = 180000;
const MEMORY_TEST_TIMEOUT_MS = 240000;
const DEFAULT_MAX_MEMORIES = 8;
const MIN_MAX_MEMORIES = 1;
const MAX_MAX_MEMORIES = 20;

function text(value: any, max = 500): string {
  if (value == null) return '';
  return String(value).trim().slice(0, max);
}

function rawText(value: any, max = 500): string {
  if (value == null) return '';
  return String(value).slice(0, max);
}

function validHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function plainRecord(raw: any): Record<string, string | number | boolean> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(key)) continue;
    if (typeof value === 'string') out[key] = value.slice(0, 2000);
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  return out;
}

function stringRecord(raw: any): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(key)) continue;
    if (value == null) continue;
    out[key] = text(value, 2000);
  }
  return out;
}

function normalizeField(raw: any): MemoryPluginField | null {
  if (!raw || typeof raw !== 'object') return null;
  const key = text(raw.key, 80);
  if (!key || RESERVED_OPTION_KEYS.has(key) || !/^[A-Za-z0-9_.-]{1,80}$/.test(key)) return null;
  const rawType = text(raw.type, 20).toLowerCase();
  return {
    key,
    label: text(raw.label, 120) || key,
    type: FIELD_TYPES.has(rawType) ? (rawType as MemoryPluginField['type']) : 'text',
    placeholder: text(raw.placeholder, 200) || undefined,
    required: raw.required === true,
    default: text(raw.default, 200) || undefined,
    help: text(raw.help, 300) || undefined,
  };
}

export function normalizeMemoryManifest(raw: any): MemoryPluginManifest {
  let value = raw;
  if (typeof value === 'string') value = JSON.parse(value);
  if (value && typeof value === 'object' && !Array.isArray(value) && value.plugin && typeof value.plugin === 'object') {
    value = value.plugin;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Memory plugin file must be a JSON object.');
  }

  const name = text(value.name, 120);
  const id = text(value.id, 80) || name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!id) throw new Error('Memory plugin file needs an "id" or "name".');
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(id)) {
    throw new Error('Memory plugin "id" may only contain letters, numbers, dots, dashes and underscores.');
  }
  if (!name) throw new Error('Memory plugin file needs a "name".');

  const baseUrl = text(value.baseUrl, 500);
  if (baseUrl && !validHttpUrl(baseUrl)) {
    throw new Error('Memory plugin "baseUrl" must start with http:// or https://.');
  }

  const endpointsRaw = value.endpoints && typeof value.endpoints === 'object' ? value.endpoints : {};
  const endpoint = (key: string, fallback?: string): string | undefined => {
    const rawEndpoint = text((endpointsRaw as any)[key], 300);
    if (!rawEndpoint) return fallback;
    if (!rawEndpoint.startsWith('/')) throw new Error(`Memory plugin endpoint "${key}" must start with "/".`);
    return rawEndpoint;
  };

  const authRaw = value.auth && typeof value.auth === 'object' ? value.auth : {};
  const rawAuthType = text(authRaw.type, 20).toLowerCase();
  const authType = rawAuthType === 'header' || rawAuthType === 'none' ? rawAuthType : 'bearer';
  const authHeader = text(authRaw.header, 80) || 'Authorization';
  const authPrefix = authRaw.prefix !== undefined ? rawText(authRaw.prefix, 40) : authType === 'bearer' ? 'Bearer ' : '';

  const requestRaw = value.request && typeof value.request === 'object' ? value.request : {};
  const chatIdField = text(requestRaw.chatIdField, 80) || 'chat_id';
  const messageField = text(requestRaw.messageField, 80) || 'message';
  const queryField = text(requestRaw.queryField, 80) || 'query';
  const roleField = text(requestRaw.roleField, 80) || undefined;
  const maxMemoriesField = text(requestRaw.maxMemoriesField, 80) || undefined;

  const responseRaw = value.response && typeof value.response === 'object' ? value.response : {};
  const fields = Array.isArray(value.fields)
    ? value.fields.map(normalizeField).filter((field: MemoryPluginField | null): field is MemoryPluginField => Boolean(field))
    : [];

  return {
    id,
    name,
    version: text(value.version, 40) || undefined,
    description: text(value.description, 500) || undefined,
    baseUrl: baseUrl || undefined,
    endpoints: {
      search: endpoint('search', DEFAULT_SEARCH_ENDPOINT),
      store: endpoint('store', DEFAULT_STORE_ENDPOINT),
      test: endpoint('test'),
    },
    auth: {
      type: authType,
      header: authHeader,
      prefix: authPrefix,
    },
    request: {
      chatIdField,
      messageField,
      queryField,
      roleField,
      maxMemoriesField,
      extra: plainRecord(requestRaw.extra),
    },
    response: {
      memoriesPath: text(responseRaw.memoriesPath, 160) || 'memories',
      summaryField: text(responseRaw.summaryField, 80) || 'summary',
      scoreField: text(responseRaw.scoreField, 80) || 'score',
    },
    fields,
  };
}

export function parseMemoryPluginFile(content: string): MemoryPluginManifest {
  return normalizeMemoryManifest(content);
}

function defaultConfig(): MemoryPluginConfig {
  return {
    enabled: false,
    manifest: null,
    fileName: undefined,
    baseUrl: '',
    apiKey: '',
    chatId: '',
    maxMemories: DEFAULT_MAX_MEMORIES,
    options: {},
    initialSyncDone: false,
    initialSyncCursor: 0,
  };
}

function normalizeMaxMemories(value: any): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_MAX_MEMORIES;
  return Math.max(MIN_MAX_MEMORIES, Math.min(MAX_MAX_MEMORIES, Math.floor(number)));
}

function generateSerenChatId(): string {
  return `seren-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

function ensureConfigChatId(config: MemoryPluginConfig): MemoryPluginConfig {
  if (!config.chatId.trim()) config.chatId = generateSerenChatId();
  return config;
}

function persistMemoryConfig(config: MemoryPluginConfig): void {
  const stored = loadStoredSettings();
  saveStoredSettings({ ...stored, memory: config });
  memoryConfig = config;
}

function memoryTarget(config: MemoryPluginConfig): string {
  return [
    effectiveBaseUrl(config),
    config.apiKey,
    config.chatId,
    config.manifest?.id || '',
  ].join('\u0000');
}

export function normalizeMemoryConfig(raw: any): MemoryPluginConfig {
  const base = defaultConfig();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  let manifest: MemoryPluginManifest | null = null;
  if (raw.manifest) {
    try {
      manifest = normalizeMemoryManifest(raw.manifest);
    } catch {
      manifest = null;
    }
  }
  return {
    enabled: raw.enabled === true,
    manifest,
    fileName: text(raw.fileName, 300) || undefined,
    baseUrl: text(raw.baseUrl, 500).replace(/\/+$/, ''),
    apiKey: text(raw.apiKey, 2000),
    chatId: text(raw.chatId, 200),
    maxMemories: normalizeMaxMemories(raw.maxMemories),
    options: stringRecord(raw.options),
    initialSyncDone: raw.initialSyncDone === true,
    initialSyncCursor: Number(raw.initialSyncCursor) || 0,
  };
}

let memoryConfig: MemoryPluginConfig = normalizeMemoryConfig(loadStoredSettings().memory);
let initialSyncActive = false;

function ensureRuntimeChatId(): void {
  if (memoryConfig.chatId.trim()) return;
  memoryConfig = { ...memoryConfig, chatId: generateSerenChatId() };
  persistMemoryConfig(memoryConfig);
}

export function getMemoryConfig(): MemoryPluginConfig {
  return { ...memoryConfig, options: { ...memoryConfig.options } };
}

export function saveMemoryConfig(input: any): MemoryPluginConfig {
  const previousTarget = memoryTarget(memoryConfig);
  const next: MemoryPluginConfig = { ...memoryConfig, options: { ...memoryConfig.options } };
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    if ('enabled' in input) next.enabled = input.enabled === true;
    if ('manifest' in input) {
      next.manifest = input.manifest == null || input.manifest === ''
        ? null
        : normalizeMemoryManifest(input.manifest);
    }
    if ('fileName' in input) next.fileName = text(input.fileName, 300) || undefined;
    if ('baseUrl' in input) {
      const value = text(input.baseUrl, 500).replace(/\/+$/, '');
      if (value && !validHttpUrl(value)) {
        throw new Error('Memory plugin base URL must start with http:// or https://.');
      }
      next.baseUrl = value;
    }
    if ('chatId' in input) {
      const value = text(input.chatId, 200);
      next.chatId = value || memoryConfig.chatId || generateSerenChatId();
    }
    if ('maxMemories' in input) next.maxMemories = normalizeMaxMemories(input.maxMemories);
    if ('apiKey' in input) {
      const value = text(input.apiKey, 2000);
      if (value || input.clearApiKey === true) next.apiKey = value;
    }
    if ('options' in input) next.options = stringRecord(input.options);
  }
  ensureConfigChatId(next);
  if (memoryTarget(next) !== previousTarget) {
    next.initialSyncDone = false;
    next.initialSyncCursor = 0;
  }

  persistMemoryConfig(next);
  return { ...next, options: { ...next.options } };
}

export function resetMemoryConfig(): void {
  memoryConfig = defaultConfig();
}

function effectiveBaseUrl(config: MemoryPluginConfig): string {
  return (config.baseUrl || config.manifest?.baseUrl || '').replace(/\/+$/, '');
}

function resolveChatId(config: MemoryPluginConfig): string {
  return ensureConfigChatId(config).chatId.trim();
}

function authHeaders(manifest: MemoryPluginManifest, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const authType = manifest.auth?.type || 'bearer';
  if (authType === 'none') return headers;
  const header = manifest.auth?.header || 'Authorization';
  const prefix = manifest.auth?.prefix ?? (authType === 'bearer' ? 'Bearer ' : '');
  const needsSpace = authType === 'bearer' && prefix && !/\s$/.test(prefix);
  headers[header] = `${prefix}${needsSpace ? ' ' : ''}${apiKey}`.trim();
  return headers;
}

function valueByPath(value: any, path: string): any {
  if (!path) return undefined;
  return path.split('.').reduce((acc: any, part: string) => {
    if (acc && typeof acc === 'object') return acc[part];
    return undefined;
  }, value);
}

function extractMemories(json: any, manifest: MemoryPluginManifest, limit = DEFAULT_MAX_MEMORIES): string[] {
  const memoriesPath = manifest.response?.memoriesPath || 'memories';
  let items = valueByPath(json, memoriesPath);
  if (!Array.isArray(items)) {
    if (Array.isArray(json)) items = json;
    else if (Array.isArray(json?.data)) items = json.data;
    else if (Array.isArray(json?.data?.memories)) items = json.data.memories;
    else if (Array.isArray(json?.results)) items = json.results;
    else items = [];
  }

  const summaryField = manifest.response?.summaryField || 'summary';
  const maxItems = normalizeMaxMemories(limit);
  const memories: string[] = [];
  for (const item of items) {
    let summary = '';
    if (typeof item === 'string') {
      summary = item;
    } else if (item && typeof item === 'object') {
      summary = text(
        valueByPath(item, summaryField) ??
          item.summary ??
          item.text ??
          item.content ??
          item.value ??
          item.memory,
        500
      );
    }
    summary = summary.replace(/\s+/g, ' ').trim();
    if (summary && !memories.includes(summary)) memories.push(summary);
    if (memories.length >= maxItems) break;
  }
  return memories;
}

function configFromInput(input: any): MemoryPluginConfig {
  const config: MemoryPluginConfig = { ...memoryConfig, options: { ...memoryConfig.options } };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return config;

  if ('manifest' in input) {
    config.manifest = input.manifest == null || input.manifest === ''
      ? null
      : normalizeMemoryManifest(input.manifest);
  }
  if ('baseUrl' in input) {
    const value = text(input.baseUrl, 500).replace(/\/+$/, '');
    if (value && !validHttpUrl(value)) {
      throw new Error('Memory plugin base URL must start with http:// or https://.');
    }
    config.baseUrl = value;
  }
  if ('apiKey' in input) {
    const value = text(input.apiKey, 2000);
    if (value || input.clearApiKey === true) config.apiKey = value;
  }
  if ('chatId' in input) config.chatId = text(input.chatId, 200) || config.chatId;
  if ('maxMemories' in input) config.maxMemories = normalizeMaxMemories(input.maxMemories);
  if ('options' in input) config.options = stringRecord(input.options);
  if (memoryTarget(config) !== memoryTarget(memoryConfig)) {
    config.initialSyncDone = false;
    config.initialSyncCursor = 0;
  }
  return config;
}

export function memoryStatus() {
  ensureRuntimeChatId();
  const config = memoryConfig;
  const manifest = config.manifest;
  const baseUrl = effectiveBaseUrl(config);
  const needsKey = Boolean(manifest) && (manifest?.auth?.type || 'bearer') !== 'none';
  const ready = Boolean(config.enabled && manifest && baseUrl && (!needsKey || config.apiKey));

  return {
    enabled: config.enabled,
    ready,
    baseUrl,
    chatId: config.chatId,
    maxMemories: config.maxMemories,
    hasApiKey: Boolean(config.apiKey),
    needsKey,
    fileName: config.fileName || null,
    plugin: manifest ? { ...manifest } : null,
    options: { ...config.options },
    initialSyncDone: config.initialSyncDone === true,
    builtins: BUILTIN_MEMORY_PLUGINS.map((plugin) => ({ ...plugin })),
  };
}

export async function retrieveMemories(query: string, _userProfile?: any): Promise<string[]> {
  const config = memoryConfig;
  const manifest = config.manifest;
  if (!config.enabled || !manifest || !query.trim()) return [];
  if ((manifest.auth?.type || 'bearer') !== 'none' && !config.apiKey) return [];
  const baseUrl = effectiveBaseUrl(config);
  if (!baseUrl) return [];
  ensureRuntimeChatId();

  const endpoint = manifest.endpoints?.search || DEFAULT_SEARCH_ENDPOINT;
  const chatId = resolveChatId(config);
  const maxMemoriesField = manifest.request?.maxMemoriesField;
  const body = {
    ...(manifest.request?.extra || {}),
    ...config.options,
    [manifest.request?.chatIdField || 'chat_id']: chatId,
    [manifest.request?.queryField || 'query']: query.trim(),
    ...(maxMemoriesField ? { [maxMemoriesField]: config.maxMemories } : {}),
  };

  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${baseUrl}${endpoint}`,
      {
        method: 'POST',
        headers: authHeaders(manifest, config.apiKey),
        body: JSON.stringify(body),
      },
      MEMORY_SEARCH_TIMEOUT_MS
    );
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error(`Memory search timed out after ${MEMORY_SEARCH_TIMEOUT_MS / 1000}s.`);
    }
    throw err;
  }
  const raw = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`Memory search failed (HTTP ${res.status}): ${raw.slice(0, 200)}`);
  }
  if (!raw.trim()) return [];
  try {
    return extractMemories(JSON.parse(raw), manifest, config.maxMemories);
  } catch {
    return [];
  }
}

async function storeMessageWithConfig(
  config: MemoryPluginConfig,
  message: string,
  role?: 'user' | 'assistant'
): Promise<boolean> {
  const manifest = config.manifest;
  if (!manifest || !message.trim()) return false;
  if ((manifest.auth?.type || 'bearer') !== 'none' && !config.apiKey) return false;
  const baseUrl = effectiveBaseUrl(config);
  if (!baseUrl) return false;

  const endpoint = manifest.endpoints?.store;
  if (!endpoint) return false;
  const chatId = resolveChatId(config);
  const roleField = manifest.request?.roleField;
  const body = {
    ...(manifest.request?.extra || {}),
    ...config.options,
    [manifest.request?.chatIdField || 'chat_id']: chatId,
    [manifest.request?.messageField || 'message']: message.trim(),
    ...(roleField && role ? { [roleField]: role } : {}),
  };

  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${baseUrl}${endpoint}`,
      {
        method: 'POST',
        headers: authHeaders(manifest, config.apiKey),
        body: JSON.stringify(body),
      },
      MEMORY_STORE_TIMEOUT_MS
    );
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error(`Memory store timed out after ${MEMORY_STORE_TIMEOUT_MS / 1000}s.`);
    }
    throw err;
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw new Error(`Memory store failed (HTTP ${res.status}): ${raw.slice(0, 200)}`);
  }
  return true;
}

export async function storeMemory(
  message: string,
  _userProfile?: any,
  role: 'user' | 'assistant' = 'user'
): Promise<void> {
  const config = memoryConfig;
  if (!config.enabled) return;
  ensureRuntimeChatId();
  await storeMessageWithConfig(config, message, role);
}

export function buildMemoryPromptBlock(memories: string[]): string {
  if (!memories.length) return '';
  return memories.map((memory, index) => `${index + 1}. ${memory}`).join('\n');
}

interface InitialMemoryMessage {
  text: string;
  timestamp: number;
  role: 'user' | 'assistant';
}

function sanitizeInitialMessages(raw: any): InitialMemoryMessage[] {
  if (!Array.isArray(raw)) return [];
  const messages: InitialMemoryMessage[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const body = text(item, 2000);
      if (body) messages.push({ text: body, timestamp: 0, role: 'user' });
    } else if (item && typeof item === 'object') {
      const sender = text(item.sender, 20).toLowerCase();
      const role = sender === 'seren' || sender === 'assistant' ? 'assistant' : 'user';
      const body = text(item.text ?? item.message, 2000);
      if (body) messages.push({ text: body, timestamp: Number(item.timestamp) || 0, role });
    }
  }
  return messages.sort((a, b) => a.timestamp - b.timestamp);
}

async function syncInitialHistory(
  config: MemoryPluginConfig,
  messages: InitialMemoryMessage[]
): Promise<{ sent: number; pending: number; completed: boolean; error?: string }> {
  const pending = messages.filter((message) => message.timestamp > config.initialSyncCursor);
  let sent = 0;
  for (const message of pending) {
    if (memoryTarget(config) !== memoryTarget(memoryConfig)) {
      return { sent, pending: pending.length, completed: false, error: 'Memory settings changed during history sync.' };
    }
    try {
      if (!(await storeMessageWithConfig(config, message.text, message.role))) {
        return { sent, pending: pending.length, completed: false, error: 'The plugin did not store every message.' };
      }
    } catch (err: any) {
      return {
        sent,
        pending: pending.length,
        completed: false,
        error: err?.message || 'Could not sync the casual chat history.',
      };
    }
    sent += 1;
    config.initialSyncCursor = message.timestamp;
    if (memoryTarget(config) === memoryTarget(memoryConfig)) {
      memoryConfig = { ...memoryConfig, initialSyncCursor: config.initialSyncCursor };
      persistMemoryConfig(memoryConfig);
    }
  }
  return { sent, pending: pending.length, completed: true };
}

export async function testMemoryConnection(input: any = {}): Promise<{
  ok: true;
  status: number;
  memories: number;
  message: string;
  initialSync: { attempted: number; sent: number; error?: string };
  memory: ReturnType<typeof memoryStatus>;
}> {
  const config = ensureConfigChatId(configFromInput(input));
  const manifest = config.manifest;
  if (!manifest) throw new Error('Choose a memory plugin file first.');
  const baseUrl = effectiveBaseUrl(config);
  if (!baseUrl) throw new Error('Memory plugin base URL is missing.');
  if ((manifest.auth?.type || 'bearer') !== 'none' && !config.apiKey) {
    throw new Error('This memory plugin requires an API key.');
  }

  const endpoint = manifest.endpoints?.test || manifest.endpoints?.search || DEFAULT_SEARCH_ENDPOINT;
  const chatId = resolveChatId(config);
  const maxMemoriesField = manifest.request?.maxMemoriesField;
  const body = {
    ...(manifest.request?.extra || {}),
    ...config.options,
    [manifest.request?.chatIdField || 'chat_id']: chatId,
    [manifest.request?.queryField || 'query']: 'connection test',
    ...(maxMemoriesField ? { [maxMemoriesField]: config.maxMemories } : {}),
  };

  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${baseUrl}${endpoint}`,
      {
        method: 'POST',
        headers: authHeaders(manifest, config.apiKey),
        body: JSON.stringify(body),
      },
      MEMORY_TEST_TIMEOUT_MS
    );
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error(`Memory plugin test timed out after ${MEMORY_TEST_TIMEOUT_MS / 1000}s.`);
    }
    throw err;
  }
  const raw = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`Memory plugin rejected the test (HTTP ${res.status}): ${raw.slice(0, 240)}`);
  }

  let json: any = {};
  if (raw.trim()) {
    try {
      json = JSON.parse(raw);
    } catch {
      json = {};
    }
  }

  persistMemoryConfig(config);

  const initialMessages = sanitizeInitialMessages(input?.initialMessages);
  const initialSync: { attempted: number; sent: number; error?: string } = {
    attempted: 0,
    sent: 0,
  };
  if (!memoryConfig.initialSyncDone && initialMessages.length > 0) {
    initialSync.attempted = initialMessages.filter(
      (message) => message.timestamp > memoryConfig.initialSyncCursor
    ).length;
    if (initialSyncActive) {
      initialSync.error = 'History sync is already in progress.';
    } else {
      initialSyncActive = true;
      try {
        const result = await syncInitialHistory(config, initialMessages);
        initialSync.attempted = result.pending;
        initialSync.sent = result.sent;
        if (result.completed) {
          if (memoryTarget(config) === memoryTarget(memoryConfig)) {
            memoryConfig = { ...memoryConfig, initialSyncDone: true, initialSyncCursor: 0 };
            persistMemoryConfig(memoryConfig);
          }
        } else {
          initialSync.error = result.error || 'The plugin did not store every message.';
        }
      } catch (err: any) {
        initialSync.error = err?.message || 'Could not sync the casual chat history.';
      } finally {
        initialSyncActive = false;
      }
    }
  }

  return {
    ok: true,
    status: res.status,
    memories: extractMemories(json, manifest, config.maxMemories).length,
    message: 'Memory plugin responded successfully.',
    initialSync,
    memory: memoryStatus(),
  };
}
