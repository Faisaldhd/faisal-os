import type { AgentOptions, ToolCall } from './agent';
import { sseData } from './sse';
import { supportsTools, type Provider } from './providers';

/**
 * Any OpenAI-compatible provider (GroqCloud, DeepSeek), called straight from the browser
 * with the user's own key. Which host is used, which model ids are preferred and which
 * models accept custom tools all come from `providers.ts`; this module only speaks the
 * protocol, so nothing about the Groq path changed when DeepSeek was added.
 *
 * Groq's `groq/compound` models search the web and open pages on Groq's servers by
 * themselves (the `executed_tools` chunks below) and report the sources they read.
 * DeepSeek has no server-side search, so those chunks simply never arrive for it.
 */

/** Chat-capable models only: speech, TTS and moderation models can't chat. */
const NOT_CHAT = /whisper|tts|orpheus|playai|guard|safeguard|embed/i;

export interface Source { url: string; title: string }
/** A function call as the OpenAI-compatible API stores it in an assistant message. */
export interface ApiToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
/**
 * One message of the conversation. Plain chat only has user/assistant turns; an agent
 * turn adds assistant messages with `tool_calls` and the `tool` results that answer them.
 *
 * `reasoning_content` is DeepSeek's streamed chain of thought. It is never answer text,
 * but DeepSeek's thinking mode requires it back on later requests that carry `tools`, so
 * an assistant turn keeps it and `provider.echoesReasoning` decides whether it is sent.
 */
export type ChatTurn =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ApiToolCall[]; reasoning_content?: string }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface TurnHandlers {
  onText(delta: string): void;
  onTool(name: 'web_search' | 'web_fetch', detail: string): void;
}

export interface TurnResult {
  text: string;
  sources: Source[];
  truncated: boolean;
}

/** HTTP error from the provider; `status` picks the message the user sees. */
export class ChatError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ChatError';
  }
}

const systemPrompt = (provider: Provider, model: string, agent: boolean) =>
  'You are Faisal AI, the assistant built into Fai$al OS, a desktop that runs in the web browser. ' +
  `You run on ${provider.label.en} using the model "${model}"; say so if asked what model you are. ` +
  'Reply in the language the user writes in (Arabic or English). ' +
  (agent
    ? 'You are an agent inside Fai$al OS: use your tools to look at and act on its files, apps, windows, terminal and settings ' +
      'instead of telling the user how to do it. The home folder is /home/user (Documents, Pictures, …). ' +
      'Look before you change things (list or read first). Changes ask the user for confirmation; ' +
      'if they decline, do not retry unless they ask. Finish with a short summary of what you did. '
    : provider.serverSideSearch
      ? 'If you can search the web, do so for anything current or that you are unsure of, and cite your sources. '
      : 'You have no web search in this app: answer from what you know and say plainly when something may be out of date rather than pretending to look it up. ') +
  'Keep answers clear and well organized; use Markdown for lists, code and headings.';

async function fail(res: Response): Promise<never> {
  let message = `HTTP ${res.status}`;
  try { message = (await res.json())?.error?.message ?? message; } catch { /* keep the status text */ }
  throw new ChatError(res.status, message);
}

/**
 * Pure: chat-capable model ids, this provider's preferred ones first, then alphabetical.
 * Non-chat models (whisper, TTS, moderation) are dropped.
 */
export function sortModels(provider: Provider, ids: string[]): string[] {
  const chat = [...new Set(ids)].filter((id) => !NOT_CHAT.test(id));
  const rank = (id: string) => { const i = provider.preferredModels.indexOf(id); return i < 0 ? provider.preferredModels.length : i; };
  return chat.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** The models to show: the account's list once it is known, else the provider's static fallback. */
export const modelsOrFallback = (provider: Provider, ids: readonly string[]): string[] =>
  ids.length ? [...ids] : [...provider.fallbackModels];

/** Lists the models this key can use. Also a cheap way to check that the key works. */
export async function listModels(provider: Provider, apiKey: string, signal?: AbortSignal): Promise<string[]> {
  const res = await fetch(`${provider.apiBase}/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal });
  if (!res.ok) await fail(res);
  // Groq marks retired models with `active: false`; DeepSeek sends no such field, which
  // reads as active — exactly what we want, since the list it returns is authoritative.
  const body = (await res.json()) as { data?: { id?: unknown; active?: unknown }[] };
  return sortModels(provider, (body.data ?? []).filter((m) => m.active !== false && typeof m.id === 'string').map((m) => m.id as string));
}

interface ExecutedTool {
  type?: string;
  arguments?: string;
  search_results?: { results?: { title?: string; url?: string }[] };
}
/** A fragment of a streamed function call; fragments with the same `index` concatenate. */
interface ToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}
interface Chunk {
  choices?: {
    /**
     * `reasoning_content` is streamed by DeepSeek's thinking models next to `content`,
     * at the same level of `delta` (and on the finished `message`). It is the model's
     * chain of thought: it never reaches `onText`, the answer text or the sources, but
     * it is kept on the assistant turn and sent back when the provider requires it —
     * see `bodyMessage` and `Provider.echoesReasoning`.
     */
    delta?: { content?: string | null; reasoning_content?: string | null; executed_tools?: ExecutedTool[]; tool_calls?: ToolCallDelta[] };
    message?: { reasoning_content?: string | null; executed_tools?: ExecutedTool[] };
    finish_reason?: string | null;
  }[];
  error?: { message?: string };
}

/**
 * Pure: one history message as the request body carries it. `reasoning_content` is
 * serialized on an assistant turn only when the provider requires the echo
 * (`Provider.echoesReasoning`) and the text is non-empty; a provider that does not
 * require it never sees the field, so its request bodies stay exactly as before.
 */
function bodyMessage(provider: Provider, turn: ChatTurn): ChatTurn {
  if (turn.role !== 'assistant') return turn;
  const { reasoning_content, ...rest } = turn;
  return provider.echoesReasoning && reasoning_content ? { ...rest, reasoning_content } : rest;
}

const abortError = () => new DOMException('Aborted', 'AbortError');

/**
 * Runs one user turn. `history` must already end with the user's message; the reply
 * is appended to it when the turn completes.
 *
 * With `agent` (and a model that supports custom tools) the model may call tools: each
 * requested call is previewed, run and answered, then the model is asked again, until it
 * answers in text or `agent.maxSteps` round trips are used up (then `truncated` is true).
 * The assistant/tool messages of those steps stay in `history`. If the turn throws
 * (abort, HTTP error), `history` is restored to how it was on entry.
 */
export async function runTurn(
  provider: Provider,
  apiKey: string,
  model: string,
  history: ChatTurn[],
  h: TurnHandlers,
  signal: AbortSignal,
  agent?: AgentOptions,
): Promise<TurnResult> {
  const tools = agent && supportsTools(provider, model) ? agent : undefined;
  const maxSteps = Math.max(1, tools?.maxSteps ?? 8);
  const entryLength = history.length;

  let text = '';
  const seenTools = new Set<string>();
  const sources = new Map<string, Source>();

  const onTools = (executed: ExecutedTool[] | undefined) => {
    for (const tool of executed ?? []) {
      let args: { query?: unknown; url?: unknown } = {};
      try { args = JSON.parse(tool.arguments ?? '{}'); } catch { /* not JSON: no detail */ }
      const isVisit = /visit|browse|fetch/i.test(tool.type ?? '');
      const detail = String((isVisit ? args.url : args.query) ?? args.query ?? args.url ?? '');
      const key = `${tool.type}:${detail}`;
      if (detail && !seenTools.has(key)) {
        seenTools.add(key);
        h.onTool(isVisit ? 'web_fetch' : 'web_search', detail);
      }
      for (const r of tool.search_results?.results ?? []) {
        if (r.url && !sources.has(r.url)) sources.set(r.url, { url: r.url, title: r.title ?? '' });
      }
    }
  };

  /** One streamed completion: its text, finish reason and the calls it requested. */
  const step = async () => {
    const res = await fetch(`${provider.apiBase}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [{ role: 'system', content: systemPrompt(provider, model, !!tools) }, ...history.map((turn) => bodyMessage(provider, turn))],
        ...(tools && {
          tools: tools.tools.specs.map((s) => ({
            type: 'function',
            function: { name: s.name, description: s.description, parameters: s.parameters },
          })),
          tool_choice: 'auto',
        }),
      }),
      signal,
    });
    if (!res.ok || !res.body) await fail(res);

    let stepText = '';
    let stepReasoning = '';
    let finish = '';
    const calls: ToolCall[] = [];

    for await (const data of sseData(res.body!)) {
      if (data === '[DONE]') break;
      let chunk: Chunk;
      try { chunk = JSON.parse(data) as Chunk; } catch { continue; }
      if (chunk.error?.message) throw new ChatError(500, chunk.error.message);
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta?.content;
      if (delta) { stepText += delta; text += delta; h.onText(delta); }
      // Chain of thought: accumulated on its own, never streamed out as answer text.
      if (choice.delta?.reasoning_content) stepReasoning += choice.delta.reasoning_content;
      if (choice.message?.reasoning_content) stepReasoning += choice.message.reasoning_content;
      onTools(choice.delta?.executed_tools);
      onTools(choice.message?.executed_tools);
      for (const [n, part] of (choice.delta?.tool_calls ?? []).entries()) {
        const call = (calls[part.index ?? n] ??= { id: '', name: '', arguments: '' });
        if (part.id) call.id = part.id;
        if (part.function?.name) call.name += part.function.name;
        if (part.function?.arguments) call.arguments += part.function.arguments;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    const toolCalls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}` }));
    return { stepText, stepReasoning, finish, toolCalls };
  };

  try {
    for (let n = 0; n < maxSteps; n++) {
      if (signal.aborted) throw abortError();
      const { stepText, stepReasoning, finish, toolCalls } = await step();
      if (!tools || !toolCalls.length) {
        history.push({ role: 'assistant', content: stepText, ...(provider.echoesReasoning && stepReasoning && { reasoning_content: stepReasoning }) });
        return { text, sources: [...sources.values()], truncated: finish === 'length' };
      }
      history.push({
        role: 'assistant',
        content: stepText,
        tool_calls: toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
        ...(provider.echoesReasoning && stepReasoning && { reasoning_content: stepReasoning }),
      });
      for (const call of toolCalls) {
        if (signal.aborted) throw abortError();
        tools.onCall?.(call, tools.tools.preview(call));
        const result = await tools.tools.execute(call, tools.confirm);
        tools.onResult?.(call, result);
        history.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
    }
  } catch (err) {
    // Leave no half-finished tool exchange behind: the API rejects unanswered tool_calls.
    history.length = entryLength;
    throw err;
  }
  // Step cap reached while the model still wanted tools; history ends with tool results.
  return { text, sources: [...sources.values()], truncated: true };
}
