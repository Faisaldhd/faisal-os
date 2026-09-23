/**
 * Terminal (الطرفية) — GNOME Console-style terminal with two backends:
 *  - sim: the built-in bash-like Faisal shell over the VFS (instant)
 *  - v86: a real Linux kernel in the v86 emulator, over its serial console
 */
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './terminal.css';
import './strings';
import type { AppContext, AppModule, TerminalBackend } from '../../kernel/types';
import { t } from '../../kernel/i18n';
import { SimBackend } from './backends/sim';
import { TERM_TEXT } from './strings';
import { ICON_TERMINAL } from '../../brand/icons';

type Kind = TerminalBackend['kind'];

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="2" y="3.5" width="20" height="17" rx="3.5" fill="#2e3436"/><rect x="2" y="3.5" width="20" height="4" rx="2" fill="#555753"/><path d="M6 11l3 2.5L6 16" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M11 16.5h6" stroke="#8ff0a4" stroke-width="1.6" stroke-linecap="round"/></svg>`;

function cssVar(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch { return fallback; }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function launch({ sys, window: win, args }: AppContext): void {
  const root = el('div', 'faisal-term');
  const header = el('div', 'faisal-term-header');
  header.dir = sys.locale() === 'ar' ? 'rtl' : 'ltr';
  const label = el('label', undefined, t('terminal.backend'));
  const select = el('select', 'faisal-term-select');
  select.id = `faisal-term-kind-${win.id}`;
  label.htmlFor = select.id;
  for (const k of ['sim', 'v86'] as Kind[]) {
    const o = el('option', undefined, t(`terminal.${k}`));
    o.value = k;
    select.append(o);
  }
  const status = el('span', 'faisal-term-status');
  const restart = el('button', 'faisal-term-btn', t('terminal.restart'));
  restart.type = 'button';
  header.append(label, select, status, restart);

  const body = el('div', 'faisal-term-body');
  body.dir = 'ltr';
  const host = el('div', 'faisal-term-xterm');
  host.dir = 'ltr';
  body.append(host);
  root.append(header, body);
  win.content.replaceChildren(root);

  const accent = cssVar('--faisal-accent', '#3584e4');
  const term = new Terminal({
    fontFamily: "'Source Code Pro', 'DejaVu Sans Mono', 'Noto Sans Mono', 'Cascadia Mono', Menlo, Consolas, monospace",
    fontSize: 14,
    lineHeight: 1.1,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: false,
    macOptionIsMeta: true,
    theme: {
      background: '#1e1e1e',
      foreground: '#f6f5f4',
      cursor: cssVar('--faisal-fg', '#f6f5f4'),
      cursorAccent: '#1e1e1e',
      selectionBackground: /^#[0-9a-f]{6}$/i.test(accent) ? accent + '66' : 'rgba(53, 132, 228, 0.4)',
      black: '#241f31', red: '#e01b24', green: '#2ec27e', yellow: '#f5c211',
      blue: '#3584e4', magenta: '#c061cb', cyan: '#33c7de', white: '#c0bfbc',
      brightBlack: '#5e5c64', brightRed: '#f66151', brightGreen: '#57e389', brightYellow: '#f8e45c',
      brightBlue: '#62a0ea', brightMagenta: '#dc8add', brightCyan: '#93ddc2', brightWhite: '#f6f5f4',
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  const doFit = () => {
    try { if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit(); } catch { /* not visible yet */ }
  };
  requestAnimationFrame(doFit);

  let backend: TerminalBackend | null = null;
  let current: Kind = 'sim';
  const setStatus = (key: string, error = false) => {
    status.textContent = t(`terminal.${key}`);
    status.title = status.textContent;
    status.dataset.state = error ? 'error' : '';
  };

  const shellHost = {
    exit: () => win.close(),
    switchBackend: (k: 'v86') => { queueMicrotask(() => void switchTo(k)); },
    size: () => ({ cols: term.cols, rows: term.rows }),
    // LRI…PDI keeps "user@faisal: ~" in order inside an RTL title bar
    setTitle: (s: string) => win.setTitle(`\u2066${s}\u2069`),
    listApps: () => sys.apps.list().map((m) => ({ id: m.id, name: m.name.en })),
    clear: () => term.write('\x1b[H\x1b[2J\x1b[3J'),
    open: async (path: string, isDir: boolean) => {
      const id = isDir
        ? sys.apps.list().find((m) => m.id === 'org.faisal.Files')?.id
        : sys.apps.appForFile(path)?.id;
      if (!id) return false;
      await sys.apps.launch(id, [path]);
      return true;
    },
  };

  async function switchTo(kind: Kind): Promise<void> {
    backend?.dispose();
    backend = null;
    current = kind;
    select.value = kind;
    term.reset();
    let b: TerminalBackend;
    if (kind === 'sim') {
      b = new SimBackend({
        vfs: sys.vfs,
        host: shellHost,
        lang: sys.locale() === 'ar' ? 'ar_SA.UTF-8' : 'en_US.UTF-8',
        banner: TERM_TEXT.banner,
      });
      setStatus('statusSim');
    } else {
      setStatus('statusLoading');
      win.setTitle(t('terminal.v86'));
      const { V86Backend } = await import('./backends/v86');
      if (current !== kind) return;
      b = new V86Backend({
        assetsBase: new URL('v86/', document.baseURI).href,
        messages: {
          loading: TERM_TEXT.v86Loading,
          booting: TERM_TEXT.v86Booting,
          missing: TERM_TEXT.v86Missing,
          failed: TERM_TEXT.v86Failed,
        },
        size: () => ({ cols: term.cols, rows: term.rows }),
        onStatus: (st) => {
          if (current !== 'v86') return;
          const map = { loading: 'statusLoading', booting: 'statusBooting', running: 'statusRunning', missing: 'statusMissing', failed: 'statusFailed' } as const;
          setStatus(map[st], st === 'missing' || st === 'failed');
        },
      });
    }
    backend = b;
    await b.start((data) => { if (backend === b) term.write(data); });
    b.resize?.(term.cols, term.rows);
    term.focus();
  }

  const offData = term.onData((d) => backend?.input(d));
  const offResize = term.onResize(({ cols, rows }) => backend?.resize?.(cols, rows));
  select.addEventListener('change', () => { void switchTo(select.value as Kind); });
  restart.addEventListener('click', () => { void switchTo(current); });

  const offWinResize = win.onResize(() => doFit());
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => doFit()) : null;
  ro?.observe(body);

  win.onClose(() => {
    offData.dispose();
    offResize.dispose();
    offWinResize();
    ro?.disconnect();
    backend?.dispose();
    backend = null;
    term.dispose();
  });

  void switchTo(args[0] === '--linux' ? 'v86' : 'sim');
}

const app: AppModule = {
  manifest: {
    id: 'org.faisal.Terminal',
    name: { ar: 'الطرفية', en: 'Terminal' },
    description: { ar: 'سطر أوامر شبيه بـ bash، ولينكس حقيقي عبر v86', en: 'A bash-like command line, plus real Linux via v86' },
    icon: ICON_TERMINAL,
    // fs:system so users can read /etc/os-release etc. The shell itself refuses
    // writes outside /home/user and /tmp, like an unprivileged Linux user.
    permissions: ['fs:home', 'fs:read-all'],
  },
  launch,
};

export default app;
