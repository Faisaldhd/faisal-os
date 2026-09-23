/** أدوات مسارات POSIX مشتركة. */

export function normalize(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return '/' + parts.join('/');
}

/** يحلّ مساراً نسبياً مقابل cwd، ويدعم ~ كاختصار لـ home. */
export function resolve(cwd: string, p: string, home = '/home/user'): string {
  if (p === '~' || p.startsWith('~/')) p = home + p.slice(1);
  return normalize(p.startsWith('/') ? p : `${cwd}/${p}`);
}

export function dirname(p: string): string {
  const n = normalize(p);
  const i = n.lastIndexOf('/');
  return i <= 0 ? '/' : n.slice(0, i);
}

export function basename(p: string): string {
  const n = normalize(p);
  return n === '/' ? '/' : n.slice(n.lastIndexOf('/') + 1);
}

export function join(...parts: string[]): string {
  return normalize(parts.join('/'));
}
