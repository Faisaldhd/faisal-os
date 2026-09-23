import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemAPI } from '../../kernel/types';
import { createMemVFS } from '../terminal/__tests__/memvfs';
import { Shell } from '../terminal/shell/shell';
import { createToolBox, isReadOnlyCommand, stripAnsi } from './tools';
import type { ConfirmFn, ToolBox } from './agent';

let vfs: ReturnType<typeof createMemVFS>;
let settings: Map<string, unknown>;
let notified: [string, string | undefined][];
let locale: 'ar' | 'en';
let box: ToolBox;

const call = (name: string, args: unknown = {}) => ({ id: 'c1', name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });
const yes: ConfirmFn = async () => true;
const no: ConfirmFn = async () => false;

beforeEach(() => {
  vfs = createMemVFS({
    '/home/user/notes.txt': 'hello\n',
    '/home/user/Documents/report.md': '# Report\n',
    '/home/user/Pictures/': '',
    '/tmp/': '',
  });
  settings = new Map();
  notified = [];
  locale = 'en';
  const sys = {
    vfs,
    locale: () => locale,
    notify: (t: string, b?: string) => { notified.push([t, b]); },
    settings: { get: (k: string, d: unknown) => settings.get(k) ?? d, set: (k: string, v: unknown) => { settings.set(k, v); } },
    apps: {
      list: () => [{ id: 'org.faisal.Files', name: { en: 'Files', ar: 'الملفات' } }],
      catalog: () => [{ id: 'org.faisal.Files', name: { en: 'Files', ar: 'الملفات' } }],
      running: () => [],
      appForFile: () => undefined,
      launch: vi.fn(async () => ({ id: 'w1' })),
    },
    wm: { list: () => [], get: () => undefined, focused: () => undefined, isMinimized: () => false },
  } as unknown as SystemAPI;
  box = createToolBox(sys, { shell: new Shell({ vfs, home: '/home/user', host: { open: async () => true, listApps: () => [] } as never }) });
});

describe('isReadOnlyCommand', () => {
  it.each([
    ['ls -la', true], ['cat notes.txt | grep a', true], ['cd Documents && pwd', true], ['find . -name x', true],
    ['rm notes.txt', false], ['echo hi > f', false], ['find . -delete', false], ['echo $(rm x)', false],
    ['sort -o out f', false], ['ls; rm x', false], ['cat f | tee g', false], ['sleep 1 &', false], ['', false],
  ])('%s → %s', (cmd, ok) => expect(isReadOnlyCommand(cmd)).toBe(ok));
});

describe('toolbox', () => {
  it('reads without asking', async () => {
    const confirm = vi.fn(yes);
    expect(await box.execute(call('read_file', { path: 'notes.txt' }), confirm)).toBe('hello\n');
    expect(await box.execute(call('list_directory', {}), confirm)).toMatch(/Documents\/[\s\S]*notes\.txt/);
    expect(await box.execute(call('search_files', { query: 'REPORT' }), confirm)).toContain('/home/user/Documents/report.md');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('writes only after confirmation; overwriting is dangerous', async () => {
    const confirm = vi.fn(no);
    expect(await box.execute(call('write_file', { path: 'notes.txt', content: 'x' }), confirm)).toMatch(/declined/);
    expect(confirm.mock.calls[0][0].danger).toBe(true);
    expect(await vfs.readText('/home/user/notes.txt')).toBe('hello\n');

    expect(await box.execute(call('write_file', { path: 'new.txt', content: 'hi' }), yes)).toMatch(/^Created/);
    expect(await vfs.readText('/home/user/new.txt')).toBe('hi');
    await box.execute(call('write_file', { path: 'new.txt', content: '!', append: true }), yes);
    expect(await vfs.readText('/home/user/new.txt')).toBe('hi!');
  });

  it('refuses to delete protected folders and deletes after confirmation', async () => {
    const confirm = vi.fn(yes);
    expect(await box.execute(call('delete', { path: '/home/user' }), confirm)).toMatch(/refusing/);
    expect(confirm).not.toHaveBeenCalled();
    expect(await box.execute(call('delete', { path: 'Documents' }), confirm)).toMatch(/^Deleted folder/);
    expect(confirm.mock.calls[0][0].danger).toBe(true);
    await expect(vfs.stat('/home/user/Documents')).rejects.toThrow();
  });

  it('moves into an existing folder and never overwrites', async () => {
    expect(await box.execute(call('move', { from: 'notes.txt', to: 'Pictures' }), yes)).toContain('/home/user/Pictures/notes.txt');
    expect(await box.execute(call('copy', { from: 'Pictures/notes.txt', to: 'Documents/report.md' }), yes)).toMatch(/EEXIST/);
  });

  it('runs read-only commands directly and asks for the rest', async () => {
    const confirm = vi.fn(yes);
    expect(await box.execute(call('run_command', { command: 'cat notes.txt' }), confirm)).toBe('hello\n[exit status 0]');
    expect(confirm).not.toHaveBeenCalled();
    expect(await box.execute(call('run_command', { command: 'rm notes.txt' }), no)).toMatch(/declined/);
    expect(await vfs.readText('/home/user/notes.txt')).toBe('hello\n');
    expect(box.preview(call('run_command', { command: 'rm notes.txt' })).confirm?.danger).toBe(true);
  });

  it('changes settings after confirmation and validates values', async () => {
    expect(await box.execute(call('set_theme', { mode: 'dark' }), yes)).toBe('Theme set to dark.');
    expect(settings.get('theme')).toBe('dark');
    expect(await box.execute(call('set_theme', { mode: 'pink' }), yes)).toMatch(/must be one of/);
  });

  it('opens apps and sends notifications', async () => {
    expect(await box.execute(call('open_app', { app_id: 'org.faisal.Files', path: 'Documents' }), no)).toMatch(/Opened Files/);
    expect(await box.execute(call('open_app', { app_id: 'nope' }), no)).toMatch(/unknown app id/);
    await box.execute(call('notify', { title: 'Hi', body: 'there' }), no);
    expect(notified).toEqual([['Hi', 'there']]);
  });

  it('turns bad input into text, never throws', async () => {
    expect(await box.execute(call('read_file', '{oops'), yes)).toMatch(/not a valid JSON/);
    expect(await box.execute(call('format_disk'), yes)).toMatch(/unknown tool/);
    expect(await box.execute(call('read_file', { path: 'missing.txt' }), yes)).toMatch(/ENOENT/);
    expect(box.preview(call('delete', '{oops')).confirm?.danger).toBe(true);
  });

  it('previews in Arabic with isolated paths', () => {
    locale = 'ar';
    const p = box.preview(call('delete', { path: 'notes.txt' }));
    expect(p.label).toBe('يحذف ⁦/home/user/notes.txt⁩');
    expect(p.confirm?.title).toBe('حذف نهائي؟');
    expect(box.preview(call('read_file', { path: 'a' })).confirm).toBeUndefined();
  });

  it('strips terminal colours', () => {
    expect(stripAnsi('\x1b[1;32mok\x1b[0m')).toBe('ok');
  });
});
