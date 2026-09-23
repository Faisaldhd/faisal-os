# Security review: Fai$al OS 0.1

Date: 2026-09-23. Scope: kernel, VFS, Files, Editor, Terminal (sim + v86), shell, CSP, dependencies.
`npm audit --omit=dev`: 0 vulnerabilities. Tests: 92 passing when this review was written (274 in the current tree). An independent follow-up audit is recorded at the end of this file.

## Fixed in this review

| # | Severity | Issue | Fix |
| --- | --- | --- | --- |
| 1 | High | The per-app `SystemAPI` spread `...sys`, so every app had the unscoped `bus`, `wm` and `apps`. Any app could emit `notify` without the permission, spoof `fs:change`, register a new app with `fs:system`, and reach other apps' windows through `wm.list()[i].content` (read the Terminal or Editor DOM). `fs:change` events also leaked file names outside the app's scope. | `src/kernel/apps.ts`: frozen capability object. `bus.emit` is denied for apps, `fs:change` is filtered by read scope, `wm` sees only the app's own windows, `apps.register` is denied. |
| 2 | Medium | Terminal held `fs:system` and enforced "no writes outside home" inside the app only (`assertWritable`). One missed code path would give full write access. | New permission `fs:read-all`. Terminal now runs with `fs:home` + `fs:read-all`, so the kernel blocks system writes even if the shell has a bug. `fs:home` now includes `/tmp`. |
| 3 | Medium | The SVG icon sanitizer was a denylist: it kept `<a xlink:href>`, `<use href=data:>`, `<animate>`/`<set>` that rewrite `href`, `<image>` with remote URLs, and `style` with external `url()`. Safe today (icons are built-in), exploitable once third-party app manifests exist. | `src/shell/icon.ts`: allowlist of drawing tags and presentation attributes, and `url()` may only reference `#fragments`. |
| 4 | Low | `createSettings` stored data in a plain object: `set('__proto__', …)` replaced its prototype, and `get('toString')` returned a function. | Null-prototype store, key allowlist regex, `Object.hasOwn`, invalid keys dropped on load. |
| 5 | Low | VFS persistence was fire-and-forget (`void backend.put(...)`): an IndexedDB failure (quota, eviction) lost data silently. | Errors are logged and one notification is shown. |
| 6 | Low | CSP allowed `frame-src 'self' blob:` and `connect-src data:` with no use. | `frame-src 'none'`, `data:` removed from `connect-src`. |
| 7 | Info | File downloads used a `Blob` with no type. | Forced `application/octet-stream`. |

## Open (accepted for now, with a plan)

| Severity | Issue | Plan |
| --- | --- | --- |
| High (architectural) | All apps run in the same JS realm as the kernel. The capability object is a guard against bugs, not a sandbox: in-process code can still use `document`, `indexedDB` and `localStorage` directly. Acceptable only while every app is built-in. | Phase 3: third-party apps in `<iframe sandbox="allow-scripts">` on an opaque origin, talking to a kernel broker over `postMessage` with the same capability checks. Re-enable `frame-src` for `blob:` only then. |
| Medium | Clickjacking: `frame-ancestors` can't be set in a `<meta>` CSP. | When hosting, send the CSP as an HTTP header with `frame-ancestors 'none'`, plus `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. |
| Low | `style-src 'unsafe-inline'` is needed for element `style` attributes used by the shell. | Move dynamic styles to CSS variables/classes, then drop it. |
| Low | `grep` compiles user regexes on the main thread: a catastrophic pattern freezes the tab (self-DoS only, Ctrl+C can't interrupt synchronous regex). | Run `grep` in a Worker with a timeout. |
| Low | `cat` of a file containing escape sequences sends them to xterm.js. xterm.js has no clipboard (OSC 52) or link handlers enabled, so the effect is limited to screen/title changes. File names are already sanitized. | Optional: filter OSC/DCS sequences from file output. |
| Info | v86 VM: no network adapter, assets loaded from `./v86/` only, runs under `wasm-unsafe-eval` + `worker-src blob:` (required). Nothing in the VM is persisted. | Keep as is. |

## Browser app (added after the review)
- CSP `frame-src` changed from `'none'` to `https:` so the Browser app can show websites.
- Frames only get `https:` URLs from a different origin than the OS (`src/apps/browser/url.ts`, tested). `javascript:`, `data:`, `blob:`, `file:` and same-origin URLs are refused, so `allow-same-origin` in the iframe sandbox never gives a page access to the OS.
- `referrerpolicy="no-referrer"`; no camera, microphone, location, clipboard or payment permissions; no history stored.
- Sites that forbid framing are opened in a real browser tab with `rel="noopener noreferrer"`.

## Done well
- No `innerHTML`/`eval`/`new Function` with dynamic data anywhere; file names and contents use `textContent`.
- Paths normalized through one function (`kernel/path.ts`) before every permission check; `..` and prefix tricks (`/home/user2`) are covered by tests.
- Terminal replaces control characters in file names, blocks `rm -rf /`, and has no network.
- No runtime dependencies beyond `@xterm/*` and `v86`.

## Follow-up audit (independent, read-only, same session)

Eight independent reviewers re-checked the whole repository. Verdict: all seven fixes above are still in place at source level, all six open items are still open with their severities roughly correct, no secret exists anywhere in the repository, and the previously published claims about `markdown.ts` (escape-then-insert, `https?://`-only links) were re-verified as safe by construction rather than by luck.

### Corrections to this document

| Claim | Correction |
| --- | --- |
| "Terminal (sim + v86) runs the emulator in a Web Worker" | Wrong. There is no `new Worker` in the repository; `V86Backend` constructs the emulator on the main thread (`src/apps/terminal/backends/v86.ts`). The isolation is at the emulator level (no network adapter, no disk, assets read from `./v86/`), not a separate thread. |
| `worker-src 'self' blob:` and `connect-src ... blob:` are unused | Re-checked and **kept** (not dropped): `blob:` in `connect-src` *is* used. `src/shell/screenshot.ts:61` runs `html-to-image`'s `toCanvas` over `#faisal-root`, and its `embedImageNode` embeds every non-`data:` `<img src>` — including the `blob:` URLs the Images app assigns at `src/apps/images/index.ts:271` and `:393` — through `fetch(url)` (`node_modules/html-to-image/es/dataurl.js:11`, shipped in `dist/assets/es-BFdEF1jL.js`). Without `connect-src blob:` that fetch is CSP-blocked and the catch substitutes the 1×1 `imagePlaceholder` (`screenshot.ts:73`), so images would silently vanish from screenshots. Direct app code never fetches a `blob:` URL: the only `fetch(` call sites are `src/apps/terminal/backends/v86.ts:146,150` (http(s) `assetsBase`, `terminal/index.ts:147`) and `src/apps/ai/chat.ts:90,185` (the two https API bases), and `src/**`/`build/**` contain no `XMLHttpRequest`, `WebSocket`, `sendBeacon`, `importScripts` or `EventSource`. `worker-src blob:` must stay: libv86 creates a blob Worker internally (`register_yield`, reached from the `Emulator` constructor). Removing it would break `linux` boot. |
| `cat` of a file with escape sequences could reach the clipboard (OSC 52) | Lower than stated: `@xterm/xterm` 6.0.0 ships no OSC 52 handler and the app enables no link handler, so the impact is limited to screen/title spoofing. The item stays open as hardening. |
| `frame-src 'none'` (fix #6) | Deliberately reversed later for the Browser app: `frame-src https:` is required to embed web pages. Covered by the URL policy below. |

### Fixed in this pass (with the tests that now guard them)

| Severity | Issue | Fix |
| --- | --- | --- |
| Medium | `uninstall()` and `closeWindow()` called `WindowHandle.close()`, which deliberately bypasses the app's close guard, so removing an app from the Store or ending it from System Monitor discarded unsaved editor content without asking. | `WindowHandle.requestClose()` added to the contract (`src/kernel/types.ts`) and used by both kernel paths; the window manager implements it on the handle it already had internally. |
| Medium | A silent fallback to the in-memory backend meant a user in private mode (or with IndexedDB blocked) could write files for an hour and lose everything on reload, with no message. | `createVFS` now announces it once the shell is listening (`system:ready`), through the `vfs` string namespace in the user's language. |
| Low | `rename(p, p)` deleted the record from IndexedDB while keeping the in-memory node, so the file disappeared after a reload. | Refused with `EINVAL`, with a regression test that asserts the file survives. |
| Low | App manifests were frozen but never validated: an unknown permission string was silently accepted. | `validateManifest()` rejects malformed ids, missing `name.ar`/`name.en`, unknown permissions, unknown categories and bad `opens` extensions at registration. |
| Low | The terminal leaked a running v86 emulator (roughly 64 MB and a CPU core) when the window was closed while the Linux chunk was still loading. | The app now records the close and disposes a backend that finishes loading afterwards. |

### Still open (accepted, with the honest limit stated)

| Severity | Issue | Why it is accepted for now |
| --- | --- | --- |
| High (architectural) | All apps share one JS realm with the kernel; the capability object guards against bugs, not against hostile code. | Unchanged: needs the iframe + `postMessage` broker phase. Every app is still built-in. |
| Medium | The `network` permission is declared and explained in the Store but never enforced; only the CSP limits where requests can go. | Cannot be enforced without a broker or a sandboxed realm. Documented here so it is not mistaken for a control that exists. |
| Medium | The Groq API key lives in `localStorage` on the OS origin. | No XSS exists today, and no repository secret exists; a future XSS or the agent path below could still read it. A "do not save" option would be the next mitigation. |
| Medium | Indirect prompt injection: the AI agent can read files and web pages and send them to the model, and its read-only tools run without a confirmation card. | Mitigated by the confirmation card showing the concrete command; the real fix is treating tool output as untrusted data and restricting `run_command` for the agent. |
| Medium | The Browser app frames untrusted pages with `allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox`. Separate origins keep page scripts out of the OS data, but `allow-popups-to-escape-sandbox` can open real, unframed windows. | The frame can only ever load a different-origin `https:` URL (tested in `src/apps/browser/url.ts`). Dropping `allow-popups-to-escape-sandbox` is the cheap next step. |
| Medium | `frame-ancestors` cannot be set from a `<meta>` tag and GitHub Pages cannot send custom headers. | Unchanged; requires a host with header support. |
| Low | `style-src 'unsafe-inline'` is still required by element-level dynamic styles. | Unchanged; a migration to CSS variables/classes across the shell and apps. |
| Low | `grep` compiles a user regex on the main thread (self-inflicted freeze only). | Unchanged; a Worker with a timeout is the plan. |

### Verified absent (so future work does not repeat it)

No `eval`, `new Function`, string-argument timers, `document.write`, `srcdoc`, `insertAdjacentHTML`, `javascript:` URLs, dynamic `import()` with a computed specifier, cookies, telemetry, or network request the user did not trigger. The only `innerHTML` writes are the escaped output of `src/apps/ai/markdown.ts` and static clearing.

### Second AI provider: DeepSeek (added to the AI app afterwards)

| Item | Note |
| --- | --- |
| CSP widened by exactly one host | `connect-src` in `index.html` now allows `https://api.deepseek.com` next to `https://api.groq.com`. Those two API bases are still the only hosts the app may contact; the key-console links (`console.groq.com`, `platform.deepseek.com`) are user-clicked `target="_blank" rel="noopener noreferrer"` links, never `fetch` targets. The Arabic comment above the meta tag names both hosts. |
| Key-storage caveat unchanged, now covers two keys | The DeepSeek key lives in `localStorage` under `faisal.deepseek.apiKey`, exactly like Groq's unchanged `faisal.groq.apiKey`. The Medium item above ("The Groq API key lives in `localStorage`…") therefore applies to both keys, with the same severity and the same next mitigation (a "do not save" option). |
| Keys still never travel in a URL | Both providers get the key in the `authorization` header only; no key is put in a query string, logged or echoed anywhere. `src/apps/ai/chat.test.ts` asserts the request URLs contain no key and no `?`. |
| One key per provider, chosen provider remembered | `faisal.ai.provider` stores the selected provider id and falls back to Groq for an unknown value; the two providers keep separate key and model entries, so switching cannot hand one provider's key to the other. |
| No new web-search claim | Faisal AI has no web-search tool of its own: only Groq's `groq/compound*` models search on Groq's servers and report sources. The UI now says plainly, when DeepSeek is selected, that there is no web search — it does not pretend to search or cite sources. |
| Limit of this note | This was a source-level review: no live DeepSeek key was used, so the runtime behaviour against `api.deepseek.com` was taken from the published docs, not observed. |
| Thinking mode's `reasoning_content` is echoed back, never shown | DeepSeek enables thinking mode by default, and its docs require that for any request carrying the `tools` parameter the `reasoning_content` of every previous assistant turn be passed back in full — including turns with no tool call — or the API returns HTTP 400 (https://api-docs.deepseek.com/guides/thinking_mode). The client therefore keeps that text on the assistant history turn and serializes it on later requests, but only for a provider whose `echoesReasoning` flag is set (DeepSeek; Groq stays byte-identical because it has no such rule). `reasoning_content` is still never rendered: it is accumulated apart from `content`, never passed to `onText`, never part of `TurnResult.text`, and never a source. This fixes DeepSeek agent mode, which was returning HTTP 400 before the echo was implemented. |

### Streamed browser (added after this review)

| Item | Note |
| --- | --- |
| The streamed browser is a container **outside** this system, and no OS capability, data, key or file ever reaches it | `org.faisal.Stream` (`src/apps/stream/`) frames a streaming client the owner runs in Docker; the framed client is a real browser on another origin, not part of the OS. Nothing crosses into it: no VFS path or file, no `sys.settings`, no kernel capability, no API key or any other secret. The app holds one `localStorage` value (`faisal.stream.url`) and hands that URL to the iframe; there is no `postMessage` in either direction, no `contentWindow` access, no reading or scripting of the frame's DOM, and no OS state is ever passed to it. The probe sends one credential-less request (`credentials: 'omit'`, `mode: 'no-cors'`, body never read) and only the endpoint URL is validated — all inside `src/apps/stream/config.ts`, covered by `src/apps/stream/stream.test.ts`. |
| The iframe is cross-origin with a **minimal sandbox and no clipboard permission**, and the only real risk is exposing the container without authentication | The frame is always a different origin from the OS page, so `allow-same-origin` cannot be used to escape into the OS document. The sandbox is exactly `allow-scripts allow-same-origin allow-forms allow-popups allow-presentation` with `allow="fullscreen; encrypted-media; picture-in-picture"` and `referrerpolicy="no-referrer"`; `allow-top-navigation*`, `allow-modals`, `allow-downloads`, `allow-popups-to-escape-sandbox` and **clipboard (read and write) are deliberately absent** — clipboard support is a documented follow-up, not a default. Endpoint validation only accepts `http:`/`https:`, and a remote plain-http endpoint is reported as refused by this system's own policy rather than framed. That leaves one genuine risk, outside the OS's control: **an unauthenticated container is an open proxy** — anyone who reaches it gets a browser (and, on neko, file sharing, clipboard and the whole desktop) running from the owner's machine or server. Mitigation, spelled out in `docs/STREAM_BROWSER.md`: keep it bound to `127.0.0.1` with a password, or on a VPS put it behind a reverse proxy with TLS plus the client's own login or HTTP basic auth, expose the WebRTC UDP range only as required, and treat the ephemeral profile as the default (a persistent profile stores session cookies on disk — an explicit warning is documented there). Not yet verified end to end: no Docker exists in the environment where it was built, so no container and no streamed picture were observed; the run commands come from the official neko and linuxserver documentation. |

### Local proxy (opt-in escape hatch, added after this review)

| Item | Note |
| --- | --- |
| It is opt-in, loopback-only, and the site's framing refusal is the only thing it bypasses | `tools/local-proxy.mjs` is a dependency-free server the owner runs by hand; the window never offers it unless `/health` answers on `127.0.0.1`, and there is no silent fallback to a direct embed. Binding is fixed to `127.0.0.1` (`assertLoopbackHost()`; `--host` refuses anything else). `X-Frame-Options` and CSP `frame-ancestors` are removed — the documented and only purpose — while every other CSP directive, the content type and the status pass through and `Set-Cookie` is never forwarded. The full SSRF guard (scheme allowlist, no credentials in the URL, the whole private/reserved range list, `localhost`/`*.local`/`*.internal`/dotless names, and a DNS re-check of every answer) runs before every request **and on every redirect hop** (at most 3, followed by hand). Written up in `docs/LOCAL_PROXY.md`; covered by `src/apps/web/local-proxy.test.ts`. |
| **The ticket decision: why an iframe needs one, and why a query token or a cookie was rejected** | An iframe cannot send a request header, so raw mode could never authenticate with `x-faisal-proxy-token` and always rendered the proxy's own 401 JSON — the defect this row records: it was invisible to header-carrying server calls and to jsdom, where no server exists. The fix is a **single-use ticket**. `GET /ticket?url=…&mode=…` is gated by the same constant-time token comparison and by `validateTargetUrl`, and answers `{ ticket, expiresIn }`, where the ticket is `randomBytes(32).toString('hex')` (64 hex characters) bound to one target and one mode, with a 60 s TTL and at most 32 live entries (oldest evicted). `GET /view?ticket=…` is deliberately **token-free** and deletes the ticket **before** the upstream fetch, so it is dead by the time the framed page's own scripts run; a tampered `?url=`/`?mode=` is ignored because the ticket alone decides. A **token in the query string** was rejected because the framed page can read its own URL (`location.href`) and would then hold the owner's token; a **cookie** was rejected because a cookie from `127.0.0.1` read by a page on another origin is a third-party cookie, which current browsers block by default (and `SameSite` would break the flow outright). The token therefore still never appears in any URL, and a leaked `src` is worth exactly one already-spent fetch. |
| `/health` stays token-free, and `/view` is the only token-free data route | `/health` carries no page data and no target URL (version and auth mode only). `/view` is authorised by the ticket alone: it cannot be retargeted, cannot be replayed, and answers 410 once the ticket is spent or expired. `OPTIONS` preflight is answered for `/fetch` **and** `/ticket` (the custom header is what triggers it); `/view` needs none. The ticket is never logged, not even with `--verbose`. |
| Limit of this note | Source-level and test-level only. The suite starts a real proxy on a random loopback port with a counted, injected upstream fetch (so no request reaches a real site), but this environment has no browser, so the raw render through a real iframe was not observed end to end. That one step is spelled out in `docs/LOCAL_PROXY.md` under "Verify it yourself". |

### Cloud sync (added after this review, by another workstream — reviewed here)

| Item | Note |
| --- | --- |
| What was verified in the code | `tools/cloud-sync.mjs` + `src/shell/sync.ts` keep the web copy and the desktop app in step through the owner's own D1 (`SYNC_DB`). Every call except `/health` needs `x-faisal-sync-token`, compared as SHA-256 digests in constant time, and sync is **off** until both a token and a database exist (503 otherwise, 401 on a mismatch); `/health` exposes booleans only. Keys are an allowlist (`fs:/home/user/…`, `set:<key>`, `ls:faisal.<key>`) with no `..`, no NUL and bounded lengths, the kind must match the key, and items/batches/bytes are capped (1.4 MB per item, 200 items, 6 MB per push). Every D1 statement is a prepared statement with bound parameters, so no query is built from data. `cache-control: no-store` and `nosniff` on every reply. API keys, tokens, the lock record and window geometry are never sent by the client. Sync is connected by hand from Settings, not by default. |
| Risks worth stating plainly, none of them blocking | (1) **Not end-to-end encrypted**: files and settings are stored in readable form in the owner's D1, so Cloudflare can read their contents. The allowance list keeps secrets out, but content is content. (2) **One token can serve both features**: with `FAISAL_SYNC_TOKEN` unset the sync falls back to `FAISAL_PROXY_TOKEN`, so a single leak opens the proxy *and* the file store; setting a separate `FAISAL_SYNC_TOKEN` narrows the blast radius and lets either secret be rotated alone. (3) **Last-writer-wins on the client's clock**: two devices editing the same file silently keep one version, and a device whose clock runs ahead stamps its edits with a future `mtime` and wins from then on, because the server accepts any finite `mtime` from the client. A conflicted copy (or server-side revision ordering) is the honest fix when this is enabled for real. |
| Limit of this note | Reviewed by reading the code and its tests; sync was not run against a live D1 in this environment, and no conflict scenario was exercised between two devices. |

