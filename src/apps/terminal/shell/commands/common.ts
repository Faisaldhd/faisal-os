import type { Stat } from '../../../../kernel/types';
import type { CommandContext } from '../types';
import { C, errText, safeName } from '../util';

/** Reads each operand (or stdin when none / "-"), reporting errors like coreutils. */
export async function* inputs(
  ctx: CommandContext,
  operands: string[],
): AsyncGenerator<{ name: string; text: string } | { name: string; error: string }> {
  const list = operands.length ? operands : ['-'];
  for (const op of list) {
    if (op === '-') { yield { name: '(standard input)', text: ctx.stdin ?? '' }; continue; }
    const path = ctx.shell.resolve(op);
    try {
      const st = await ctx.shell.vfs.stat(path);
      if (st.type === 'dir') { yield { name: op, error: 'Is a directory' }; continue; }
      yield { name: op, text: await ctx.shell.vfs.readText(path) };
    } catch (e) {
      yield { name: op, error: errText(e) };
    }
  }
}

export async function tryStat(ctx: CommandContext, path: string): Promise<Stat | null> {
  try { return await ctx.shell.vfs.stat(path); } catch { return null; }
}

export function ownerOf(path: string, home: string): string {
  return path === home || path.startsWith(home + '/') || path.startsWith('/tmp/') ? 'user' : 'root';
}

const ARCHIVE = /\.(zip|tar|gz|tgz|xz|bz2|7z|rar|rpm|deb|zst|iso)$/i;
const IMAGE = /\.(png|jpe?g|gif|svg|webp|bmp|ico|avif)$/i;
const MEDIA = /\.(mp3|ogg|wav|flac|mp4|webm|mkv|avi|mov|m4a)$/i;

/** Colors a file name the way `ls --color` does (only on a tty). */
export function colorName(st: Pick<Stat, 'type' | 'mode' | 'name'>, shown: string, tty: boolean): string {
  const name = safeName(shown);
  if (!tty) return name;
  if (st.type === 'dir') return C.boldBlue + name + C.reset;
  if (st.mode & 0o111) return C.boldGreen + name + C.reset;
  if (ARCHIVE.test(st.name)) return C.boldRed + name + C.reset;
  if (IMAGE.test(st.name)) return C.boldMagenta + name + C.reset;
  if (MEDIA.test(st.name)) return C.cyan + name + C.reset;
  return name;
}

export function usageError(ctx: CommandContext, msg: string, usage?: string): number {
  ctx.err(`${ctx.name}: ${msg}\n`);
  ctx.err(usage ? `Usage: ${usage}\n` : `Try '${ctx.name} --help' for more information.\n`);
  return 2;
}

/** Recursively walks a directory (depth-first, sorted). */
export async function* walk(ctx: CommandContext, root: string, maxDepth = Infinity, depth = 0): AsyncGenerator<{ path: string; st: Stat; depth: number }> {
  if (ctx.signal.cancelled) return;
  let entries: Stat[];
  try { entries = await ctx.shell.vfs.readdir(root); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  for (const e of entries) {
    const path = root === '/' ? `/${e.name}` : `${root}/${e.name}`;
    yield { path, st: e, depth: depth + 1 };
    if (e.type === 'dir' && depth + 1 < maxDepth) yield* walk(ctx, path, maxDepth, depth + 1);
  }
}

export async function treeSize(ctx: CommandContext, path: string): Promise<number> {
  const st = await ctx.shell.vfs.stat(path);
  if (st.type === 'file') return st.size;
  let total = 0;
  for await (const e of walk(ctx, path)) if (e.st.type === 'file') total += e.st.size;
  return total;
}
