/** Pure helpers for the System Monitor — kept separate from the DOM/canvas code so they're easy to unit-test. */

/** Formats an uptime in milliseconds as "H:MM:SS" (or "M:SS" under an hour). */
export function formatUptime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export interface FsNode {
  path: string;
  type: 'file' | 'dir';
  size: number;
}

/** Sums file sizes per top-level directory under a root, from a flat recursive listing. */
export function aggregateByTopLevel(nodes: FsNode[], root: string): Map<string, number> {
  const totals = new Map<string, number>();
  const prefix = root === '/' ? '/' : root + '/';
  for (const node of nodes) {
    if (node.type !== 'file') continue;
    if (!node.path.startsWith(prefix)) continue;
    const rest = node.path.slice(prefix.length);
    const top = rest.split('/')[0];
    if (!top) continue;
    totals.set(top, (totals.get(top) ?? 0) + node.size);
  }
  return totals;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** Clamps a ratio (used for quota/usage bars) into [0, 1]. */
export function clampRatio(used: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, used / total));
}
