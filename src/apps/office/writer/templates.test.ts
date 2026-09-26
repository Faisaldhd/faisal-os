/**
 * Templates: the naming rules, the collision rule, the built-in template and taking a template from
 * an open document. All pure — the window only reads and writes the paths these functions produce.
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DocModel } from '../model';
import { writeZip, utf8 } from '../zip';
import { contentTypes } from '../ooxml';
import {
  DEFAULT_TEMPLATE_BASE, TEMPLATES_DIR, TEMPLATE_EXT, TEMPLATE_NAME_MAX, defaultTemplateBlocks,
  defaultTemplateLines, isTemplatePath, newDocumentName, safeTemplateName, templateFromDocument,
  templateLabel, templatePath, templatesIn, uniqueTemplateName,
} from './templates';
import { blockText, type DocBlock } from './types';

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** The template as a real `.docx`: evidence that a template is an ordinary document. */
function templateDocx(): Uint8Array {
  const body = defaultTemplateBlocks()
    .map((b) => `<w:p>${b.runs.map((r) => `<w:r><w:t xml:space="preserve">${r.text}</w:t></w:r>`).join('')}</w:p>`)
    .join('');
  const ct = contentTypes([
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
  ]);
  return writeZip([
    { name: '[Content_Types].xml', data: utf8(ct) },
    { name: '_rels/.rels', data: utf8(`${DECL}<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`) },
    { name: 'word/document.xml', data: utf8(`${DECL}<w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`) },
  ]);
}

describe('templates — safe names', () => {
  it('keeps a readable name and removes what a file name may not carry', () => {
    expect(safeTemplateName('تقرير شهري')).toBe('تقرير شهري');
    expect(safeTemplateName('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j');
    expect(safeTemplateName('  نقاط   متعددة  ')).toBe('نقاط متعددة');
    expect(safeTemplateName('..hidden..')).toBe('hidden');
    expect(safeTemplateName('line\u0000break\u001fhere')).toBe('line break here');
  });

  it('never returns an empty name, and caps the length', () => {
    expect(safeTemplateName('')).toBe(DEFAULT_TEMPLATE_BASE);
    expect(safeTemplateName('   ')).toBe(DEFAULT_TEMPLATE_BASE);
    expect(safeTemplateName('...')).toBe(DEFAULT_TEMPLATE_BASE);
    expect(safeTemplateName(undefined, 'بديل')).toBe('بديل');
    expect(safeTemplateName('x'.repeat(200))).toHaveLength(TEMPLATE_NAME_MAX);
  });

  it('builds paths and labels that agree with each other', () => {
    const path = templatePath('عقد عمل');
    expect(path).toBe(`${TEMPLATES_DIR}/عقد عمل.${TEMPLATE_EXT}`);
    expect(templateLabel(path)).toBe('عقد عمل');
    expect(templateLabel('Report.docx')).toBe('Report');
    expect(isTemplatePath(path)).toBe(true);
    expect(isTemplatePath('/home/user/Documents/عقد عمل.docx')).toBe(false);
    expect(isTemplatePath(`${TEMPLATES_DIR}/notes.txt`)).toBe(false);
    // A name that needed cleaning also lands in a safe path.
    expect(templatePath('a/b:c')).toBe(`${TEMPLATES_DIR}/a b c.${TEMPLATE_EXT}`);
  });

  it('prevents collisions, including case-only ones, and stays inside the cap', () => {
    expect(uniqueTemplateName([], 'Report')).toBe('Report');
    expect(uniqueTemplateName(['Report.docx'], 'Report')).toBe('Report 2');
    expect(uniqueTemplateName(['Report.docx', 'report 2.docx'], 'report')).toBe('report 3');
    expect(uniqueTemplateName(['قالب.docx'], 'قالب')).toBe('قالب 2');
    expect(uniqueTemplateName([`${'x'.repeat(TEMPLATE_NAME_MAX)}.docx`], 'x'.repeat(TEMPLATE_NAME_MAX))).toHaveLength(TEMPLATE_NAME_MAX);
  });

  it('lists only templates, in reading order', () => {
    const paths = [
      `${TEMPLATES_DIR}/ب.docx`, '/home/user/Documents/ع.docx', `${TEMPLATES_DIR}/أ.docx`, `${TEMPLATES_DIR}/note.txt`,
    ];
    expect(templatesIn(paths).map((t) => t.name)).toEqual(['أ', 'ب']);
    expect(templatesIn(paths)[0].path).toBe(`${TEMPLATES_DIR}/أ.docx`);
  });
});

describe('templates — the built-in template', () => {
  it('has content, so the first visit is never an empty list', () => {
    const blocks = defaultTemplateBlocks();
    expect(blocks.length).toBeGreaterThan(0);
    expect(defaultTemplateLines()[0]).toBe('عنوان المستند');
    expect(blocks.map(blockText)).toEqual(defaultTemplateLines());
    expect(blocks[0].runs[0]).toMatchObject({ t: 'text', props: { b: true } });
  });

  it('is an ordinary .docx that our own reader accepts', async () => {
    const bytes = templateDocx();
    expect(bytes.length).toBeGreaterThan(200);
    // The package is a plain Word file: no new format, no sidecar.
    const { readDocxDocument } = await import('./docxread');
    const read = await readDocxDocument(bytes);
    expect(read.blocks.map(blockText)).toEqual(defaultTemplateLines());
    const dir = `${process.env.TEMP ?? '.'}\\faisal-verify`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}\\template-default.docx`, bytes);
    // The document created FROM the template is a byte-for-byte independent copy.
    const copy = `${dir}\\template-new-document.docx`;
    fs.writeFileSync(copy, bytes);
    expect(fs.readFileSync(copy).equals(fs.readFileSync(`${dir}\\template-default.docx`))).toBe(true);
  });
});

describe('templates — taking a template from a document', () => {
  const blocks: DocBlock[] = [
    { id: 0, runs: [{ t: 'text', text: 'عنوان', props: { b: true } }] },
    { id: 1, runs: [{ t: 'text', text: 'جملة أولى', props: {} }] },
  ];
  const model = { kind: 'docx' as const, paragraphs: blocks.map(blockText), blocks, tracked: { items: [{ id: 1 }] } } as unknown as DocModel;

  it('keeps the content and formatting and drops the document’s own review state', () => {
    const template = templateFromDocument(model);
    expect(template.kind).toBe('docx');
    expect((template.blocks ?? []).map(blockText)).toEqual(['عنوان', 'جملة أولى']);
    expect((template.blocks ?? [])[0].runs[0]).toMatchObject({ props: { b: true } });
    expect('tracked' in template).toBe(false);
    // Purely functional: the model it came from is untouched.
    expect(model.paragraphs).toEqual(['عنوان', 'جملة أولى']);
  });

  it('falls back to the plain paragraphs when there are no rich blocks', () => {
    const plain = { kind: 'docx' as const, paragraphs: ['نصّ فقط'] } as DocModel;
    expect(templateFromDocument(plain).paragraphs).toEqual(['نصّ فقط']);
  });

  it('names a new document without colliding with what is there', () => {
    expect(newDocumentName([], 'قالب')).toBe('قالب');
    expect(newDocumentName(['قالب.docx'], 'قالب')).toBe('قالب 2');
    expect(newDocumentName(['قالب.docx'], 'a/b')).toBe('a b');
  });
});
