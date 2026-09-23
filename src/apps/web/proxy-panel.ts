/**
 * Fai$al OS — the DOM half of the OPT-IN local proxy flow (واجهة الوسيط المحلي).
 *
 * Why this is a separate module from ./index.ts: the window file is already the
 * shared content of every web app, and the proxy flow is a self-contained set of
 * cards. Keeping it here means the window only has to call four builders and
 * hold four pieces of state (see ProxyUiState).
 *
 * Security rules this module obeys, without exception:
 *  • every user-visible node is created with `createElement` and filled with
 *    `textContent` — NO `innerHTML`, NO `insertAdjacentHTML`, NO `document.write`;
 *  • the token lives in a `type="password"` input, is read once on submit and is
 *    never put in a `title`, a placeholder, a data-attribute, a URL or a log;
 *  • the proxied frame is never inspected: we set `src` and nothing else;
 *  • no `postMessage` in either direction.
 *
 * All copy comes from the `web.*` table in ./strings.ts (both languages).
 */
import { t } from '../../kernel/i18n';
import { isPrivateAddress, readProxyEnabled, writeProxyEnabled, type ProxyMode, type ProxyStorage } from './local-proxy';

export type { ProxyMode, ProxyStorage };

/** Where the proxy flow currently is, inside one window. */
export interface ProxyUiState {
  /** The `faisal.web.proxy.enabled` flag as last written by THIS window. */
  enabled: boolean;
  /** Set only after the owner chose a sub-mode in this window. */
  mode: ProxyMode | null;
  /** Which card (if any) is open on top of the fallback card. */
  panel: 'none' | 'modes' | 'token';
  /** Last error shown in the token / reader card, already translated. */
  error: string | null;
}

/**
 * The enabled flag is a RECORD of the owner's last choice, never a gate: a
 * window only proxies once a mode was chosen in it (`mode: null` below), so a
 * stored `'true'` cannot switch anything on by itself.
 */
export function initialProxyState(storage: ProxyStorage): ProxyUiState {
  try {
    return { enabled: readProxyEnabled(storage), mode: null, panel: 'none', error: null };
  } catch {
    return { enabled: false, mode: null, panel: 'none', error: null };
  }
}

/** True only after the owner picked a sub-mode in THIS window. */
export function proxyIsActive(state: ProxyUiState): boolean {
  return state.mode !== null;
}

/** Records the owner's choice. Only ever called from a click in this window. */
export function markProxyEnabled(storage: ProxyStorage, enabled: boolean): void {
  try {
    writeProxyEnabled(storage, enabled);
  } catch {
    /* best effort */
  }
}


/** Everything the cards need from the window; all callbacks are one-shot clicks. */
export interface ProxyPanelHost {
  /**
   * The proxy action was clicked: ask for a token when the running tool requires
   * one, otherwise go straight to the two sub-modes.
   */
  openProxy(): void;
  /** Show the two sub-modes. */
  chooseMode(): void;
  /** Pick a sub-mode (only ever called from a click in this window). */
  setMode(mode: ProxyMode): void;
  /** Turn the proxy off and clear the enabled flag. */
  stop(): void;
  /** Back to the fallback card. */
  cancel(): void;
  /** Open a URL in a real browser tab. */
  openExternal(url: string): void;
  /** Replace the panel error text (already translated). */
  setError(message: string | null): void;
}

/* ─────────────────────────────── shared pieces ─────────────────────────────── */

function plainButton(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

/** The permanent badge bar. While it is on screen, the window is in proxy mode. */
export function buildProxyBar(
  mode: ProxyMode,
  targetUrl: string,
  host: ProxyPanelHost,
): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'faisal-web-proxybar';
  bar.setAttribute('role', 'status');

  const badge = document.createElement('span');
  badge.className = 'faisal-web-proxy-badge';
  badge.textContent = t(mode === 'raw' ? 'web.proxyBadgeRaw' : 'web.proxyBadgeReader');

  const note = document.createElement('span');
  note.className = 'faisal-web-proxy-note';
  note.textContent = t('web.proxyHint');

  const open = plainButton(t('web.proxyOpenOriginal'), 'faisal-web-btn is-plain', () => {
    host.openExternal(targetUrl);
  });

  const stop = plainButton(t('web.proxyStop'), 'faisal-web-btn is-plain faisal-web-proxy-stop', () => {
    host.stop();
  });

  bar.append(badge, note, open, stop);
  return bar;
}

/** Best-effort warning shown with the raw embed: it is permanent, not a toast. */
export function buildRawWarning(): HTMLElement {
  const note = document.createElement('div');
  note.className = 'faisal-web-notice faisal-web-proxy-rawwarning';
  note.textContent = t('web.proxyRawWarning');
  return note;
}

/** Honest refusal shown BEFORE any request when the target is obviously private. */
export function buildTargetWarning(): HTMLElement {
  const box = document.createElement('div');
  box.className = 'faisal-web-proxy-error';
  box.textContent = t('web.proxyBlockedTarget');
  return box;
}

/**
 * The third action on the fallback card. Only ever appended when the probe
 * reported a reachable proxy — see ./index.ts.
 */
export function buildProxyFallbackAction(host: ProxyPanelHost): HTMLButtonElement {
  return plainButton(t('web.proxyAction'), 'faisal-web-btn is-plain faisal-web-proxy-open', () => {
    // NOT chooseMode(): the window decides whether a token is needed first, and
    // that decision must not be bypassable from the DOM.
    host.openProxy();
  });
}

/* ──────────────────────────────── the token card ──────────────────────────────── */

/**
 * The inline token form. `initial` is the token already stored (if any) and is
 * deliberately NOT pre-filled: asking again is cheaper than leaking an existing
 * token into the DOM of a page that never needed it.
 */
export function buildTokenPanel(
  auth: 'none' | 'token-required' | null,
  error: string | null,
  onSubmit: (token: string) => void,
  host: ProxyPanelHost,
): HTMLElement {
  const card = document.createElement('div');
  card.className = 'faisal-web-fallback';

  const title = document.createElement('div');
  title.className = 'faisal-web-fallback-title';
  title.textContent = t('web.proxyTokenTitle');

  const body = document.createElement('div');
  body.className = 'faisal-web-fallback-body';
  body.textContent = auth === 'none' ? t('web.proxyHint') : t('web.proxyTokenNeeded');

  const form = document.createElement('form');
  form.className = 'faisal-web-proxy-token';

  const label = document.createElement('label');
  label.htmlFor = 'faisal-web-proxy-token';
  label.textContent = t('web.proxyTokenLabel');

  const input = document.createElement('input');
  input.id = 'faisal-web-proxy-token';
  input.type = 'password';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.className = 'faisal-web-proxy-tokeninput';
  input.placeholder = t('web.proxyTokenPlaceholder');
  input.setAttribute('aria-label', t('web.proxyTokenLabel'));

  const actions = document.createElement('div');
  actions.className = 'faisal-web-fallback-actions';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'faisal-web-open';
  submit.textContent = t('web.proxyTokenSubmit');
  actions.append(submit, plainButton(t('web.proxyTokenCancel'), 'faisal-web-btn is-plain', () => host.cancel()));

  form.append(label, input, actions);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    // This form lives INSIDE the window's address <form> subtree, so without
    // this the shell's own submit handler would also fire, read the (unchanged)
    // address field and navigate away, throwing the token card out from under
    // the user. The token check owns this event and nothing else may see it.
    ev.stopPropagation();
    const value = input.value;
    // Never keep the raw token in the DOM while the request is in flight.
    input.value = '';
    onSubmit(value);
  });

  card.append(title, body, form);
  if (error) {
    const box = document.createElement('div');
    box.className = 'faisal-web-proxy-error';
    box.textContent = error;
    card.append(box);
  }
  return card;
}

/* ─────────────────────────────── the mode picker ─────────────────────────────── */

/**
 * The two sub-modes. Reader is the default and is presented first; raw embed is
 * explicitly labelled as the rough one. Nothing is preselected silently: both
 * are buttons the owner must click.
 */
export function buildProxyModePicker(error: string | null, host: ProxyPanelHost): HTMLElement {
  const card = document.createElement('div');
  card.className = 'faisal-web-fallback';

  const title = document.createElement('div');
  title.className = 'faisal-web-fallback-title';
  title.textContent = t('web.proxyModeTitle');

  const body = document.createElement('div');
  body.className = 'faisal-web-fallback-body';
  body.textContent = t('web.proxyHint');

  const choices = document.createElement('div');
  choices.className = 'faisal-web-proxy-modes';

  const reader = document.createElement('button');
  reader.type = 'button';
  reader.className = 'faisal-web-open faisal-web-proxy-reader';
  reader.textContent = t('web.proxyModeReader');
  reader.addEventListener('click', () => host.setMode('reader'));

  const readerHint = document.createElement('div');
  readerHint.className = 'faisal-web-proxy-modehint';
  readerHint.textContent = t('web.proxyModeReaderHint');

  const raw = document.createElement('button');
  raw.type = 'button';
  raw.className = 'faisal-web-btn is-plain faisal-web-proxy-raw';
  raw.textContent = t('web.proxyModeRaw');
  raw.addEventListener('click', () => host.setMode('raw'));

  const rawHint = document.createElement('div');
  rawHint.className = 'faisal-web-proxy-modehint';
  rawHint.textContent = t('web.proxyModeRawHint');

  choices.append(reader, readerHint, raw, rawHint);

  const actions = document.createElement('div');
  actions.className = 'faisal-web-fallback-actions';
  actions.append(plainButton(t('web.proxyTokenCancel'), 'faisal-web-btn is-plain', () => host.cancel()));

  card.append(title, body, choices, actions);
  if (error) {
    const box = document.createElement('div');
    box.className = 'faisal-web-proxy-error';
    box.textContent = error;
    card.append(box);
  }
  return card;
}

/* ──────────────────────────────── reader panel ──────────────────────────────── */

/**
 * Native rendering of the extracted text. `title` and `blocks` came from an
 * untrusted page through ./reader.ts, so every one of them is written with
 * `textContent` into a fresh element — there is no markup path at all.
 */
export function buildReaderPanel(
  title: string,
  blocks: string[],
  targetUrl: string,
  host: ProxyPanelHost,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'faisal-web-reader';

  const inner = document.createElement('div');
  inner.className = 'faisal-web-reader-blocks';

  const bar = document.createElement('div');
  bar.className = 'faisal-web-reader-bar';
  bar.append(plainButton(t('web.proxyOpenOriginal'), 'faisal-web-btn is-plain', () => {
    host.openExternal(targetUrl);
  }));

  if (title) {
    const heading = document.createElement('div');
    heading.className = 'faisal-web-reader-title';
    heading.textContent = title;
    bar.append(heading);
  }
  inner.append(bar);

  if (!blocks.length) {
    const empty = document.createElement('p');
    empty.className = 'faisal-web-reader-block faisal-web-reader-empty';
    empty.textContent = t('web.proxyReaderEmpty');
    inner.append(empty);
  } else {
    for (const block of blocks) {
      const p = document.createElement('p');
      p.className = 'faisal-web-reader-block';
      p.textContent = block;
      inner.append(p);
    }
  }

  wrap.append(inner);
  return wrap;
}

/** Reader mode is asynchronous: this is what is on screen while it fetches. */
export function buildReaderLoading(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'faisal-web-reader';
  const status = document.createElement('div');
  status.className = 'faisal-web-loading';
  status.setAttribute('role', 'status');
  const ring = document.createElement('span');
  ring.className = 'faisal-web-spinner';
  const label = document.createElement('span');
  label.textContent = t('web.proxyReaderLoading');
  status.append(ring, label);
  wrap.append(status);
  return wrap;
}

/**
 * Raw mode is asynchronous too, for a different reason: the iframe must not
 * exist until the single-use ticket does (a frame cannot send the token header).
 * This is what is on screen during that one round trip.
 */
export function buildRawLoading(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'faisal-web-reader';
  const status = document.createElement('div');
  status.className = 'faisal-web-loading';
  status.setAttribute('role', 'status');
  const ring = document.createElement('span');
  ring.className = 'faisal-web-spinner';
  const label = document.createElement('span');
  label.textContent = t('web.proxyRawLoading');
  status.append(ring, label);
  wrap.append(status);
  return wrap;
}

/** A failed reader fetch: explained, retryable, and never silently empty. */
export function buildReaderError(
  message: string,
  targetUrl: string,
  retry: () => void,
  host: ProxyPanelHost,
): HTMLElement {
  const card = document.createElement('div');
  card.className = 'faisal-web-fallback';

  const title = document.createElement('div');
  title.className = 'faisal-web-fallback-title';
  title.textContent = t('web.proxyTitle');

  const body = document.createElement('div');
  body.className = 'faisal-web-fallback-body';
  body.textContent = message;

  const urlLine = document.createElement('div');
  urlLine.className = 'faisal-web-fallback-url';
  urlLine.dir = 'ltr';
  urlLine.textContent = targetUrl;

  const actions = document.createElement('div');
  actions.className = 'faisal-web-fallback-actions';
  actions.append(
    plainButton(t('web.retry'), 'faisal-web-btn is-plain', retry),
    plainButton(t('web.proxyOpenOriginal'), 'faisal-web-open', () => host.openExternal(targetUrl)),
    plainButton(t('web.proxyStop'), 'faisal-web-btn is-plain', () => host.stop()),
  );

  card.append(title, body, urlLine, actions);
  return card;
}

/* ─────────────────────────────── window-side helpers ─────────────────────────────── */

/**
 * The proxy target for the URL currently on screen. Kept pure so ./index.ts
 * cannot accidentally proxy something other than what the user is looking at.
 */
export function proxyTargetOf(displayUrl: string | null, fallback: string): string {
  return displayUrl ?? fallback;
}

/** Should the reader card show the private-address warning before any request? */
export function targetIsObviouslyPrivate(targetUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(targetUrl);
  } catch {
    return true;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
  return isPrivateAddress(u.hostname);
}
