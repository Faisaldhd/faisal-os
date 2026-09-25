import { describe, expect, it } from 'vitest';
import { readRawZip, utf8 } from '../zip';
import type { DocModel } from '../model';
import {
  ODT_MIME, logicalAlign, odtContentXml, odtMetaXml, odtStylesXml, odtText, safeImageName, toOdt, xmlEscape,
} from './odt';

/*
 * An `.odt` has two contracts and both are pinned here, with nothing else:
 *  1. the MODEL → XML mapping (paragraphs, direction, headings, runs, lists, tables);
 *  2. the CONTAINER: `mimetype` first and stored uncompressed, and a manifest that declares every
 *     other part — the two things a reader checks before it will open the file at all.
 */

/**
 * The bytes of one entry, read straight out of the archive instead of through the module's own
 * reader: a stored entry's data begins after its 30-byte local header, its name and its extra field.
 */
function storedData(bytes: Uint8Array, entry: { localOffset: number; nameBytes: Uint8Array; size: number; method: number }): Uint8Array {
  expect(entry.method, 'the part must be stored').toBe(0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const extra = view.getUint16(entry.localOffset + 28, true);
  const at = entry.localOffset + 30 + entry.nameBytes.length + extra;
  return bytes.subarray(at, at + entry.size);
}

const model = (): DocModel => ({
  kind: 'docx',
  paragraphs: [],
  blocks: [
    { id: 0, runs: [{ t: 'text', text: 'تقرير Fai$al OS', props: {} }] },
    { id: 1, runs: [
      { t: 'text', text: 'مقدمة ', props: {} },
      { t: 'text', text: 'عريضة', props: { b: true } },
      { t: 'text', text: ' وملوّنة', props: { i: true, color: 'C8894B' } },
    ] },
    { id: 2, runs: [{ t: 'text', text: 'أولاً', props: {} }] },
    { id: 3, runs: [{ t: 'text', text: 'ثانياً', props: {} }] },
    { id: 4, runs: [{ t: 'text', text: 'خلية أ', props: {} }], cell: { table: 0, row: 0, col: 0, rows: 1, cols: 2 } },
    { id: 5, runs: [{ t: 'text', text: 'خلية ب', props: {} }], cell: { table: 0, row: 0, col: 1, rows: 1, cols: 2 } },
  ],
  formats: {
    0: { style: 'Heading1', dir: 'rtl', align: 'right' },
    1: { dir: 'rtl', align: 'right' },
    2: { list: 'bullet', dir: 'rtl' },
    3: { list: 'bullet', dir: 'rtl' },
  },
});

describe('the model becomes OpenDocument XML', () => {
  it('writes direction, headings, runs, lists and tables the way a reader expects', () => {
    const doc = model();
    const content = odtContentXml(doc, []);
    /** The document's own text, taken from the model so no Arabic literal is typed twice. */
    const textOf = (block: number, run = 0): string => (doc.blocks![block].runs[run] as { text: string }).text;

    // One document, correct namespaces and version.
    expect(content.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(content).toContain('xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"');
    expect(content).toContain('office:version="1.2"');
    expect(content).toContain('<office:body>');
    expect(content.endsWith('</office:document-content>\n')).toBe(true);

    // RTL is a paragraph property, not only an alignment: without it an Arabic paragraph is laid
    // out left-to-right in the reader however its characters are aligned.
    expect(content).toContain('style:writing-mode="rl-tb"');
    expect(content).toMatch(/<style:style style:name="P\d+" style:family="paragraph" style:parent-style-name="Heading1">/);
    expect(content).toContain('text:outline-level="1"');
    // The heading wraps the paragraph's own text, character for character (compared as code points,
    // because a mixed Arabic/Latin needle is reordered by the terminal and proves nothing visually).
    const headingOpen = content.indexOf('<text:h ');
    const headingTextStart = content.indexOf('>', headingOpen) + 1;
    const headingInner = content.slice(headingTextStart, headingTextStart + textOf(0).length);
    expect([...headingInner].map((char) => char.codePointAt(0))).toEqual([...textOf(0)].map((char) => char.codePointAt(0)));
    expect(content.slice(headingTextStart + textOf(0).length, headingTextStart + textOf(0).length + '</text:h>'.length)).toBe('</text:h>');

    // Runs: bold and italic+colour are spans with their own automatic styles.
    expect(content).toContain(`<text:span text:style-name="T`);
    expect(content).toContain(`>${textOf(1, 1)}</text:span>`);
    expect(content).toContain('fo:font-weight="bold"');
    expect(content).toContain('fo:font-style="italic"');
    expect(content).toContain('fo:color="#c8894b"');
    expect(content).toContain(textOf(1, 0));

    // Two consecutive bulleted paragraphs are ONE list with two items, not two paragraphs.
    expect(content).toContain('<text:list text:style-name="LBullet">');
    expect((content.match(/<text:list-item>/g) ?? []).length).toBe(2);
    expect((content.match(/<\/text:list>/g) ?? []).length).toBe(1);

    // The table keeps its grid: one row, two columns, both cells filled.
    expect(content).toContain('<table:table table:name="Table1" table:style-name="TableGrid">');
    expect(content).toContain('<table:table-column table:number-columns-repeated="2"/>');
    expect((content.match(/<table:table-cell /g) ?? []).length).toBe(2);
    expect(content).toContain(textOf(4));
    expect(content).toContain(textOf(5));

    // The named styles the body leans on exist in styles.xml, lists included.
    const styles = odtStylesXml();
    expect(styles).toContain('<style:style style:name="Standard"');
    expect(styles).toContain('<style:style style:name="Heading1"');
    expect(styles).toContain('<text:list-style style:name="LBullet">');
    expect(styles).toContain('<text:list-style style:name="LNumber">');
    expect(styles).toContain('style:num-format="1"');
  });

  it('escapes text, keeps its spacing, and maps alignment logically', () => {
    expect(xmlEscape('a & b < c > d "e" \'f\'')).toBe('a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;');
    // Control characters XML 1.0 forbids are dropped, not smuggled into the part.
    expect(xmlEscape('ok\u0000\u0008 here')).toBe('ok here');
    expect(odtText('a\tb\nc')).toBe('a<text:tab/>b<text:line-break/>c');
    expect(odtText('a  b   c')).toBe('a<text:s text:c="2"/>b<text:s text:c="3"/>c');
    expect(odtText('عربي & <وسم>')).toBe('عربي &amp; &lt;وسم&gt;');
    // ODF alignment is logical: "right" in an RTL paragraph is the paragraph's start.
    expect(logicalAlign('right', true)).toBe('start');
    expect(logicalAlign('left', true)).toBe('end');
    expect(logicalAlign('left', false)).toBe('start');
    expect(logicalAlign('center', true)).toBe('center');
    expect(logicalAlign(null, true)).toBeNull();
    // A picture name can never escape Pictures/.
    expect(safeImageName('../../etc/passwd', 'png')).toBe('passwd.png');
    expect(safeImageName('صورة ١', 'jpeg')).toMatch(/^-+\.jpg$/);
    // The meta part always carries a title and the generator.
    expect(odtMetaXml({ title: 'تقرير', created: '2026-09-25T00:00:00.000Z' })).toContain('<dc:title>تقرير</dc:title>');
    expect(odtMetaXml({})).toContain('<dc:title>Untitled</dc:title>');
  });
});

describe('the container is a valid ODF package', () => {
  it('puts mimetype first, stored uncompressed, and declares every part in the manifest', () => {
    const bytes = toOdt(model(), { title: 'تقرير', created: '2026-09-25T00:00:00.000Z' });

    // 1. The FIRST local file header must be `mimetype`…
    expect(bytes[0]).toBe(0x50); // 'P'
    const firstNameLength = bytes[26] | (bytes[27] << 8);
    const firstName = new TextDecoder().decode(bytes.subarray(30, 30 + firstNameLength));
    expect(firstName).toBe('mimetype');

    // 2. …and it must be STORED (method 0), never deflated — readers refuse the file otherwise.
    const method = bytes[8] | (bytes[9] << 8);
    expect(method).toBe(0);
    const size = bytes[18] | (bytes[19] << 8) | (bytes[20] << 16) | (bytes[21] << 24);
    const content = new TextDecoder().decode(bytes.subarray(30 + firstNameLength, 30 + firstNameLength + size));
    expect(content).toBe(ODT_MIME);
    expect(content).toBe('application/vnd.oasis.opendocument.text');

    // 3. The archive reads back, and the order is the one ODF requires.
    const zip = readRawZip(bytes);
    expect(zip.entries.map((entry) => entry.name)).toEqual([
      'mimetype', 'META-INF/manifest.xml', 'content.xml', 'styles.xml', 'meta.xml',
    ]);
    expect(zip.entries.find((entry) => entry.name === 'mimetype')?.method).toBe(0);
    const partText = (name: string): string => {
      const entry = zip.entries.find((candidate) => candidate.name === name)!;
      return new TextDecoder().decode(storedData(bytes, entry));
    };

    // 4. The manifest declares the container and every part that follows, with its media type.
    const manifest = partText('META-INF/manifest.xml');
    expect(manifest).toContain('<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">');
    expect(manifest).toContain('manifest:full-path="/" manifest:version="1.2" manifest:media-type="application/vnd.oasis.opendocument.text"');
    for (const part of ['content.xml', 'styles.xml', 'meta.xml', 'META-INF/manifest.xml']) {
      expect(manifest, part).toContain(`manifest:full-path="${part}" manifest:media-type="text/xml"`);
    }

    // 5. Every XML part is a whole document, and the document's own text is inside content.xml.
    for (const entry of zip.entries.filter((candidate) => candidate.name !== 'mimetype')) {
      const text = partText(entry.name);
      expect(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), entry.name).toBe(true);
      expect(text.trimEnd().endsWith('>'), entry.name).toBe(true);
    }
    const contentXml = partText('content.xml');
    expect(contentXml).toContain('تقرير Fai$al OS');
    expect(contentXml).toContain('style:writing-mode="rl-tb"');
    // …and the media type really is the ODF text type, byte for byte.
    expect(utf8(ODT_MIME).length).toBe(ODT_MIME.length);
  });
});
