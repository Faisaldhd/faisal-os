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
export interface ChatTurn { role: 'user' | 'assistant'; content: string }

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

interface ExecutedTool {
  type?: string;
  arguments?: string;
  search_results?: { results?: { title?: string; url?: string }[] };
}
interface Chunk {
  choices?: {
    delta?: { content?: string | null; executed_tools?: ExecutedTool[] };
    message?: { executed_tools?: ExecutedTool[] };
    finish_reason?: string | null;
  }[];
  error?: { message?: string };
}

/**
 * Runs one user turn. `history` must already end with the user's message; the reply
 * is appended to it when the turn completes.
 */
export async function runGroqTurn(
  apiKey: string,
  model: string,
  history: ChatTurn[],
  h: TurnHandlers,
  signal: AbortSignal,
): Promise<TurnResult> {
  const res = await fetch(`${API}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [{ role: 'system', content: systemPrompt(model) }, ...history],
    }),
    signal,
  });
  if (!res.ok || !res.body) await fail(res);

  let text = '';
  let finish = '';
  const seenTools = new Set<string>();
  const sources = new Map<string, Source>();

  const onTools = (tools: ExecutedTool[] | undefined) => {
    for (const tool of tools ?? []) {
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

  for await (const data of sseData(res.body!)) {
    if (data === '[DONE]') break;
    let chunk: Chunk;
    try { chunk = JSON.parse(data) as Chunk; } catch { continue; }
    if (chunk.error?.message) throw new GroqError(500, chunk.error.message);
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta?.content;
    if (delta) { text += delta; h.onText(delta); }
    onTools(choice.delta?.executed_tools);
    onTools(choice.message?.executed_tools);
    if (choice.finish_reason) finish = choice.finish_reason;
  }

  history.push({ role: 'assistant', content: text });
  return { text, sources: [...sources.values()], truncated: finish === 'length' };
}
