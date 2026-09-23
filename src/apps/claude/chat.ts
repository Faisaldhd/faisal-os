import type Anthropic from '@anthropic-ai/sdk';

export type ChatMessage = Anthropic.Beta.BetaMessageParam;

export const MODEL = 'claude-opus-5';
const MAX_CONTINUATIONS = 5;

/** Server-side tools: the searches and page fetches run on Anthropic's servers, not in the browser. */
const TOOLS: Anthropic.Beta.BetaToolUnion[] = [
  { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
  { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 5 },
];

const SYSTEM =
  'You are Faisal AI, the assistant built into Fai$al OS, a desktop that runs in the web browser. ' +
  'You are powered by Claude, made by Anthropic; say so if asked what model you are. ' +
  'Reply in the language the user writes in (Arabic or English). ' +
  'Use web search for anything current or that you are unsure of, and web fetch to read a link the user gives you. ' +
  'Keep answers clear and well organized; use Markdown for lists, code and headings.';

export interface Source { url: string; title: string }

export interface TurnHandlers {
  onText(delta: string): void;
  onTool(name: 'web_search' | 'web_fetch', detail: string): void;
}

export interface TurnResult {
  text: string;
  sources: Source[];
  refused: boolean;
  truncated: boolean;
}

/** The SDK is loaded on first use so it stays out of the desktop's startup bundle. */
export async function createClient(apiKey: string): Promise<Anthropic> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  // The key is the user's own and never leaves their browser except to api.anthropic.com.
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
}

/**
 * Runs one user turn. `history` must already end with the user's message; the assistant's
 * reply is appended to it. A refused turn is rolled back (user message included) so the
 * conversation can carry on.
 */
export async function runTurn(
  client: Anthropic,
  history: ChatMessage[],
  h: TurnHandlers,
  signal: AbortSignal,
): Promise<TurnResult> {
  const start = history.length - 1;
  let text = '';
  const sources = new Map<string, Source>();

  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    const stream = client.beta.messages.stream(
      {
        model: MODEL,
        max_tokens: 64000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        cache_control: { type: 'ephemeral' },
        system: SYSTEM,
        tools: TOOLS,
        messages: history,
      },
      { signal },
    );

    stream.on('contentBlock', (block) => {
      if (block.type === 'server_tool_use' && (block.name === 'web_search' || block.name === 'web_fetch')) {
        const input = block.input as { query?: unknown; url?: unknown };
        h.onTool(block.name, String(input.query ?? input.url ?? ''));
      } else if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        for (const r of block.content) if (!sources.has(r.url)) sources.set(r.url, { url: r.url, title: r.title });
      }
    });

    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
        text += ev.delta.text;
        h.onText(ev.delta.text);
      }
    }

    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') {
      history.length = start;
      return { text, sources: [], refused: true, truncated: false };
    }
    history.push({ role: 'assistant', content: msg.content as Anthropic.Beta.BetaContentBlockParam[] });
    // The server paused a long search loop; sending the history back resumes it.
    if (msg.stop_reason === 'pause_turn') continue;
    return { text, sources: [...sources.values()], refused: false, truncated: msg.stop_reason === 'max_tokens' };
  }
  return { text, sources: [...sources.values()], refused: false, truncated: true };
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(s: string): string {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

/**
 * Small, safe Markdown subset for chat replies: fenced code, headings, bullet and numbered
 * lists, bold, inline code, and http(s) links. Everything is HTML-escaped first, so the only
 * markup in the output is what this function writes.
 */
export function renderMarkdown(src: string): string {
  const out: string[] = [];
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  let list: 'ul' | 'ol' | null = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      closeList();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) code.push(lines[i]);
      out.push(`<pre dir="ltr"><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (h) { closeList(); out.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`); }
    else if (ul || ol) {
      const kind = ul ? 'ul' : 'ol';
      if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline((ul ?? ol)![1])}</li>`);
    } else if (line.trim() === '') closeList();
    else { closeList(); out.push(`<p>${inline(line)}</p>`); }
  }
  closeList();
  return out.join('');
}
