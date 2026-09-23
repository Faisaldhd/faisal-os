# Fai$al OS

A browser-based personal desktop OS inspired by Fedora/GNOME: Arabic-first (RTL) with full English support, built with Vite + TypeScript and plain DOM (no UI framework).

**Live:** https://faisaldhd.github.io/faisal-os/ · **Code:** https://github.com/Faisaldhd/faisal-os

This is a personal project by Faisal Saeed Al Shahrani. It is built for one user (its author) and documented honestly rather than marketed.

## نظرة سريعة

**Fai$al OS** نظام سطح مكتب شخصي يعمل داخل المتصفح، مستوحى من فيدورا وGNOME، عربي أولًا (RTL) مع دعم كامل للإنجليزية. مشروع شخصي من تطوير فيصل سعيد الشهراني.

- **الموقع المباشر:** <https://faisaldhd.github.io/faisal-os/> — يُنشر تلقائيًا عبر GitHub Actions عند كل دفع إلى الفرع `main`، بعد نجاح الاختبارات والبناء.
- **الشيفرة:** <https://github.com/Faisaldhd/faisal-os>
- **أبرز المزايا:** إحدى عشرة تطبيقًا مدمجًا لا يُحمَّل كودها إلا عند أول تشغيل، ومدير نوافذ كامل (سحب، تحجيم، التصاق بالحواف، تثبيت في الأعلى، حفظ الهندسة، استعادة الجلسة)، ونظام ملفات POSIX على IndexedDB بحصة 50 ميغابايت، وإشعارات مع سجل ووضع «عدم الإزعاج»، وسمتان داكنة وفاتحة مع لون تمييز، وطرفية فيها صدفة شبيهة بـ bash، وأمر `linux` يُقلع نواة لينكس 6.8 حقيقية مع BusyBox عبر محاكي v86.
- **الأمن:** لا أسرار في المستودع، ولا قياس عن بعد، وسياسة CSP صارمة. راجع [docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md)؛ التطبيقات اليوم تتشارك بيئة JavaScript نفسها مع النواة، فطبقة الصلاحيات حارس ضد الأخطاء لا صندوق رمل.
- **محليًا:**

  ```bash
  npm install
  npm run dev        # خادم تطوير Vite
  npm test           # vitest
  npm run build      # tsc ثم vite build إلى dist/
  ```

  يتطلب Node 22 (وهو الإصدار الذي يستخدمه سير النشر).

## نسخة سطح المكتب (Electron) — متصفح بلا قيود

داخل تبويب متصفح عادي لا يستطيع النظام عرض المواقع إلا عبر `iframe`، ومواقع مثل Google وYouTube وGitHub ترفض ذلك. نسخة سطح المكتب تستخدم `<webview>` حقيقيًا من Electron، فتفتح كل المواقع داخل تطبيق «المتصفح» وتطبيقات الويب مع تسجيل الدخول والكوكيز — بلا وسيط وبلا تعديل أي هيدر.

```bash
npm install
npm run desktop         # بناء ثم تشغيل التطبيق
npm run desktop:build   # ملف تثبيت في release/ (Windows: NSIS، macOS: DMG، Linux: AppImage)
```

- الملفات: `electron/main.cjs` (العملية الرئيسية) و`electron/preload.cjs` (جسر صغير معزول) و`src/shell/native-web.ts` (جهة الواجهة).
- الأمان: النظام يُخدَّم من أصل خاص `app://faisal-os` في بيئة معزولة بلا Node؛ كل `webview` يُجبَر على بيئة معزولة بلا Node ولا preload وعلى قسم جلسة منفصل `persist:faisal-web`، ولا يحمّل إلا http(s).
- النسخة المنشورة على GitHub Pages لم تتغير: خارج Electron تبقى `iframe` وبطاقات الرفض كما هي.

### التحديث التلقائي

النسخة المثبّتة تفحص [GitHub Releases](https://github.com/Faisaldhd/faisal-os/releases) عند التشغيل وكل 6 ساعات، وتنزّل الإصدار الجديد في الخلفية ثم تسأل: «إعادة التشغيل الآن» أو «لاحقًا» (يُثبَّت عند الإغلاق). يعمل على Windows وLinux؛ على macOS يتطلب التحديث التلقائي توقيعًا رقميًا من Apple، فهناك يُنزَّل الإصدار الجديد يدويًا.

لإصدار نسخة جديدة:

```bash
npm version patch          # يرفع الإصدار في package.json وينشئ الوسم v1.0.1
git push --follow-tags     # سير العمل desktop-release.yml يبني Windows/Linux/macOS وينشر الإصدار
```

## What it is

Fai$al OS puts a GNOME-style desktop inside a browser tab: a top bar, a dash, a desktop with shortcuts, an Activities overview, a window manager, notifications, a settings app, and a set of built-in applications backed by a virtual file system. The Arabic interface is the default (`<html lang="ar" dir="rtl">`); English is a runtime switch. Everything is plain DOM and CSS — no React/Vue.

Two things make it more than a mock desktop: apps are real capability-scoped modules behind a kernel contract (`src/kernel/types.ts`), and the Terminal can boot an actual Linux 6.8 kernel with BusyBox under the v86 x86 emulator.

### Live demo

<https://faisaldhd.github.io/faisal-os/> — deployed by GitHub Actions on every push to `main` (`.github/workflows/pages.yml` runs `npm ci`, `npm test`, `npm run build`, then publishes `dist/` to GitHub Pages).

### Screenshot

<!-- TODO: add a screenshot asset (for example docs/screenshot.png) and reference it here, e.g.
![Fai$al OS desktop](docs/screenshot.png)
No screenshot file exists in the repository yet, so none is shown. -->

No screenshot file exists in the repository yet; the block above is a placeholder for one.

## Features

### Shell and desktop experience

- GNOME-style top bar with a system menu: theme, language, full screen (with Keyboard Lock), screenshot and About.
- Activities overview (Super/Windows key tap, `Alt+F1`, or the `$` button) with open windows and app search.
- Window manager: drag, resize, minimize, maximize, edge snapping, always-on-top, per-app saved geometry, and session restore (up to 12 windows, installed apps only).
- Close guard for apps with unsaved work (the Text Editor asks before discarding).
- Notifications with a 50-entry history and a Do Not Disturb switch.
- Light/dark/system themes plus accent presets driven by CSS variables; boot splash.
- Screenshot tool (region or full screen) that saves into `Pictures` in the virtual file system.
- Desktop shortcuts, dash pins and app context menus; long-press support for touch context menus.
- Installable PWA (`public/manifest.webmanifest`) with a generated service worker for offline use in production builds and a "new version" notification.
- Full Arabic/English i18n through `defineStrings`/`t`, with logical CSS so both directions lay out correctly.

### Built-in apps

Eleven built-in apps, each with a static manifest and a code + CSS chunk that loads on first launch: Files, Terminal, Text Editor, Browser, Faisal AI, Calculator, Image Viewer, Clock, System Monitor, Store and Settings. See the [apps table](#apps) for ids, permissions and instance behaviour.

### Terminal and Linux VM

- Two backends in one app: a built-in `sim` shell (bash-like commands, pipes, redirects, tab completion, history in `/home/user/.bash_history`) and `v86`.
- The `linux` command boots a real Linux kernel (6.8.12, i686, built-in initramfs with BusyBox 1.36.1) in the v86 emulator; its serial console (`ttyS0`) is wired to xterm.js.
- The VM has no network card and no disk: everything runs in RAM and is lost when the session is closed. Assets are fetched only when Linux is requested.

### System services

- Event bus with per-handler error isolation.
- VFS: POSIX-like async API (`stat`, `readdir`, `readFile`, `writeFile`, `mkdir`, `remove`, `rename`, `chmod`) with an in-memory index over an IndexedDB backend, a memory-only fallback, a 50 MB total quota and a 20 MB per-file limit.
- Kernel capability layer: every app receives a frozen, permission-scoped `SystemAPI` (scoped VFS, no `bus.emit`, only its own windows, no app registration).
- App registry with catalog, install/uninstall state and a running-apps view.
- Settings store on `localStorage` (prototype-pollution guarded) and path normalization shared by all permission checks.
- Brand layer: navy + gold identity, marks, wordmarks and icons ([src/brand/BRAND.md](src/brand/BRAND.md)).

## Architecture

```text
Desktop (src/shell)      top bar · dash · desktop · Activities overview · notifications · splash · theme.css
        |
        v
Window Manager           open/close/focus, z-index, drag & resize, snapping, always-on-top,
(src/shell/wm.ts)        saved geometry, session restore
        |
        v
App Registry             manifests + lazy chunks, catalog, install/uninstall, running apps
(src/kernel/apps.ts)
        |
        v
Kernel capabilities      frozen per-app SystemAPI: scoped VFS, no bus.emit, own windows only
(src/kernel/types.ts)
        |
        v
Services                 VFS (src/vfs: IndexedDB <-> memory, 50 MB) · settings (localStorage)
                         event bus · i18n (ar/en) · notifications
```

| Path | What lives there |
| --- | --- |
| `src/kernel` | Contracts (`types.ts`), event bus, settings, i18n, path normalization, app registry and the per-app capability layer |
| `src/shell` | Window manager, top bar, dash, desktop, Activities overview, notifications, dialogs, context menus, screenshot, splash, appearance, `theme.css` |
| `src/vfs` | POSIX-like virtual file system: in-memory index plus IndexedDB backend, with a memory-only fallback |
| `src/apps/*` | The 11 built-in apps; each has `manifest.ts` (metadata only) and a lazily imported `index.ts` |
| `src/brand` | `BRAND.md`, SVG marks, wordmarks and the shared app icons |
| `public/v86` | Linux `bzImage`, SeaBIOS and VGA BIOS for the Terminal VM, plus the sources used to build them |
| `build` | Vite plugin that generates the service worker (`pwa.ts`, `sw-template.js`) |
| `docs` | Contracts, security review, and read-only audit reports in `docs/audit/` |

## Apps

Every row is derived from the app manifest in `src/apps/*/manifest.ts`. "multi" means the app can open more than one window; "single" means `singleInstance: true` (launching it again focuses the existing window).

| id | name (ar / en) | category | permissions | instances | what it does |
| --- | --- | --- | --- | --- | --- |
| `org.faisal.Files` | الملفات / Files | system | `fs:home` | multi | Browse, create, copy, move, delete, upload and download files; grid/list views |
| `org.faisal.Terminal` | الطرفية / Terminal | system | `fs:home`, `fs:read-all` | multi | Bash-like shell in the app, plus `linux` to boot the v86 Linux VM |
| `org.faisal.TextEditor` | محرر النصوص / Text Editor | accessories | `fs:home` | multi | Text editing with line gutter, search, save/save-as; opens `.txt .md .json .js .ts .css .html .sh .conf .log` |
| `org.faisal.Browser` | المتصفح / Browser | utilities | `network` | multi | Tabbed https-only browsing in an embedded cross-origin frame, bookmarks and search; blocked sites offer a real tab |
| `org.faisal.Claude` | Faisal AI / Faisal AI | utilities | `network`, `fs:home`, `fs:read-all`, `system:monitor`, `settings`, `notifications` | single | AI agent that runs on the provider you pick (GroqCloud or DeepSeek, with your own key) and proposes file, app and shell actions; every change asks for confirmation |
| `org.faisal.Calculator` | الآلة الحاسبة / Calculator | utilities | none | multi | Basic and advanced arithmetic, history, keyboard input |
| `org.faisal.ImageViewer` | عارض الصور / Image Viewer | media | `fs:home` | multi | Gallery browsing, zoom/fit; opens `.png .jpg .jpeg .gif .webp .svg .bmp .avif` |
| `org.faisal.Clock` | الساعة / Clock | utilities | `notifications` | multi | World time, Gregorian and Hijri (Umm al-Qura) calendar, stopwatch and timer |
| `org.faisal.SystemMonitor` | مراقب النظام / System Monitor | system | `system:monitor`, `fs:read-all` | single | Running apps (with close), JS heap and FPS, VFS storage usage |
| `org.faisal.Store` | المتجر / Store | system | `apps:manage`, `notifications` | single | Browses the catalog and installs/removes built-in apps (core apps cannot be removed) |
| `org.faisal.Settings` | الإعدادات / Settings | system | `settings` | single | Theme, accent, language, session restore, storage estimate, reset and About |

Notes: `Files`, `Terminal`, `Settings` and `Store` are `core` and cannot be uninstalled. The AI app keeps the id `org.faisal.Claude` from its first version so install state and pins carry over. `org.faisal.Store` is the only manifest that sets `defaultInstalled: true` explicitly; the others rely on the default.

## Getting started

Prerequisites: Node.js 22 (the version pinned in `.github/workflows/pages.yml`) and npm with the committed `package-lock.json`.

| Command | What it does |
| --- | --- |
| `npm install` | Installs dependencies (CI uses `npm ci` for a clean, lockfile-exact install) |
| `npm run dev` | Vite dev server with HMR; the service worker is not generated in dev |
| `npm test` | Vitest (jsdom) over `src/**/*.test.ts` — 18 test files, 250+ cases |
| `npm run typecheck` | `tsc` in strict mode over `src` |
| `npm run build` | `tsc && vite build` into `dist/` and generates `sw.js` |

Deploying: push to `main`. GitHub Actions runs tests and the build and deploys `dist/` to GitHub Pages; the workflow can also be started manually (`workflow_dispatch`). A failing test or build stops the deploy, so the previous successful version stays live.

## Development contracts

[docs/CONTRACTS.md](docs/CONTRACTS.md) is the short version of the rules; `src/kernel/types.ts` is the single source of truth and only the kernel track edits it.

| Track | Owns (write access) |
| --- | --- |
| kernel | `src/kernel/**`, `src/main.ts`, `index.html`, `package.json`, `vite.config.ts` |
| A: Shell | `src/shell/**`, `src/apps/settings/**` |
| B: Files | `src/vfs/**`, `src/apps/files/**`, `src/apps/editor/**` |
| C: Terminal | `src/apps/terminal/**`, `public/v86/**` |

- Read other tracks' code only through the interfaces in `types.ts`; request kernel changes in `docs/requests/<track>.md` instead of editing the contract.
- UI strings go through `defineStrings('<ns>', { ar, en })` and `t('<ns>.key')`; Arabic is the default and layouts must work in RTL and LTR (logical CSS properties only).
- Scope styles under a class prefix (`.faisal-shell-*`, `.faisal-files-*`, …) and use the shell's `--faisal-*` CSS variables.
- No `eval`, no `new Function`, no `innerHTML` with untrusted data (file names and file contents are untrusted).
- No network requests without the `network` permission.
- No new npm dependencies, except v86-related ones for the Terminal track.
- Tests live in `src/<area>/**/*.test.ts` (vitest, jsdom).

## Security notes

The full review is [docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md); it lists 7 fixed items and the open items with plans.

In place today: a frozen per-app capability object (kernel-enforced scoped VFS by permission, apps cannot emit system events, apps see only their own windows, apps cannot register apps); a strict CSP in `index.html` (`default-src 'self'`, no `eval`, `connect-src` limited to same-origin plus `https://api.groq.com` and `https://api.deepseek.com`, `object-src`/`base-uri`/`form-action` set to `'none'`); a browser URL policy that only frames `https:` URLs from another origin and refuses `javascript:`, `data:`, `blob:`, `file:` and same-origin URLs; no secrets in the repository (each AI provider key is entered by the user at runtime and kept in `localStorage`); no telemetry, cookies or fingerprinting; an allowlist-based SVG icon sanitizer; and path normalization before every permission check.

Honest limits: all apps share one JavaScript realm with the kernel, so the capability object is a guard against bugs, not a sandbox — in-process code can still reach `document`, `indexedDB` and `localStorage` directly. That is acceptable only while every app is built-in; sandboxed iframes plus a `postMessage` broker are the plan for third-party apps. The CSP is delivered as a `<meta>` tag, and GitHub Pages cannot send response headers, so `frame-ancestors`, `X-Content-Type-Options` and `Permissions-Policy` cannot be set on the live deployment (clickjacking stays a documented risk). `style-src 'unsafe-inline'` is still required by inline element styles. The `network` permission is declared in manifests but not yet enforced by the kernel; network reach is currently bounded by the CSP allowlist.

## Performance notes

Numbers measured on a local `dist/` build (see [docs/audit/build-perf.md](docs/audit/build-perf.md) for the method):

- Before first paint: **169 KiB raw (about 53 KiB gzip)** — `index.html`, the entry chunk, the shell chunk and the theme CSS. `index.html` itself has no visible content, so the first paint depends on JavaScript; this is a known P0 with a proposed fix in the audit.
- Each app's code and CSS is a separate chunk, loaded on first launch; the shell does not import app code.
- The Terminal chunk also pulls `libv86` (about 348 KiB raw / 92 KiB gzip) when the app opens.
- The Linux VM is opt-in: `bzImage` (1.66 MiB) + the v86 wasm (2.05 MiB) + BIOS files (about 164 KiB) ≈ **3.8 MiB (2.13 MiB gzip)**, fetched only when the user chooses the Linux session or runs `linux`.

## Known limitations

- The Store installs/uninstalls only built-in apps: it flips their install state and the launchers appear or disappear. No new code is downloaded, and the set of apps is fixed at build time.
- The Browser can only frame sites that allow embedding; sites that send `X-Frame-Options`/`frame-ancestors` protections show a blank frame, and the app offers to open them in a real browser tab instead. It stores no history and refuses non-`https:` and same-origin URLs.
- System Monitor shows only what the browser exposes: running apps from the registry, the JS heap (Chromium only, via `performance.memory`), an FPS estimate from `requestAnimationFrame`, and VFS usage against the internal 50 MB quota. There is no CPU/GPU temperature, no real hardware RAM figure and no fan sensors.
- Apps are not sandboxed in iframes yet (single JS realm, as described in the security notes).
- Storage is best-effort: if IndexedDB is unavailable (for example in private mode) the VFS falls back to memory only and notifies you that nothing will survive a reload. Open tabs are not synchronized, and there is no `navigator.storage.persist()` call.
- The theme setting offers a "System" mode, but it does not yet follow OS `prefers-color-scheme` changes live.
- Uploading a file whose name already exists replaces it without asking, and two Text Editor windows on the same file can overwrite each other's saves (last save wins). Both are open items in `docs/audit/AUDIT_ROADMAP.md`.
- System Monitor also shows a browser storage estimate next to the internal 50 MB quota, so the two storage numbers do not always agree.
- A new deployment needs every Fai$al OS tab closed before it takes over; the OS only shows a notification.
- Hijri dates come from the browser's `Intl` Umm al-Qura data, not from a bundled calendar.
- There is no dedicated mobile layout; touch works, but the shell is designed for a desktop-sized pointer.

## License and credits

No license file yet — all rights reserved by the author (Faisal Saeed Al Shahrani). `package.json` carries a `"license": "ISC"` field, but no `LICENSE` file exists in the repository.

Bundled third-party components keep their own licenses: v86 (BSD-2-Clause), SeaBIOS/SeaVGABIOS (LGPL-3.0), the Linux kernel and BusyBox (GPL-2.0) — see [public/v86/README.md](public/v86/README.md) for the exact sources. Runtime libraries used: `@xterm/xterm`, `@xterm/addon-fit`, `v86` and `html-to-image`, with Vite, TypeScript, Vitest, jsdom and `fake-indexeddb` for development.

## Documentation

- [docs/CONTRACTS.md](docs/CONTRACTS.md) — ownership and development rules.
- [docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md) — security review (fixed and open items).
- [src/brand/BRAND.md](src/brand/BRAND.md) — brand marks, palette and usage.
- [public/v86/README.md](public/v86/README.md) — the Linux VM assets, their licenses and how to rebuild them.
- [docs/audit/](docs/audit/) — read-only audit reports: kernel, shell/window manager, apps registry, heavy apps, VFS persistence, build/performance, security and mobile/accessibility/CSS.
- [docs/AUDIT_ROADMAP.md](docs/AUDIT_ROADMAP.md) — one prioritized plan (P0–P3) built from those reports, with guardrails and open decisions.
