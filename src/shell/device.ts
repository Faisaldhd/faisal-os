/**
 * Device policy for the shell.
 *
 * The product rule is that mobile is not "a smaller desktop": on a phone or tablet a
 * windowed desktop with drag-and-resize chrome is unusable, so applications take the whole
 * surface. This module holds that decision in one place so the window manager, the CSS
 * breakpoints and the tests all agree on the same numbers.
 */

/**
 * Width (CSS px) below which the surface counts as narrow. This is the ONE source of truth
 * for the value; `wm.ts` imports it, and `theme.css` mirrors it in the narrow media query
 * (`max-width: 699px`, chosen to match the strict `<` comparison used here).
 */
export const NARROW_BREAKPOINT = 700;

type MediaQueryListLike = {
  matches: boolean;
  addEventListener?: (type: 'change', listener: () => void) => void;
  removeEventListener?: (type: 'change', listener: () => void) => void;
};

/** Uses the `function` form so the receiver is preserved (`matchMedia` is not a free function). */
const COARSE_QUERY = '(pointer: coarse)';

function queryList(query: string): MediaQueryListLike | null {
  const mm = typeof window !== 'undefined' ? window.matchMedia : undefined;
  if (typeof mm !== 'function') return null;
  try {
    const list = mm.call(window, query) as unknown as MediaQueryListLike | null | undefined;
    return list && typeof list.matches === 'boolean' ? list : null;
  } catch {
    return null; // an unparsable query must never take the shell down
  }
}

/**
 * True on touch-first devices (phone, tablet, or a touchscreen laptop whose primary pointer
 * is a finger). Guarded: jsdom has no `matchMedia`, where this is simply `false`.
 */
export function isCoarsePointer(): boolean {
  return queryList(COARSE_QUERY)?.matches === true;
}

/**
 * Should a surface this wide use the compact (phone) shell layout?
 *
 * PURE, so the shell can decide it from a *measured* width (a ResizeObserver on the shell
 * root) instead of only from a viewport media query: a narrow desktop window then gets the
 * same compact chrome as a phone. This is the one place the comparison lives; `theme.css`
 * mirrors it in `max-width: 699px` as the no-JS/first-paint fallback, and `shouldFillScreen`
 * below reads it too.
 *
 * The comparison is strict (`<`), exactly like the window manager's original narrow check:
 * at exactly `breakpoint` (700) the desktop layout stays.
 */
export function isCompactWidth(width: number, breakpoint = NARROW_BREAKPOINT): boolean {
  return width < breakpoint;
}

/**
 * Should a window fill the whole surface instead of floating?
 *
 * PURE: the caller supplies the measurements, so this is testable without a DOM.
 * Reasoning: a narrow surface has no room for a windowed desktop at all, and a coarse
 * pointer cannot reliably grab a 6px resize grip, drag a titlebar or hit a 26px titlebar
 * button — so on touch the window fills the surface even on a large tablet. Both conditions
 * are deliberately the same decision (fill), which is why they share one function.
 *
 * The comparison is strict (`<`), exactly like the window manager's original narrow check:
 * at exactly `breakpoint` (700) and a fine pointer the window floats as before.
 */
export function shouldFillScreen(input: { width: number; coarse: boolean; breakpoint?: number }): boolean {
  return isCompactWidth(input.width, input.breakpoint) || input.coarse;
}

/**
 * Watches the `(pointer: coarse)` media query so a tablet that gains a mouse (or a phone
 * that gains a keyboard/trackpad) adapts without a reload.
 *
 * Returns an unsubscribe function. Degrades to a no-op when `matchMedia` is unavailable
 * (jsdom) or when the browser lacks `addEventListener` on media query lists.
 */
export function watchPointerKind(cb: (coarse: boolean) => void): () => void {
  const list = queryList(COARSE_QUERY);
  if (!list || typeof list.addEventListener !== 'function') return () => {};
  const onChange = () => cb(list.matches === true);
  list.addEventListener('change', onChange);
  return () => list.removeEventListener?.('change', onChange);
}
