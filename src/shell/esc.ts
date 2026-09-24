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
 * Fullscreen: while the shell is in fullscreen it locks the Escape key together with the Windows
 * key (`navigator.keyboard.lock(['Escape', …])` in topbar.ts). Chromium then keeps fullscreen and
 * delivers Escape to the page instead of leaving fullscreen by itself — verified in a real
 * browser. So this stack decides what Escape means while the owner is fullscreen: close the
 * topmost popup, or (with nothing open) leave fullscreen on purpose through the fallback below.
 */
const layers: Array<() => void> = [];
let installed = false;
let fallback: (() => boolean) | null = null;

/**
 * What Escape means when no surface of ours is open. Returns true when it handled the key; false
 * leaves Escape completely alone for the app or the browser. The shell uses this to leave
 * fullscreen on purpose, and only when it really is in fullscreen (topbar.ts).
 */
export function setEscapeFallback(fn: (() => boolean) | null): void {
  fallback = fn;
}

/** Closes the topmost registered surface. True when there was one. */
export function closeTop(): boolean {
  const top = layers.pop();
  if (!top) return false;
  top();
  return true;
}

function onKeydown(ev: KeyboardEvent) {
  if (ev.key !== 'Escape' || ev.isComposing) return;
  if (layers.length) {
    closeTop();
  } else if (!fallback?.()) {
    return; // nothing of ours is open and the shell has no use for the key: leave it alone
  }
  ev.preventDefault();
  ev.stopPropagation();
  ev.stopImmediatePropagation();
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
