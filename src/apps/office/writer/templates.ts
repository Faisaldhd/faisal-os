/**
 * Writer — templates (القوالب).
 *
 * A template is an ordinary `.docx` that lives in one folder of Fai$al OS's own file system: no new
 * format, so a template can be opened, copied to a USB stick or mailed like any other document, and
 * "new from template" is a plain copy whose bytes the editor then owns (the template itself is never
 * written to).
 *
 * Everything here is pure — naming, collision, the built-in template and extracting a template from
 * an open document — so the rules can be tested without a file system, and the window only has to
 * read and write the paths this module produces.
 */
import type { DocModel } from '../model';
import type { DocBlock } from './types';

/** One folder, so the list is never ambiguous and nothing else is mistaken for a template. */
export const TEMPLATES_DIR = '/home/user/Templates';
export const TEMPLATE_EXT = 'docx';
/** The name the built-in template is created with (the owner sees the label, this is the file). */
export const DEFAULT_TEMPLATE_BASE = 'Template';
export const TEMPLATE_NAME_MAX = 48;

/** Characters a file name may not carry on any of the systems these files travel to. */
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[\u0000-\u001f\u007f/\\:*?"<>|]/g;

/**
 * A name that is safe as a file and still readable: control characters and path separators become
 * spaces, runs of whitespace collapse, dots at the ends go (they hide extensions), and the result is
 * capped. An empty result falls back, so a template can never be created without a name.
 */
export function safeTemplateName(raw: unknown, fallback = DEFAULT_TEMPLATE_BASE): string {
  const text = typeof raw === 'string' ? raw : '';
  const clean = text
    .replace(ILLEGAL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, TEMPLATE_NAME_MAX)
    .trim();
  return clean || fallback;
}

/** The file a template with this name lives in. */
export function templatePath(name: string): string {
  return `${TEMPLATES_DIR}/${safeTemplateName(name)}.${TEMPLATE_EXT}`;
}

/** The label a person reads for a template file. */
export function templateLabel(fileNameOrPath: string): string {
  const base = (fileNameOrPath ?? '').slice((fileNameOrPath ?? '').lastIndexOf('/') + 1);
  return base.toLowerCase().endsWith(`.${TEMPLATE_EXT}`) ? base.slice(0, -(TEMPLATE_EXT.length + 1)) : base;
}

export function isTemplatePath(path: string): boolean {
  const p = path ?? '';
  return p.startsWith(`${TEMPLATES_DIR}/`) && p.toLowerCase().endsWith(`.${TEMPLATE_EXT}`);
}

/**
 * A name that does not collide with the ones already there: `Report`, `Report 2`, `Report 3` …
 * Case-insensitive, because two files differing only in case are a trap on the systems these files
 * travel to.
 */
export function uniqueTemplateName(existing: readonly string[], base: string): string {
  const wanted = safeTemplateName(base);
  const taken = new Set(existing.map((n) => templateLabel(n).toLowerCase()));
  if (!taken.has(wanted.toLowerCase())) return wanted;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${wanted} ${n}`.slice(0, TEMPLATE_NAME_MAX).trim();
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${wanted} ${Date.now().toString(36)}`.slice(0, TEMPLATE_NAME_MAX);
}

/** The templates a folder listing offers, in the order a person expects to read them. */
export function templatesIn(paths: readonly string[]): { path: string; name: string }[] {
  return paths
    .filter((p) => isTemplatePath(p))
    .map((p) => ({ path: p, name: templateLabel(p) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ar'));
}

/**
 * The built-in template, so the list is never empty on a first visit: a heading and a line telling
 * the reader what to do. It is ordinary content — editing the copy changes nothing here.
 */
export function defaultTemplateLines(): string[] {
  return ['عنوان المستند', 'اكتب هنا…'];
}

export function defaultTemplateBlocks(): DocBlock[] {
  return defaultTemplateLines().map((line, i) => ({
    id: i,
    runs: [{ t: 'text' as const, text: line, props: i === 0 ? { b: true, sz: 18 } : {} }],
  }));
}

/**
 * A template taken from the document that is open: its content and formatting, without the tracked
 * changes and pending revisions that belong to that document's own review (a template is a starting
 * point, not a record of who changed what).
 */
export function templateFromDocument(model: DocModel): DocModel {
  const blocks = (model.blocks ?? []).map((b) => ({ ...b, runs: [...b.runs] }));
  return {
    kind: 'docx',
    paragraphs: blocks.length ? blocks.map((b) => b.runs.map((r) => r.text).join('')) : model.paragraphs.slice(),
    ...(blocks.length ? { blocks } : {}),
    ...(model.formats ? { formats: { ...model.formats } } : {}),
  };
}

/** The name a new document gets when it is created from a template. */
export function newDocumentName(existing: readonly string[], base: string): string {
  return uniqueTemplateName(existing, safeTemplateName(base));
}
