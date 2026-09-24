# AGENTS.md — rules for every AI assistant working on Fai$al OS

(Claude, DeepSeek, Copilot, or anyone else. Read this before your first change.)

Fai$al OS is a desktop OS that runs in the browser (TypeScript + Vite + vitest, no framework).
Repository: https://github.com/Faisaldhd/faisal-os

## How a change reaches the owner — both products, together

Two products are built from the **same code** on `main`, and they are published **together**:

1. A merge to `main` starts `.github/workflows/desktop-release.yml`: tests, the desktop builds, then a new
   GitHub Release. The installed app finds it, downloads it and asks "Restart now / Later".
2. **Only after that release succeeds**, the same workflow publishes the web from the same commit:
   GitHub Pages (`pages.yml`) and Cloudflare Pages (it moves the `release` branch, which is Cloudflare's
   production branch) → https://faisal-os.pages.dev.
3. If the desktop build fails, the web is **not** updated either. Fix the failure; never work around it.

Publishing one product without the other happens **only when the owner explicitly asks**:
"Publish web only" (`web-only.yml`, typed confirmation) or Desktop release with `target: app-only`.
Never trigger these on your own. Never deploy by hand, never commit `dist/`, never bump the app version.
A change to `.md` files or `docs/` only publishes nothing (neither product changes).

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
