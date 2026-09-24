import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { createBlankPdf, loadPdf } from './pdfdoc';

describe('createBlankPdf', () => {
  it('makes a verified one-page A4 document that opens again', async () => {
    const result = await createBlankPdf();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const loaded = await loadPdf(result.bytes);
    expect(loaded.ok).toBe(true);
    const doc = await PDFDocument.load(result.bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(Math.round(doc.getPage(0).getWidth())).toBe(595);
  });

  it('takes another page size', async () => {
    const result = await createBlankPdf({ width: 612, height: 792 });
    expect(result.ok && (await PDFDocument.load(result.bytes)).getPage(0).getHeight()).toBe(792);
  });
});
