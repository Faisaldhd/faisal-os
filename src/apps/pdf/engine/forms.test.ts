import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { pageContent, streamText } from './common';
import { fillFields, flattenForm, listFields } from './forms';
import { arabicFontBytes, blankPdf, okBytes } from './test-helpers';

async function formPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const p0 = doc.addPage([400, 400]);
  const p1 = doc.addPage([400, 400]);
  const form = doc.getForm();
  form.createTextField('name').addToPage(p0, { x: 20, y: 300, width: 200, height: 24 });
  const notes = form.createTextField('notes');
  notes.enableMultiline();
  notes.addToPage(p0, { x: 20, y: 200, width: 200, height: 80 });
  form.createCheckBox('agree').addToPage(p0, { x: 20, y: 160, width: 16, height: 16 });
  const radio = form.createRadioGroup('size');
  radio.addOptionToPage('S', p1, { x: 20, y: 300, width: 16, height: 16 });
  radio.addOptionToPage('L', p1, { x: 60, y: 300, width: 16, height: 16 });
  const dd = form.createDropdown('city');
  dd.addOptions(['Riyadh', 'Jeddah', 'Abha']);
  dd.addToPage(p1, { x: 20, y: 200, width: 150, height: 24 });
  const list = form.createOptionList('langs');
  list.addOptions(['ar', 'en', 'fr']);
  list.enableMultiselect();
  list.addToPage(p1, { x: 200, y: 200, width: 100, height: 60 });
  form.createButton('go').addToPage('Go', p1, { x: 20, y: 20, width: 60, height: 20 });
  const ro = form.createTextField('locked');
  ro.setText('fixed');
  ro.enableReadOnly();
  ro.addToPage(p1, { x: 200, y: 20, width: 100, height: 20 });
  return doc.save();
}

describe('listFields', () => {
  it('lists every fillable field with kind, page, rect, value and options (buttons left out)', async () => {
    const fields = await listFields(await formPdf());
    expect(fields.map((f) => [f.name, f.kind, f.page])).toEqual([
      ['name', 'text', 0], ['notes', 'text', 0], ['agree', 'checkbox', 0], ['size', 'radio', 1],
      ['city', 'dropdown', 1], ['langs', 'list', 1], ['locked', 'text', 1],
    ]);
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    // pdf-lib grows the widget by its 1 pt border.
    expect(byName.name.rect).toEqual({ x: 19.5, y: 299.5, width: 201, height: 25 });
    expect(byName.notes.multiline).toBe(true);
    expect(byName.agree.value).toBe(false);
    expect(byName.size.options).toEqual(['S', 'L']);
    expect(byName.size.widgets.map((w) => w.option)).toEqual(['S', 'L']);
    expect(byName.size.widgets[1].rect.x).toBe(60);
    expect(byName.city.options).toEqual(['Riyadh', 'Jeddah', 'Abha']);
    expect(byName.locked).toMatchObject({ readOnly: true, value: 'fixed' });
  });

  it('lists nothing for a document without a form or for garbage', async () => {
    expect(await listFields(await blankPdf())).toEqual([]);
    expect(await listFields(new Uint8Array([1, 2]))).toEqual([]);
  });
});

describe('fillFields', () => {
  it('fills text, checkbox, radio, dropdown and list, and the values read back', async () => {
    const out = okBytes(await fillFields(await formPdf(), [
      { name: 'name', value: 'Faisal' }, { name: 'agree', value: true }, { name: 'size', value: 'L' },
      { name: 'city', value: 'Abha' }, { name: 'langs', value: 'ar, en' }, { name: 'locked', value: 'nope' },
    ]));
    const byName = Object.fromEntries((await listFields(out)).map((f) => [f.name, f.value]));
    expect(byName).toMatchObject({ name: 'Faisal', agree: true, size: 'L', city: 'Abha', langs: 'ar, en', locked: 'fixed' });
  });

  it('writes Arabic values with a shaped appearance when the font is given', async () => {
    const out = okBytes(await fillFields(await formPdf(), [{ name: 'name', value: 'فيصل الشهراني' }], { arabicFont: arabicFontBytes() }));
    const f = (await listFields(out)).find((x) => x.name === 'name');
    expect(f?.value).toBe('فيصل الشهراني');
    const doc = await PDFDocument.load(out);
    const field = doc.getForm().getTextField('name');
    const ap = field.acroField.getWidgets()[0].getNormalAppearance();
    const body = streamText(doc, ap as never);
    expect(body).toMatch(/TJ/);
    expect(body).toMatch(/\/ActualText/);
    expect(doc.context.lookup(ap as never)).toBeInstanceOf(PDFRawStream);
  });

  it('refuses Arabic without the font, unknown names, bad radio options and forms that do not exist', async () => {
    const pdf = await formPdf();
    expect(await fillFields(pdf, [{ name: 'name', value: 'فيصل' }])).toMatchObject({ ok: false, code: 'textNotRenderable' });
    expect(await fillFields(pdf, [{ name: 'nope', value: 'x' }])).toMatchObject({ ok: false, code: 'emptyResult' });
    expect(await fillFields(pdf, [{ name: 'size', value: 'XL' }])).toMatchObject({ ok: false });
    expect(await fillFields(await blankPdf(), [{ name: 'a', value: 'b' }])).toMatchObject({ ok: false, code: 'noForm' });
    expect(await fillFields(pdf, [])).toMatchObject({ ok: false, code: 'emptyResult' });
  });
});

describe('flattenForm', () => {
  it('burns the fields into the pages and removes the form', async () => {
    const filled = okBytes(await fillFields(await formPdf(), [
      { name: 'name', value: 'فيصل' }, { name: 'agree', value: true },
    ], { arabicFont: arabicFontBytes() }));
    const out = okBytes(await flattenForm(filled, { arabicFont: arabicFontBytes() }));
    expect(await listFields(out)).toEqual([]);
    const doc = await PDFDocument.load(out);
    expect(pageContent(doc, 0)).toMatch(/Do/);
    const annots = doc.getPage(0).node.get(PDFName.of('Annots'));
    expect(annots ? String(doc.context.lookup(annots)) : '[ ]').not.toMatch(/R/);
  });

  it('refuses a document without a form', async () => {
    expect(await flattenForm(await blankPdf())).toMatchObject({ ok: false, code: 'noForm' });
  });
});
