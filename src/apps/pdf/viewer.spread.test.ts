import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PdfViewer } from './viewer';
import type { PdfJsDocument, PdfJsLib } from './render';

/*
 * The viewer's spread LAYOUT, without pdf.js: a fake document gives the pages their geometry, and
 * `requestAnimationFrame` is stubbed so nothing is ever drawn — what is under test is where the
 * page boxes are put, which row each one lands in, and how the "current page" follows.
 *
 * (`index.test.ts` covers the window around this: the ribbon switch, the status line and the
 * presentation; `spread.test.ts` covers the pairing maths itself.)
 */

/** A page good enough for the layout: a real view box, a rotation, and no drawing at all. */
function fakePage() {
  return {
    view: [0, 0, 595, 842] as [number, number, number, number],
    rotate: 0,
    getViewport: ({ scale }: { scale: number }) => ({ width: 595 * scale, height: 842 * scale }),
    render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
    getTextContent: async () => ({ items: [], styles: {} }),
  };
}

function fakeDocument(pageCount: number): PdfJsDocument {
  const page = fakePage();
  return {
    numPages: pageCount,
    getPage: async () => page,
    loadingTask: { destroy: async () => {} },
  } as unknown as PdfJsDocument;
}

const pages = (viewer: PdfViewer): HTMLElement[] => [...viewer.frame.querySelectorAll<HTMLElement>('.faisal-pdf-page')];
const rows = (viewer: PdfViewer): HTMLElement[] => [...viewer.frame.querySelectorAll<HTMLElement>('.faisal-pdf-spread')];
const pagesIn = (row: HTMLElement): string[] =>
  [...row.querySelectorAll<HTMLElement>('.faisal-pdf-page')].map((page) => page.dataset.page ?? '');

function makeViewer(): { viewer: PdfViewer; changed: number[] } {
  const changed: number[] = [];
  const viewer = new PdfViewer({
    onPageChange: (page) => changed.push(page),
    onZoomChange: () => {},
    fieldValue: (_name, fallback) => fallback,
    onFieldInput: () => {},
  });
  return { viewer, changed };
}

beforeEach(() => {
  // No drawing: the layout is the subject, and jsdom has no canvas anyway.
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

describe('the spread layout of the viewer', () => {
  it('keeps one page per row until the spread is switched on', async () => {
    const { viewer } = makeViewer();
    await viewer.setDocument({} as PdfJsLib, fakeDocument(3), false);

    expect(viewer.pageCount).toBe(3);
    expect(viewer.spread).toBe(false);
    expect(rows(viewer)).toHaveLength(0);
    expect(pages(viewer).map((page) => page.dataset.page)).toEqual(['0', '1', '2']);

    viewer.setSpread(true);
    expect(viewer.spread).toBe(true);
    const spreadRows = rows(viewer);
    expect(spreadRows).toHaveLength(2);
    expect(pagesIn(spreadRows[0])).toEqual(['0']);
    expect(pagesIn(spreadRows[1])).toEqual(['1', '2']);
    // Every page still exists exactly once, inside its row now.
    expect(pages(viewer)).toHaveLength(3);
    expect(pages(viewer).every((page) => page.closest('.faisal-pdf-spread') !== null)).toBe(true);

    viewer.setSpread(false);
    expect(rows(viewer)).toHaveLength(0);
    expect(pages(viewer).map((page) => page.dataset.page)).toEqual(['0', '1', '2']);
    viewer.destroy();
  });

  it('pairs 0 · 1-2 · 3-4 for five pages and 0 · 1-2 for three', async () => {
    const { viewer } = makeViewer();
    await viewer.setDocument({} as PdfJsLib, fakeDocument(5), false);
    viewer.setSpread(true);
    expect(rows(viewer).map(pagesIn)).toEqual([['0'], ['1', '2'], ['3', '4']]);
    expect(viewer.spreadInfo()).toEqual({ spread: { index: 0, pages: [0] }, total: 3 });
    viewer.destroy();
  });

  it('moves a whole spread at a time and clamps at both ends', async () => {
    const { viewer, changed } = makeViewer();
    await viewer.setDocument({} as PdfJsLib, fakeDocument(5), false);
    viewer.setSpread(true);
    expect(viewer.currentPage).toBe(0);

    viewer.goToSpread(1);
    expect(viewer.currentPage).toBe(1);                 // the pair 2‑3 starts at page 2
    expect(viewer.spreadInfo().spread).toEqual({ index: 1, pages: [1, 2] });
    viewer.goToSpread(1);
    expect(viewer.currentPage).toBe(3);                 // the pair 4‑5 starts at page 4
    expect(viewer.spreadInfo().spread).toEqual({ index: 2, pages: [3, 4] });
    viewer.goToSpread(1);
    expect(viewer.currentPage).toBe(3);                 // and the last spread does not run past
    viewer.goToSpread(-1);
    expect(viewer.currentPage).toBe(1);
    viewer.goToSpread(-1);
    expect(viewer.currentPage).toBe(0);
    viewer.goToSpread(-1);
    expect(viewer.currentPage).toBe(0);
    // 0 → 1 → 3 → 3 → 1 → 0 → 0: the window was told about every real move, and nothing else.
    expect(changed).toEqual([1, 3, 1, 0]);
    viewer.destroy();
  });

  it('reports the first page of the pair as "the page", even when the probe is on the right one', async () => {
    const { viewer } = makeViewer();
    await viewer.setDocument({} as PdfJsLib, fakeDocument(4), false);
    viewer.setSpread(true);
    // Asking for the right-hand page of a pair lands on the spread, and the window is told 1 (page 2).
    viewer.goToPage(2);
    expect(viewer.currentPage).toBe(1);
    expect(viewer.spreadInfo().spread).toEqual({ index: 1, pages: [1, 2] });
    // The single-page view keeps the page the owner asked for.
    viewer.setSpread(false);
    viewer.goToPage(2);
    expect(viewer.currentPage).toBe(2);
    viewer.destroy();
  });

  it('fits the PAIR into the width, not one page', async () => {
    const { viewer } = makeViewer();
    await viewer.setDocument({} as PdfJsLib, fakeDocument(4), false);
    viewer.setMode('fitWidth');
    const single = viewer.zoom;
    viewer.setSpread(true);
    viewer.setMode('fitWidth');
    const pair = viewer.zoom;
    // Two pages share the width: the fit is a little under half of the single-page one (the gutter
    // between the pages is counted too), and never larger.
    expect(pair).toBeLessThan(single);
    expect(pair).toBeGreaterThan(single * 0.4);
    viewer.destroy();
  });

  it('handles a one-page document and an empty viewer without inventing rows', async () => {
    const { viewer } = makeViewer();
    await viewer.setDocument({} as PdfJsLib, fakeDocument(1), false);
    viewer.setSpread(true);
    expect(rows(viewer).map(pagesIn)).toEqual([['0']]);
    viewer.goToSpread(1);
    expect(viewer.currentPage).toBe(0);
    expect(viewer.spreadInfo()).toEqual({ spread: { index: 0, pages: [0] }, total: 1 });

    const empty = makeViewer();
    empty.viewer.setSpread(true);
    empty.viewer.goToSpread(1);
    expect(empty.viewer.pageCount).toBe(0);
    expect(rows(empty.viewer)).toHaveLength(0);
    expect(empty.viewer.spreadInfo()).toEqual({ spread: null, total: 0 });
    viewer.destroy();
    empty.viewer.destroy();
  });

  it('keeps the spread when a new document replaces the old one', async () => {
    const { viewer } = makeViewer();
    await viewer.setDocument({} as PdfJsLib, fakeDocument(2), false);
    viewer.setSpread(true);
    // Two pages and a cover rule: page 1 alone, then page 2 alone.
    expect(rows(viewer).map(pagesIn)).toEqual([['0'], ['1']]);
    await viewer.setDocument({} as PdfJsLib, fakeDocument(6), true);
    expect(viewer.spread).toBe(true);
    expect(rows(viewer).map(pagesIn)).toEqual([['0'], ['1', '2'], ['3', '4'], ['5']]);
    viewer.destroy();
  });
});
