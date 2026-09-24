/**
 * Escape priority (زر Esc بالأولوية).
 *
 * Every floating surface in the shell — menus, dialogs, the clipboard panel, the Activities
 * overview, the notification panel, the screenshot overlay — registers itself here while it is
 * open. ONE capture-phase listener on `window` then hands Escape to the surface that opened last
 * (the one on top) and consumes the event, so a single keypress can never close two surfaces at
 * once, and never reaches whatever sits behind the popup.
 *
 * A capture listener on `window` is deliberate: it runs before any listener an app registers on
 * `document` or on its own elements, which is exactly what makes the topmost popup win.
 *
 * Fullscreen: while the shell is in real fullscreen, Chromium reserves Escape to leave
 * fullscreen and never delivers it to the page — verified in a real browser: not even a capture
 * listener on `window` sees it, and calling `requestFullscreen()` right after is refused for
 * lack of a user gesture. So "close the popup *and* stay fullscreen" is not something any page
 * can do. What this module still delivers is the second best outcome: the moment the shell
 * leaves fullscreen, the topmost surface closes straight away, so Escape never strands a popup
 * over the desktop.
 */
const layers: Array<() => void> = [];
let installed = false;

/** Closes the topmost registered surface. True when there was one. */
export function closeTop(): boolean {
  const top = layers.pop();
  if (!top) return false;
  top();
  return true;
}

function onKeydown(ev: KeyboardEvent) {
  if (ev.key !== 'Escape' || ev.isComposing || !layers.length) return;
  ev.preventDefault();
  ev.stopPropagation();
  ev.stopImmediatePropagation();
  closeTop();
}

function onFullscreenChange() {
  if (!document.fullscreenElement) closeTop();
}

function install() {
  if (installed) return;
  installed = true;
  window.addEventListener('keydown', onKeydown, true);
  document.addEventListener('fullscreenchange', onFullscreenChange);
}

/**
 * Registers an open surface. Keep the returned function and call it whenever the surface closes,
 * whatever closed it, so a layer is never left behind on the stack.
 */
export function pushEscapeLayer(close: () => void): () => void {
  install();
  layers.push(close);
  let live = true;
  return () => {
    if (!live) return;
    live = false;
    const i = layers.lastIndexOf(close);
    if (i >= 0) layers.splice(i, 1);
  };
}

/** How many surfaces are open. For tests. */
export function escapeLayerCount(): number {
  return layers.length;
}
