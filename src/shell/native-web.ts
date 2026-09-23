/**
 * Native web views — only in the desktop (Electron) build.
 *
 * In a browser tab the Browser and Web apps can only use <iframe>, which most
 * big sites refuse. The desktop build (electron/) exposes `window.faisalDesktop`
 * and enables Electron's <webview>: a real browsing context in its own process,
 * so those sites load normally. Everywhere else `nativeWeb()` is null and the
 * apps keep their iframe path unchanged.
 *
 * The main process (electron/main.cjs) forces every webview into a sandboxed,
 * Node-less, preload-less guest on its own session partition and only lets it
 * load http(s); nothing set here can loosen that.
 */

interface DesktopBridge {
  readonly isDesktop: true;
  openExternal(url: string): Promise<void>;
  onOpenTab(callback: (url: string, fromId: number) => void): () => void;
}

/** The subset of Electron's WebviewTag the apps use. */
export interface WebviewElement extends HTMLElement {
  src: string;
  loadURL(url: string): Promise<void>;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  getURL(): string;
  getTitle(): string;
  getWebContentsId(): number;
}

export interface NavigateEvent extends Event { url: string; isMainFrame?: boolean }
export interface TitleEvent extends Event { title: string }

/** Must match WEB_PARTITION in electron/main.cjs (the main process enforces it anyway). */
const WEB_PARTITION = 'persist:faisal-web';

export function nativeWeb(): DesktopBridge | null {
  const bridge = (globalThis as { faisalDesktop?: DesktopBridge }).faisalDesktop;
  return bridge?.isDesktop === true ? bridge : null;
}

/** Only http(s) ever reaches a webview. */
export function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

export function createWebview(url: string, className: string): WebviewElement {
  const view = document.createElement('webview') as WebviewElement;
  view.className = className;
  view.setAttribute('partition', WEB_PARTITION);
  // Lets the main process see window.open/target=_blank and turn it into a tab.
  view.setAttribute('allowpopups', '');
  view.setAttribute('src', url);
  return view;
}

/** webview methods throw until the guest is attached (`dom-ready`). */
export function safeCall<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Opens `url` in the user's real browser: the system browser on desktop, a new tab on the web. */
export function openInRealBrowser(url: string): void {
  const bridge = nativeWeb();
  if (bridge) void bridge.openExternal(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}
