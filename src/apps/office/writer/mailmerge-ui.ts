/**
 * Writer — the mail-merge panel (لوحة دمج المراسلات): a field, a source, a preview, the copies.
 *
 * The logic lives in `mailmerge.ts` and is tested there; this file is the window around it — the
 * field marker the editor understands, the CSV box, what matched and what did not, the first row
 * as a preview, and one file per row through the app's own export (which never overwrites and makes
 * a unique name of its own).
 *
 * A field is inserted as the editor's own kind of mark: a `span.fo-marker` carrying `data-skip="1"`
 * and `contentEditable="false"`, exactly like every other visible-but-not-text mark here. Without
 * that, `reconcile()` would read the marker as paragraph text and write it into the document.
 */
import { t } from '../../../kernel/i18n';
import type { EditorContext } from '../editor';
import { writeDocx } from '../ooxml';
import { button, el } from '../ui/dom';
import { openModal } from '../ui/popover';
import { FIELD_CLASS, fieldText, matchFields, mergeDocuments, parseSource, FIELD_SKIP_ATTR, resultMessage } from './mailmerge';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** The paragraph the caret is in, if the editor has the focus in one. */
function caretBlock(): HTMLElement | null {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.isContentEditable) return active;
  const selection = document.getSelection();
  const node = selection?.anchorNode ?? null;
  const fromNode = node instanceof HTMLElement ? node : node?.parentElement ?? null;
  const block = fromNode?.closest<HTMLElement>('[contenteditable="true"]') ?? null;
  return block ?? document.querySelector<HTMLElement>('[contenteditable="true"]');
}

/**
 * Puts `{{name}}` at the caret as a marker the editor skips, then lets the editor commit it by
 * firing the same `input` event typing fires. Answers false when there is nowhere to put it.
 */
export function insertMergeField(ctx: EditorContext, name: string): boolean {
  const field = name.trim();
  if (!field || !ctx.editable()) return false;
  const block = caretBlock();
  if (!block) return false;
  const marker = el('span', FIELD_CLASS, fieldText(field));
  marker.contentEditable = 'false';
  marker.dataset.skip = '1';
  marker.setAttribute('aria-label', t('office.mergeFieldChip', { name: field }));
  marker.title = t('office.mergeFieldChip', { name: field });
  const space = document.createTextNode('\u00A0');
  const selection = document.getSelection();
  const range = selection && selection.rangeCount && block.contains(selection.anchorNode) ? selection.getRangeAt(0) : null;
  if (range) {
    range.deleteContents();
    range.insertNode(space);
    range.insertNode(marker);
    range.setStartAfter(space);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
  } else {
    block.append(marker, space);
  }
  // The editor listens for `input`: this is what turns the marker into a document edit it saves.
  block.dispatchEvent(new Event('input', { bubbles: true }));
  ctx.setStatus(t('office.mergeFieldInserted', { name: field }));
  ctx.refresh();
  return true;
}

export interface MergeUiHooks {
  /** The document's paragraphs, as the model holds them (fields included). */
  paragraphs: () => string[];
  /** Inserts one field into the editor. */
  insertField: (name: string) => boolean;
}

function fieldPrompt(ctx: EditorContext, hooks: MergeUiHooks): void {
  const input = el('input', 'fo-input');
  input.type = 'text';
  input.placeholder = t('office.mergeFieldPrompt');
  input.setAttribute('aria-label', t('office.mergeField'));
  const body = el('div', 'fo-field');
  body.append(input);
  const modal = openModal({
    title: t('office.mergeField'),
    body,
    okLabel: t('office.apply'),
    cancelLabel: t('office.cancel'),
    host: ctx.host(),
    onOk: () => {
      if (!hooks.insertField(input.value)) return false;
      modal.close();
      return true;
    },
  });
  input.focus();
}

/**
 * The panel: paste or open a CSV, see which fields it can fill, look at the first copy, then make
 * the files. Every message is the honest one — created, skipped, and fields with no column.
 */
export function openMailMergePanel(ctx: EditorContext, hooks: MergeUiHooks): void {
  const source = el('textarea', 'fo-input fo-merge-source');
  source.rows = 6;
  source.spellcheck = false;
  source.setAttribute('aria-label', t('office.mergeSource'));
  source.placeholder = t('office.mergeSourceHint');
  const file = el('input');
  file.type = 'file';
  file.accept = '.csv,.tsv,text/csv,text/plain';
  file.setAttribute('aria-label', t('office.mergeOpenFile'));
  const report = el('div', 'fo-sheetpanel-note fo-merge-report');
  report.setAttribute('role', 'status');
  report.setAttribute('aria-live', 'polite');
  const preview = el('div', 'fo-merge-preview');
  const body = el('div', 'fo-sheetpanel-body fo-merge-body');
  const pick = button('plus', t('office.mergeOpenFile'), () => file.click(), { showLabel: true });
  const insert = button('plus', t('office.mergeField'), () => fieldPrompt(ctx, hooks), { showLabel: true });
  const actions = el('div', 'fo-sheetpanel-actions');
  const detect = button(null, t('office.mergeDetect'), () => void detectColumns(), { showLabel: true, primary: false });
  const create = button(null, t('office.mergeCreate'), () => void createCopies(), { showLabel: true, primary: true });
  actions.append(detect, create);
  body.append(source, file, pick, insert, actions, report, preview);

  file.addEventListener('change', () => {
    const chosen = file.files?.[0];
    if (!chosen) return;
    void chosen.text().then((text) => {
      source.value = text;
      void detectColumns();
    });
  });

  const modal = openModal({
    title: t('office.mergeTitle'),
    body,
    okLabel: t('office.close'),
    cancelLabel: t('office.cancel'),
    host: ctx.host(),
    onOk: () => true,
  });

  const readSource = (): ReturnType<typeof parseSource> => parseSource(source.value, source.value.includes('\t') && !source.value.includes(',') ? '\t' : ',');

  /** What the CSV can fill, what it cannot, and the first copy as it will read. */
  function detectColumns(): boolean {
    const paragraphs = hooks.paragraphs();
    const parsed = readSource();
    const result = mergeDocuments(paragraphs, parsed);
    const lines: string[] = [];
    if (!result.match.fields.length) lines.push(t('office.mergeNoFields'));
    else {
      lines.push(t('office.mergeMatched', { list: result.match.matched.join('، ') || '—' }));
      if (result.match.missing.length) lines.push(t('office.mergeMissing', { list: result.match.missing.join('، ') }));
      if (result.match.unused.length) lines.push(t('office.mergeUnused', { list: result.match.unused.join('، ') }));
      lines.push(t('office.mergeRows', { n: parsed.rows.length }));
    }
    report.textContent = lines.join(' · ');
    preview.replaceChildren();
    if (result.copies.length) {
      preview.append(el('p', 'fo-merge-preview-title', t('office.mergePreview')));
      for (const paragraph of result.copies[0].paragraphs) {
        const line = el('p', 'fo-merge-preview-line', paragraph || ' ');
        preview.append(line);
      }
    }
    return true;
  }

  /** One `.docx` per row, through the app's own export (a new name, never an overwrite). */
  async function createCopies(): Promise<void> {
    const paragraphs = hooks.paragraphs();
    const result = mergeDocuments(paragraphs, readSource());
    if (!result.copies.length) {
      ctx.setStatus(result.match.fields.length ? t('office.mergeNothingToCreate') : t('office.mergeNoFields'));
      return;
    }
    create.disabled = true;
    report.textContent = t('office.mergeWorking', { n: result.copies.length });
    try {
      for (const copy of result.copies) await ctx.exportFile(writeDocx(copy.paragraphs), 'docx', DOCX_MIME);
      ctx.setStatus(resultMessage(result, {
        created: (n) => t('office.mergeCreated', { n }),
        skipped: (n, rows) => t('office.mergeSkipped', { n, rows }),
        missing: (fields) => t('office.mergeMissing', { list: fields }),
      }));
      report.textContent = t('office.mergeCreated', { n: result.copies.length });
    } finally {
      create.disabled = false;
    }
  }

  void detectColumns();
  ctx.refresh();
  void modal;
}
