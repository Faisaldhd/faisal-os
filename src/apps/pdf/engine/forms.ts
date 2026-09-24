/**
 * PDF engine — AcroForm fields (قراءة حقول النماذج وتعبئتها وتسطيحها).
 *
 * Lists every fillable field with the page and rectangle of each of its widgets (so the UI can
 * draw inputs over the page), fills text / checkbox / radio / dropdown / list values, and
 * flattens the form into page content.
 *
 * A value only SHOWS when the widget's appearance stream is rebuilt. pdf-lib builds it with
 * Helvetica, which cannot encode Arabic, so for a value that needs Unicode the engine writes
 * the appearance itself with the shared Arabic-aware layout, and tells pdf-lib not to redo it.
 */
import {
  PDFCheckBox, PDFDropdown, PDFName, PDFOptionList, PDFRadioGroup, PDFRef, PDFTextField, StandardFonts,
  type PDFDocument, type PDFField, type PDFForm, type PDFWidgetAnnotation,
} from 'pdf-lib';
import type { OpResult } from '../pdfdoc';
import { needsUnicodeFont } from './arabic';
import { EngineRefusal, num, pageContent, round2, runOp, type Box } from './common';
import { blockOperators, embedTextFonts, fontResources } from './text';

export type FieldKind = 'text' | 'checkbox' | 'radio' | 'dropdown' | 'list';

export interface FieldWidget {
  page: number;
  rect: Box;
  /** Radio: the export value this widget selects. */
  option?: string;
}

export interface FieldInfo {
  name: string;
  kind: FieldKind;
  /** Page / rect of the first widget (−1 / zero box when the field has none on a page). */
  page: number;
  rect: Box;
  /** text/dropdown/radio: the string (radio '' when none); list: selections joined by ', '; checkbox: boolean. */
  value: string | boolean;
  options?: string[];
  readOnly: boolean;
  multiline: boolean;
  /** Extension: every widget (radios have one per option). */
  widgets: FieldWidget[];
}

export interface FieldFill { name: string; value: string | boolean }

const flag = (fn: () => boolean): boolean => {
  try { return fn(); } catch { return false; }
};

function kindOf(field: PDFField): FieldKind | null {
  if (field instanceof PDFTextField) return 'text';
  if (field instanceof PDFCheckBox) return 'checkbox';
  if (field instanceof PDFRadioGroup) return 'radio';
  if (field instanceof PDFDropdown) return 'dropdown';
  if (field instanceof PDFOptionList) return 'list';
  return null;
}

/** The page a widget lives on: its /P, else a search of every page's /Annots. */
function pageOfWidget(doc: PDFDocument, widget: PDFWidgetAnnotation, widgetRef: PDFRef | undefined): number {
  const pages = doc.getPages();
  const p = widget.P();
  if (p) {
    const i = pages.findIndex((pg) => pg.ref === p || pg.ref.toString() === p.toString());
    if (i >= 0) return i;
  }
  if (!widgetRef) return -1;
  return pages.findIndex((pg) => {
    const annots = pg.node.Annots();
    return !!annots && annots.asArray().some((o) => o instanceof PDFRef && o.toString() === widgetRef.toString());
  });
}

function widgetRefs(doc: PDFDocument, field: PDFField): (PDFRef | undefined)[] {
  // pdf-lib keeps the widgets as dicts; find each one's ref in the context.
  const widgets = field.acroField.getWidgets();
  const kids = field.acroField.Kids();
  if (kids) return widgets.map((_, i) => { const k = kids.get(i); return k instanceof PDFRef ? k : undefined; });
  return widgets.map(() => field.ref);
}

function widgetsOf(doc: PDFDocument, field: PDFField): FieldWidget[] {
  const refs = widgetRefs(doc, field);
  const radio = field instanceof PDFRadioGroup;
  return field.acroField.getWidgets().map((w, i) => {
    const r = w.getRectangle();
    const out: FieldWidget = { page: pageOfWidget(doc, w, refs[i]), rect: { x: round2(r.x), y: round2(r.y), width: round2(r.width), height: round2(r.height) } };
    if (radio) {
      const on = w.getOnValue();
      if (on) out.option = on.decodeText();
    }
    return out;
  });
}

function infoOf(doc: PDFDocument, field: PDFField): FieldInfo | null {
  const kind = kindOf(field);
  if (!kind) return null;
  const widgets = widgetsOf(doc, field);
  const first = widgets[0] ?? { page: -1, rect: { x: 0, y: 0, width: 0, height: 0 } };
  let value: string | boolean = '';
  let options: string[] | undefined;
  let multiline = false;
  if (field instanceof PDFTextField) {
    value = (() => { try { return field.getText() ?? ''; } catch { return ''; } })();
    multiline = flag(() => field.isMultiline());
  } else if (field instanceof PDFCheckBox) {
    value = flag(() => field.isChecked());
  } else if (field instanceof PDFRadioGroup) {
    options = (() => { try { return field.getOptions(); } catch { return []; } })();
    value = (() => { try { return field.getSelected() ?? ''; } catch { return ''; } })();
  } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
    options = (() => { try { return field.getOptions(); } catch { return []; } })();
    const selected = (() => { try { return field.getSelected(); } catch { return []; } })();
    value = field instanceof PDFDropdown ? (selected[0] ?? '') : selected.join(', ');
  }
  return {
    name: field.getName(), kind, page: first.page, rect: first.rect, value, options,
    readOnly: flag(() => field.isReadOnly()), multiline, widgets,
  };
}

/** Reads the fields of an already-open document. */
export function readFields(doc: PDFDocument): FieldInfo[] {
  if (!doc.catalog.getAcroForm()) return [];
  return doc.getForm().getFields().map((f) => infoOf(doc, f)).filter((f): f is FieldInfo => !!f);
}

/** Every fillable field (buttons and signature fields are left out). An unreadable file lists nothing. */
export async function listFields(bytes: Uint8Array): Promise<FieldInfo[]> {
  try {
    const { PDFDocument: Doc } = await import('pdf-lib');
    const doc = await Doc.load(bytes, { updateMetadata: false });
    return readFields(doc);
  } catch {
    return [];
  }
}

/**
 * Writes a Unicode-aware appearance for a text-like field (text or dropdown) on every widget:
 * the value laid out with the shared Arabic layout, right-aligned when it reads right-to-left.
 */
async function unicodeAppearance(doc: PDFDocument, field: PDFTextField | PDFDropdown, value: string, fontBytes: Uint8Array | undefined): Promise<void> {
  const fonts = await embedTextFonts(doc, value, fontBytes);
  const multiline = field instanceof PDFTextField && flag(() => field.isMultiline());
  for (const w of field.acroField.getWidgets()) {
    const r = w.getRectangle();
    const { dict, keys } = fontResources(fonts);
    const pad = 2;
    const size = multiline ? 11 : Math.max(6, Math.min(12, r.height * 0.62));
    const top = multiline ? r.y + r.height - pad - size : r.y + (r.height - size) / 2 + size * 0.22;
    const block = blockOperators(fonts, keys, value, {
      x: r.x + pad, y: top, size, color: { r: 0, g: 0, b: 0 }, maxWidth: Math.max(1, r.width - 2 * pad),
    });
    const content = [
      '/Tx BMC q',
      `${num(r.x + 1)} ${num(r.y + 1)} ${num(Math.max(0, r.width - 2))} ${num(Math.max(0, r.height - 2))} re W n`,
      ...block.ops.map((o) => o.toString()),
      'Q EMC',
    ].join('\n');
    const stream = doc.context.flateStream(content, {
      Type: 'XObject', Subtype: 'Form', FormType: 1,
      BBox: [r.x, r.y, r.x + r.width, r.y + r.height],
      Resources: { Font: dict } as never,
    });
    w.setNormalAppearance(doc.context.register(stream));
  }
}

/** Sets one field; returns what the reload must show, or null when the field was skipped. */
async function fillOne(doc: PDFDocument, form: PDFForm, fill: FieldFill, fontBytes: Uint8Array | undefined, helv: Awaited<ReturnType<PDFDocument['embedFont']>>): Promise<boolean> {
  const field = form.getFieldMaybe(fill.name);
  if (!field || flag(() => field.isReadOnly())) return false;
  if (field instanceof PDFCheckBox) {
    if (fill.value === true || fill.value === 'true' || fill.value === 'on') field.check();
    else field.uncheck();
    field.defaultUpdateAppearances();
    return true;
  }
  const value = typeof fill.value === 'string' ? fill.value : String(fill.value);
  if (field instanceof PDFTextField) {
    field.setText(value);
    if (needsUnicodeFont(value)) await unicodeAppearance(doc, field, value, fontBytes);
    else field.defaultUpdateAppearances(helv);
    return true;
  }
  if (field instanceof PDFRadioGroup) {
    if (!value) { field.clear(); return true; }
    if (!field.getOptions().includes(value)) throw new EngineRefusal('unknown', `radio "${fill.name}" has no option "${value}"`);
    field.select(value);
    field.defaultUpdateAppearances();
    return true;
  }
  if (field instanceof PDFDropdown) {
    if (!value) field.clear();
    else field.select(value);
    if (needsUnicodeFont(value)) await unicodeAppearance(doc, field, value, fontBytes);
    else field.defaultUpdateAppearances(helv);
    return true;
  }
  if (field instanceof PDFOptionList) {
    const wanted = value ? value.split(/\s*,\s*/) : [];
    if (!wanted.length) field.clear();
    else field.select(wanted);
    if (needsUnicodeFont(value)) {
      if (!fontBytes) throw new EngineRefusal('textNotRenderable', `list "${fill.name}" needs the Unicode font`);
      // pdf-lib draws list boxes itself; with Unicode the reader is asked to draw them.
      const acro = doc.catalog.getAcroForm();
      acro?.dict.set(PDFName.of('NeedAppearances'), doc.context.obj(true));
    } else {
      field.defaultUpdateAppearances(helv);
    }
    return true;
  }
  return false;
}

function same(a: string | boolean, b: string | boolean): boolean {
  return a === b || String(a) === String(b);
}

/**
 * Fills fields by name. Read-only and unknown names are skipped; if nothing at all was written
 * the operation fails with `emptyResult`. Every written value is re-read from the saved bytes.
 * Arabic values need `opts.arabicFont`.
 */
export async function fillFields(bytes: Uint8Array, fills: readonly FieldFill[], opts: { arabicFont?: Uint8Array } = {}): Promise<OpResult> {
  if (!fills.length) return { ok: false, code: 'emptyResult', detail: 'no fields to fill' };
  const written: FieldFill[] = [];
  return runOp(bytes, async (doc) => {
    if (!doc.catalog.getAcroForm()) throw new EngineRefusal('noForm', 'the document has no AcroForm');
    const form = doc.getForm();
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    for (const fill of fills) {
      if (await fillOne(doc, form, fill, opts.arabicFont, helv)) written.push(fill);
    }
    if (!written.length) throw new EngineRefusal('emptyResult', 'no matching writable fields');
    return `filled=${written.length}`;
  }, (doc) => {
    const now = new Map(readFields(doc).map((f) => [f.name, f]));
    const bad: string[] = [];
    for (const w of written) {
      const f = now.get(w.name);
      if (!f) { bad.push(`field "${w.name}" missing`); continue; }
      const want = f.kind === 'checkbox' ? w.value === true || w.value === 'true' || w.value === 'on' : String(w.value);
      if (!same(f.value, want)) bad.push(`field "${w.name}" ${String(f.value)} != ${String(want)}`);
    }
    return bad;
  }, { updateFieldAppearances: false });
}

/**
 * Burns every field into the page content and removes the form. Appearances are rebuilt first
 * where pdf-lib can (WinAnsi values); a Unicode value keeps the appearance it was filled with.
 */
export async function flattenForm(bytes: Uint8Array, opts: { arabicFont?: Uint8Array } = {}): Promise<OpResult> {
  let pagesWithWidgets: number[] = [];
  return runOp(bytes, async (doc) => {
    if (!doc.catalog.getAcroForm()) throw new EngineRefusal('noForm', 'the document has no AcroForm');
    const form = doc.getForm();
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const infos = readFields(doc);
    pagesWithWidgets = [...new Set(infos.flatMap((f) => f.widgets.map((w) => w.page)).filter((p) => p >= 0))];
    for (const field of form.getFields()) {
      const kind = kindOf(field);
      try {
        if (field instanceof PDFTextField || field instanceof PDFDropdown) {
          const value = field instanceof PDFTextField ? field.getText() ?? '' : field.getSelected()[0] ?? '';
          if (needsUnicodeFont(value)) {
            if (opts.arabicFont) await unicodeAppearance(doc, field, value, opts.arabicFont);
          } else {
            field.defaultUpdateAppearances(helv);
          }
        } else if (kind === 'checkbox' || kind === 'radio') {
          (field as PDFCheckBox | PDFRadioGroup).defaultUpdateAppearances();
        } else if (field instanceof PDFOptionList && !field.getSelected().some(needsUnicodeFont)) {
          field.defaultUpdateAppearances(helv);
        }
      } catch {
        // A field pdf-lib cannot redraw keeps the appearance it already has.
      }
    }
    form.flatten({ updateFieldAppearances: false });
    return `flattened fields=${infos.length}`;
  }, (doc) => {
    const bad: string[] = [];
    const left = doc.catalog.getAcroForm() ? doc.getForm().getFields().length : 0;
    if (left) bad.push(`${left} fields left after flatten`);
    for (const p of pagesWithWidgets) {
      if (!/\bDo\b/.test(pageContent(doc, p))) bad.push(`page ${p + 1} shows no flattened field`);
    }
    return bad;
  });
}
