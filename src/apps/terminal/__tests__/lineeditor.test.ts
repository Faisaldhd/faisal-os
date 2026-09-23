import { describe, expect, it } from 'vitest';
import { LineEditor, nextKey, type LineEditorOptions } from '../shell/lineeditor';

function setup(extra: Partial<LineEditorOptions> = {}, cols = 80) {
  const lines: string[] = [];
  let written = '';
  let interrupts = 0;
  let eof = 0;
  const ed = new LineEditor({
    write: (s) => { written += s; },
    cols: () => cols,
    onLine: (l) => { lines.push(l); },
    onInterrupt: () => { interrupts++; },
    onEOF: () => { eof++; },
    ...extra,
  });
  ed.start('$ ');
  return {
    ed, lines,
    get written() { return written; },
    reset() { written = ''; },
    get interrupts() { return interrupts; },
    get eof() { return eof; },
  };
}

const LEFT = '\x1b[D', RIGHT = '\x1b[C', UP = '\x1b[A', DOWN = '\x1b[B';

describe('nextKey', () => {
  it('splits escape sequences, control keys and text runs', () => {
    expect(nextKey('\x1b[Aabc')).toBe('\x1b[A');
    expect(nextKey('\x1b[1;5Cx')).toBe('\x1b[1;5C');
    expect(nextKey('\x1bOH')).toBe('\x1bOH');
    expect(nextKey('\x1bb')).toBe('\x1bb');
    expect(nextKey('hello\r')).toBe('hello');
    expect(nextKey('\x7f')).toBe('\x7f');
    expect(nextKey('مرحبا\r')).toBe('مرحبا');
  });
});

describe('LineEditor', () => {
  it('types, edits in the middle and submits', () => {
    const t = setup();
    t.ed.feed('helo');
    t.ed.feed(LEFT);
    t.ed.feed('l');
    expect(t.ed.line).toBe('hello');
    expect(t.ed.cursorPos).toBe(4);
    t.ed.feed('\x1b[F world\r');
    expect(t.lines).toEqual(['hello world']);
    expect(t.ed.isActive).toBe(false);
  });

  it('backspace, delete, home/end', () => {
    const t = setup();
    t.ed.feed('abcd\x7f');
    expect(t.ed.line).toBe('abc');
    t.ed.feed('\x01'); // Ctrl+A
    expect(t.ed.cursorPos).toBe(0);
    t.ed.feed('\x1b[3~');
    expect(t.ed.line).toBe('bc');
    t.ed.feed('\x05X'); // Ctrl+E
    expect(t.ed.line).toBe('bcX');
    t.ed.feed('\x1b[HY');
    expect(t.ed.line).toBe('YbcX');
  });

  it('Ctrl+U / Ctrl+K / Ctrl+W / Ctrl+Y', () => {
    const t = setup();
    t.ed.feed('git commit -m msg');
    t.ed.feed('\x17');
    expect(t.ed.line).toBe('git commit -m ');
    t.ed.feed('\x19');
    expect(t.ed.line).toBe('git commit -m msg');
    t.ed.feed(LEFT.repeat(4) + '\x0b');
    expect(t.ed.line).toBe('git commit -m');
    t.ed.feed('\x15');
    expect(t.ed.line).toBe('');
  });

  it('walks history with up/down and restores the draft', () => {
    const t = setup({ history: ['first', 'second'] });
    t.ed.feed('draft');
    t.ed.feed(UP);
    expect(t.ed.line).toBe('second');
    t.ed.feed(UP);
    expect(t.ed.line).toBe('first');
    t.ed.feed(UP);
    expect(t.ed.line).toBe('first');
    t.ed.feed(DOWN + DOWN);
    expect(t.ed.line).toBe('draft');
  });

  it('Ctrl+C prints ^C and interrupts; Ctrl+D on empty line is EOF', () => {
    const t = setup();
    t.ed.feed('oops\x03');
    expect(t.written).toContain('^C\r\n');
    expect(t.interrupts).toBe(1);
    expect(t.lines).toEqual([]);
    t.ed.start('$ ');
    t.ed.feed('\x04');
    expect(t.eof).toBe(1);
  });

  it('queues type-ahead / pasted lines until the next prompt', () => {
    const t = setup();
    t.ed.feed('one\r\ntwo\rthr');
    expect(t.lines).toEqual(['one']);
    t.ed.start('$ ');
    expect(t.lines).toEqual(['one', 'two']);
    t.ed.start('$ ');
    expect(t.ed.line).toBe('thr');
  });

  it('keeps Arabic input as whole characters', () => {
    const t = setup();
    t.ed.feed('echo سلام');
    t.ed.feed('\x7f');
    expect(t.ed.line).toBe('echo سلا');
    t.ed.feed(RIGHT + '\r');
    expect(t.lines).toEqual(['echo سلا']);
  });

  it('wraps long lines by emitting a newline at the right margin', () => {
    const t = setup({}, 10);
    t.reset();
    t.ed.feed('abcdefgh'); // "$ " + 8 = 10 columns
    expect(t.written).toBe('abcdefgh\r\n');
    t.reset();
    t.ed.feed('\x01'); // move to start: go up one row, then to column 2
    expect(t.written).toContain('\x1b[1A');
    expect(t.written.endsWith('\r\x1b[2C')).toBe(true);
  });

  it('Tab completes a unique match, then lists ambiguous ones on double Tab', async () => {
    const complete = async (line: string, cursor: number) => {
      const start = line.lastIndexOf(' ', cursor - 1) + 1;
      const word = line.slice(start, cursor);
      return { start, candidates: ['Documents/', 'Downloads/', 'notes.txt'].filter((c) => c.startsWith(word)) };
    };
    const t = setup({ complete });
    const tick = () => new Promise((r) => setTimeout(r, 0));
    t.ed.feed('cat no\t');
    await tick();
    expect(t.ed.line).toBe('cat notes.txt ');
    t.ed.feed('\x15ls D\t');
    await tick();
    expect(t.ed.line).toBe('ls Do');
    t.reset();
    t.ed.feed('\t');
    await tick();
    expect(t.written).toBe('\x07');
    t.ed.feed('\t');
    await tick();
    expect(t.written).toContain('Documents/  Downloads/');
    expect(t.ed.line).toBe('ls Do');
    // input typed while completion was pending is not lost
    t.ed.feed('c\t');
    t.ed.feed('X');
    await tick();
    await tick();
    expect(t.ed.line).toBe('ls Documents/X');
  });
});
