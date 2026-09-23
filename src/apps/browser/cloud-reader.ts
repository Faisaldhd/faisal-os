/**
 * The Browser app's way into the owner's cloud proxy (tools/cloud-proxy.mjs):
 * for a site that refuses to be framed, an extra action reads the page through
 * the proxy and shows its text in the tab. Reader only, like the proxy.
 *
 * The token is the same one the Web apps store (`faisal.web.proxy.token`), so
 * the owner pastes it once for both. It is sent only to the proxy, in a header.
 * Everything is rendered with textContent.
 */
import { t } from '../../kernel/i18n';
import {
  buildProxyUrl, cloudProxyBaseFor, probeLocalProxy, proxyStorageOrNull,
  readProxyToken, writeProxyToken, clearProxyToken, NO_PROXY_STORAGE,
} from '../web/local-proxy';
import { htmlToText } from '../web/reader';

let probe: Promise<string | null> | null = null;

/** The cloud proxy base when it is configured and answering, else null (cached per page). */
export function cloudReaderBase(origin = globalThis.location?.origin ?? ''): Promise<string | null> {
  probe ??= (async () => {
    const base = cloudProxyBaseFor(origin);
    if (!base) return null;
    const result = await probeLocalProxy(base, 2500);
    return result.available && result.kind === 'cloud' ? base : null;
  })().catch(() => null);
  return probe;
}

const storage = () => proxyStorageOrNull() ?? NO_PROXY_STORAGE;

function button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

/** Adds the reader action to `actions` once the proxy has answered. */
export function offerCloudReader(actions: HTMLElement, url: string, body: HTMLElement): void {
  void cloudReaderBase().then((base) => {
    if (!base || !actions.isConnected) return;
    actions.append(button(t('browser.cloudRead'), 'faisal-browser-blocked-btn is-plain faisal-browser-cloudread',
      () => (readProxyToken(storage()) ? read(base, url, body) : askToken(base, url, body))));
  });
}

function card(): HTMLElement {
  const c = document.createElement('div');
  c.className = 'faisal-browser-blocked faisal-browser-reader';
  return c;
}

function askToken(base: string, url: string, body: HTMLElement, error?: string): void {
  body.textContent = '';
  const c = card();
  const title = document.createElement('div');
  title.className = 'faisal-browser-blocked-title';
  title.textContent = t('browser.cloudTokenTitle');
  const hint = document.createElement('div');
  hint.className = 'faisal-browser-blocked-body';
  hint.textContent = t('browser.cloudTokenHint');
  const input = document.createElement('input');
  input.type = 'password';
  input.autocomplete = 'off';
  input.className = 'faisal-browser-cloudtoken';
  input.placeholder = t('browser.cloudTokenPlaceholder');
  input.setAttribute('aria-label', t('browser.cloudTokenPlaceholder'));
  const actions = document.createElement('div');
  actions.className = 'faisal-browser-blocked-actions';
  const submit = async () => {
    const token = input.value.trim();
    input.value = '';
    if (!token) return;
    let ok = false;
    try {
      const res = await fetch(buildProxyUrl(base, 'https://example.com/'), { headers: { 'x-faisal-proxy-token': token }, cache: 'no-store' });
      ok = res.status !== 401 && res.status !== 403;
    } catch { ok = false; }
    if (!ok) { askToken(base, url, body, t('browser.cloudTokenWrong')); return; }
    writeProxyToken(storage(), token);
    read(base, url, body);
  };
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); void submit(); } });
  actions.append(button(t('browser.cloudTokenSubmit'), 'faisal-browser-blocked-btn is-primary', () => { void submit(); }));
  c.append(title, hint, input, actions);
  if (error) {
    const e = document.createElement('div');
    e.className = 'faisal-browser-cloud-error';
    e.setAttribute('role', 'alert');
    e.textContent = error;
    c.append(e);
  }
  body.append(c);
  input.focus();
}

function read(base: string, url: string, body: HTMLElement): void {
  body.textContent = '';
  const wrap = document.createElement('article');
  wrap.className = 'faisal-browser-readerpage';
  const status = document.createElement('div');
  status.className = 'faisal-browser-reader-status';
  status.setAttribute('role', 'status');
  status.textContent = t('browser.cloudLoading');
  wrap.append(status);
  body.append(wrap);

  const bar = document.createElement('div');
  bar.className = 'faisal-browser-reader-bar';
  const badge = document.createElement('span');
  badge.className = 'faisal-browser-reader-badge';
  badge.textContent = t('browser.cloudBadge');
  const open = document.createElement('a');
  open.href = url;
  open.target = '_blank';
  open.rel = 'noopener noreferrer';
  open.textContent = t('browser.openReal');
  bar.append(badge, open);

  const token = readProxyToken(storage());
  let target: string;
  try { target = buildProxyUrl(base, url); } catch { status.textContent = t('browser.cloudError'); return; }
  void fetch(target, { headers: token ? { 'x-faisal-proxy-token': token } : {}, cache: 'no-store' })
    .then(async (res) => {
      if (res.status === 401) { clearProxyToken(storage()); askToken(base, url, body, t('browser.cloudTokenWrong')); return; }
      if (!res.ok) throw new Error(String(res.status));
      const doc = htmlToText(await res.text());
      wrap.textContent = '';
      wrap.append(bar);
      if (doc.title) {
        const h = document.createElement('h1');
        h.textContent = doc.title;
        wrap.append(h);
      }
      if (!doc.blocks.length) {
        const p = document.createElement('p');
        p.className = 'faisal-browser-reader-empty';
        p.textContent = t('browser.cloudEmpty');
        wrap.append(p);
      }
      for (const block of doc.blocks) {
        const p = document.createElement('p');
        p.textContent = block;
        wrap.append(p);
      }
    })
    .catch(() => {
      wrap.textContent = '';
      wrap.append(bar);
      const p = document.createElement('p');
      p.className = 'faisal-browser-reader-empty';
      p.textContent = t('browser.cloudError');
      wrap.append(p);
    });
}
