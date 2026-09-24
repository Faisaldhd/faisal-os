/**
 * Fai$al OS — DeepSeek Harness window: the pure, DOM-free half of the app.
 *
 * Everything the window does before it touches an <iframe> lives here, so it can
 * be unit-tested with no browser, no network and no DSH installation:
 *   • `normalizeDshUrl` — one strict validator for the endpoint. Only `http:` and
 *     `https:` survive; `javascript:`, `data:`, `blob:`, `file:`, credentials in
 *     the URL and plain garbage all return `null`. The query string is KEPT,
 *     because the token of the DSH GUI lives there (see the note below).
 *   • `dshEndpointPolicy` — says which scheme/host combination the OS's own
 *     security policy will actually allow (loopback may be http, remote must be
 *     https).
 *   • `probeDsh` — the reachability probe. Total: it never throws.
 *   • the localStorage helpers — they swallow a corrupt value and a storage that
 *     throws, exactly like the other apps' local keys.
 *
 * WHICH SERVER THIS IS: the DeepSeek Harness is the owner's own agent/chat
 * harness — a separate project (https://github.com/deepseek-ai/deepseek-harness)
 * installed outside Fai$al OS and started by the owner on his own machine. The
 * app frames the web interface that harness prints when it starts. It does not
 * install it, start it, or reach into it.
 *
 * NOTHING here is a security boundary for the framed GUI: it is a separate origin
 * with its own token, and no OS data is ever sent to it. This module only decides
 * whether we may point a frame at a URL at all.
 */

/* ─────────────────────────────── endpoint ─────────────────────────────── */

/** The one localStorage key this app owns. Never a system-wide setting. */
export const DSH_URL_KEY = 'faisal.dsh.url';

/**
 * Where DSH's web server listens when the owner starts it on this machine
 * (`corepack pnpm dsh web` from the harness checkout). Written in the canonical
 * form `normalizeDshUrl` returns (a bare origin gains a trailing slash), so the
 * default, a saved value and a probed value are always the same kind of string.
 *
 * The default carries NO token on purpose: without one the server answers 401 on
 * every path, so the app must not pretend this address is a working GUI. The
 * owner pastes the full URL the harness printed — token and all — and that is
 * what gets framed.
 */
export const DEFAULT_DSH_URL = 'http://127.0.0.1:3080/';

/** How long the probe may take before we call the endpoint silent. */
export const PROBE_TIMEOUT_MS = 4000;

/**
 * The client's own policy for the iframe, kept here as a constant so a test can
 * assert exactly what is in it (see the clipboard note below).
 *
 * `allow-same-origin` is safe to combine with `allow-scripts` here because the
 * framed GUI is always a different origin from the OS page — a loopback port is
 * still a different origin — so there is no same-origin sandbox escape back into
 * the OS document.
 *
 * WHY THE CLIPBOARD **IS** GRANTED HERE, while the Streamed Browser deliberately
 * refuses it: this frame is the owner's own local tool on his own machine, and a
 * chat UI without paste is unusable — composing a prompt means pasting text,
 * code, and paths into it. The Streamed Browser frames a remote browser session
 * where clipboard access would mean handing a stranger's page the owner's
 * clipboard; that risk does not exist for a token-protected server he started
 * himself on 127.0.0.1. The grant is still bounded: the framed origin remains
 * cross-origin, so `allow-same-origin` cannot reach the OS document, and every
 * other sandbox flag below stays out.
 */
export const IFRAME_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads';
export const IFRAME_ALLOW = 'clipboard-read; clipboard-write; fullscreen';

/** Where the honest, full documentation lives (repository-relative). */
export const DSH_DOC_PATH = 'docs/DSH.md';

/**
 * The same document, at a URL that actually opens from the deployed app.
 *
 * `docs/**` is NOT part of the published site: `.github/workflows/pages.yml`
 * uploads `dist` only, so a link to `./docs/DSH.md` would 404 for every user of
 * the live OS. The setup screen therefore links to the file in the repository,
 * and still shows `DSH_DOC_PATH` beside it so a reader knows exactly where the
 * file lives in the tree.
 */
export const DSH_DOC_URL = 'https://github.com/Faisaldhd/faisal-os/blob/main/docs/DSH.md';

/**
 * Copy-ready commands, each with the string key of its own label.
 *
 * These are language-neutral program text, not UI copy, so they are ASCII
 * literals here rather than entries in the string table: no `<...>` placeholder
 * for the parser to trip over, no newline, no backslash continuation, and not one
 * non-ASCII byte. A shell command is not prose — an Arabic word inside it is a
 * second way to fail before Node even starts, and a `\` at the end of a line is
 * bash syntax that PowerShell does not have.
 *
 * The first command is the owner's own route (the repository he cloned); the
 * second needs no checkout at all.
 */
export type DshStartCommand = { readonly id: string; readonly labelKey: string; readonly command: string };

/** The one checkout path the owner measured on his machine. */
const DSH_CHECKOUT = '$HOME' + '\\' + 'Projects' + '\\' + 'deepseek-harness';

export const DSH_START_COMMANDS: readonly DshStartCommand[] = [
  {
    // Both halves of the PowerShell pair in one paste: `;` is PowerShell's own
    // statement separator, so this is still one line and one paste.
    id: 'windows',
    labelKey: 'dsh.startWindowsLabel',
    command: 'cd ' + DSH_CHECKOUT + '; corepack pnpm dsh web',
  },
  {
    id: 'checkout',
    labelKey: 'dsh.startCheckoutLabel',
    command: 'corepack pnpm dsh web',
  },
  {
    id: 'npx',
    labelKey: 'dsh.startNpxLabel',
    command: 'npx @deepseek-ai/dsh web',
  },
];

/**
 * A stored endpoint is only ever a URL we may point an <iframe> at, so the check
 * is an allowlist of two schemes and nothing else:
 *
 *  - trimmed; empty/blank, non-strings and unparsable text → `null`
 *  - `javascript:`, `data:`, `blob:`, `file:`, `about:`, `chrome:`, a bare
 *    `127.0.0.1:3080` (parsed as scheme `127.0.0.1:`) → `null`
 *  - `http://` / `https://` with a hostname → the canonical form
 *  - credentials (`http://user:pass@host`) → `null`: the endpoint goes into an
 *    iframe `src`, a `fetch` and any error message, and a password does not
 *    belong in any of them. DSH authenticates with its own token.
 *
 * The canonical form is `new URL(raw).href`, which KEEPS the query string — and
 * that is the whole point here: DSH protects every path with a token that travels
 * in the URL, so dropping `?token=…` would produce a URL that frames a 401 page.
 * A fragment is kept too; it is the owner's paste, not ours to edit.
 */
export function normalizeDshUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;
  // `username`/`password` are set for http(s)://user:pass@host, and only there.
  if (parsed.username || parsed.password) return null;
  return parsed.href;
}

/** True for `localhost`, `127.0.0.0/8` and the IPv6 loopback `::1`. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return true;
  return /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * What the OS's own Content-Security-Policy will do with this endpoint:
 *   'https'        — always framed and always probeable.
 *   'http-loopback' — allowed by policy (loopback is trusted for a server on this
 *                     machine), so the frame and the probe work.
 *   'http-remote'  — refused by policy before it loads: remote origins must be
 *                     https. Returned so the window can say that plainly instead
 *                     of showing a blank frame.
 *   `null`         — not a URL we would ever frame (see normalizeDshUrl).
 */
export type DshEndpointPolicy = 'https' | 'http-loopback' | 'http-remote';

export function dshEndpointPolicy(input: unknown): DshEndpointPolicy | null {
  const url = normalizeDshUrl(input);
  if (!url) return null;
  const parsed = new URL(url);
  if (parsed.protocol === 'https:') return 'https';
  return isLoopbackHostname(parsed.hostname) ? 'http-loopback' : 'http-remote';
}

/* ─────────────────────────── reachability probe ─────────────────────────── */

type FetchLike = (input: string, init?: RequestInit) => Promise<unknown>;

/**
 * The reachability probe. One plain request to the endpoint, nothing else:
 *
 *  • `mode: 'no-cors'` is deliberate. DSH is a cross-origin server that answers
 *    with ordinary HTML and sends no CORS headers, so a CORS request would reject
 *    even while the server is perfectly reachable. An opaque response still
 *    *resolves*, which is exactly the signal we want: "something answered on that
 *    port". The body is never read — not JSON, empty and opaque are all the same
 *    to us.
 *  • `credentials: 'omit'` — no cookie of the OS origin is ever sent to it.
 *  • `cache: 'no-store'` — a cached answer is not a reachability answer.
 *  • A timeout aborts the request and resolves `false`.
 *  • It NEVER throws and never rejects: an invalid URL, a missing `fetch`, a
 *    synchronous throw, a network error, an abort — every one of them is `false`.
 *
 * THE DISTINCTION THAT MATTERS: "answered" is not "authorised". DSH answers 401
 * without a token on EVERY path, including `/` and `/index.html`, and that 401 is
 * an opaque response here — it resolves. So `true` means only "a server is
 * listening there", never "the GUI will render". The window says exactly that,
 * which is why the toolbar badge never claims a connection.
 */
export async function probeDsh(
  base: unknown,
  timeoutMs: number = PROBE_TIMEOUT_MS,
  fetchImpl?: FetchLike,
): Promise<boolean> {
  const url = normalizeDshUrl(base);
  if (!url) return false;
  const doFetch = fetchImpl ?? defaultFetch();
  if (!doFetch) return false;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  try {
    if (typeof AbortController === 'function') controller = new AbortController();
    const request = (async (): Promise<boolean> => {
      try {
        await doFetch(url, {
          method: 'GET',
          mode: 'no-cors',
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'follow',
          signal: controller ? controller.signal : undefined,
        } as RequestInit);
        return true;
      } catch {
        return false;
      }
    })();
    const expiry = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        try { controller?.abort(); } catch { /* nothing to abort */ }
        resolve(false);
      }, Math.max(0, timeoutMs));
    });
    return await Promise.race([request, expiry]);
  } catch {
    // Defensive: nothing above should throw, but "reachable" must never be the
    // answer to a crash.
    return false;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** The browser's own `fetch`, or undefined where there is none. */
function defaultFetch(): FetchLike | undefined {
  const f = (globalThis as { fetch?: unknown }).fetch;
  return typeof f === 'function' ? (f as FetchLike).bind(globalThis) : undefined;
}

/* ──────────────────────────── local endpoint storage ──────────────────────── */

/**
 * The only storage this app touches. Injected (never read from the global
 * directly) so a test can pass a throwing or corrupt stub, and so no part of this
 * module depends on `window`.
 *
 * This app has no `settings` permission, so it must not ask for one just to
 * remember its own endpoint: the full URL — token included — lives under
 * `faisal.dsh.url` and nowhere else.
 */
export type DshStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** A store that remembers nothing: used when localStorage is unavailable. */
export const NO_STORAGE: DshStorage = { getItem: () => null, setItem: () => {} };

/** The real store, or null when the browser blocks it (private mode, partition). */
export function localStorageOrNull(): DshStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * The endpoint the window should use: the saved one when it is still a valid DSH
 * URL, otherwise the default. A corrupt, hostile or hand-edited value can
 * therefore never reach the frame — it is simply ignored.
 */
export function savedDshUrl(storage: DshStorage): string {
  try {
    return normalizeDshUrl(storage.getItem(DSH_URL_KEY)) ?? DEFAULT_DSH_URL;
  } catch {
    return DEFAULT_DSH_URL;
  }
}

/**
 * Saves an endpoint after validation. Returns `false` (and writes nothing) for
 * anything `normalizeDshUrl` rejects, so storage can never hold a value the
 * window would refuse to use.
 */
export function saveDshUrl(url: unknown, storage: DshStorage): boolean {
  const normalized = normalizeDshUrl(url);
  if (!normalized) return false;
  try {
    storage.setItem(DSH_URL_KEY, normalized);
    return true;
  } catch {
    return false;
  }
}
