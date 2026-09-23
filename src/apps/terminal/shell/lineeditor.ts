/**
 * Readline-style line editor for xterm (pure: talks to the terminal only
 * through `write`). Handles cursor movement, history, kill/yank, Tab
 * completion and wrapped lines.
 */
import { charWidth, columns, strWidth } from './util';

export interface CompletionResult {
  /** Index (in code points) where the word being completed starts. */
  start: number;
  /** Full replacement texts for that word. Directories end with "/". */
  candidates: string[];
  /** Optional shorter labels for listing (e.g. basenames). */
  display?: string[];
}

export interface LineEditorOptions {
  write(s: string): void;
  cols(): number;
  history?: string[];
  complete?(line: string, cursor: number): Promise<CompletionResult>;
  onLine(line: string): void;
  /** Ctrl+C at the prompt (the editor already printed ^C and a newline). */
  onInterrupt?(): void;
  /** Ctrl+D on an empty line. */
  onEOF?(): void;
}

/** Splits raw terminal input into keys / escape sequences / printable runs. */
export function nextKey(s: string): string {
  const c = s.charCodeAt(0);
  if (s[0] === '\x1b') {
    const m = /^\x1b\[[0-9;?<=>]*[ -/]*[@-~]/.exec(s) ?? /^\x1bO[\s\S]/.exec(s) ?? /^\x1b[\s\S]/.exec(s);
    return m ? m[0] : '\x1b';
  }
  if (c < 0x20 || c === 0x7f) return s[0];
  // eslint-disable-next-line no-control-regex
  const m = /^[^\x00-\x1f\x7f\x1b]+/.exec(s);
  return m ? m[0] : s[0];
}

const KEYS: Record<string, string> = {
  '\r': 'enter', '\n': 'enter',
  '\x7f': 'backspace', '\b': 'backspace',
  '\x1b[3~': 'delete',
  '\x1b[D': 'left', '\x1bOD': 'left', '\x02': 'left',
  '\x1b[C': 'right', '\x1bOC': 'right', '\x06': 'right',
  '\x1b[A': 'up', '\x1bOA': 'up', '\x10': 'up',
  '\x1b[B': 'down', '\x1bOB': 'down', '\x0e': 'down',
  '\x1b[H': 'home', '\x1bOH': 'home', '\x1b[1~': 'home', '\x1b[7~': 'home', '\x01': 'home',
  '\x1b[F': 'end', '\x1bOF': 'end', '\x1b[4~': 'end', '\x1b[8~': 'end', '\x05': 'end',
  '\x1b[1;5D': 'wordLeft', '\x1b[1;3D': 'wordLeft', '\x1bb': 'wordLeft',
  '\x1b[1;5C': 'wordRight', '\x1b[1;3C': 'wordRight', '\x1bf': 'wordRight',
  '\x15': 'killStart', '\x0b': 'killEnd', '\x17': 'killWord', '\x1b\x7f': 'killWord', '\x1bd': 'killWordRight',
  '\x19': 'yank', '\x03': 'interrupt', '\x04': 'eof', '\x0c': 'clearScreen', '\t': 'tab',
};

const cpWidth = (s: string) => charWidth(s.codePointAt(0)!);

export class LineEditor {
  private buf: string[] = [];
  private cursor = 0;
  private prompt = '';
  private cursorRow = 0;
  private active = false;
  private busy = false;
  private queue = '';
  private histIndex = 0;
  private draft: string[] = [];
  private killRing = '';
  private lastWasTab = false;
  private skipLF = false;
  readonly history: string[];

  constructor(private opts: LineEditorOptions) {
    this.history = opts.history ?? [];
  }

  /** Current line text (for tests). */
  get line(): string { return this.buf.join(''); }
  get cursorPos(): number { return this.cursor; }
  get isActive(): boolean { return this.active; }

  /** Shows the prompt and starts accepting a new line. */
  start(prompt: string): void {
    this.prompt = prompt;
    this.buf = [];
    this.cursor = 0;
    this.cursorRow = 0;
    this.histIndex = this.history.length;
    this.draft = [];
    this.active = true;
    this.lastWasTab = false;
    this.opts.write(prompt);
    this.pump();
  }

  /** Raw input from the terminal. Queued while inactive (type-ahead / paste). */
  feed(data: string): void {
    this.queue += data;
    this.pump();
  }

  clearQueue(): void { this.queue = ''; }

  /** Call after the terminal was resized so wrapped-line math stays right. */
  resized(): void {
    if (!this.active) return;
    const cols = Math.max(1, this.opts.cols());
    this.cursorRow = Math.floor((strWidth(this.prompt) + this.widthOf(0, this.cursor)) / cols);
  }

  /** Redraws prompt + line (e.g. after the screen was cleared). */
  redraw(fromTop = false): void {
    if (fromTop) this.cursorRow = 0;
    if (this.active) this.refresh();
  }

  private pump(): void {
    while (this.active && !this.busy && this.queue) {
      const key = nextKey(this.queue);
      this.queue = this.queue.slice(key.length);
      if (this.skipLF && key === '\n') { this.skipLF = false; continue; }
      this.skipLF = key === '\r';
      this.handle(key);
    }
  }

  private widthOf(from: number, to: number): number {
    let w = 0;
    for (let i = from; i < to; i++) w += cpWidth(this.buf[i]);
    return w;
  }

  private refresh(): void {
    const cols = Math.max(1, this.opts.cols());
    const promptW = strWidth(this.prompt);
    let s = '';
    if (this.cursorRow > 0) s += `\x1b[${this.cursorRow}A`;
    s += '\r\x1b[J' + this.prompt + this.buf.join('');
    const total = promptW + this.widthOf(0, this.buf.length);
    if (total > 0 && total % cols === 0) s += '\r\n';
    const endRow = Math.floor(total / cols);
    const target = promptW + this.widthOf(0, this.cursor);
    const tRow = Math.floor(target / cols);
    const tCol = target % cols;
    if (endRow > tRow) s += `\x1b[${endRow - tRow}A`;
    s += '\r';
    if (tCol) s += `\x1b[${tCol}C`;
    this.cursorRow = tRow;
    this.opts.write(s);
  }

  private insert(text: string): void {
    const chars = Array.from(text);
    const atEnd = this.cursor === this.buf.length;
    this.buf.splice(this.cursor, 0, ...chars);
    this.cursor += chars.length;
    if (atEnd) {
      const cols = Math.max(1, this.opts.cols());
      const total = strWidth(this.prompt) + this.widthOf(0, this.buf.length);
      let s = text;
      if (total % cols === 0) s += '\r\n';
      this.cursorRow = Math.floor(total / cols);
      this.opts.write(s);
    } else this.refresh();
  }

  private setLine(chars: string[]): void {
    this.buf = chars;
    this.cursor = chars.length;
    this.refresh();
  }

  private wordStart(): number {
    let i = this.cursor;
    while (i > 0 && /\s/.test(this.buf[i - 1])) i--;
    while (i > 0 && !/[\s/]/.test(this.buf[i - 1])) i--;
    if (i === this.cursor && i > 0) i--; // lone separator
    return i;
  }

  private wordEnd(): number {
    let i = this.cursor;
    while (i < this.buf.length && /\s/.test(this.buf[i])) i++;
    while (i < this.buf.length && !/[\s/]/.test(this.buf[i])) i++;
    if (i === this.cursor && i < this.buf.length) i++;
    return i;
  }

  private handle(key: string): void {
    const action = KEYS[key];
    const wasTab = this.lastWasTab;
    this.lastWasTab = action === 'tab';
    switch (action) {
      case 'enter': {
        const line = this.buf.join('');
        // move to the end of a wrapped line before the newline
        this.cursor = this.buf.length;
        this.refresh();
        this.opts.write('\r\n');
        this.active = false;
        this.cursorRow = 0;
        this.opts.onLine(line);
        return;
      }
      case 'backspace':
        if (this.cursor > 0) {
          this.buf.splice(this.cursor - 1, 1);
          this.cursor--;
          this.refresh();
        }
        return;
      case 'delete':
        if (this.cursor < this.buf.length) { this.buf.splice(this.cursor, 1); this.refresh(); }
        return;
      case 'left': if (this.cursor > 0) { this.cursor--; this.refresh(); } return;
      case 'right': if (this.cursor < this.buf.length) { this.cursor++; this.refresh(); } return;
      case 'home': this.cursor = 0; this.refresh(); return;
      case 'end': this.cursor = this.buf.length; this.refresh(); return;
      case 'wordLeft': this.cursor = this.wordStart(); this.refresh(); return;
      case 'wordRight': this.cursor = this.wordEnd(); this.refresh(); return;
      case 'killStart':
        this.killRing = this.buf.slice(0, this.cursor).join('');
        this.buf.splice(0, this.cursor);
        this.cursor = 0;
        this.refresh();
        return;
      case 'killEnd':
        this.killRing = this.buf.slice(this.cursor).join('');
        this.buf.splice(this.cursor);
        this.refresh();
        return;
      case 'killWord': {
        const s = this.wordStart();
        this.killRing = this.buf.slice(s, this.cursor).join('');
        this.buf.splice(s, this.cursor - s);
        this.cursor = s;
        this.refresh();
        return;
      }
      case 'killWordRight': {
        const e = this.wordEnd();
        this.killRing = this.buf.slice(this.cursor, e).join('');
        this.buf.splice(this.cursor, e - this.cursor);
        this.refresh();
        return;
      }
      case 'yank': if (this.killRing) this.insert(this.killRing); return;
      case 'up':
        if (this.histIndex > 0) {
          if (this.histIndex === this.history.length) this.draft = [...this.buf];
          this.histIndex--;
          this.setLine(Array.from(this.history[this.histIndex]));
        }
        return;
      case 'down':
        if (this.histIndex < this.history.length) {
          this.histIndex++;
          this.setLine(this.histIndex === this.history.length ? [...this.draft] : Array.from(this.history[this.histIndex]));
        }
        return;
      case 'interrupt':
        this.cursor = this.buf.length;
        this.refresh();
        this.opts.write('^C\r\n');
        this.active = false;
        this.queue = '';
        this.cursorRow = 0;
        this.opts.onInterrupt?.();
        return;
      case 'eof':
        if (!this.buf.length) { this.opts.write('\r\n'); this.active = false; this.opts.onEOF?.(); }
        else if (this.cursor < this.buf.length) { this.buf.splice(this.cursor, 1); this.refresh(); }
        return;
      case 'clearScreen':
        this.opts.write('\x1b[H\x1b[2J');
        this.cursorRow = 0;
        this.refresh();
        return;
      case 'tab':
        this.complete(wasTab);
        return;
      default:
        break;
    }
    if (key[0] === '\x1b' || key.charCodeAt(0) < 0x20) return; // unknown control / escape
    this.insert(key);
  }

  private complete(listIfAmbiguous: boolean): void {
    if (!this.opts.complete) return;
    this.busy = true;
    const line = this.buf.join('');
    const cursorIdx = this.cursor;
    // completion API works on code-point indices
    this.opts.complete(line, cursorIdx)
      .then((r) => this.applyCompletion(r, listIfAmbiguous))
      .catch(() => { /* ignore */ })
      .finally(() => { this.busy = false; this.pump(); });
  }

  private applyCompletion(r: CompletionResult, list: boolean): void {
    if (!this.active) return;
    const word = this.buf.slice(r.start, this.cursor).join('');
    const cands = r.candidates;
    if (!cands.length) { this.opts.write('\x07'); return; }
    const replace = (text: string) => {
      const chars = Array.from(text);
      this.buf.splice(r.start, this.cursor - r.start, ...chars);
      this.cursor = r.start + chars.length;
      this.refresh();
    };
    if (cands.length === 1) {
      const c = cands[0];
      const endsDir = c.endsWith('/');
      const next = this.buf[this.cursor];
      replace(c + (endsDir || next === ' ' ? '' : ' '));
      return;
    }
    let prefix = cands[0];
    for (const c of cands) while (!c.startsWith(prefix)) prefix = prefix.slice(0, -1);
    if (prefix.length > word.length) { replace(prefix); this.lastWasTab = false; return; }
    if (!list) { this.opts.write('\x07'); return; }
    const labels = r.display ?? cands;
    const items = labels.map((t) => ({ text: t, width: strWidth(t) }));
    this.cursorRow = 0;
    const saved = this.cursor;
    this.cursor = this.buf.length;
    this.refresh();
    this.opts.write('\r\n' + columns(items, Math.max(1, this.opts.cols())).replace(/\n/g, '\r\n'));
    this.cursorRow = 0;
    this.cursor = saved;
    this.refresh();
  }
}
