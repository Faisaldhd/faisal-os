/**
 * The AI providers Faisal AI can talk to. Everything that differs between them lives
 * here: the OpenAI-compatible API base, the localStorage keys, the model lists, and the
 * capability rules the UI has to be honest about. The client (chat.ts) and the UI
 * (index.ts) only read this table; neither hardcodes a host.
 */

/** Provider name in both languages; Arabic is the default locale. */
export interface ProviderLabel { ar: string; en: string }

export interface Provider {
  /** Stable id, also the value stored in `faisal.ai.provider`. */
  id: string;
  label: ProviderLabel;
  /** OpenAI-compatible API base, without a trailing slash. */
  apiBase: string;
  /** Host shown to the user (key screen and its privacy note). */
  host: string;
  /** Where the user creates a key; opened in a new tab. */
  keyUrl: string;
  /** Format hint for the key input. Not translated: it is a literal prefix. */
  keyPlaceholder: string;
  /** i18n key of the sentence that describes this provider on its key screen. */
  setupBodyKey: string;
  /** One saved key and one chosen model per provider, so switching never loses the other. */
  keyStorage: string;
  modelStorage: string;
  /** Best models first, for ordering the picker. */
  preferredModels: string[];
  /** Shown when the account's model list cannot be fetched. */
  fallbackModels: string[];
  /** True when the model searches the web on the provider's own servers and reports sources. */
  serverSideSearch: boolean;
  /** Models that get that server-side web search. */
  searchModels?: RegExp;
  /** Models that reject the app's custom function-calling tools. */
  noCustomTools?: RegExp;
  /**
   * True when this provider's thinking mode makes the previous assistant turns'
   * `reasoning_content` mandatory on every follow-up request that carries `tools`.
   * DeepSeek: "Thinking mode is enabled by default, with the default effort being `high`"
   * and "for requests carrying the `tools` parameter, the `reasoning_content` must be
   * fully passed back to the API in all subsequent requests — even for turns where the
   * model did not perform a tool call. If your code does not correctly pass back
   * `reasoning_content`, the API will return a 400 error."
   * (https://api-docs.deepseek.com/guides/thinking_mode). Groq never sends the field, so
   * absent/false there — and its request bodies must stay byte-identical.
   */
  echoesReasoning?: boolean;
}

/**
 * GroqCloud. The storage keys are unchanged from the app's Groq-only versions, so an
 * existing user keeps the key and model they already saved.
 * `groq/compound*` searches the web on Groq's servers and cannot take custom tools.
 */
const groq: Provider = {
  id: 'groq',
  label: { ar: 'GroqCloud', en: 'GroqCloud' },
  apiBase: 'https://api.groq.com/openai/v1',
  host: 'api.groq.com',
  keyUrl: 'https://console.groq.com/keys',
  keyPlaceholder: 'gsk_…',
  setupBodyKey: 'ai.setupBody',
  keyStorage: 'faisal.groq.apiKey',
  modelStorage: 'faisal.groq.model',
  preferredModels: ['groq/compound', 'groq/compound-mini', 'openai/gpt-oss-120b', 'llama-3.3-70b-versatile'],
  fallbackModels: ['groq/compound', 'groq/compound-mini', 'llama-3.3-70b-versatile'],
  serverSideSearch: true,
  searchModels: /^groq\/compound/,
  noCustomTools: /^groq\/compound/,
};

/**
 * DeepSeek. The documented OpenAI-compatible base has no `/v1` suffix
 * (https://api-docs.deepseek.com/): the docs' table says `base_url (OpenAI) =
 * https://api.deepseek.com` and their curl example posts to
 * https://api.deepseek.com/chat/completions, with GET /models documented in the API
 * reference. So the client builds https://api.deepseek.com/models and
 * https://api.deepseek.com/chat/completions. The model ids below are only the fallback:
 * when GET /models works, the picker shows exactly what the key can use.
 *
 * DeepSeek answers from its own knowledge only — it has no server-side web search — and
 * function calling works on both models (thinking mode included since V3.2), so no
 * custom-tool restriction applies here.
 */
const deepseek: Provider = {
  id: 'deepseek',
  label: { ar: 'DeepSeek', en: 'DeepSeek' },
  apiBase: 'https://api.deepseek.com',
  host: 'api.deepseek.com',
  keyUrl: 'https://platform.deepseek.com/api_keys',
  keyPlaceholder: 'sk-…',
  setupBodyKey: 'ai.setupBodyDeepseek',
  keyStorage: 'faisal.deepseek.apiKey',
  modelStorage: 'faisal.deepseek.model',
  preferredModels: ['deepseek-flash', 'deepseek-v4-pro'],
  fallbackModels: ['deepseek-flash', 'deepseek-v4-pro'],
  serverSideSearch: false,
  // Thinking mode is on by default, so every DeepSeek turn may produce
  // `reasoning_content`, and with `tools` in the body the API demands it back.
  echoesReasoning: true,
};

/** Every provider the app offers, default first. */
export const PROVIDERS: readonly Provider[] = [groq, deepseek];
export const DEFAULT_PROVIDER = 'groq';
/** Remembers which provider the user picked, across app launches. */
export const PROVIDER_STORAGE = 'faisal.ai.provider';
/** Keys saved by the app's obsolete Claude and Gemini versions; removed on launch. */
export const LEGACY_STORAGE_KEYS = ['faisal.claude.apiKey', 'faisal.gemini.apiKey'];

/** Pure: an unknown, missing or garbled id resolves to the default provider, never throws. */
export function providerById(id: string | null | undefined): Provider {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS.find((p) => p.id === DEFAULT_PROVIDER)!;
}

/** The part of localStorage this module needs; narrow so tests can fake it. */
export interface StorageLike { getItem(key: string): string | null }

/** Reads one stored value; '' when nothing is stored or the browser blocks storage. */
function stored(store: StorageLike | null | undefined, key: string): string {
  try { return store?.getItem(key) ?? ''; } catch { return ''; }
}

/** The key this provider's user saved — Groq's resolves through its unchanged storage key. */
export const savedKey = (store: StorageLike | null | undefined, provider: Provider): string =>
  stored(store, provider.keyStorage);

/** The model this provider's user last chose, or '' when they never chose one. */
export const savedModel = (store: StorageLike | null | undefined, provider: Provider): string =>
  stored(store, provider.modelStorage);

/** The provider the user last chose; an unknown or missing value falls back to the default. */
export const savedProvider = (store: StorageLike | null | undefined): Provider =>
  providerById(stored(store, PROVIDER_STORAGE));

/**
 * Pure: may this provider's model be given the app's custom function-calling tools?
 * False only where the API rejects them (`groq/compound*`).
 */
export const supportsTools = (provider: Provider, model: string): boolean =>
  !(provider.noCustomTools?.test(model) ?? false);

/**
 * Pure: does this provider's model search the web on the provider's servers and report
 * sources? Faisal AI has no web-search tool of its own, so this is the only way it can
 * honestly claim to search.
 */
export const searchesWeb = (provider: Provider, model: string): boolean =>
  provider.serverSideSearch && (provider.searchModels?.test(model) ?? false);
