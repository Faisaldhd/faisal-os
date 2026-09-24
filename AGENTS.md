# AGENTS.md — rules for every AI assistant working on Fai$al OS

(Claude, DeepSeek, Copilot, or anyone else. Read this before your first change.)

Fai$al OS is a desktop OS that runs in the browser (TypeScript + Vite + vitest, no framework).
Repository: https://github.com/Faisaldhd/faisal-os

## How a change reaches the owner

Two products are built from the **same code** on the `main` branch:

1. **Web** — https://faisal-os.pages.dev — Cloudflare Pages rebuilds it about 2 minutes after a merge to `main`
   (a GitHub Pages copy is also deployed by `.github/workflows/pages.yml`).
2. **Desktop app** (Windows, Electron) — `.github/workflows/desktop-release.yml` publishes a new
   GitHub Release on every merge to `main`; the installed app finds it, downloads it and asks
   "Restart now / Later", then restarts on the new version.

So **any PR merged into `main` reaches the web and the desktop app automatically.** Never deploy by hand,
never commit `dist/`, never bump the app version (it is computed). A change to `.md` files or `docs/` only
does not publish a new desktop release.

## Workflow for every task

1. Branch from the latest `main` (e.g. `fix/short-name`) and open a Pull Request into `main`.
   Never push to `main` directly, never force-push.
2. Put the change in the shared code under `src/` so it works in both products. Do not touch
   `electron/` or `.github/workflows/` unless the owner asked for it. If behaviour must differ between
   web and desktop, branch on `nativeWeb()` from `src/shell/native-web.ts` and say so in the PR.
3. Wait for the PR checks: **PR checks** (tests + build, `.github/workflows/pr-checks.yml`) and the
   Cloudflare Pages preview (a bot comment with a preview link). If a check fails, fix it on the same
   branch; do not open a new PR.
4. If the PR conflicts with `main`, merge `main` into your branch and resolve it in the same PR.
5. Do not merge your own PR — the owner merges.

## Project rules

- Arabic first (RTL) with English: every user-visible string goes into the matching `strings.ts`
  in **both** `ar` and `en`.
- Render text with `textContent`; never put external or user content through `innerHTML`.
- No API keys, tokens or passwords in code. Keys live only in the user's browser.
- Add or update a vitest test for logic you change. Never delete, skip or weaken a test to go green.
- No new dependencies without a strong reason; prefer browser APIs.
- The OS version shown to users lives in `src/kernel/version.ts` and `src/brand/logo.ts`; change it only when asked.
- Map: `src/shell/` desktop, top bar, windows, notifications, clipboard · `src/apps/<app>/` one folder per app ·
  `src/kernel/` core · `src/vfs/` file system · `functions/` Cloudflare functions · `electron/` desktop app only.

## Report back after every task

- The PR link
- What changed and why (short, in Arabic for the owner)
- Checks ✅/❌ and the preview link
- One explicit line: "Reaches the web and the desktop app after merge" — or explain the exception
- Anything you could not verify, said plainly (never assume success)
