# Security review: Fai$al OS 0.1

Date: 2026-09-23. Scope: kernel, VFS, Files, Editor, Terminal (sim + v86), shell, CSP, dependencies.
`npm audit --omit=dev`: 0 vulnerabilities. Tests: 92 passing (6 new security tests in `src/kernel/security.test.ts`).

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

## Done well
- No `innerHTML`/`eval`/`new Function` with dynamic data anywhere; file names and contents use `textContent`.
- Paths normalized through one function (`kernel/path.ts`) before every permission check; `..` and prefix tricks (`/home/user2`) are covered by tests.
- Terminal replaces control characters in file names, blocks `rm -rf /`, and has no network.
- No runtime dependencies beyond `@xterm/*` and `v86`.
