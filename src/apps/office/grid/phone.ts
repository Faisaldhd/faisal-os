/**
 * The sheet on a phone — pure helpers.
 *
 * When the on-screen keyboard opens, the browser shrinks the *visual* viewport and leaves the
 * layout viewport alone, so anything pinned to the bottom of the window ends up under the
 * keyboard. The formula bar is lifted to sit right on top of it while an entry is open.
 */

/** How many pixels of the window the on-screen keyboard covers (0 when it is closed). */
export function keyboardInset(layoutHeight: number, visualHeight: number, visualTop: number): number {
  const covered = layoutHeight - (visualHeight + visualTop);
  // A browser toolbar sliding in or out moves the viewport by a few dozen pixels: not a keyboard.
  return covered > 120 ? Math.round(covered) : 0;
}

/** Where the lifted formula bar's top goes (layout pixels), so its bottom meets the keyboard. */
export function barTopAboveKeyboard(visualHeight: number, visualTop: number, barHeight: number): number {
  return Math.max(0, Math.round(visualTop + visualHeight - barHeight));
}
