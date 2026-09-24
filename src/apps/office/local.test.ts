/**
 * The boundary with the browser: a real `File` (built here, as the test asks) read
 * through the import path, the path it is written to inside /home/user, and the
 * direct download.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IMPORT_TEXT_LIMIT, downloadBlob, importLocalFile, importLeaf, importPathFor, importableExtension, printHtml } from './local';

const file = (parts: BlobPart[], name: string, type = ''): File => new File(parts, name, { type });

beforeEach(() => {
  // jsdom has no Blob-URL store of its own; the PDF app's tests stub it the same way.
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:office-test'), configurable: true, writable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true, writable: true });
});

afterEach(() => {
  document.body.textContent = '';
  vi.restoreAllMocks();
});

describe('which files can be imported', () => {
  it('accepts .txt and .csv whatever their case, and nothing else', () => {
    expect(importableExtension('note.txt')).toBe('.txt');
    expect(importableExtension('REPORT.CSV')).toBe('.csv');
    expect(importableExtension('/home/user/data.csv')).toBe('.csv');
    expect(importableExtension('sheet.docx')).toBeNull();
    expect(importableExtension('noextension')).toBeNull();
    expect(importableExtension('..')).toBeNull();
  });

  it('turns any dropped name into one safe leaf inside /home/user', () => {
    expect(importLeaf('../../etc/passwd.csv')).toBe('passwd.csv');
    expect(importLeaf('C:\\Users\\me\\note.txt')).toBe('C--Users-me-note.txt');
    expect(importLeaf('')).toBe('imported');
    expect(importPathFor('report.csv')).toBe('/home/user/report.csv');
    expect(importPathFor('../../etc/passwd.txt').startsWith('/home/user/')).toBe(true);
  });
});

describe('importing a real File', () => {
  it('reads a .csv into the sheet model', async () => {
    const result = await importLocalFile(file(['name,qty\r\nwidget,12\r\n'], 'data.csv', 'text/csv'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.name).toBe('data.csv');
    expect(result.path).toBe('/home/user/data.csv');
    expect(result.plan.kind).toBe('csv');
    expect(result.model.kind).toBe('csv');
    if (result.model.kind === 'csv') expect(result.model.grids[0]?.rows).toEqual([['name', 'qty'], ['widget', '12']]);
    expect(new TextDecoder().decode(result.bytes)).toContain('widget');
  });

  it('reads an Arabic .txt into the text model', async () => {
    const result = await importLocalFile(file(['مرحباً بالعالم'], 'ملاحظة.txt', 'text/plain'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model).toEqual({ kind: 'text', text: 'مرحباً بالعالم' });
  });

  it('takes an empty file as a new empty document', async () => {
    const result = await importLocalFile(file([], 'empty.csv'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.empty).toBe(true);
    expect(result.model.kind).toBe('csv');
  });

  it('refuses another extension by name, without reading a byte', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const result = await importLocalFile({ name: 'report.docx', size: 10, arrayBuffer });
    expect(result).toEqual({ ok: false, name: 'report.docx', refusal: 'extension' });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('refuses a huge .txt before reading it into memory', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const result = await importLocalFile({ name: 'huge.txt', size: IMPORT_TEXT_LIMIT + 1, arrayBuffer });
    expect(result).toEqual({ ok: false, name: 'huge.txt', refusal: 'toolarge' });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('refuses a .txt that is really binary, exactly as the window does', async () => {
    const result = await importLocalFile(file([new Uint8Array([0, 1, 2, 0, 3])], 'bin.txt'));
    expect(result).toEqual({ ok: false, name: 'bin.txt', refusal: 'binary' });
  });
});

describe('downloading the exported file', () => {
  it('clicks a download link with the name and type it was given', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    downloadBlob('report.html', '<html></html>', 'text/html;charset=utf-8');

    expect(click).toHaveBeenCalledTimes(1);
    const created = vi.mocked(URL.createObjectURL).mock.calls[0]?.[0] as Blob | undefined;
    expect(created?.type).toBe('text/html;charset=utf-8');
    expect(created?.size).toBe('<html></html>'.length);
    // The anchor is removed again: no leftover node in the desktop's DOM.
    expect(document.body.querySelector('a[download]')).toBeNull();
  });

  it('hands bytes through untouched', () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    downloadBlob('x.txt', new Uint8Array([1, 2, 3]), 'text/plain;charset=utf-8');
    expect((vi.mocked(URL.createObjectURL).mock.calls[0]?.[0] as Blob).size).toBe(3);
  });
});

describe('the print-ready page', () => {
  it('appends a size-zero frame carrying the page, and never markup in the window', () => {
    printHtml('<!DOCTYPE html><html><body><p>&lt;script&gt;</p></body></html>');
    const frame = document.body.querySelector<HTMLIFrameElement>('iframe.faisal-office-printframe');
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute('aria-hidden')).toBe('true');
    expect(frame?.srcdoc).toContain('&lt;script&gt;');
  });
});
