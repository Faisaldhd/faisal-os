import { describe, it, expect } from 'vitest';
import { formatUptime, aggregateByTopLevel, formatBytes, clampRatio } from './helpers';

describe('formatUptime', () => {
  it('formats under a minute', () => {
    expect(formatUptime(5000)).toBe('0:05');
  });
  it('formats minutes and seconds under an hour', () => {
    expect(formatUptime(65_000)).toBe('1:05');
  });
  it('formats hours, minutes, seconds', () => {
    expect(formatUptime(3 * 3600_000 + 4 * 60_000 + 7_000)).toBe('3:04:07');
  });
  it('clamps negative durations to zero', () => {
    expect(formatUptime(-500)).toBe('0:00');
  });
});

describe('aggregateByTopLevel', () => {
  const root = '/';
  it('sums file sizes per top-level directory', () => {
    const nodes = [
      { path: '/home/user/a.txt', type: 'file' as const, size: 100 },
      { path: '/home/user/docs/b.txt', type: 'file' as const, size: 50 },
      { path: '/tmp/c.txt', type: 'file' as const, size: 10 },
      { path: '/home', type: 'dir' as const, size: 0 },
    ];
    const totals = aggregateByTopLevel(nodes, root);
    expect(totals.get('home')).toBe(150);
    expect(totals.get('tmp')).toBe(10);
    expect(totals.size).toBe(2);
  });

  it('respects a non-root root prefix', () => {
    const nodes = [
      { path: '/home/user/a.txt', type: 'file' as const, size: 20 },
      { path: '/home/user/sub/b.txt', type: 'file' as const, size: 30 },
      { path: '/home/other/c.txt', type: 'file' as const, size: 5 },
    ];
    const totals = aggregateByTopLevel(nodes, '/home/user');
    expect(totals.get('sub')).toBe(30);
    expect(totals.has('other')).toBe(false);
  });

  it('ignores nothing when list is empty', () => {
    expect(aggregateByTopLevel([], '/').size).toBe(0);
  });
});

describe('formatBytes', () => {
  it('formats bytes, KB, MB', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('clampRatio', () => {
  it('clamps into [0, 1]', () => {
    expect(clampRatio(50, 100)).toBe(0.5);
    expect(clampRatio(200, 100)).toBe(1);
    expect(clampRatio(-5, 100)).toBe(0);
  });
  it('returns 0 for a non-positive total', () => {
    expect(clampRatio(10, 0)).toBe(0);
  });
});
