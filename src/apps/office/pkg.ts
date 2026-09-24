/**
 * Office — small, exact edits to an OOXML package's bookkeeping parts
 * (`[Content_Types].xml` and `*.rels`), used when a save adds a part: a picture,
 * a numbering definition, a new slide. Each helper edits the markup as text and
 * leaves everything it does not need to touch byte-for-byte as it was.
 */
import { attr, elements, localName, parsePart } from './xmlscan';
import { xmlText } from './xml';

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
export const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
export const REL_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Inserts `markup` just before the root element's closing tag. */
function appendToRoot(xml: string, rootName: string, markup: string): string {
  const doc = parsePart(xml);
  const root = doc.roots.find((r) => localName(r.name) === rootName);
  if (!root) throw new Error(`pkg: no <${rootName}> root`);
  if (root.selfClosing) {
    const open = xml.slice(root.start, root.end - 2).trimEnd();
    return `${xml.slice(0, root.start)}${open}>${markup}</${root.name}>${xml.slice(root.end)}`;
  }
  const close = xml.lastIndexOf('<', root.end - 1);
  return `${xml.slice(0, close)}${markup}${xml.slice(close)}`;
}

/** `[Content_Types].xml` with a `<Default>` for this extension (when it has none). */
export function ensureDefault(xml: string, ext: string, mime: string): string {
  const doc = parsePart(xml);
  const has = elements(doc, 'Default').some((d) => (attr(xml, d, 'Extension') ?? '').toLowerCase() === ext.toLowerCase());
  return has ? xml : appendToRoot(xml, 'Types', `<Default Extension="${xmlText(ext)}" ContentType="${xmlText(mime)}"/>`);
}

/** `[Content_Types].xml` with an `<Override>` for this part (replacing a stale one). */
export function ensureOverride(xml: string, partName: string, contentType: string): string {
  const doc = parsePart(xml);
  const found = elements(doc, 'Override').find((o) => attr(xml, o, 'PartName') === partName);
  if (found && attr(xml, found, 'ContentType') === contentType) return xml;
  const markup = `<Override PartName="${xmlText(partName)}" ContentType="${xmlText(contentType)}"/>`;
  if (found) return `${xml.slice(0, found.start)}${markup}${xml.slice(found.end)}`;
  return appendToRoot(xml, 'Types', markup);
}

/** `[Content_Types].xml` without the `<Override>` of a removed part. */
export function removeOverride(xml: string, partName: string): string {
  const doc = parsePart(xml);
  const found = elements(doc, 'Override').find((o) => attr(xml, o, 'PartName') === partName);
  return found ? `${xml.slice(0, found.start)}${xml.slice(found.end)}` : xml;
}

/** The `_rels/…rels` path of a part: `word/document.xml` → `word/_rels/document.xml.rels`. */
export function relsPathOf(part: string): string {
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}

/** An empty relationships part. */
export function emptyRels(): string {
  return `${DECL}<Relationships xmlns="${RELS_NS}"></Relationships>`;
}

/** The relationship ids a rels part already uses. */
export function relIds(xml: string): Set<string> {
  const doc = parsePart(xml);
  return new Set(elements(doc, 'Relationship').map((r) => attr(xml, r, 'Id') ?? ''));
}

/** A fresh id that does not collide with any id in `taken`: rId<N>. */
export function freshRelId(taken: Set<string>): string {
  let n = taken.size + 1;
  while (taken.has(`rId${n}`)) n++;
  taken.add(`rId${n}`);
  return `rId${n}`;
}

/** Adds a relationship and returns the new part text with its id. */
export function addRelationship(xml: string | null, type: string, target: string): { xml: string; id: string } {
  const base = xml ?? emptyRels();
  const id = freshRelId(relIds(base));
  const markup = `<Relationship Id="${id}" Type="${REL_BASE}/${type}" Target="${xmlText(target)}"/>`;
  return { xml: appendToRoot(base, 'Relationships', markup), id };
}

/** Removes the relationships matching a predicate (by type suffix and target). */
export function removeRelationships(xml: string, match: (type: string, target: string, id: string) => boolean): string {
  const doc = parsePart(xml);
  const doomed = elements(doc, 'Relationship').filter((r) => match((attr(xml, r, 'Type') ?? '').split('/').pop() ?? '', attr(xml, r, 'Target') ?? '', attr(xml, r, 'Id') ?? ''));
  let out = xml;
  for (const r of doomed.sort((a, b) => b.start - a.start)) out = `${out.slice(0, r.start)}${out.slice(r.end)}`;
  return out;
}

export const MIME_OF: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', gif: 'image/gif' };
