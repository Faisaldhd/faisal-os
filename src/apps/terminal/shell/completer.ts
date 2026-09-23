import type { CompletionResult } from './lineeditor';
import type { ShellLike } from './types';

const escapeWord = (s: string) => s.replace(/([\s'"\\$&;|<>()*?[\]#!`])/g, '\\$1');

/** Tab completion for commands, paths and $VARIABLES. `cursor` is a code-point index. */
export async function complete(shell: ShellLike, line: string, cursor: number): Promise<CompletionResult> {
  const chars = Array.from(line);
  let start = cursor;
  while (start > 0) {
    const c = chars[start - 1];
    if (/[\s;|&<>]/.test(c) && chars[start - 2] !== '\\') break;
    start--;
  }
  const word = chars.slice(start, cursor).join('');
  const before = chars.slice(0, start).join('').trimEnd();
  const commandPos = before === '' || /(\|\||&&|[;|&])$/.test(before) || /(^|[;|&]\s*)(sudo|which|type|help)$/.test(before);

  if (word.startsWith('$')) {
    const q = word.slice(1);
    const names = [...shell.env.keys(), 'PWD', 'RANDOM'].filter((n, i, a) => n.startsWith(q) && a.indexOf(n) === i).sort();
    return { start, candidates: names.map((n) => '$' + n) };
  }

  if (commandPos && !word.includes('/')) {
    const names = shell.commandNames().filter((n) => n.startsWith(word) && n !== '.');
    return { start, candidates: [...new Set(names)] };
  }

  // path completion (unescape what the user typed)
  const raw = word.replace(/\\(.)/g, '$1');
  const slash = raw.lastIndexOf('/');
  const dirPart = slash >= 0 ? raw.slice(0, slash + 1) : '';
  const base = slash >= 0 ? raw.slice(slash + 1) : raw;
  const dirPath = shell.resolve(dirPart || '.');
  let entries;
  try { entries = await shell.vfs.readdir(dirPath); } catch { return { start, candidates: [] }; }
  const matches = entries
    .filter((e) => e.name.startsWith(base) && (base.startsWith('.') || !e.name.startsWith('.')))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return {
    start,
    candidates: matches.map((e) => escapeWord(dirPart) + escapeWord(e.name) + (e.type === 'dir' ? '/' : '')),
    display: matches.map((e) => e.name + (e.type === 'dir' ? '/' : '')),
  };
}
