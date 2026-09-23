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
| `worker-src 'self' blob:` and `connect-src ... blob:` are unused | `blob:` in `connect-src` is unused, but `worker-src blob:` must stay: libv86 creates a blob Worker internally (`register_yield`, reached from the `Emulator` constructor). Removing it would break `linux` boot. |
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
