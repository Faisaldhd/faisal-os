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

## Review verdict on wip/phase11-12-review (eff487e), read-only, 2026-09-23

CLOCK: safe, but ONLY because the commit also adds `.faisal-clock-cal-row { display: contents }`
(clock.css:227-232). Without it the calendar would break visually: the grid is
`display:grid; grid-template-columns:repeat(7,1fr)` and the new `.faisal-clock-cal-row` wrappers
are its direct children, so each week would collapse into a single 1fr column (8 narrow stacked
columns). Treat clock/index.ts and clock/clock.css as ONE unit - never ship one without the other.
The four other replaced lines are behaviourally identical (same class toggle, same Intl weekday,
same Hijri value computed once instead of twice, same cell append; `weekRow` is assigned before
first use so no cell can be dropped). Cells were never given a data-* attribute or an
addEventListener (premise corrected).

MONITOR: safe. FPS sampling, the visibility pause, canvas drawing and tab switching are untouched;
the four replaced lines are the same class toggle. Accessibility is not blocked: aria-hidden sits on
the <canvas> only, while the numeric value is a separate visible span whose textContent is still
written, and aria-live="off" on a plain span is a no-op rather than a hide. IDs, aria-controls,
aria-labelledby and aria-selected usage are all clean (no duplicates, no dangling refs, no
forbidden role/attribute pairings); grid has rows and gridcells; every tabpanel has an owning tab.
Non-ARIA content in these two files: none, apart from the load-bearing clock.css rule above.

Known gaps to fix when convenient (gaps, not regressions): (1) the charts have no text alternative
for the trend - a screen-reader user gets the current number but no history; (2) role="status" on
the two async storage lines sits inside a body that is aria-live="off", so they will likely never be
announced - scope aria-live to those nodes or drop the role; (3) the numeric value is not announced
when it changes.

Still required before merge: the eight manual browser checks (both themes) listed in the review,
above all the clock grid pixel alignment and the Hijri sub-line in every cell.
