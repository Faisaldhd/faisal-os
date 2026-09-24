/**
 * Writer — pagination arithmetic (تقسيم الصفحات), pure so it is tested alone.
 *
 * The document is one flow of blocks laid over a stack of page rectangles. A
 * block that would cross the bottom margin of its page is pushed to the top of
 * the next page (unless it already starts at a page top, in which case it is
 * simply taller than a page and stays). The view applies the push as a margin,
 * so no element ever moves in the DOM and the caret is never disturbed.
 */
export interface PageGeometry {
  /** Page height, the gap between pages and the vertical margins, all in px. */
  height: number;
  gap: number;
  top: number;
  bottom: number;
}

export interface Pagination {
  /** Extra space above each block (0 for most). */
  pushes: number[];
  /** The page each block starts on (0-based). */
  pageOf: number[];
  pages: number;
}

export function paginate(heights: readonly number[], geo: PageGeometry, breaks: ReadonlySet<number> = new Set()): Pagination {
  const stride = geo.height + geo.gap;
  const pushes: number[] = [];
  const pageOf: number[] = [];
  let y = geo.top;
  for (let i = 0; i < heights.length; i++) {
    const h = Math.max(0, heights[i]);
    let page = Math.floor(y / stride);
    const pageTop = page * stride + geo.top;
    const pageBottom = page * stride + geo.height - geo.bottom;
    let push = 0;
    const forced = breaks.has(i) && y > pageTop + 0.5;
    if (forced || (y + h > pageBottom + 0.5 && y > pageTop + 0.5)) {
      page += 1;
      const next = page * stride + geo.top;
      push = next - y;
      y = next;
    }
    pushes.push(push);
    pageOf.push(page);
    y += h;
  }
  const last = Math.max(0, Math.floor(Math.max(0, y - 1) / stride));
  return { pushes, pageOf, pages: Math.max(1, last + 1, (pageOf[pageOf.length - 1] ?? 0) + 1) };
}

/** Points → CSS pixels. */
export const PX = 96 / 72;
