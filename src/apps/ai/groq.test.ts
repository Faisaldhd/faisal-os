// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { GroqError, listModels, runGroqTurn, sortModels, type ChatTurn } from './groq';

const sse = (chunks: (object | string)[]) =>
  new Response(chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join(''), {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  });
const noop = { onText: () => {}, onTool: () => {} };

afterEach(() => vi.unstubAllGlobals());

describe('sortModels', () => {
  it('puts web-search models first and drops non-chat models', () => {
    expect(sortModels(['zeta-8b', 'whisper-large-v3', 'llama-3.3-70b-versatile', 'groq/compound', 'playai-tts', 'alpha-1b', 'meta-llama/llama-guard-4-12b']))
      .toEqual(['groq/compound', 'llama-3.3-70b-versatile', 'alpha-1b', 'zeta-8b']);
  });
});

describe('listModels', () => {
  it('sends the key and returns active chat models', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: 'llama-3.3-70b-versatile', active: true }, { id: 'old-model', active: false }, { id: 'groq/compound' },
    ] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await listModels('gsk_x')).toEqual(['groq/compound', 'llama-3.3-70b-versatile']);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.groq.com/openai/v1/models');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer gsk_x');
  });

  it('turns a bad key into GroqError 401 with the API message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Invalid API Key' } }), { status: 401 })));
    const err = await listModels('bad').catch((e) => e);
    expect(err).toBeInstanceOf(GroqError);
    expect(err).toMatchObject({ status: 401, message: 'Invalid API Key' });
  });
});

describe('runGroqTurn', () => {
  it('streams text, reports web searches and sources, and appends the reply', async () => {
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
    const res = await runGroqTurn('gsk_x', 'groq/compound', history,
      { onText: (d) => { streamed += d; }, onTool: (n, d) => tools.push(`${n}:${d}`) }, new AbortController().signal);

    expect(res).toMatchObject({ text: 'الذهب مرتفع', truncated: false });
    expect(streamed).toBe('الذهب مرتفع');
    expect(tools).toEqual(['web_search:gold price', 'web_fetch:https://x.test/g']);
    expect(res.sources).toEqual([{ url: 'https://x.test/g', title: 'Gold' }]);
    expect(history.at(-1)).toEqual({ role: 'assistant', content: 'الذهب مرتفع' });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({ model: 'groq/compound', stream: true });
    expect(body.messages[0].role).toBe('system');
    expect(body.messages.slice(1)).toEqual([{ role: 'user', content: 'سعر الذهب؟' }]);
  });

  it('marks a reply cut off by the length limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([{ choices: [{ delta: { content: 'a' }, finish_reason: 'length' }] }])));
    const res = await runGroqTurn('k', 'm', [{ role: 'user', content: 'x' }], noop, new AbortController().signal);
    expect(res.truncated).toBe(true);
  });

  it('throws GroqError on rate limits', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Rate limit reached' } }), { status: 429 })));
    const err = await runGroqTurn('k', 'm', [{ role: 'user', content: 'x' }], noop, new AbortController().signal).catch((e) => e);
    expect(err).toMatchObject({ status: 429 });
  });
});
