/**
 * Writer — the rich document model (نموذج المستند الغني).
 *
 * A Word paragraph is a list of runs. A *text* run carries its characters and
 * the run properties this app can edit (bold, italic, colour, size…) plus the
 * raw `<w:rPr>` it was read from, so everything the app does not model — a
 * complex-script hint, a language tag, a kerning value — is written back exactly
 * as it was. An *opaque* run is everything else that lives in a paragraph (an
 * image, a hyperlink, a field, a bookmark): the editor shows it and can delete it
 * as a unit, and the save writes its original XML back verbatim.
 *
 * Every paragraph has a stable `id`, which is how the save knows which paragraph
 * of the file an edited, split, merged or new paragraph corresponds to.
 */

/** The run properties the editor can change. `undefined` = inherited from the style. */
export interface RunProps {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  strike?: boolean;
  /** Text colour as RRGGBB. */
  color?: string;
  /** Word highlight name (`yellow`, `green`, …). */
  hl?: string;
  /** Font size in points. */
  sz?: number;
  font?: string;
  /** A right-to-left (complex-script) run: `<w:rtl/>`. */
  rtl?: boolean;
  va?: 'superscript' | 'subscript';
}

export const RUN_KEYS = ['b', 'i', 'u', 'strike', 'color', 'hl', 'sz', 'font', 'rtl', 'va'] as const;
export type RunKey = typeof RUN_KEYS[number];

export interface TextRun {
  t: 'text';
  text: string;
  /** Direct formatting (what the run's `<w:rPr>` says, as edited). */
  props: RunProps;
  /** Formatting that comes from a character style: shown, never written. */
  styled?: RunProps;
  /** The run's original `<w:rPr>…</w:rPr>` markup, or '' when it had none. */
  rpr?: string;
  /** What `rpr` itself says, as run properties: the save writes only what differs from it. */
  base?: RunProps;
  /** The index of the original run element in its paragraph (for the save). */
  src?: number;
}

export interface ImageInfo {
  /** Relationship id of the picture in the part it came from. */
  rid?: string;
  /** Display size in points. */
  w: number;
  h: number;
  /** Floating picture (`wp:anchor`) and the side the text wraps around. */
  float?: 'start' | 'end' | 'none';
  alt?: string;
}

export interface NewImage { data: Uint8Array; ext: 'png' | 'jpeg' | 'gif'; w: number; h: number; name: string }

export interface OpaqueRun {
  t: 'opaque';
  /** The text this element contributes to the paragraph (a hyperlink's words, a page break's "\n"). */
  text: string;
  /** Original markup, written back verbatim; '' for a new element the save generates. */
  xml: string;
  kind: 'image' | 'link' | 'field' | 'break' | 'page' | 'mark' | 'note' | 'object';
  image?: ImageInfo;
  /** A picture inserted in this session: its bytes travel with the model until saved. */
  newImage?: NewImage;
  src?: number;
}

export type Run = TextRun | OpaqueRun;

/** A cell of a table inserted in this session. */
export interface NewCell { table: number; row: number; col: number; rows: number; cols: number; rtl?: boolean }

export interface DocBlock {
  id: number;
  runs: Run[];
  /** A new paragraph copies its paragraph and run properties from this paragraph id. */
  tpl?: number;
  /** A paragraph of a table inserted in this session. */
  cell?: NewCell;
  /** The file's structure around it cannot be rewritten (a text-box host). */
  locked?: boolean;
}

/** Plain text of a paragraph: exactly what the viewer's reader returns for it. */
export function blockText(block: DocBlock): string {
  let out = '';
  for (const run of block.runs) out += run.text;
  return out;
}
