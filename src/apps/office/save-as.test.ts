import { describe, expect, it } from 'vitest';
import type { DocModel, SheetsModel, TextModel } from './model';
import { defaultSaveFormat, saveFormatChoices, serializeAs, textOf } from './save-as';
import { planFor } from './model';

/**
 * Office "Save as" — the format table.
 *
 * The dialog is the shell's; what this app must get right is that it never offers a format its
 * writers cannot produce, and that the bytes it hands the dialog really are that format (a
 * `.csv` written as `.xlsx` has to be a ZIP, a `.docx` as `.txt` has to be readable text).
 */

const doc: DocModel = { kind: 'docx', paragraphs: ['مرحباً', 'second paragraph'] };
const sheet: SheetsModel = {
  kind: 'xlsx', active: 0, delimiter: ',',
  grids: [{ name: 'Sheet1', rows: [['a', 'b'], ['1', '2']], truncated: false }],
};
const text: TextModel = { kind: 'text', text: '# Title\n\nbody' };

describe('office save-as — format choices', () => {
  it('offers Word its own family: .docx, the OpenDocument text export, and plain text', () => {
    expect(saveFormatChoices(doc).map((c) => c.value)).toEqual(['docx', 'odt', 'txt']);
    expect(saveFormatChoices(doc).map((c) => c.ext)).toEqual(['docx', 'odt', 'txt']);
    // The OpenDocument choice carries the ODF text media type, not the OOXML one.
    expect(saveFormatChoices(doc).find((c) => c.value === 'odt')?.mime).toBe('application/vnd.oasis.opendocument.text');
  });

  it('offers a spreadsheet .xlsx and .csv', () => {
    expect(saveFormatChoices(sheet).map((c) => c.value)).toEqual(['xlsx', 'csv']);
    expect(saveFormatChoices({ ...sheet, kind: 'csv' }).map((c) => c.value)).toEqual(['xlsx', 'csv']);
  });

  it('offers a deck .pptx only', () => {
    expect(saveFormatChoices({ kind: 'pptx', slides: [['title']] }).map((c) => c.value)).toEqual(['pptx']);
  });

  it('keeps the file’s own extension first, so Save as never silently changes it', () => {
    expect(saveFormatChoices(text, 'md').map((c) => c.value)).toEqual(['md', 'txt']);
    expect(saveFormatChoices(text, '.txt').map((c) => c.value)).toEqual(['txt', 'md']);
    expect(saveFormatChoices(sheet, 'csv').map((c) => c.value)).toEqual(['csv', 'xlsx']);
    expect(defaultSaveFormat(text, 'md')).toBe('md');
    expect(defaultSaveFormat(sheet, 'csv')).toBe('csv');
  });
});

describe('office save-as — the bytes', () => {
  it('writes a real ZIP package for .docx, not UTF-8 text', () => {
    const bytes = serializeAs(doc, 'docx');
    expect(bytes.length).toBeGreaterThan(100);
    // ZIP local file header: "PK\x03\x04".
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it('writes real ZIP packages for .xlsx and .pptx', () => {
    for (const bytes of [serializeAs(sheet, 'xlsx'), serializeAs({ kind: 'pptx', slides: [['t']] }, 'pptx')]) {
      expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    }
  });

  it('writes a real ODF package for .odt, with the text media type stored first', () => {
    const bytes = serializeAs(doc, 'odt');
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const nameLength = bytes[26] | (bytes[27] << 8);
    expect(new TextDecoder().decode(bytes.subarray(30, 30 + nameLength))).toBe('mimetype');
    const content = new TextDecoder().decode(bytes.subarray(30 + nameLength, 30 + nameLength + 39));
    expect(content).toBe('application/vnd.oasis.opendocument.text');
    // The package it just wrote is one this app can open again (the import landed in the same
    // release): saving as `.odt` is a real save-as, and the window continues on the new file.
    expect(planFor('odt-save-check.odt')).toMatchObject({ kind: 'docx', odf: true, refusal: null });
  });

  it('writes RFC 4180 CSV, always with a comma, whatever the model delimiter was', () => {
    const tsv: SheetsModel = { ...sheet, kind: 'csv', delimiter: '\t', grids: [{ name: 's', rows: [['a', 'b,c']], truncated: false }] };
    expect(new TextDecoder().decode(serializeAs(tsv, 'csv'))).toBe('a,"b,c"\r\n');
  });

  it('writes readable text for .txt and .md', () => {
    expect(new TextDecoder().decode(serializeAs(doc, 'txt'))).toBe('مرحباً\n\nsecond paragraph');
    expect(new TextDecoder().decode(serializeAs(text, 'md'))).toBe('# Title\n\nbody');
  });

  it('renders a document as text the same way for the preview and the writer', () => {
    expect(textOf(doc)).toBe('مرحباً\n\nsecond paragraph');
    expect(textOf({ kind: 'pptx', slides: [['a', 'b'], ['c']] })).toBe('a\nb\n\n---\n\nc');
    expect(textOf(sheet)).toBe('a,b\r\n1,2\r\n');
  });

  it('refuses a format its writers cannot produce instead of writing the wrong bytes', () => {
    expect(() => serializeAs(sheet, 'docx')).toThrow(/cannot write/);
    expect(() => serializeAs(doc, 'xlsx')).toThrow(/cannot write/);
    expect(() => serializeAs(doc, 'pptx')).toThrow(/cannot write/);
    expect(() => serializeAs(text, 'csv')).toThrow(/cannot write/);
    expect(() => serializeAs(sheet, 'odt')).toThrow(/cannot write/);
  });
});
