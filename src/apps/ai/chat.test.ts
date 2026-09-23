// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ChatError, listModels, modelsOrFallback, runTurn, sortModels, type ChatTurn } from './chat';
import {
  DEFAULT_PROVIDER, LEGACY_STORAGE_KEYS, PROVIDERS, PROVIDER_STORAGE, providerById, savedKey, savedModel,
  savedProvider, searchesWeb, supportsTools,
} from './providers';
import type { AgentOptions, ToolBox, ToolCall } from './agent';

const GROQ = providerById('groq');
const DEEPSEEK = providerById('deepseek');

const sse = (chunks: (object | string)[]) =>
  new Response(chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join(''), {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  });
const noop = { onText: () => {}, onTool: () => {} };
/** A fake localStorage; the client and the registry never touch the real one. */
const fakeStore = (values: Record<string, string>) => ({ getItem: (k: string) => values[k] ?? null });
const urlOf = (fetchMock: ReturnType<typeof vi.fn>, i = 0) => (fetchMock.mock.calls[i] as unknown as [string, RequestInit])[0];
const initOf = (fetchMock: ReturnType<typeof vi.fn>, i = 0) => (fetchMock.mock.calls[i] as unknown as [string, RequestInit])[1];

afterEach(() => vi.unstubAllGlobals());

describe('provider registry', () => {
  it('offers Groq (the default) and DeepSeek, each labelled in both languages', () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual(['groq', 'deepseek']);
    expect(DEFAULT_PROVIDER).toBe('groq');
    expect(providerById(DEFAULT_PROVIDER)).toBe(PROVIDERS[0]);
    for (const p of PROVIDERS) {
      expect(p.label.ar.length).toBeGreaterThan(0);
      expect(p.label.en.length).toBeGreaterThan(0);
      expect(p.host).toBe(new URL(p.apiBase).host);
    }
  });

  it('keeps one key and one model per provider, Groq under its unchanged storage keys', () => {
    expect(GROQ.keyStorage).toBe('faisal.groq.apiKey');
    expect(GROQ.modelStorage).toBe('faisal.groq.model');
    expect(DEEPSEEK.keyStorage).toBe('faisal.deepseek.apiKey');
    expect(DEEPSEEK.modelStorage).toBe('faisal.deepseek.model');
    expect(PROVIDER_STORAGE).toBe('faisal.ai.provider');
    // The chosen provider must not collide with a key or a model.
    const all = PROVIDERS.flatMap((p) => [p.keyStorage, p.modelStorage]);
    expect(new Set(all).size).toBe(all.length);
    expect(all).not.toContain(PROVIDER_STORAGE);
  });

  it('never names a host outside the two API bases and the key consoles', () => {
    expect(PROVIDERS.map((p) => p.host)).toEqual(['api.groq.com', 'api.deepseek.com']);
    expect(GROQ.apiBase).toBe('https://api.groq.com/openai/v1');
    // Documented OpenAI-compatible base, no /v1 (https://api-docs.deepseek.com/).
    expect(DEEPSEEK.apiBase).toBe('https://api.deepseek.com');
    for (const p of PROVIDERS) {
      expect(p.apiBase).not.toMatch(/\?/); // never a key in a query string
      expect(new URL(p.keyUrl).protocol).toBe('https:');
    }
    expect(DEEPSEEK.keyUrl).toBe('https://platform.deepseek.com/api_keys');
  });

  it('falls back to the default provider for an unknown, missing or garbled id', () => {
    expect(providerById('nope')).toBe(GROQ);
    expect(providerById('')).toBe(GROQ);
    expect(providerById(null)).toBe(GROQ);
    expect(providerById(undefined)).toBe(GROQ);
    expect(providerById('deepseek').id).toBe('deepseek');
  });

  it('remembers the chosen provider and defaults when nothing valid is stored', () => {
    expect(savedProvider(fakeStore({ [PROVIDER_STORAGE]: 'deepseek' })).id).toBe('deepseek');
    expect(savedProvider(fakeStore({ [PROVIDER_STORAGE]: 'gemini' }))).toBe(GROQ);
    expect(savedProvider(fakeStore({}))).toBe(GROQ);
    expect(savedProvider(null)).toBe(GROQ);
  });

  it('still resolves an existing Groq key and model saved by earlier versions', () => {
    const old = fakeStore({ 'faisal.groq.apiKey': 'gsk_existing', 'faisal.groq.model': 'llama-3.3-70b-versatile' });
    expect(savedKey(old, GROQ)).toBe('gsk_existing');
    expect(savedModel(old, GROQ)).toBe('llama-3.3-70b-versatile');
    // The other provider stays empty rather than picking up Groq's key.
    expect(savedKey(old, DEEPSEEK)).toBe('');
    expect(savedModel(old, DEEPSEEK)).toBe('');
  });

  it('reads no key when the browser blocks storage', () => {
    const blocked = { getItem: () => { throw new Error('blocked'); } };
    expect(savedKey(blocked, GROQ)).toBe('');
    expect(savedModel(blocked, GROQ)).toBe('');
    expect(savedProvider(blocked)).toBe(GROQ);
  });

  it('removes only the obsolete Claude and Gemini keys', () => {
    expect(LEGACY_STORAGE_KEYS).toEqual(['faisal.claude.apiKey', 'faisal.gemini.apiKey']);
    expect(LEGACY_STORAGE_KEYS).not.toContain(GROQ.keyStorage);
    expect(LEGACY_STORAGE_KEYS).not.toContain(DEEPSEEK.keyStorage);
    expect(LEGACY_STORAGE_KEYS).not.toContain(PROVIDER_STORAGE);
  });
});

describe('tool and search capability rules', () => {
  it('refuses custom tools only for Groq compound models', () => {
    expect(supportsTools(GROQ, 'groq/compound')).toBe(false);
    expect(supportsTools(GROQ, 'groq/compound-mini')).toBe(false);
    expect(supportsTools(GROQ, 'llama-3.3-70b-versatile')).toBe(true);
    expect(supportsTools(GROQ, 'openai/gpt-oss-120b')).toBe(true);
  });

  it('gives DeepSeek models the app tools (function calling works, thinking mode included)', () => {
    expect(supportsTools(DEEPSEEK, 'deepseek-flash')).toBe(true);
    expect(supportsTools(DEEPSEEK, 'deepseek-v4-pro')).toBe(true);
    expect(supportsTools(DEEPSEEK, 'deepseek-reasoner')).toBe(true);
    for (const p of PROVIDERS) expect(p.noCustomTools?.test('deepseek-reasoner') ?? false).toBe(false);
  });

  it('reports server-side web search only where the provider really has it', () => {
    expect(searchesWeb(GROQ, 'groq/compound')).toBe(true);
    expect(searchesWeb(GROQ, 'groq/compound-mini')).toBe(true);
    expect(searchesWeb(GROQ, 'llama-3.3-70b-versatile')).toBe(false);
    expect(GROQ.serverSideSearch).toBe(true);
    expect(DEEPSEEK.serverSideSearch).toBe(false);
    for (const id of DEEPSEEK.fallbackModels) expect(searchesWeb(DEEPSEEK, id)).toBe(false);
  });
});

describe('sortModels', () => {
  it('puts Groq search models first and drops non-chat models', () => {
    expect(sortModels(GROQ, ['zeta-8b', 'whisper-large-v3', 'llama-3.3-70b-versatile', 'groq/compound', 'playai-tts', 'alpha-1b', 'meta-llama/llama-guard-4-12b']))
      .toEqual(['groq/compound', 'llama-3.3-70b-versatile', 'alpha-1b', 'zeta-8b']);
  });

  it('orders DeepSeek models by its own preference and drops non-chat models', () => {
    expect(sortModels(DEEPSEEK, ['deepseek-v4-pro', 'deepseek-flash', 'text-embedding-v1', 'deepseek-v4-flash']))
      .toEqual(['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash']);
  });
});

describe('modelsOrFallback', () => {
  it('shows the account list when it is known and the static list otherwise', () => {
    expect(modelsOrFallback(GROQ, ['a', 'b'])).toEqual(['a', 'b']);
    expect(modelsOrFallback(GROQ, [])).toEqual(['groq/compound', 'groq/compound-mini', 'llama-3.3-70b-versatile']);
    expect(modelsOrFallback(DEEPSEEK, [])).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    // A copy, so the picker can never mutate the registry's own list.
    expect(modelsOrFallback(DEEPSEEK, [])).not.toBe(DEEPSEEK.fallbackModels);
  });

  it('uses the fallback list when the model list cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const err = await listModels(DEEPSEEK, 'sk_x').catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(modelsOrFallback(DEEPSEEK, [])).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
  });
});

describe('listModels', () => {
  it('builds the Groq /models URL and returns active chat models', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: 'llama-3.3-70b-versatile', active: true }, { id: 'old-model', active: false }, { id: 'groq/compound' },
    ] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await listModels(GROQ, 'gsk_x')).toEqual(['groq/compound', 'llama-3.3-70b-versatile']);
    expect(urlOf(fetchMock)).toBe('https://api.groq.com/openai/v1/models');
    expect((initOf(fetchMock).headers as Record<string, string>).authorization).toBe('Bearer gsk_x');
  });

  it('builds the DeepSeek /models URL and accepts models without an active field', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ object: 'list', data: [
      { id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek' },
      { id: 'deepseek-flash', object: 'model', owned_by: 'deepseek' },
    ] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await listModels(DEEPSEEK, 'sk_x')).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    expect(urlOf(fetchMock)).toBe('https://api.deepseek.com/models');
    expect((initOf(fetchMock).headers as Record<string, string>).authorization).toBe('Bearer sk_x');
  });

  it('validates a Groq key: a bad key becomes ChatError 401 with the API message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Invalid API Key' } }), { status: 401 })));
    const err = await listModels(GROQ, 'bad').catch((e) => e);
    expect(err).toBeInstanceOf(ChatError);
    expect(err).toMatchObject({ status: 401, message: 'Invalid API Key', name: 'ChatError' });
  });

  it('validates a DeepSeek key the same way, without ever putting it in the URL', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Authentication Fails' } }), { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const err = await listModels(DEEPSEEK, 'sk_bad').catch((e) => e);
    expect(err).toMatchObject({ status: 401, message: 'Authentication Fails' });
    expect(urlOf(fetchMock)).toBe('https://api.deepseek.com/models');
    expect(urlOf(fetchMock)).not.toContain('sk_bad');
    expect((initOf(fetchMock).headers as Record<string, string>).authorization).toBe('Bearer sk_bad');
  });

  it('sends the key in the header only, never as a query parameter', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await listModels(GROQ, 'gsk_secret');
    const url = urlOf(fetchMock);
    expect(url).not.toContain('gsk_secret');
    expect(url).not.toContain('?');
    expect(initOf(fetchMock).method ?? 'GET').toBe('GET');
  });
});

describe('runTurn', () => {
  it('streams Groq text, reports web searches and sources, and appends the reply', async () => {
    const fetchMock = vi.fn(async () => sse([
      { choices: [{ delta: { content: 'الذهب ' } }] },
      { choices: [{ delta: { executed_tools: [{ type: 'search', arguments: '{"query":"gold price"}',
        search_results: { results: [{ title: 'Gold', url: 'https://x.test/g' }] } }] } }] },
      { choices: [{ delta: { executed_tools: [{ type: 'visit', arguments: '{"url":"https://x.test/g"}' }] } }] },
      { choices: [{ delta: { content: 'مرتفع' }, finish_reason: 'stop' }] },
      '[DONE]',
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const history: ChatTurn[] = [{ role: 'user', content: 'سعر الذهب؟' }];
    const tools: string[] = [];
    let streamed = '';
    const res = await runTurn(GROQ, 'gsk_x', 'groq/compound', history,
      { onText: (d) => { streamed += d; }, onTool: (n, d) => tools.push(`${n}:${d}`) }, new AbortController().signal);

    expect(res).toMatchObject({ text: 'الذهب مرتفع', truncated: false });
    expect(streamed).toBe('الذهب مرتفع');
    expect(tools).toEqual(['web_search:gold price', 'web_fetch:https://x.test/g']);
    expect(res.sources).toEqual([{ url: 'https://x.test/g', title: 'Gold' }]);
    expect(history.at(-1)).toEqual({ role: 'assistant', content: 'الذهب مرتفع' });
    expect(urlOf(fetchMock)).toBe('https://api.groq.com/openai/v1/chat/completions');
    const body = JSON.parse(initOf(fetchMock).body as string);
    expect(body).toMatchObject({ model: 'groq/compound', stream: true });
    expect(body.messages[0].role).toBe('system');
    expect(body.messages.slice(1)).toEqual([{ role: 'user', content: 'سعر الذهب؟' }]);
  });

  it('posts to the DeepSeek /chat/completions URL with the same OpenAI-shaped body', async () => {
    const fetchMock = vi.fn(async () => sse([{ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }, '[DONE]']));
    vi.stubGlobal('fetch', fetchMock);
    const history: ChatTurn[] = [{ role: 'user', content: 'x' }];
    const res = await runTurn(DEEPSEEK, 'sk_x', 'deepseek-flash', history, noop, new AbortController().signal);

    expect(res.text).toBe('hi');
    expect(urlOf(fetchMock)).toBe('https://api.deepseek.com/chat/completions');
    const body = JSON.parse(initOf(fetchMock).body as string);
    expect(body).toMatchObject({ model: 'deepseek-flash', stream: true });
    expect(body.messages[0].role).toBe('system');
    // No provider-specific extras: thinking mode is not toggled here.
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(history.at(-1)).toEqual({ role: 'assistant', content: 'hi' });
  });

  it('keeps streamed reasoning_content out of the answer, onText and sources', async () => {
    const fetchMock = vi.fn(async () => sse([
      { choices: [{ delta: { reasoning_content: 'secret chain of thought' } }] },
      { choices: [{ delta: { reasoning_content: ' more thinking', content: 'Answer' } }] },
      { choices: [{ delta: { content: '.' }, finish_reason: 'stop' }] },
      '[DONE]',
    ]));
    vi.stubGlobal('fetch', fetchMock);
    let streamed = '';
    const history: ChatTurn[] = [{ role: 'user', content: 'x' }];
    const res = await runTurn(DEEPSEEK, 'sk_x', 'deepseek-flash', history,
      { onText: (d) => { streamed += d; }, onTool: () => {} }, new AbortController().signal);

    expect(res.text).toBe('Answer.');
    expect(streamed).toBe('Answer.');
    expect(res.sources).toEqual([]);
    // DeepSeek's thinking mode requires the echo, so the assistant turn keeps it…
    expect(history.at(-1)).toEqual({
      role: 'assistant', content: 'Answer.', reasoning_content: 'secret chain of thought more thinking',
    });
    // …separately from the answer, which is all any user-facing surface sees.
    expect(streamed).not.toContain('chain of thought');
    expect(JSON.stringify(res)).not.toContain('chain of thought');
    expect(JSON.stringify(res.sources)).not.toContain('chain of thought');
  });

  it('echoes reasoning only for a provider that requires it, with or without tools', async () => {
    const stream = () => sse([
      { choices: [{ delta: { reasoning_content: 'why' } }] },
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
    ]);
    for (const provider of PROVIDERS) {
      const fetchMock = vi.fn(async () => stream());
      vi.stubGlobal('fetch', fetchMock);
      // A prior reasoning turn already sits in the history, so the echo rule is
      // exercised on the request body itself, not only on the reply we push.
      const prior = { role: 'assistant', content: 'earlier', reasoning_content: 'prior thought' } as ChatTurn;
      const history: ChatTurn[] = [{ role: 'user', content: 'x' }, prior, { role: 'user', content: 'x' }];
      const res = await runTurn(provider, 'k', 'm', history, noop, new AbortController().signal);

      expect(res.text).toBe('ok');
      expect(res.sources).toEqual([]);
      expect(JSON.stringify(res)).not.toContain('why');
      const sent = JSON.parse(initOf(fetchMock).body as string).messages as ChatTurn[];
      const assistant = sent.find((m): m is Extract<ChatTurn, { role: 'assistant' }> => m.role === 'assistant');
      expect(assistant?.reasoning_content).toBe(provider.echoesReasoning ? 'prior thought' : undefined);
      expect(history.at(-1)).toEqual(provider.echoesReasoning
        ? { role: 'assistant', content: 'ok', reasoning_content: 'why' }
        : { role: 'assistant', content: 'ok' });
    }
  });

  it('omits reasoning_content for DeepSeek too when the stream never sends any', async () => {
    const fetchMock = vi.fn(async () => sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]));
    vi.stubGlobal('fetch', fetchMock);
    const history: ChatTurn[] = [{ role: 'user', content: 'x' }];
    await runTurn(DEEPSEEK, 'sk_x', 'deepseek-flash', history, noop, new AbortController().signal);
    expect(history.at(-1)).toEqual({ role: 'assistant', content: 'ok' });
    expect(initOf(fetchMock).body as string).not.toContain('reasoning_content');
  });

  it('marks a reply cut off by the length limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([{ choices: [{ delta: { content: 'a' }, finish_reason: 'length' }] }])));
    const res = await runTurn(GROQ, 'k', 'm', [{ role: 'user', content: 'x' }], noop, new AbortController().signal);
    expect(res.truncated).toBe(true);
  });

  it('throws ChatError on rate limits for both providers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Rate limit reached' } }), { status: 429 })));
    for (const p of PROVIDERS) {
      const err = await runTurn(p, 'k', 'm', [{ role: 'user', content: 'x' }], noop, new AbortController().signal).catch((e) => e);
      expect(err).toBeInstanceOf(ChatError);
      expect(err).toMatchObject({ status: 429 });
    }
  });
});

describe('runTurn with tools', () => {
  const bodyOf = (fetchMock: ReturnType<typeof vi.fn>, i: number) =>
    JSON.parse(initOf(fetchMock, i).body as string);
  /** The stored `reasoning_content` of the assistant turn in request `i`. */
  const reasoningOf = (fetchMock: ReturnType<typeof vi.fn>, i: number) =>
    (bodyOf(fetchMock, i).messages as ChatTurn[]).find((m) => m.role === 'assistant')?.reasoning_content;

  /** A fake tool box that answers every call with `result:<name>:<arguments>`. */
  const makeAgent = (extra: Partial<AgentOptions> = {}) => {
    const log: string[] = [];
    const tools: ToolBox = {
      specs: [{ name: 'read_file', description: 'Reads a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
      preview: (call) => ({ label: `preview ${call.name}` }),
      execute: vi.fn(async (call: ToolCall) => `result:${call.name}:${call.arguments}`),
    };
    const agent: AgentOptions = {
      tools,
      confirm: async () => true,
      onCall: (call, preview) => log.push(`call ${call.id} ${preview.label}`),
      onResult: (call, result) => log.push(`result ${call.id} ${result}`),
      ...extra,
    };
    return { agent, tools, log };
  };

  it('runs a streamed tool call, sends the result back and returns the final answer', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sse([
        { choices: [{ delta: { content: 'Checking. ' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"/home/' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'a.txt"}' } }] }, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]))
      .mockResolvedValueOnce(sse([
        { choices: [{ delta: { content: 'It says hi.' }, finish_reason: 'stop' }] },
        '[DONE]',
      ]));
    vi.stubGlobal('fetch', fetchMock);
    const { agent, tools, log } = makeAgent();
    const history: ChatTurn[] = [{ role: 'user', content: 'read a.txt' }];
    let streamed = '';
    const res = await runTurn(GROQ, 'k', 'llama-3.3-70b-versatile', history,
      { onText: (d) => { streamed += d; }, onTool: () => {} }, new AbortController().signal, agent);

    const call = { id: 'call_a', name: 'read_file', arguments: '{"path":"/home/a.txt"}' };
    expect(tools.execute).toHaveBeenCalledTimes(1);
    expect(tools.execute).toHaveBeenCalledWith(call, agent.confirm);
    expect(log).toEqual(['call call_a preview read_file', `result call_a result:read_file:${call.arguments}`]);
    expect(res).toEqual({ text: 'Checking. It says hi.', sources: [], truncated: false });
    expect(streamed).toBe('Checking. It says hi.');

    const first = bodyOf(fetchMock, 0);
    expect(first.tool_choice).toBe('auto');
    expect(first.tools).toEqual([{ type: 'function', function: tools.specs[0] }]);

    const assistantCall = { role: 'assistant', content: 'Checking. ',
      tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'read_file', arguments: call.arguments } }] };
    const toolMsg = { role: 'tool', tool_call_id: 'call_a', content: `result:read_file:${call.arguments}` };
    expect(bodyOf(fetchMock, 1).messages.slice(1)).toEqual([{ role: 'user', content: 'read a.txt' }, assistantCall, toolMsg]);
    expect(history).toEqual([{ role: 'user', content: 'read a.txt' }, assistantCall, toolMsg, { role: 'assistant', content: 'It says hi.' }]);
    expect(urlOf(fetchMock, 1)).toBe('https://api.groq.com/openai/v1/chat/completions');
  });

  it('sends custom tools to DeepSeek too, keeping the assistant/tool history in order', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"path":"/a"}' } }] }, finish_reason: 'tool_calls' }] },
      ]))
      .mockResolvedValueOnce(sse([{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }]));
    vi.stubGlobal('fetch', fetchMock);
    const { agent, tools } = makeAgent();
    const history: ChatTurn[] = [{ role: 'user', content: 'x' }];
    const res = await runTurn(DEEPSEEK, 'sk_x', 'deepseek-flash', history, noop, new AbortController().signal, agent);

    expect(res.text).toBe('done');
    expect(urlOf(fetchMock)).toBe('https://api.deepseek.com/chat/completions');
    expect(bodyOf(fetchMock, 0).tools).toEqual([{ type: 'function', function: tools.specs[0] }]);
    expect(bodyOf(fetchMock, 1).messages.slice(1)).toEqual([
      { role: 'user', content: 'x' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/a"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'result:read_file:{"path":"/a"}' },
    ]);
  });

  it('echoes DeepSeek reasoning_content back on the follow-up tool request', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sse([
        { choices: [{ delta: { reasoning_content: 'I should read ' } }] },
        { choices: [{ delta: { reasoning_content: 'a.txt.' } }] },
        { choices: [{ delta: { content: 'Checking. ' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"path":"/a"}' } }] }, finish_reason: 'tool_calls' }] },
      ]))
      .mockResolvedValueOnce(sse([
        { choices: [{ delta: { reasoning_content: 'The file says hi.' } }] },
        { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] },
      ]));
    vi.stubGlobal('fetch', fetchMock);
    const { agent, tools } = makeAgent();
    const history: ChatTurn[] = [{ role: 'user', content: 'x' }];
    const res = await runTurn(DEEPSEEK, 'sk_x', 'deepseek-flash', history, noop, new AbortController().signal, agent);

    expect(res.text).toBe('Checking. done');
    // The rule: echoed only for a provider whose echoesReasoning flag is true.
    expect(DEEPSEEK.echoesReasoning).toBe(true);
    expect(GROQ.echoesReasoning ?? false).toBe(false);
    // The requests themselves are unchanged: thinking is not toggled on for the user.
    for (const i of [0, 1]) expect(bodyOf(fetchMock, i)).not.toHaveProperty('thinking');

    // First request: no assistant turn yet, so nothing to echo.
    expect(reasoningOf(fetchMock, 0)).toBeUndefined();
    // Second request: the assistant turn carries exactly the reasoning that streamed
    // with it, and the tool result follows it in order.
    expect(reasoningOf(fetchMock, 1)).toBe('I should read a.txt.');
    expect(bodyOf(fetchMock, 1).messages.slice(1)).toEqual([
      { role: 'user', content: 'x' },
      { role: 'assistant', content: 'Checking. ', reasoning_content: 'I should read a.txt.',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/a"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: `result:read_file:{"path":"/a"}` },
    ]);
    expect(tools.execute).toHaveBeenCalledTimes(1);
    expect(history[1]).toMatchObject({ role: 'assistant', reasoning_content: 'I should read a.txt.' });
    // The final answer's own reasoning is kept too (it never reached the answer text).
    expect(history.at(-1)).toEqual({ role: 'assistant', content: 'done', reasoning_content: 'The file says hi.' });
    // …and it is nowhere in the answer, or the sources.
    expect(res.text).not.toContain('The file says hi.');
    expect(res.sources).toEqual([]);
    expect(JSON.stringify(res)).not.toContain('I should read');
  });

  it('never puts reasoning_content in a Groq request body, agent turn or plain turn', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sse([
        { choices: [{ delta: { content: 'Checking. ' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'g1', function: { name: 'read_file', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
      ]))
      .mockResolvedValueOnce(sse([{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }]));
    vi.stubGlobal('fetch', fetchMock);
    const { agent } = makeAgent();
    const history: ChatTurn[] = [{ role: 'user', content: 'x' }];
    const res = await runTurn(GROQ, 'k', 'llama-3.3-70b-versatile', history, noop, new AbortController().signal, agent);

    expect(res.text).toBe('Checking. done');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Groq's bodies are byte-identical to before: the field is absent, not null.
    for (const i of [0, 1]) {
      expect(initOf(fetchMock, i).body as string).not.toContain('reasoning_content');
    }
    expect(bodyOf(fetchMock, 1).messages.slice(1)).toEqual([
      { role: 'user', content: 'x' },
      { role: 'assistant', content: 'Checking. ', tool_calls: [{ id: 'g1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'g1', content: 'result:read_file:{}' },
    ]);
    expect(JSON.stringify(history)).not.toContain('reasoning_content');
  });

  it('runs parallel tool calls in order and answers each one', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sse([
        { choices: [{ delta: { tool_calls: [
          { index: 0, id: 'c0', function: { name: 'read_file', arguments: '{"path":"/a"}' } },
          { index: 1, id: 'c1', function: { name: 'read_file', arguments: '{"path":' } },
        ] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '"/b"}' } }] }, finish_reason: 'tool_calls' }] },
      ]))
      .mockResolvedValueOnce(sse([{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }]));
    vi.stubGlobal('fetch', fetchMock);
    const { agent, tools } = makeAgent();
    await runTurn(GROQ, 'k', 'openai/gpt-oss-120b', [{ role: 'user', content: 'x' }], noop, new AbortController().signal, agent);

    expect((tools.execute as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as ToolCall).arguments))
      .toEqual(['{"path":"/a"}', '{"path":"/b"}']);
    const msgs = bodyOf(fetchMock, 1).messages;
    expect(msgs[2].tool_calls.map((c: { id: string }) => c.id)).toEqual(['c0', 'c1']);
    expect(msgs.slice(3)).toEqual([
      { role: 'tool', tool_call_id: 'c0', content: 'result:read_file:{"path":"/a"}' },
      { role: 'tool', tool_call_id: 'c1', content: 'result:read_file:{"path":"/b"}' },
    ]);
  });

  it('never sends custom tools to Groq compound models', async () => {
    const fetchMock = vi.fn(async () => sse([{ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }]));
    vi.stubGlobal('fetch', fetchMock);
    const { agent } = makeAgent();
    const res = await runTurn(GROQ, 'k', 'groq/compound', [{ role: 'user', content: 'x' }], noop, new AbortController().signal, agent);
    expect(res.text).toBe('hi');
    const body = bodyOf(fetchMock, 0);
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
  });

  it('stops after maxSteps with truncated when the model keeps calling tools', async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => sse([{ choices: [{ delta: { tool_calls: [
      { index: 0, id: `c${n++}`, function: { name: 'read_file', arguments: '{}' } },
    ] }, finish_reason: 'tool_calls' }] }]));
    vi.stubGlobal('fetch', fetchMock);
    const { agent, tools } = makeAgent({ maxSteps: 3 });
    const history: ChatTurn[] = [{ role: 'user', content: 'loop' }];
    const res = await runTurn(GROQ, 'k', 'm', history, noop, new AbortController().signal, agent);
    expect(res.truncated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(tools.execute).toHaveBeenCalledTimes(3);
    expect(history.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c2' });
  });

  it('stops when aborted between steps and restores the history', async () => {
    const ctrl = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => sse([{ choices: [{ delta: { tool_calls: [
      { index: 0, id: 'c', function: { name: 'read_file', arguments: '{}' } },
    ] }, finish_reason: 'tool_calls' }] }])));
    const { agent } = makeAgent({ onResult: () => ctrl.abort() });
    const history: ChatTurn[] = [{ role: 'user', content: 'x' }];
    const err = await runTurn(GROQ, 'k', 'm', history, noop, ctrl.signal, agent).catch((e) => e);
    expect(err).toMatchObject({ name: 'AbortError' });
    expect(history).toEqual([{ role: 'user', content: 'x' }]);
  });

  it('restores the history when a DeepSeek step fails mid tool exchange', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(sse([{ choices: [{ delta: { tool_calls: [
        { index: 0, id: 'c', function: { name: 'read_file', arguments: '{}' } },
      ] }, finish_reason: 'tool_calls' }] }]))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 })));
    const { agent } = makeAgent();
    const history: ChatTurn[] = [{ role: 'user', content: 'x' }];
    const err = await runTurn(DEEPSEEK, 'sk_x', 'deepseek-flash', history, noop, new AbortController().signal, agent).catch((e) => e);
    expect(err).toBeInstanceOf(ChatError);
    expect(history).toEqual([{ role: 'user', content: 'x' }]);
  });
});
