/**
 * The three serialisers behind the export buttons. Nothing here trusts a hand-written
 * string: the CSV is parsed back with the app's own reader, and the HTML is parsed by
 * the DOM to prove that file content stayed text and never became markup.
 */
import { describe, expect, it } from 'vitest';
import { parseCsv } from '../viewer/formats';
import { escapeHtml, exportMime, exportName, plainText, sheetRows, toCsv, toHtml } from './export';
import type { OfficeModel } from './model';

const DOC: OfficeModel = { kind: 'docx', paragraphs: ['مرحباً بالعالم', 'second paragraph', ''] };
const CSV: OfficeModel = {
  kind: 'csv',
  active: 0,
  delimiter: ',',
  grids: [{ name: 'x', rows: [['name', 'note'], ['widget', 'a,b'], ['q"q', 'l1\nl2']], truncated: false }],
};

describe('the plain text of a document', () => {
  it('writes one line per Word paragraph, empty ones included', () => {
    expect(plainText(DOC)).toBe('مرحباً بالعالم\nsecond paragraph\n');
  });

  it('separates slides with a blank line and sheet cells with a tab', () => {
    expect(plainText({ kind: 'pptx', slides: [['one', 'two'], ['three']] })).toBe('one\ntwo\n\nthree');
    expect(plainText(CSV)).toBe('name\tnote\nwidget\ta,b\nq"q\tl1\nl2');
  });

  it('writes a text buffer exactly as it is', () => {
    expect(plainText({ kind: 'text', text: 'line 1\nline 2\n' })).toBe('line 1\nline 2\n');
  });

  it('gives a non-sheet document one single-column row per line for CSV', () => {
    expect(sheetRows(DOC)).toEqual([['مرحباً بالعالم'], ['second paragraph'], ['']]);
    expect(sheetRows({ kind: 'text', text: 'a\nb' })).toEqual([['a\nb']]);
  });
});

describe('the CSV export', () => {
  it('quotes only what must be quoted, and parses back to the same cells', () => {
    const text = toCsv(CSV);
    expect(text).toBe('name,note\r\nwidget,"a,b"\r\n"q""q","l1\nl2"\r\n');
    expect(parseCsv(text, ',')).toEqual([['name', 'note'], ['widget', 'a,b'], ['q"q', 'l1\nl2']]);
  });

  it('keeps the Arabic cells intact through the reader', () => {
    const model: OfficeModel = {
      kind: 'csv',
      active: 0,
      delimiter: ',',
      grids: [{ name: 'x', rows: [['الاسم', 'ملاحظة'], ['قيمة, بفاصلة', 'قيمة، بفاصلة']], truncated: false }],
    };
    const text = toCsv(model);
    // Only the Latin comma is the delimiter; the Arabic comma needs no quoting.
    expect(text).toContain('"قيمة, بفاصلة",قيمة، بفاصلة');
    expect(parseCsv(text, ',')).toEqual([['الاسم', 'ملاحظة'], ['قيمة, بفاصلة', 'قيمة، بفاصلة']]);
  });

  it('writes nothing at all for an empty sheet, and never a header it does not have', () => {
    expect(toCsv({ kind: 'csv', active: 0, delimiter: ',', grids: [{ name: 'x', rows: [], truncated: false }] })).toBe('');
  });
});

describe('the HTML export', () => {
  const EVIL = '<script>alert(1)</script> & <b>bold</b>';
  const htmlFor = (model: OfficeModel): Document =>
    new DOMParser().parseFromString(toHtml(model, 'تقرير <x>', 'rtl'), 'text/html');

  it('escapes every piece of document text and of the title', () => {
    expect(escapeHtml(EVIL)).toBe('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;b&gt;bold&lt;/b&gt;');
    const doc = htmlFor({ kind: 'docx', paragraphs: [EVIL] });
    expect(doc.querySelectorAll('script')).toHaveLength(0);
    expect(doc.querySelector('b')).toBeNull();
    expect(doc.title).toBe('تقرير <x>');
    // The text is there, as text.
    expect(doc.body.textContent).toContain(EVIL);
  });

  it('writes a complete, self-contained page with the direction it was given', () => {
    const html = toHtml(DOC, 'تقرير', 'rtl');
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8"/>');
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('@media print');
    const ltr = new DOMParser().parseFromString(toHtml(DOC, 'Report', 'ltr'), 'text/html');
    expect(ltr.documentElement.dir).toBe('ltr');
    expect(ltr.body.querySelectorAll('p')).toHaveLength(3);
  });

  it('turns a sheet into a real table, kept left-to-right', () => {
    const doc = htmlFor(CSV);
    const table = doc.querySelector('table');
    expect(table?.getAttribute('dir')).toBe('ltr');
    expect([...doc.querySelectorAll('tr')].map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent)))
      .toEqual([['name', 'note'], ['widget', 'a,b'], ['q"q', 'l1\nl2']]);
  });

  it('keeps line breaks inside a paragraph and a text buffer', () => {
    expect(htmlFor({ kind: 'text', text: 'one\ntwo' }).querySelector('pre')?.textContent).toBe('one\ntwo');
    expect(toHtml({ kind: 'text', text: 'one\ntwo' }, 't')).toContain('white-space:pre-wrap');
    expect(htmlFor({ kind: 'docx', paragraphs: ['one\ntwo'] }).querySelector('p')?.textContent).toBe('one\ntwo');
    expect(toHtml(DOC, 't')).toContain('</p><p></p>'); // the empty paragraph stays a paragraph
  });
});

describe('export names and types', () => {
  it('replaces the extension of the opened file', () => {
    expect(exportName('report.docx', 'txt')).toBe('report.txt');
    expect(exportName('table.csv', 'html')).toBe('table.html');
    expect(exportName('A.CSV', 'csv')).toBe('A.csv');
    expect(exportName('ملف.txt', 'txt')).toBe('ملف.txt');
  });

  it('strips anything that could act as a path or a reserved character', () => {
    expect(exportName('../../etc/passwd.txt', 'txt')).toBe('passwd.txt');
    expect(exportName('a:b*c?.txt', 'txt')).toBe('a-b-c-.txt');
    expect(exportName('.hidden.txt', 'txt')).toBe('hidden.txt');
    expect(exportName('', 'txt')).toBe('document.txt');
  });

  it('names a UTF-8 type for each format', () => {
    expect(exportMime('txt')).toBe('text/plain;charset=utf-8');
    expect(exportMime('csv')).toBe('text/csv;charset=utf-8');
    expect(exportMime('html')).toBe('text/html;charset=utf-8');
  });
});
