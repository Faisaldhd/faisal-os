import type { AgentOptions, ToolCall } from './agent';
import { sseData } from './sse';

/**
 * GroqCloud (OpenAI-compatible API), called straight from the browser with the
 * user's own key. The groq/compound models search the web and open pages on
 * Groq's servers by themselves; other models just answer.
 */
const API = 'https://api.groq.com/openai/v1';

/** Preferred defaults, best first: compound models can search the web. */
export const PREFERRED_MODELS = ['groq/compound', 'groq/compound-mini', 'openai/gpt-oss-120b', 'llama-3.3-70b-versatile'];
/** Used when the model list can't be fetched. */
export const FALLBACK_MODELS = ['groq/compound', 'groq/compound-mini', 'llama-3.3-70b-versatile'];
/** Speech, TTS and moderation models can't chat. */
const NOT_CHAT = /whisper|tts|orpheus|playai|guard|safeguard|embed/i;

export interface Source { url: string; title: string }
/** A function call as the OpenAI-compatible API stores it in an assistant message. */
export interface ApiToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
/**
 * One message of the conversation. Plain chat only has user/assistant turns; an agent
 * turn adds assistant messages with `tool_calls` and the `tool` results that answer them.
 */
export type ChatTurn =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ApiToolCall[] }
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

/** HTTP error from GroqCloud; `status` picks the message the user sees. */
export class GroqError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'GroqError';
  }
}

const systemPrompt = (model: string) =>
  'You are Faisal AI, the assistant built into Fai$al OS, a desktop that runs in the web browser. ' +
  `You run on GroqCloud using the model "${model}"; say so if asked what model you are. ` +
  'Reply in the language the user writes in (Arabic or English). ' +
  'If you can search the web, do so for anything current or that you are unsure of, and cite your sources. ' +
  'Keep answers clear and well organized; use Markdown for lists, code and headings.';

async function fail(res: Response): Promise<never> {
  let message = `HTTP ${res.status}`;
  try { message = (await res.json())?.error?.message ?? message; } catch { /* keep the status text */ }
  throw new GroqError(res.status, message);
}

/** Pure: chat-capable model ids, preferred ones first, then alphabetical. */
export function sortModels(ids: string[]): string[] {
  const chat = [...new Set(ids)].filter((id) => !NOT_CHAT.test(id));
  const rank = (id: string) => { const i = PREFERRED_MODELS.indexOf(id); return i < 0 ? PREFERRED_MODELS.length : i; };
  return chat.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Lists the models this key can use. Also a cheap way to check that the key works. */
export async function listModels(apiKey: string, signal?: AbortSignal): Promise<string[]> {
  const res = await fetch(`${API}/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal });
  if (!res.ok) await fail(res);
  const body = (await res.json()) as { data?: { id?: unknown; active?: unknown }[] };
  return sortModels((body.data ?? []).filter((m) => m.active !== false && typeof m.id === 'string').map((m) => m.id as string));
}

/** Compound models only run Groq's built-in tools and reject custom ones. */
export function supportsTools(model: string): boolean {
  return !model.startsWith('groq/compound');
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
    delta?: { content?: string | null; executed_tools?: ExecutedTool[]; tool_calls?: ToolCallDelta[] };
    message?: { executed_tools?: ExecutedTool[] };
    finish_reason?: string | null;
  }[];
  error?: { message?: string };
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
export async function runGroqTurn(
  apiKey: string,
  model: string,
  history: ChatTurn[],
  h: TurnHandlers,
  signal: AbortSignal,
  agent?: AgentOptions,
): Promise<TurnResult> {
  const tools = agent && supportsTools(model) ? agent : undefined;
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
    const res = await fetch(`${API}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [{ role: 'system', content: systemPrompt(model) }, ...history],
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
    let finish = '';
    const calls: ToolCall[] = [];

    for await (const data of sseData(res.body!)) {
      if (data === '[DONE]') break;
      let chunk: Chunk;
      try { chunk = JSON.parse(data) as Chunk; } catch { continue; }
      if (chunk.error?.message) throw new GroqError(500, chunk.error.message);
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta?.content;
      if (delta) { stepText += delta; text += delta; h.onText(delta); }
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
    return { stepText, finish, toolCalls };
  };

  try {
    for (let n = 0; n < maxSteps; n++) {
      if (signal.aborted) throw abortError();
      const { stepText, finish, toolCalls } = await step();
      if (!tools || !toolCalls.length) {
        history.push({ role: 'assistant', content: stepText });
        return { text, sources: [...sources.values()], truncated: finish === 'length' };
      }
      history.push({
        role: 'assistant',
        content: stepText,
        tool_calls: toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
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
