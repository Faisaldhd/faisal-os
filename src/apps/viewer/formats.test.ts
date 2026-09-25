import { describe, it, expect } from 'vitest';
import {
  kindOf, mimeOf, extensionOf, looksLikeText, parseCsv, columnIndex,
  zipEntries, openZip, readXlsx, readDocx, readPptx, ZipError, VIEWER_EXTENSIONS, MAX_COLS, MAX_ROWS,
} from './formats';

/* A tiny ZIP writer for the tests: stored (method 0) or deflated (method 8) members. */
async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(data.slice()).body!.pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function makeZip(files: Record<string, string>, deflate = true): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = enc.encode(text);
    const data = deflate ? await deflateRaw(raw) : raw;
    const nameBytes = enc.encode(name);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, deflate ? 8 : 0, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, deflate ? 8 : 0, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) { out.set(part, at); at += part.length; }
  return out;
}

describe('file kinds', () => {
  it('maps extensions to kinds, case-insensitively', () => {
    expect(kindOf('/home/u/Report.PDF')).toBe('pdf');
    expect(kindOf('/a/b.xlsx')).toBe('sheet');
    expect(kindOf('/a/b.csv')).toBe('csv');
    expect(kindOf('/a/b.docx')).toBe('doc');
    expect(kindOf('/a/b.pptx')).toBe('slides');
    expect(kindOf('/a/song.mp3')).toBe('audio');
    expect(kindOf('/a/clip.mp4')).toBe('video');
    expect(kindOf('/a/setup.exe')).toBe('other');
    expect(kindOf('/a/Makefile')).toBe('other');
  });

  it('never gives an unknown or HTML file a renderable type', () => {
    expect(mimeOf('/a/b.pdf')).toBe('application/pdf');
    expect(mimeOf('/a/page.html')).toBe('application/octet-stream');
    expect(mimeOf('/a/x.svg')).toBe('application/octet-stream');
    expect(mimeOf('/a/noext')).toBe('application/octet-stream');
  });

  it('reads the extension of the last path segment only', () => {
    expect(extensionOf('/a.b/file')).toBe('');
    expect(extensionOf('/a/.hidden')).toBe('');
    expect(extensionOf('/a/b.tar.GZ')).toBe('.gz');
  });

  it('names real extensions in the manifest list', () => {
    expect(VIEWER_EXTENSIONS).toContain('.pdf');
    expect(VIEWER_EXTENSIONS).toContain('.xlsx');
    expect(VIEWER_EXTENSIONS.every((e) => e.startsWith('.'))).toBe(true);
  });
});

describe('looksLikeText', () => {
  it('accepts UTF-8 (Arabic included) and rejects binary', () => {
    expect(looksLikeText(new TextEncoder().encode('مرحبا hello\n'))).toBe(true);
    expect(looksLikeText(new Uint8Array([0x25, 0x50, 0x00, 0x01]))).toBe(false);
    expect(looksLikeText(new Uint8Array([0xff, 0xfe, 0xfd]))).toBe(false);
  });

  it('tolerates a multi-byte character cut at the sample edge', () => {
    // One ASCII byte first, so the 8192-byte sample ends halfway through a two-byte letter.
    expect(looksLikeText(new TextEncoder().encode(`a${'ا'.repeat(5000)}`))).toBe(true);
  });
});

describe('parseCsv', () => {
  it('handles quotes, doubled quotes, embedded newlines, CRLF and a BOM', () => {
    const text = '﻿name,note\r\n"Ali, Jr.","said ""hi"""\r\nSara,"two\nlines"\n';
    expect(parseCsv(text)).toEqual([
      ['name', 'note'],
      ['Ali, Jr.', 'said "hi"'],
      ['Sara', 'two\nlines'],
    ]);
  });

  it('supports tabs and a last line without newline', () => {
    expect(parseCsv('a\tb\n1\t2', '\t')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('zip', () => {
  it('reads stored and deflated members', async () => {
    for (const deflate of [false, true]) {
      const zip = openZip(await makeZip({ 'a.txt': 'hello', 'dir/b.txt': 'مرحبا' }, deflate));
      expect(zip.names()).toEqual(['a.txt', 'dir/b.txt']);
      expect(new TextDecoder().decode((await zip.read('dir/b.txt'))!)).toBe('مرحبا');
      expect(await zip.read('missing')).toBeNull();
    }
  });

  it('rejects something that is not a zip', () => {
    expect(() => zipEntries(new TextEncoder().encode('not a zip at all, just text'))).toThrow(ZipError);
  });
});

describe('Office files', () => {
  it('reads every sheet of an xlsx with shared, inline, number and boolean cells', async () => {
    const bytes = await makeZip({
      'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="المبيعات" sheetId="1" r:id="rId1"/><sheet name="Second" sheetId="2" r:id="rId2"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/other.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>المنتج</t></si><si><r><t>Pr</t></r><r><t>ice</t></r></si></sst>',
      'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>قلم</t></is></c><c r="B3" t="b"><v>1</v></c><c r="C3"><v>12.5</v></c></row></sheetData></worksheet>',
      'xl/worksheets/other.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="B1"><v>7</v></c></row></sheetData></worksheet>',
    });
    const sheets = await readXlsx(bytes);
    expect(sheets.map((s) => s.name)).toEqual(['المبيعات', 'Second']);
    expect(sheets[0].rows).toEqual([['المنتج', '', 'Price'], [], ['قلم', 'TRUE', '12.5']]);
    expect(sheets[1].rows).toEqual([['', '7']]);
    expect(sheets[0].truncated).toBe(false);
  });

  it('reads docx paragraphs with tabs and breaks, skipping fallback copies', async () => {
    const w = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
    const bytes = await makeZip({
      'word/document.xml': `<w:document ${w}><w:body><w:p><w:r><w:t>مرحبا</w:t></w:r><w:r><w:tab/><w:t>world</w:t></w:r></w:p><w:p/><w:p><w:r><w:t>a</w:t><w:br/><w:t>b</w:t></w:r><w:r><mc:AlternateContent><mc:Choice><w:p><w:r><w:t>box</w:t></w:r></w:p></mc:Choice><mc:Fallback><w:p><w:r><w:t>box</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent></w:r></w:p></w:body></w:document>`,
    });
    expect(await readDocx(bytes)).toEqual(['مرحبا\tworld', '', 'a\nb', 'box']);
  });

  it('reads pptx slides in numeric order', async () => {
    const a = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
    const slide = (text: string) => `<p:sld ${a}><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p><a:p/></p:txBody></p:sld>`;
    const bytes = await makeZip({
      'ppt/slides/slide10.xml': slide('ten'),
      'ppt/slides/slide2.xml': slide('two'),
      'ppt/slides/slide1.xml': slide('one'),
    });
    expect(await readPptx(bytes)).toEqual([['one'], ['two'], ['ten']]);
  });

  it('fails clearly on a zip that is not the expected Office file', async () => {
    const bytes = await makeZip({ 'readme.txt': 'hi' });
    await expect(readXlsx(bytes)).rejects.toThrow(ZipError);
    await expect(readDocx(bytes)).rejects.toThrow(ZipError);
    await expect(readPptx(bytes)).rejects.toThrow(ZipError);
  });
});

describe('columnIndex', () => {
  it('converts cell references to zero-based columns', () => {
    expect(columnIndex('A1')).toBe(0);
    expect(columnIndex('Z9')).toBe(25);
    expect(columnIndex('AA10')).toBe(26);
    expect(columnIndex('ab3')).toBe(27);
  });
});

/*
 * The reader's row limit is a parameter, and that is what lets the sheet editor virtualise ten
 * thousand rows without dragging a huge workbook into the Files app's previews. Both halves of
 * that promise are pinned here: the default every existing caller gets, and the raised one an app
 * asks for at its own call site.
 */
describe('readXlsx row limits', () => {
  /** `A`, `Z`, `AA`, … — the fixture needs more than 26 columns for the column-limit check. */
  const colName = (c: number): string => {
    let n = c + 1;
    let out = '';
    while (n > 0) { const rem = (n - 1) % 26; out = String.fromCharCode(65 + rem) + out; n = Math.floor((n - 1) / 26); }
    return out;
  };

  const sheet = (rows: number, cols: number): Record<string, string> => {
    const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const body: string[] = [];
    for (let r = 1; r <= rows; r++) {
      const cells: string[] = [];
      for (let c = 0; c < cols; c++) cells.push(`<c r="${colName(c)}${r}"><v>${r}</v></c>`);
      body.push(`<row r="${r}">${cells.join('')}</row>`);
    }
    return {
      'xl/workbook.xml': `<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      'xl/_rels/workbook.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      'xl/worksheets/sheet1.xml': `<worksheet xmlns="${S}"><sheetData>${body.join('')}</sheetData></worksheet>`,
    };
  };

  it('stops at the reader’s own limit when the caller says nothing (previews stay small)', async () => {
    const bytes = await makeZip(sheet(MAX_ROWS + 50, 2));
    const sheets = await readXlsx(bytes);
    expect(sheets[0].rows).toHaveLength(MAX_ROWS);
    expect(sheets[0].rows[MAX_ROWS - 1][0]).toBe(String(MAX_ROWS));
    expect(sheets[0].truncated).toBe(true);
  });

  it('reads further rows when the caller asks, and never past what was asked', async () => {
    const bytes = await makeZip(sheet(2200, 2));
    const sheets = await readXlsx(bytes, { maxRows: 3000 });
    expect(sheets[0].rows).toHaveLength(2200);
    expect(sheets[0].truncated).toBe(false);
    const capped = await readXlsx(bytes, { maxRows: 500 });
    expect(capped[0].rows).toHaveLength(500);
    expect(capped[0].truncated).toBe(true);
  });

  it('keeps the column limit for everyone unless a caller asks for more', async () => {
    const bytes = await makeZip(sheet(3, MAX_COLS + 5));
    const dflt = await readXlsx(bytes, { maxRows: 100 });
    expect(dflt[0].rows[0]).toHaveLength(MAX_COLS);
    expect(dflt[0].truncated).toBe(true);
    const wide = await readXlsx(bytes, { maxRows: 100, maxCols: MAX_COLS + 5 });
    expect(wide[0].rows[0]).toHaveLength(MAX_COLS + 5);
    expect(wide[0].truncated).toBe(false);
  });
});
