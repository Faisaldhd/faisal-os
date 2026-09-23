import type { Source, TurnHandlers, TurnResult } from './chat';

/** Always the newest Flash model; it is on Google's free tier. */
export const GEMINI_MODEL = 'gemini-flash-latest';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse`;

export interface GeminiContent { role: 'user' | 'model'; parts: { text: string }[] }

const SYSTEM =
  'You are Faisal AI, the assistant built into Fai$al OS, a desktop that runs in the web browser. ' +
  'You are powered by Gemini, made by Google; say so if asked what model you are. ' +
  'Reply in the language the user writes in (Arabic or English). ' +
  'Use Google Search for anything current or that you are unsure of, and read any link the user gives you. ' +
  'Keep answers clear and well organized; use Markdown for lists, code and headings.';

/** HTTP error from the Gemini API; `status` drives the message the user sees. */
export class GeminiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'GeminiError';
  }
}

interface Chunk {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean }[] };
    finishReason?: string;
    groundingMetadata?: {
      webSearchQueries?: string[];
      groundingChunks?: { web?: { uri?: string; title?: string } }[];
    };
  }[];
  promptFeedback?: { blockReason?: string };
}

/**
 * Runs one user turn against Gemini with Google Search and URL reading enabled.
 * `history` must already end with the user's message; the reply is appended to it,
 * and a blocked turn is rolled back (user message included).
 */
export async function runGeminiTurn(
  apiKey: string,
  history: GeminiContent[],
  h: TurnHandlers,
  signal: AbortSignal,
): Promise<TurnResult> {
  const start = history.length - 1;
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: history,
      tools: [{ google_search: {} }, { url_context: {} }],
    }),
    signal,
  });
  if (!res.ok || !res.body) {
    let message = `HTTP ${res.status}`;
    try { message = (await res.json())?.error?.message ?? message; } catch { /* keep the status text */ }
    throw new GeminiError(res.status, message);
  }

  let text = '';
  let finish = '';
  let blocked = false;
  const queries = new Set<string>();
  const sources = new Map<string, Source>();

  const onChunk = (c: Chunk) => {
    if (c.promptFeedback?.blockReason) blocked = true;
    const cand = c.candidates?.[0];
    if (!cand) return;
    for (const p of cand.content?.parts ?? []) {
      if (p.text && !p.thought) { text += p.text; h.onText(p.text); }
    }
    if (cand.finishReason) finish = cand.finishReason;
    const g = cand.groundingMetadata;
    for (const q of g?.webSearchQueries ?? []) {
      if (!queries.has(q)) { queries.add(q); h.onTool('web_search', q); }
    }
    for (const gc of g?.groundingChunks ?? []) {
      const uri = gc.web?.uri;
      if (uri && !sources.has(uri)) sources.set(uri, { url: uri, title: gc.web?.title ?? '' });
    }
  };

  for await (const data of sseData(res.body)) {
    try { onChunk(JSON.parse(data) as Chunk); } catch { /* ignore a malformed chunk */ }
  }

  if (blocked || finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT' || finish === 'BLOCKLIST') {
    history.length = start;
    return { text, sources: [], refused: true, truncated: false };
  }
  history.push({ role: 'model', parts: [{ text }] });
  return { text, sources: [...sources.values()], refused: false, truncated: finish === 'MAX_TOKENS' };
}

/** Yields the `data:` payloads of a server-sent-events stream. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    buf += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let i: number;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const event = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
      const data = event.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (data) yield data;
    }
    if (done) break;
  }
  const tail = buf.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
  if (tail) yield tail;
}
