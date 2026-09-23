# Fai$al OS: contracts and ownership

`src/kernel/types.ts` is the single source of truth. Only the kernel owner changes it.
If a track needs a change there, it records the request in `docs/requests/<track>.md` and does not edit the file.

| Track | Owns (write access) | Entry points it must export |
| --- | --- | --- |
| kernel | `src/kernel/**`, `src/main.ts`, `index.html`, `package.json`, `vite.config.ts` | — |
| A: Shell | `src/shell/**`, `src/apps/settings/**` | `createWindowManager(root, bus): WindowManager`, `mountShell(root, sys): void`, default `AppModule` for settings |
| B: Files | `src/vfs/**`, `src/apps/files/**`, `src/apps/editor/**` | `createVFS(bus): Promise<VFS>`, default `AppModule` for files and editor |
| C: Terminal | `src/apps/terminal/**`, `public/v86/**` | default `AppModule` for terminal |

## Rules

- Read other tracks' code only through the interfaces in `types.ts`.
- UI strings go through `defineStrings('<ns>', {ar, en})` and `t('<ns>.key')`. Arabic is the default, and layouts must work in both RTL and LTR (use logical CSS properties).
- Styles: scope each track under its own class prefix (`.faisal-shell-*`, `.faisal-files-*`, …). Use the CSS variables the shell defines (`--faisal-*`).
- Security: no `eval`, no `new Function`, no `innerHTML` with untrusted data (file names and file contents are untrusted). No network requests without the `network` permission.
- No new npm dependencies except Track C (v86-related). The shared dependencies are already installed: `@xterm/xterm`, `@xterm/addon-fit`, `v86`, `vitest`, `fake-indexeddb`, `jsdom`.
- Tests: `src/<area>/**/*.test.ts` (vitest, jsdom).
