// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { runGeminiTurn, GeminiError, type GeminiContent } from './gemini';

const sse = (chunks: object[]) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });

afterEach(() => vi.unstubAllGlobals());

describe('runGeminiTurn', () => {
  it('streams text, reports searches and sources, and appends the reply', async () => {
    const fetchMock = vi.fn(async () => sse([
      { candidates: [{ content: { parts: [{ text: 'الذهب ' }] } }] },
      { candidates: [{ content: { parts: [{ text: 'مرتفع', thought: false }, { text: 'hidden', thought: true }] } }] },
      { candidates: [{ finishReason: 'STOP', groundingMetadata: { webSearchQueries: ['gold price'], groundingChunks: [{ web: { uri: 'https://x.test/a', title: 'x.test' } }] } }] },
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const history: GeminiContent[] = [{ role: 'user', parts: [{ text: 'سعر الذهب؟' }] }];
    const deltas: string[] = [];
    const tools: string[] = [];
    const res = await runGeminiTurn('k', history, { onText: (d) => deltas.push(d), onTool: (_n, q) => tools.push(q) }, new AbortController().signal);

    expect(res).toMatchObject({ text: 'الذهب مرتفع', refused: false, truncated: false });
    expect(res.sources).toEqual([{ url: 'https://x.test/a', title: 'x.test' }]);
    expect(deltas.join('')).toBe('الذهب مرتفع');
    expect(tools).toEqual(['gold price']);
    expect(history.at(-1)).toEqual({ role: 'model', parts: [{ text: 'الذهب مرتفع' }] });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(':streamGenerateContent?alt=sse');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('k');
    expect(JSON.parse(init.body as string).tools).toEqual([{ google_search: {} }, { url_context: {} }]);
  });

  it('rolls back a blocked turn', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([{ promptFeedback: { blockReason: 'SAFETY' } }])));
    const history: GeminiContent[] = [{ role: 'user', parts: [{ text: 'x' }] }];
    const res = await runGeminiTurn('k', history, { onText: () => {}, onTool: () => {} }, new AbortController().signal);
    expect(res.refused).toBe(true);
    expect(history).toEqual([]);
  });

  it('throws GeminiError with the API message on HTTP errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 })));
    const err = await runGeminiTurn('bad', [{ role: 'user', parts: [{ text: 'x' }] }], { onText: () => {}, onTool: () => {} }, new AbortController().signal).catch((e) => e);
    expect(err).toBeInstanceOf(GeminiError);
    expect(err.status).toBe(400);
    expect(err.message).toBe('API key not valid');
  });
});
