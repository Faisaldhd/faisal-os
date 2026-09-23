/**
 * Fai$al OS — Streamed browser: the pure, DOM-free half of the app.
 *
 * Everything the window does before it touches an <iframe> lives here, so it
 * can be unit-tested with no browser, no network and no Docker:
 *   • `normalizeStreamUrl` — one strict validator for the endpoint. Only
 *     `http:` and `https:` survive; `javascript:`, `data:`, `blob:`, `file:`,
 *     credentials in the URL and plain garbage all return `null`.
 *   • `streamEndpointPolicy` — says which scheme/host combination the OS's own
 *     security policy will actually allow (loopback may be http, remote must
 *     be https).
 *   • `probeStream` — the reachability probe. Total: it never throws.
 *   • the localStorage helpers — they swallow a corrupt value and a storage
 *     that throws, exactly like the other apps' local keys.
 *
 * NOTHING here is a security boundary for the framed client: the client is a
 * separate origin, behind its own login, and no OS data is ever sent to it.
 * This module only decides whether we may point a frame at a URL at all.
 */

/* ─────────────────────────────── endpoint ─────────────────────────────── */

/** The one localStorage key this app owns. Never a system-wide setting. */
export const STREAM_URL_KEY = 'faisal.stream.url';

/**
 * Where the container's web client listens when it runs on this machine.
 * Written in the canonical form `normalizeStreamUrl` returns (a bare origin
 * gains a trailing slash), so the default, a saved value and a probed value are
 * always the same kind of string.
 */
export const DEFAULT_STREAM_URL = 'http://127.0.0.1:8080/';

/** How long the probe may take before we call the endpoint silent. */
export const PROBE_TIMEOUT_MS = 4000;

/**
 * The client's own policy for the iframe, kept here as a constant so a test can
 * assert what is NOT in it (see the clipboard note below).
 *
 * `allow-same-origin` is safe to combine with `allow-scripts` here because the
 * framed client is always a different origin from the OS page, so there is no
 * same-origin sandbox escape back into the OS document. Cross-origin is not
 * merely likely — the OS runs on its own origin and the client runs in a
 * container on another port or another host.
 *
 * Deliberately absent in this first version: `allow-clipboard-read`,
 * `allow-clipboard-write` and `clipboard-read; clipboard-write` in `allow`.
 * Pasting from the owner's clipboard into a remote browser is a real feature,
 * but it needs an explicit decision (README follow-up), not a default.
 */
export const IFRAME_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-popups allow-presentation';
export const IFRAME_ALLOW = 'fullscreen; encrypted-media; picture-in-picture';

/** Where the honest, full documentation lives (repository-relative). */
export const STREAM_DOC_PATH = 'docs/STREAM_BROWSER.md';

/**
 * The same document, at a URL that actually opens from the deployed app.
 *
 * `docs/**` is NOT part of the published site: `.github/workflows/pages.yml`
 * uploads `dist` only, so a link to `./docs/STREAM_BROWSER.md` would 404 for
 * every user of the live OS. The setup screen therefore links to the file in the
 * repository, and still shows `STREAM_DOC_PATH` beside it so a reader knows
 * exactly where the file lives in the tree.
 */
export const STREAM_DOC_URL = 'https://github.com/Faisaldhd/faisal-os/blob/main/docs/STREAM_BROWSER.md';

/**
 * Copy-ready commands shown by the setup screen. These are language-neutral
 * program text, not UI copy, so they are literals here rather than entries in
 * the string table. `<password>` / `<adminpassword>` are placeholders the owner
 * replaces with passwords of their own choosing — never shipped defaults.
 */
export const DOCKER_NEKO_COMMAND = [
  'docker run -d --rm --name faisal-neko \\',
  '  --shm-size=2g \\',
  '  -p 127.0.0.1:8080:8080 \\',
  '  -p 127.0.0.1:56000-56100:56000-56100/udp \\',
  '  -e NEKO_WEBRTC_EPR=56000-56100 \\',
  '  -e NEKO_WEBRTC_NAT1TO1=127.0.0.1 \\',
  '  -e NEKO_MEMBER_MULTIUSER_USER_PASSWORD=<password> \\',
  '  -e NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=<adminpassword> \\',
  '  ghcr.io/m1k1o/neko/chromium:latest',
].join('\n');

export const DOCKER_SELKIES_COMMAND = [
  'docker run -d --name faisal-chromium \\',
  '  --shm-size=1gb \\',
  '  -p 127.0.0.1:3001:3001 \\',
  '  -e PUID=1000 -e PGID=1000 -e TZ=UTC \\',
  '  -e CUSTOM_USER=<user> -e PASSWORD=<password> \\',
  '  -v faisal-chromium-config:/config \\',
  '  lscr.io/linuxserver/chromium:latest',
].join('\n');

/**
 * A stored endpoint is only ever a URL we may point an <iframe> at, so the
 * check is an allowlist of two schemes and nothing else:
 *
 *  - trimmed; empty/blank, non-strings and unparsable text → `null`
 *  - `javascript:`, `data:`, `blob:`, `file:`, `about:`, `chrome:`, a bare
 *    `example.com:8080` (parsed as scheme `example.com:`) → `null`
 *  - `http://` / `https://` with a hostname → the canonical form
 *  - credentials (`http://user:pass@host`) → `null`: the endpoint goes into an
 *    iframe `src`, a `fetch` and any error message, and a password does not
 *    belong in any of them. The container has its own login for that.
 *
 * The canonical form is what the window uses, so a probe, the frame and the
 * displayed address are always the same string (`new URL(...).href`, e.g. a
 * bare origin gains a trailing slash).
 */
export function normalizeStreamUrl(input: unknown): string | null {
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
 *   'http-loopback' — allowed by policy (loopback is trusted for a container
 *                     on this machine), so the frame and the probe work.
 *   'http-remote'  — refused by policy before it loads: remote origins must be
 *                     https. Returned so the window can say that plainly
 *                     instead of showing a blank frame.
 *   `null`         — not a URL we would ever frame (see normalizeStreamUrl).
 */
export type StreamEndpointPolicy = 'https' | 'http-loopback' | 'http-remote';

export function streamEndpointPolicy(input: unknown): StreamEndpointPolicy | null {
  const url = normalizeStreamUrl(input);
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
 *  • `mode: 'no-cors'` is deliberate. The streaming client is a cross-origin
 *    page that answers with ordinary HTML and sends no CORS headers, so a CORS
 *    request would reject even while the client is perfectly reachable. An
 *    opaque response still *resolves*, which is exactly the signal we want:
 *    "something is listening there". The body is never read — not JSON, out of
 *    scope, empty and opaque are all the same to us.
 *  • `credentials: 'omit'` — no cookie of the OS origin is ever sent to it.
 *  • `cache: 'no-store'` — a cached answer is not a reachability answer.
 *  • A timeout aborts the request and resolves `false`.
 *  • It NEVER throws and never rejects: an invalid URL, a missing `fetch`, a
 *    synchronous throw, a network error, an abort — every one of them is
 *    `false`. "true" means only "the endpoint answered a request"; it is not
 *    proof that a video stream will work, and the window says so.
 */
export async function probeStream(
  base: unknown,
  timeoutMs: number = PROBE_TIMEOUT_MS,
  fetchImpl?: FetchLike,
): Promise<boolean> {
  const url = normalizeStreamUrl(base);
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
 * directly) so a test can pass a throwing or corrupt stub, and so no part of
 * this module depends on `window`.
 */
export type StreamStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** A store that remembers nothing: used when localStorage is unavailable. */
export const NO_STORAGE: StreamStorage = { getItem: () => null, setItem: () => {} };

/** The real store, or null when the browser blocks it (private mode, partition). */
export function localStorageOrNull(): StreamStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * The endpoint the window should use: the saved one when it is still a valid
 * stream URL, otherwise the default. A corrupt, hostile or hand-edited value
 * can therefore never reach the frame — it is simply ignored.
 */
export function savedStreamUrl(storage: StreamStorage): string {
  try {
    return normalizeStreamUrl(storage.getItem(STREAM_URL_KEY)) ?? DEFAULT_STREAM_URL;
  } catch {
    return DEFAULT_STREAM_URL;
  }
}

/**
 * Saves an endpoint after validation. Returns `false` (and writes nothing) for
 * anything `normalizeStreamUrl` rejects, so storage can never hold a value the
 * window would refuse to use.
 */
export function saveStreamUrl(url: unknown, storage: StreamStorage): boolean {
  const normalized = normalizeStreamUrl(url);
  if (!normalized) return false;
  try {
    storage.setItem(STREAM_URL_KEY, normalized);
    return true;
  } catch {
    return false;
  }
}
