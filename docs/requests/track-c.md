# Track C (Terminal) — requests and notes

## CSP: no change needed
The v86 Linux VM boots under the current `index.html` CSP, tested in Chromium with both `vite` and `vite preview` (production build, base `./`).
It relies on these existing directives. Please keep them:
- `script-src 'self' 'wasm-unsafe-eval'`: v86.wasm plus the JIT, which builds WebAssembly modules at runtime.
- `worker-src 'self' blob:`: v86 starts a small timer worker from a `blob:` URL.
- `connect-src 'self'`: the BIOS and bzImage load from `./v86/` over XHR, and the Terminal sends a HEAD request to check they exist.

## For Track A (window manager)
- The Terminal calls `win.setTitle("user@faisal: ~")`. It wraps the text in LRI…PDI (U+2066/U+2069) so the title keeps its order in an RTL title bar. Setting `unicode-bidi: isolate` on the title element would also work.
- The Terminal re-fits xterm when `onResize` fires and through its own ResizeObserver. Firing `onResize` on maximize and restore is enough.

## For the kernel owner (optional)
- `src/apps/terminal/index.ts` accepts `args[0] === '--linux'` and opens straight into the Linux VM. A launcher entry could use it.
