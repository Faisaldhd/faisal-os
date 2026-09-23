import type { TerminalBackend, VFS } from '../../../kernel/types';
import { Shell } from '../shell/shell';
import { LineEditor } from '../shell/lineeditor';
import { complete } from '../shell/completer';
import type { ShellHost } from '../shell/types';
import { C } from '../shell/util';

const HISTORY_FILE = '.bash_history';
const HISTORY_MAX = 1000;

export interface SimBackendOptions {
  vfs: VFS;
  host: ShellHost & { size(): { cols: number; rows: number } };
  lang?: string;
  /** Printed once when the session starts. */
  banner?: string;
}

/** The instant, built-in bash-like shell over the Faisal VFS. */
export class SimBackend implements TerminalBackend {
  readonly kind = 'sim' as const;
  readonly shell: Shell;
  private editor!: LineEditor;
  private output: (s: string) => void = () => {};
  private pending = '';
  private running: { cancelled: boolean } | null = null;
  private disposed = false;

  constructor(private opts: SimBackendOptions) {
    this.shell = new Shell({ vfs: opts.vfs, host: opts.host, lang: opts.lang });
  }

  async start(output: (data: string) => void): Promise<void> {
    this.output = output;
    const sh = this.shell;
    // /tmp is world-writable on Linux; make sure it exists (best effort).
    try { if (!(await sh.vfs.exists('/tmp'))) await sh.vfs.mkdir('/tmp'); } catch { /* read-only VFS */ }
    try {
      const text = await sh.vfs.readText(`${sh.home}/${HISTORY_FILE}`);
      sh.history.push(...text.split('\n').filter(Boolean).slice(-HISTORY_MAX));
    } catch { /* no history yet */ }

    this.editor = new LineEditor({
      write: (s) => this.output(s),
      cols: () => this.opts.host.size().cols,
      history: sh.history,
      complete: (line, cursor) => complete(sh, line, cursor),
      onLine: (line) => { void this.onLine(line); },
      onInterrupt: () => { this.pending = ''; sh.lastStatus = 130; this.prompt(); },
      onEOF: () => { this.opts.host.exit?.(); },
    });
    if (this.opts.banner) this.write(this.opts.banner);
    this.prompt();
  }

  /** Shell output uses "\n"; the terminal needs "\r\n". */
  private write(s: string): void {
    if (!this.disposed) this.output(s.replace(/\r?\n/g, '\r\n'));
  }

  private promptText(): string {
    const sh = this.shell;
    const cwd = sh.cwd === sh.home ? '~' : sh.cwd.startsWith(sh.home + '/') ? '~' + sh.cwd.slice(sh.home.length) : sh.cwd;
    const safe = cwd.replace(/[\x00-\x1f\x7f-\x9f]/g, '?');
    return `${C.boldGreen}${sh.user}@${sh.hostname}${C.reset}:${C.boldBlue}${safe}${C.reset}$ `;
  }

  private prompt(): void {
    if (this.disposed || this.shell.exited) return;
    const sh = this.shell;
    this.opts.host.setTitle?.(`${sh.user}@${sh.hostname}: ${sh.cwd === sh.home ? '~' : sh.cwd.replace(sh.home + '/', '~/')}`);
    this.editor.start(this.pending ? '> ' : this.promptText());
  }

  private async onLine(line: string): Promise<void> {
    const sh = this.shell;
    this.pending = this.pending ? `${this.pending}\n${line}` : line;
    if (Shell.needsMore(this.pending)) { this.prompt(); return; }
    const src = this.pending;
    this.pending = '';
    if (src.trim()) this.remember(src);
    if (!src.trim()) { this.prompt(); return; }

    const token = { cancelled: false };
    this.running = token;
    try {
      await sh.run(src, { out: (s) => { if (!token.cancelled) this.write(s); }, err: (s) => { if (!token.cancelled) this.write(s); }, signal: token, isTTY: true });
    } catch (e) {
      if (!token.cancelled) this.write(`bash: internal error: ${(e as Error).message}\n`);
    }
    if (token.cancelled || this.running !== token) return; // Ctrl+C already gave a new prompt
    this.running = null;
    this.prompt();
  }

  private remember(src: string): void {
    const sh = this.shell;
    if (src.startsWith(' ')) return; // HISTCONTROL=ignorespace
    const entry = src.replace(/\n/g, ' ');
    if (sh.history[sh.history.length - 1] !== entry) sh.history.push(entry);
    if (sh.history.length > HISTORY_MAX) sh.history.splice(0, sh.history.length - HISTORY_MAX);
    void sh.vfs.writeFile(`${sh.home}/${HISTORY_FILE}`, sh.history.join('\n') + '\n').catch(() => {});
  }

  input(data: string): void {
    if (this.disposed) return;
    if (this.running && data.includes('\x03')) {
      this.running.cancelled = true;
      this.running = null;
      this.editor.clearQueue();
      this.shell.lastStatus = 130;
      this.output('^C\r\n');
      this.prompt();
      return;
    }
    this.editor.feed(data);
  }

  resize(): void {
    this.editor?.resized();
  }

  dispose(): void {
    this.disposed = true;
    if (this.running) this.running.cancelled = true;
  }
}
