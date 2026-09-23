# Session handoff (Fai$al OS)

Written at the end of a long autonomous session. ASCII only on purpose (a PowerShell write
once corrupted a UTF-8 CSS file; keep handoff edits ASCII or use the edit tool).

Live site: https://faisaldhd.github.io/faisal-os/  (repo name is lowercase `faisal-os`;
`Faisal-OS` in the URL 404s). Pages uploads `dist` only, so nothing under `docs/` is served.

## Shipped and live on main (merged + deployed)
- #14 audit fixes: data-loss guards (requestClose, rename(p,p), upload overwrite, editor
  single-instance + external change), RTL resize inversion, notification-centre focus,
  ResizeObserver on minimize, key handling, SW per-entry precache + v86 in the version hash,
  static boot screen, honest Monitor/Store/Settings numbers.
- #15 performance: lazyVFS, 300 ms splash, translated boot-failure screen, Files drag & drop,
  dev-server watcher fix (EBUSY on atomic writes).
- #16 DeepSeek as a second AI provider, incl. the reasoning_content echo agent mode needs.
- #17 Settings Keyboard/Privacy sections + real ~/Desktop entries.
- #18 mobile interaction model. #19 honest System tab. #20 embedded Web Apps.
- #21 Privacy lists/clears the remembered web app URLs. #22 design tokens + a11y slice.
- #23 accessibility review branch (ARIA/token pass, clock calendar as a real grid), #24 handoff
  docs, #25 Browser app: honest fallback card instead of a blank grey frame for sites measured
  to refuse framing.
- Other session, on main and NOT reviewed by me: the Vault app (AES-GCM/PBKDF2) and the
  optional session lock. Treat both as unreviewed.

## In flight in this session (uncommitted when this was written)
1. Web experience expansion: registry grown from 3 to 18 measured sites (blocked by measurement:
   google, youtube, duckduckgo), a YouTube embed player that accepts any watch/shorts/youtu.be
   link, and a native in-OS search app with a keyless Wikipedia provider plus an optional Google
   Programmable Search provider. Measured evidence per host is in the task report; the owner
   declined the Google CSP widening, so that provider stays present, honest and inert.
2. i18n parity: `registeredKeys()` added to `src/kernel/i18n.ts` (read-only, additive) and a
   whole-table parity test. It caught a real gap on its first run: `monitor.systemHonestyTitle`
   and `monitor.systemHonesty` existed in English only, so Arabic users saw the raw key. Both
   Arabic strings now exist. The test's own first version transposed the direction
   (arabic-only vs english-only) and briefly covered only one namespace; both are fixed.
3. Local proxy (`tools/local-proxy.mjs` + `src/apps/web/local-proxy.ts` and friends): an OPT-IN
   loopback-only escape hatch with a token, an SSRF guard on the target and on every redirect
   hop, header surgery limited to X-Frame-Options and CSP frame-ancestors, and a reader mode
   that renders extracted text. See docs/LOCAL_PROXY.md.
4. Streamed browser (`src/apps/stream/**`): a neko/Chromium Docker container the owner runs
   himself, framed into a normal OS window with a permanent "streamed browser" badge. See
   docs/STREAM_BROWSER.md. The Docker command is verified against the official neko docs
   (`--shm-size=2g` for Chromium images, EPR range identical on both sides, loopback bind).
5. CSP: `index.html` now also allows loopback http (`http://127.0.0.1:*`, `http://localhost:*`)
   in `frame-src` and `connect-src`, plus `https://api.wikimedia.org` in `connect-src`. Remote
   origins stay https-only. Remote plain-http stream endpoints are refused by policy and the app
   says so instead of showing a blank frame.

## Known open item found in review (not yet fixed at the time of writing)
The proxy's raw mode could never work: `renderProxyRaw` put a token-free URL in an iframe `src`,
while the server requires the token in a header, which an iframe cannot send. Fix in progress:
a single-use 60 s ticket minted with the token and consumed by `/view` before the page loads,
so the framed page never sees a live secret.

## Next phases
1. Phase 13: grep in a Worker with a timeout; sandbox third-party apps in an iframe with a
   postMessage broker; enforce the declared `network` permission (today only the CSP limits it).
2. Phase 14-15: PWA with an explicit "update now" (no forced skipWaiting), final polish, full
   regression on the live site.
3. Small known item: 44 light-mode fallbacks inside var() in store.css can leak light values on
   dark surfaces if a token is ever missing.
4. The streamed browser and the local proxy have never been run against a live container from
   this environment (no Docker, no browser): both need the owner's own run, exactly as their
   docs describe.
5. Settings -> Privacy clears one `faisal.web.<id>.url` key per wired site (now all nineteen of
   them), but not the other keys this branch added to that namespace: `faisal.web.search.*`
   (provider, query, and any Google Programmable Search key) and `faisal.web.proxy.*` (token,
   port, enabled). The proxy token is a bearer credential, so a "clear app keys" entry is the
   honest follow-up.

## Environment facts a future session must know
- Vite and Vitest need a full-access file policy: under a confined sandbox they die with
  `spawn EPERM` from Vite's `optimizeSafeRealPathSync`. The npm cache must live inside the
  workspace (npm_config_cache=D:\Faisal-OS\.npm-cache) or installs fail.
- git/gh are not on PATH: `. C:\Users\FaisalSaeedMohammedD\Downloads\_tools\env.ps1` first.
- GitHub Pages caches HTML for ~10 minutes: re-check new features with a cache-busting query.
- One session per checkout. A second writer in D:\Faisal-OS caused misattributed work, left
  `src/shell/index.ts` dirty, and blocked rebases.
- Verification standard used throughout: no commit without a line-by-line review, no visible
  change without a real browser check, and no security claim without a measurement.
- Gates on the tree at the time of writing: 33 test files / 774 tests, typecheck clean, build OK.

## Review verdicts already recorded (read-only, 2026-09-23)

CLOCK (from the phase 11-12 branch, now merged): safe, but ONLY because that commit also adds
`.faisal-clock-cal-row { display: contents }` (clock.css:227-232). Without it the calendar would
break visually: the grid is `display:grid; grid-template-columns:repeat(7,1fr)` and the new
`.faisal-clock-cal-row` wrappers are its direct children, so each week would collapse into a
single 1fr column. Treat clock/index.ts and clock/clock.css as ONE unit.

MONITOR (same branch): safe. FPS sampling, the visibility pause, canvas drawing and tab
switching are untouched; aria-hidden sits on the <canvas> only while the numeric value is a
separate visible span whose textContent is still written, and aria-live="off" on a plain span is
a no-op rather than a hide. Known gaps, not regressions: the charts have no text alternative for
the trend, and role="status" on the two async storage lines sits inside an aria-live="off" body.
