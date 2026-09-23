# Session handoff (Fai$al OS)

Written at the end of a long autonomous session. ASCII only on purpose (a PowerShell write
once corrupted a UTF-8 CSS file; keep handoff edits ASCII or use the edit tool).

## Shipped and live on main (merged + deployed, each verified in a real browser)
- #14 audit fixes: data-loss guards (requestClose, rename(p,p), upload overwrite, editor
  single-instance + external change), RTL resize inversion, notification-centre focus,
  ResizeObserver on minimize, key handling, SW per-entry precache + v86 in the version hash,
  static boot screen, honest Monitor/Store/Settings numbers.
- #15 performance: lazyVFS (desktop no longer waits for IndexedDB), 300 ms splash, translated
  boot-failure screen, Files drag & drop with one shared mover, dev-server watcher fix
  (EBUSY on atomic writes).
- #16 DeepSeek as a second AI provider, incl. the reasoning_content echo that agent mode needs.
- #17 Settings Keyboard/Privacy sections + real ~/Desktop entries on the desktop.
- #18 mobile: full-screen windows on touch, zero resize grips, 44px controls, scrollable dock.
- #19 honest System tab in the Monitor (browser-only facts, "not available" instead of zeros).
- #20 embedded Web Apps (registry + toolbar + respectful fallback when a site refuses framing).

## Open, clean to merge
- #21 Privacy lists and clears the remembered web app URLs (faisal.web.<id>.url).
- #22 design tokens (spacing/type/elevation/z-index) + Store banner token migration +
  accessibility slice for the calculator, images and terminal.

## Preserved but NOT reviewed - branch wip/phase11-12-review (no PR, do not merge as is)
Commit eff487e: ARIA and token pass over ten files (305 insertions, 28 deletions). 28 lines
REPLACE existing code (clock calendar now an ARIA grid, files sidebar, browser tab strip).
To finish: review clock/index.ts and monitor/index.ts first (highest risk), then browser,
files, settings, store; take light + dark screenshots; only then ship (fold into #22 or a
dedicated accessibility PR).
Same branch, commit 072587a: the security review row proving connect-src blob: is REQUIRED
(screenshot.ts -> html-to-image -> resourceToDataURL -> fetch(blob:)); index.html unchanged.
Extract that into its own small docs PR.

## Next phases
1. Finish 11-12 as above (screenshots are the gate).
2. Phase 13: grep in a Worker with a timeout; sandbox third-party apps in an iframe with a
   postMessage broker; enforce the declared `network` permission (today only the CSP limits it).
3. Phase 14-15: PWA with an explicit "update now" (no forced skipWaiting), final polish,
   full regression on the live site.
4. Small known item: 44 light-mode fallbacks inside var() in store.css can leak light values
   on dark surfaces if a token is ever missing.

## Environment facts a future session must know
- Confined sandboxes cannot run Vite/Vitest (spawn EPERM from net use); npm cache must live
  inside the workspace (npm_config_cache=D:\Faisal-OS\.npm-cache) or installs fail.
- GitHub Pages caches HTML for ~10 minutes: re-check new features with a cache-busting query.
- One session per checkout. A second writer in D:\Faisal-OS caused misattributed work and
  blocked two rebases; src/shell/wm.ts still carries that session's uncommitted changes.
- Verification standard used throughout: no commit without a line-by-line review, and no
  visible change without a real browser check.
