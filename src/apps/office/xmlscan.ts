/**
 * Office — a tiny XML scanner for surgical part edits (ماسح XML صغير).
 *
 * Reading a part is the viewer's job, and it uses DOMParser — right for reading.
 * Patching a part cannot use it: serializing a parsed document rewrites the whole
 * file (prefixes, attribute order, self-closing tags, entities), and the point of
 * this app's save is that everything the owner did not edit stays exactly as it
 * was. So this module only *locates* elements — their offsets in the original
 * string — and the patcher splices that string itself.
 *
 * It is not a general XML parser. It understands what OOXML parts actually
 * contain (elements, quoted attributes, comments, CDATA, processing instructions,
 * DOCTYPE) and treats everything else as text it must not touch. Its traversal
 * rules are deliberately the same ones the viewer's `paragraphText` and
 * `paragraphs` use, so an index from the reader picks the same element here.
 */

export interface XmlElement {
  /** The tag name as written, prefix included ("w:p", "a:t"). */
  name: string;
  /** Offset of '<'. */
  start: number;
  /** Offset just past the '>' of the opening tag. */
  openEnd: number;
  /** Offset just past the closing tag (=== openEnd when self-closing). */
  end: number;
  selfClosing: boolean;
  parent: XmlElement | null;
  children: XmlElement[];
}

export interface XmlDoc {
  xml: string;
  /** The outermost elements, in document order (normally one root). */
  roots: XmlElement[];
}

/** "w:p" → "p"; a name without a prefix is returned as it is. */
export function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(colon + 1);
}

/** The offset of the '>' that closes a tag, skipping quoted attribute values. */
function tagEnd(xml: string, from: number): number {
  let quote = '';
  for (let i = from + 1; i < xml.length; i++) {
    const ch = xml[i];
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '>') return i;
  }
  return -1;
}

/** Scans a part into an element tree of offsets. Text nodes stay in `xml`. */
export function parsePart(xml: string): XmlDoc {
  const roots: XmlElement[] = [];
  const stack: XmlElement[] = [];
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) break;
    if (xml.startsWith('<!--', lt)) { const end = xml.indexOf('-->', lt + 4); i = end < 0 ? xml.length : end + 3; continue; }
    if (xml.startsWith('<![CDATA[', lt)) { const end = xml.indexOf(']]>', lt + 9); i = end < 0 ? xml.length : end + 3; continue; }
    if (xml.startsWith('<?', lt)) { const end = xml.indexOf('?>', lt + 2); i = end < 0 ? xml.length : end + 2; continue; }
    if (xml.startsWith('<!', lt)) { const end = xml.indexOf('>', lt + 2); i = end < 0 ? xml.length : end + 1; continue; }

    const gt = tagEnd(xml, lt);
    if (gt < 0) break;
    if (xml[lt + 1] === '/') {
      const open = stack.pop();
      if (open) open.end = gt + 1;
      i = gt + 1;
      continue;
    }
    let nameEnd = lt + 1;
    while (nameEnd < gt && !/[\s/>]/.test(xml[nameEnd])) nameEnd++;
    const selfClosing = xml[gt - 1] === '/';
    const element: XmlElement = {
      name: xml.slice(lt + 1, nameEnd),
      start: lt,
      openEnd: gt + 1,
      end: selfClosing ? gt + 1 : -1,
      selfClosing,
      parent: stack.length ? stack[stack.length - 1] : null,
      children: [],
    };
    (element.parent ? element.parent.children : roots).push(element);
    if (!selfClosing) stack.push(element);
    i = gt + 1;
  }
  // Unbalanced tags cannot be repaired here: the element simply runs to the end,
  // and the patcher's own verification (the reader re-reads what it produced)
  // decides whether the part was understood.
  for (const element of stack) element.end = xml.length;
  return { xml, roots };
}

/** Every descendant of `root` whose local name matches, in document order. */
export function elementsOf(root: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (parent: XmlElement): void => {
    for (const child of parent.children) {
      if (localName(child.name) === name) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

/** Every element of the part with this local name, in document order. */
export function elements(doc: XmlDoc, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const root of doc.roots) {
    if (localName(root.name) === name) out.push(root);
    out.push(...elementsOf(root, name));
  }
  return out;
}

/** The value of one attribute of an element, or null when it has none. */
export function attr(xml: string, element: XmlElement, name: string): string | null {
  const open = xml.slice(element.start, element.openEnd);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|[\\s])${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(open);
  if (!match) return null;
  return match[1] ?? match[2] ?? '';
}

/**
 * The value of an attribute by its local name, whatever prefix it carries. OOXML
 * parts name their values `w:val`, but a part written by another tool may use a
 * different prefix; asking for "val" finds both, while still refusing to match a
 * longer name that merely ends with it (like `sheetId` for "id").
 */
export function attrLocal(xml: string, element: XmlElement, name: string): string | null {
  const open = xml.slice(element.start, element.openEnd);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|[\\s])(?:[\\w.-]+:)?${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(open);
  if (!match) return null;
  return match[1] ?? match[2] ?? '';
}

/**
 * A paragraph element as the patcher counts them: everything the viewer's
 * `paragraphs()` returns — every element named `p`, except those inside an
 * `mc:Fallback` copy, in document order.
 */
export function paragraphElements(doc: XmlDoc): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (element: XmlElement, inFallback: boolean): void => {
    for (const child of element.children) {
      const fallback = inFallback || localName(child.name) === 'Fallback';
      if (localName(child.name) === 'p') { if (!fallback) out.push(child); }
      walk(child, fallback);
    }
  };
  for (const root of doc.roots) walk(root, false);
  return out;
}

/** The pieces of a paragraph's text, in the reader's own order. */
export type TextSlot =
  | { kind: 'text'; element: XmlElement }
  | { kind: 'tab'; element: XmlElement }
  | { kind: 'break'; element: XmlElement };

/**
 * The text slots of a paragraph, walked exactly like the viewer's
 * `paragraphText`: `<t>` is text, `<tab>` is a tab, `<br>`/`<cr>` is a line
 * break, and a nested `<p>` (a text box) belongs to the paragraph it is listed
 * as, so it is skipped here.
 */
export function paragraphSlots(paragraph: XmlElement): TextSlot[] {
  const out: TextSlot[] = [];
  const walk = (element: XmlElement): void => {
    for (const child of element.children) {
      const local = localName(child.name);
      if (local === 'p') continue;
      if (local === 't') out.push({ kind: 'text', element: child });
      else if (local === 'tab') out.push({ kind: 'tab', element: child });
      else if (local === 'br' || local === 'cr') out.push({ kind: 'break', element: child });
      else walk(child);
    }
  };
  walk(paragraph);
  return out;
}

/** The text between an element's open and close tags, read from the original part. */
export function elementText(xml: string, element: XmlElement): string {
  const close = xml.indexOf('<', element.openEnd);
  const end = close < 0 || close > element.end ? element.end : close;
  return xml.slice(element.openEnd, end);
}

/** The plain text of one slot, read from the original part. */
function slotText(xml: string, slot: TextSlot): string {
  if (slot.kind === 'tab') return '\t';
  if (slot.kind === 'break') return '\n';
  return elementText(xml, slot.element);
}

/** The text a paragraph reads as — the scanner's answer, checked against the reader in the tests. */
export function paragraphText(xml: string, paragraph: XmlElement): string {
  return paragraphSlots(paragraph).map((slot) => slotText(xml, slot)).join('');
}

export interface XmlEdit {
  start: number;
  end: number;
  xml: string;
}

/** Splices edits into the original text; the caller guarantees disjoint ranges. */
export function applyEdits(xml: string, edits: readonly XmlEdit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  for (const edit of sorted) {
    if (edit.start < at || edit.end < edit.start) throw new Error('xml: overlapping edits');
    out += xml.slice(at, edit.start) + edit.xml;
    at = edit.end;
  }
  return out + xml.slice(at);
}
