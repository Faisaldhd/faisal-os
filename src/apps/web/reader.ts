/**
 * Fai$al OS — reader-mode text extraction (extraction النص لقارئ الوسيط).
 *
 * The proxy hands back the page as UTF-8 TEXT and does not inject anything; this
 * module is the client half that turns that text into blocks the window renders
 * with `textContent`. Nothing here uses `innerHTML`, `insertAdjacentHTML`,
 * `document.write` or `eval`: the parsed document is only ever READ.
 *
 * What is dropped: script, style, noscript, iframe, svg, template, form controls,
 * and any element that is hidden (`hidden`, `aria-hidden="true"`, or an inline
 * `display:none` / `visibility:hidden`).
 *
 * What is kept: headings, paragraphs and list items, in document order, with
 * whitespace collapsed. Blocks are capped in NUMBER and in LENGTH, because the
 * page is untrusted and a 5 MB document must not become 5 MB of DOM.
 */

/** Hard caps: a proxied page is untrusted input, so the extraction is bounded. */
export const MAX_READER_BLOCKS = 800;
export const MAX_BLOCK_CHARS = 4000;
export const MAX_TITLE_CHARS = 300;

export interface ReaderDoc {
  title: string;
  blocks: string[];
}

/** Extracted together so the caps are testable without a DOM. */
export const READER_LIMITS = {
  maxBlocks: MAX_READER_BLOCKS,
  maxBlockChars: MAX_BLOCK_CHARS,
  maxTitleChars: MAX_TITLE_CHARS,
} as const;

/** Elements that never contribute readable text. */
const DROP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'SVG', 'TEMPLATE',
  'HEAD', 'META', 'LINK', 'TITLE',
  'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'OPTION',
  'CANVAS', 'VIDEO', 'AUDIO', 'OBJECT', 'EMBED', 'MAP', 'AREA',
]);

/** Elements whose text is a block of its own. */
const BLOCK_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'DT', 'DD',
  'BLOCKQUOTE', 'PRE', 'FIGCAPTION', 'TD', 'TH', 'SUMMARY', 'TR',
]);

/** Inline continuations of the block currently being built. */
const INLINE_TAGS = new Set([
  'A', 'B', 'I', 'EM', 'STRONG', 'CODE', 'SPAN', 'SMALL', 'MARK', 'U', 'S',
  'SUB', 'SUP', 'ABBR', 'CITE', 'Q', 'TIME', 'LABEL', 'BDI', 'BDO', 'WBR', 'BR', 'FONT', 'KBD', 'SAMP', 'VAR',
]);

/** Collapse every run of whitespace (including NBSP) to a single space. */
export function collapseWhitespace(text: string): string {
  return String(text ?? '').replace(/[\s\u00a0\u200b\ufeff]+/g, ' ').trim();
}

/** Is this element hidden from the reader? Inline style strings are matched literally. */
function isHidden(el: Element): boolean {
  if (el.hasAttribute('hidden')) return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;
  const style = el.getAttribute('style');
  if (!style) return false;
  // Read the declared text, never `el.style` — that would touch the CSSOM of an
  // attacker-controlled document just to decide whether to skip it.
  const s = style.toLowerCase();
  return s.includes('display:none')
    || s.includes('display: none')
    || s.includes('visibility:hidden')
    || s.includes('visibility: hidden');
}

/** Guard against a pathological document: the walk is bounded. */
const MAX_WALK_NODES = 200_000;

/**
 * Turn an HTML string into `{ title, blocks }`.
 *
 * `doc` is injected so a caller can pass a detached `DOMParser` document (and a
 * test can pass one too); the default parses with `DOMParser` in text/html mode.
 * This function NEVER throws on malformed input: a parse failure returns an
 * empty result, because a page we cannot read is not a reason to break the window.
 */
export function htmlToText(html: string, doc?: Document): ReaderDoc {
  const empty: ReaderDoc = { title: '', blocks: [] };
  let parsed: Document;
  if (doc) {
    parsed = doc;
  } else {
    if (typeof DOMParser === 'undefined') return empty;
    try {
      parsed = new DOMParser().parseFromString(String(html ?? ''), 'text/html');
    } catch {
      return empty;
    }
  }

  let root: Element;
  try {
    root = parsed.body ?? parsed.documentElement;
  } catch {
    return empty;
  }
  if (!root) return empty;

  // Title: read it, collapse it, cap it. Never rendered as markup.
  let title = '';
  try {
    const raw = parsed.title ?? parsed.querySelector?.('title')?.textContent ?? '';
    title = collapseWhitespace(raw).slice(0, MAX_TITLE_CHARS);
  } catch {
    title = '';
  }

  const blocks: string[] = [];
  let current = '';
  let visited = 0;

  /** Flush the block in progress, respecting both caps. */
  const flush = () => {
    const text = collapseWhitespace(current);
    current = '';
    if (!text) return;
    if (blocks.length >= MAX_READER_BLOCKS) return;
    blocks.push(text.length > MAX_BLOCK_CHARS ? text.slice(0, MAX_BLOCK_CHARS) : text);
  };

  const walk = (node: Node): void => {
    if (visited >= MAX_WALK_NODES || blocks.length >= MAX_READER_BLOCKS) return;
    visited += 1;

    if (node.nodeType === 3 /* text */) {
      current += node.nodeValue ?? '';
      return;
    }
    if (node.nodeType !== 1 /* element */) return;

    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (DROP_TAGS.has(tag)) return;
    if (isHidden(el)) return;

    const block = BLOCK_TAGS.has(tag);
    if (block) flush();

    if (tag === 'BR') {
      current += ' ';
      return;
    }

    for (const child of Array.from(el.childNodes)) {
      if (blocks.length >= MAX_READER_BLOCKS) break;
      walk(child);
    }

    // A block element ends the block it produced. Inline elements do not, so a
    // sentence split across <a>/<b> stays one block.
    if (block) flush();
    else if (!INLINE_TAGS.has(tag)) {
      // An unknown/container element: treat a non-empty result as its own block
      // so a bare <div>full text</div> is still readable.
      const text = collapseWhitespace(current);
      if (text) flush();
    }
  };

  for (const child of Array.from(root.childNodes)) {
    if (blocks.length >= MAX_READER_BLOCKS) break;
    walk(child);
  }
  flush();

  return { title, blocks };
}
