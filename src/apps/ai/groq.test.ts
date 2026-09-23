// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { GroqError, listModels, runGroqTurn, sortModels, supportsTools, type ChatTurn } from './groq';
import type { AgentOptions, ToolBox, ToolCall } from './agent';

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

describe('runGroqTurn with tools', () => {
  const bodyOf = (fetchMock: ReturnType<typeof vi.fn>, i: number) =>
    JSON.parse((fetchMock.mock.calls[i] as unknown as [string, RequestInit])[1].body as string);

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
    const res = await runGroqTurn('k', 'llama-3.3-70b-versatile', history,
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
    await runGroqTurn('k', 'openai/gpt-oss-120b', [{ role: 'user', content: 'x' }], noop, new AbortController().signal, agent);

    expect((tools.execute as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as ToolCall).arguments))
      .toEqual(['{"path":"/a"}', '{"path":"/b"}']);
    const msgs = bodyOf(fetchMock, 1).messages;
    expect(msgs[2].tool_calls.map((c: { id: string }) => c.id)).toEqual(['c0', 'c1']);
    expect(msgs.slice(3)).toEqual([
      { role: 'tool', tool_call_id: 'c0', content: 'result:read_file:{"path":"/a"}' },
      { role: 'tool', tool_call_id: 'c1', content: 'result:read_file:{"path":"/b"}' },
    ]);
  });

  it('never sends custom tools to compound models', async () => {
    expect(supportsTools('groq/compound')).toBe(false);
    expect(supportsTools('groq/compound-mini')).toBe(false);
    expect(supportsTools('llama-3.3-70b-versatile')).toBe(true);
    const fetchMock = vi.fn(async () => sse([{ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }]));
    vi.stubGlobal('fetch', fetchMock);
    const { agent } = makeAgent();
    const res = await runGroqTurn('k', 'groq/compound', [{ role: 'user', content: 'x' }], noop, new AbortController().signal, agent);
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
    const res = await runGroqTurn('k', 'm', history, noop, new AbortController().signal, agent);
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
    const err = await runGroqTurn('k', 'm', history, noop, ctrl.signal, agent).catch((e) => e);
    expect(err).toMatchObject({ name: 'AbortError' });
    expect(history).toEqual([{ role: 'user', content: 'x' }]);
  });
});
