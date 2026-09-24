/**
 * The process table: PIDs, states, exit codes and signals.
 *
 * Everything here is driven by the bus events the kernel already emits, so the kernel needed no
 * new plumbing — which is exactly what the test pins down.
 */
import { describe, it, expect, vi } from 'vitest';
import { createBus } from './bus';
import { createProcessTable, type ProcessTableOptions } from './process';
import type { EventBus, ProcessTable } from './types';

function setup(overrides: Partial<ProcessTableOptions> = {}) {
  const bus = createBus();
  const calls = { request: [] as string[], kill: [] as string[] };
  const minimized = new Set<string>();
  /** Windows the fake window manager still has open: a refused SIGTERM leaves one here. */
  const open = new Set<string>();
  let refuseNextClose = false;
  const opts: ProcessTableOptions = {
    requestClose: (id) => { calls.request.push(id); if (!refuseNextClose) open.delete(id); },
    killClose: (id) => { calls.kill.push(id); open.delete(id); },
    isMinimized: (id) => minimized.has(id),
    isAlive: (id) => open.has(id),
    now: () => 1000,
    ...overrides,
  };
  const proc = createProcessTable(bus, opts);
  const launch = (appId: string, windowId: string) => { open.add(windowId); bus.emit('app:launched', { appId, windowId }); };
  const closed = (appId: string, windowId: string) => { open.delete(windowId); bus.emit('app:closed', { appId, windowId }); };
  const refuseNext = () => { refuseNextClose = true; };
  return { bus, proc, calls, minimized, open, launch, closed, refuseNext };
}

describe('process table', () => {
  it('starts with the system itself, as PID 1 and 2', () => {
    const { proc } = setup();
    const list = proc.list();
    expect(list.map((p) => p.pid)).toEqual([1, 2]);
    expect(list.map((p) => p.appId)).toEqual(['init', 'faisal-shell']);
    expect(list.every((p) => p.system && p.state === 'running')).toBe(true);
  });

  it('gives every launched window its own increasing PID', () => {
    const { proc, launch } = setup();
    launch('org.faisal.Files', 'w1');
    launch('org.faisal.Editor', 'w2');
    const list = proc.list();
    expect(list.map((p) => p.pid)).toEqual([1, 2, 3, 4]);
    expect(list.map((p) => p.windowId)).toEqual(['', '', 'w1', 'w2']);
    expect(proc.get(3)?.appId).toBe('org.faisal.Files');
  });

  it('never spawns a second PID for the same window', () => {
    const { proc, launch } = setup();
    launch('org.faisal.Files', 'w1');
    launch('org.faisal.Files', 'w1');
    expect(proc.list()).toHaveLength(3);
  });

  it('ends a process with exit 0 when its window closes normally', () => {
    const { proc, launch, closed } = setup();
    launch('org.faisal.Files', 'w1');
    closed('org.faisal.Files', 'w1');
    expect(proc.list().map((p) => p.pid)).toEqual([1, 2]);
    const ended = proc.recent();
    expect(ended).toHaveLength(1);
    expect(ended[0].state).toBe('exited');
    expect(ended[0].exit).toEqual({ code: 0, signal: undefined, at: 1000 });
  });

  it('keeps ended processes out of list() but in all(), newest first', () => {
    const { proc, launch, closed } = setup();
    launch('org.faisal.Files', 'w1');
    launch('org.faisal.Editor', 'w2');
    closed('org.faisal.Files', 'w1');
    closed('org.faisal.Editor', 'w2');
    expect(proc.list()).toHaveLength(2);
    expect(proc.recent().map((p) => p.windowId)).toEqual(['w2', 'w1']);
    expect(proc.all().map((p) => p.pid)).toEqual([1, 2, 4, 3]);
  });

  it('SIGTERM asks nicely, and the app may keep the window', () => {
    const { proc, launch, calls } = setup();
    launch('org.faisal.Editor', 'w1');
    expect(proc.signal(3, 'TERM')).toBe(0);
    expect(calls.request).toEqual(['w1']);
    expect(calls.kill).toEqual([]);
    // The app refused to close: the process is still alive, and that is not an error.
    expect(proc.list()).toHaveLength(3);
    expect(proc.recent()).toHaveLength(0);
  });

  it('SIGKILL closes unconditionally and reports 137', () => {
    const { proc, launch, closed, calls } = setup();
    launch('org.faisal.Editor', 'w1');
    expect(proc.signal(3, 'KILL')).toBe(0);
    expect(calls.kill).toEqual(['w1']);
    closed('org.faisal.Editor', 'w1');
    expect(proc.recent()[0].exit).toEqual({ code: 137, signal: 'KILL', at: 1000 });
  });

  it('reports 143 when a SIGTERM actually ends the process', () => {
    const { proc, launch, closed } = setup();
    launch('org.faisal.Editor', 'w1');
    proc.signal(3, 'TERM');
    closed('org.faisal.Editor', 'w1');
    expect(proc.recent()[0].exit).toEqual({ code: 143, signal: 'TERM', at: 1000 });
  });

  it('refuses to signal the system and unknown PIDs', () => {
    const { proc, launch, closed } = setup();
    expect(proc.signal(1, 'KILL')).toBe(1);
    expect(proc.signal(999, 'TERM')).toBe(1);
    launch('org.faisal.Files', 'w1');
    closed('org.faisal.Files', 'w1');
    expect(proc.signal(3, 'KILL')).toBe(1); // already gone
  });

  it('does not let one window reuse another window exit signal', () => {
    const { proc, launch, closed } = setup();
    launch('org.faisal.Files', 'w1');
    launch('org.faisal.Editor', 'w2');
    proc.signal(3, 'KILL');
    closed('org.faisal.Files', 'w1');
    closed('org.faisal.Editor', 'w2');
    expect(proc.recent().map((p) => [p.windowId, p.exit?.code])).toEqual([['w2', 0], ['w1', 137]]);
  });

  it('reads a minimized window as sleeping, and waking it back', () => {
    const { bus, proc, launch, minimized } = setup();
    launch('org.faisal.Files', 'w1');
    minimized.add('w1');
    bus.emit('window:change', { windowId: 'w1' });
    expect(proc.get(3)?.state).toBe('sleeping');
    minimized.delete('w1');
    bus.emit('window:change', { windowId: 'w1' });
    expect(proc.get(3)?.state).toBe('running');
  });

  it('notifies subscribers on every change, and stops after dispose', () => {
    const { bus, proc, launch } = setup();
    const seen = vi.fn();
    const off = proc.on(seen);
    launch('org.faisal.Files', 'w1');
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    launch('org.faisal.Editor', 'w2');
    expect(seen).toHaveBeenCalledTimes(1);
    proc.dispose();
    bus.emit('app:launched', { appId: 'x', windowId: 'w3' });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('keeps the ended list bounded', () => {
    const { proc, launch, closed } = setup();
    for (let i = 0; i < 25; i += 1) {
      launch('org.faisal.Files', `w${i}`);
      closed('org.faisal.Files', `w${i}`);
    }
    expect(proc.recent()).toHaveLength(16);
    expect(proc.recent()[0].windowId).toBe('w24');
  });

  it('forgets a SIGTERM the app refused, so a later normal close reports 0', async () => {
    const { proc, launch, closed, refuseNext } = setup();
    launch('org.faisal.Editor', 'w1');
    refuseNext(); // the editor says "unsaved changes" and keeps the window
    expect(proc.signal(3, 'TERM')).toBe(0);
    await Promise.resolve(); // the guard's answer arrives as a microtask
    expect(proc.list()).toHaveLength(3);
    closed('org.faisal.Editor', 'w1');
    expect(proc.recent()[0].exit).toEqual({ code: 0, signal: undefined, at: 1000 });
  });

  it('never holds a process for a window that closed while its app was still loading', () => {
    const { proc, closed, launch } = setup();
    closed('org.faisal.Office', 'w-loading'); // closed before its chunk finished loading
    launch('org.faisal.Office', 'w-loading'); // the late event must not resurrect it
    expect(proc.list().map((p) => p.pid)).toEqual([1, 2]);
    expect(proc.recent()).toHaveLength(0);
  });
});
