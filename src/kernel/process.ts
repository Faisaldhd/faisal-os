/**
 * جدول العمليات — Process table.
 *
 * Fai$al OS has no real processes: an app is an ES module in the same JavaScript realm and a
 * window is a DOM node. This module gives them the shape a user and the tools expect — a PID, a
 * name, a state, a start time and an exit status — driven by the lifecycle events the kernel
 * already emits (`app:launched` / `app:closed`, plus `window:change` for minimizing), so nothing
 * else in the tree had to change to make it real.
 *
 * Signal semantics mirror the desktop, and deliberately reuse the window contract:
 *   SIGTERM → `requestClose()`: the app's close guard runs first and may refuse, exactly like a
 *             process that catches the signal.
 *   SIGKILL → `close()`: unconditional, like a process that cannot refuse.
 * Exit status follows the shell convention: 0 for a normal close, 128 + signal otherwise.
 */
import type { EventBus, ProcessInfo, ProcessSignal, ProcessTable, Unsubscribe } from './types';

/** Ended processes kept for `ps -a`, newest first. */
const RECENT_LIMIT = 16;

/** 128 + signal number, the code a shell reports for a signalled process. */
const EXIT_TERM = 128 + 15;
const EXIT_KILL = 128 + 9;

export interface ProcessTableOptions {
  /** SIGTERM: the polite close that lets an app keep unsaved work. */
  requestClose(windowId: string): void;
  /** SIGKILL: the unconditional close. */
  killClose(windowId: string): void;
  /** True while the window is minimized, so its process reads as sleeping. */
  isMinimized(windowId: string): boolean;
  /** Injected by the tests. */
  now?(): number;
}

export function createProcessTable(bus: EventBus, opts: ProcessTableOptions): ProcessTable {
  const now = opts.now ?? (() => Date.now());
  const live = new Map<number, ProcessInfo>();
  const recent: ProcessInfo[] = [];
  /** windowId → pid, so window events can find their process. */
  const byWindow = new Map<string, number>();
  /** windowId → the signal that asked for this close, so the exit code can say why. */
  const pending = new Map<string, ProcessSignal>();
  const listeners = new Set<() => void>();
  let nextPid = 1;

  const changed = () => { for (const cb of listeners) cb(); };

  const spawn = (appId: string, windowId: string, name: string, system = false): ProcessInfo => {
    const info: ProcessInfo = { pid: nextPid, appId, windowId, name, state: 'running', startedAt: now(), system };
    nextPid += 1;
    live.set(info.pid, info);
    if (windowId) byWindow.set(windowId, info.pid);
    changed();
    return info;
  };

  // PID 1 and 2 are the system itself. They exist from boot and refuse signals, like init does.
  spawn('init', '', 'Fai$al OS', true);
  spawn('faisal-shell', '', 'Desktop shell', true);

  const offLaunched = bus.on('app:launched', ({ appId, windowId }) => {
    if (byWindow.has(windowId)) return; // a window that only changed app: never a second PID
    spawn(appId, windowId, appId);
  });

  const offClosed = bus.on('app:closed', ({ windowId }) => {
    const pid = byWindow.get(windowId);
    if (pid === undefined) return;
    const info = live.get(pid);
    byWindow.delete(windowId);
    const signal = pending.get(windowId);
    pending.delete(windowId);
    if (!info) return;
    live.delete(pid);
    recent.unshift({
      ...info,
      state: 'exited',
      exit: { code: signal === 'KILL' ? EXIT_KILL : signal === 'TERM' ? EXIT_TERM : 0, signal, at: now() },
    });
    if (recent.length > RECENT_LIMIT) recent.length = RECENT_LIMIT;
    changed();
  });

  const offWindow = bus.on('window:change', ({ windowId }) => {
    const pid = byWindow.get(windowId);
    const info = pid === undefined ? undefined : live.get(pid);
    if (!info) return;
    const state = opts.isMinimized(windowId) ? 'sleeping' : 'running';
    if (info.state === state) return;
    info.state = state;
    changed();
  });

  const byPid = (a: ProcessInfo, b: ProcessInfo) => a.pid - b.pid;

  return {
    list: () => [...live.values()].sort(byPid),
    recent: () => [...recent],
    all: () => [...live.values()].sort(byPid).concat(recent),
    get: (pid) => live.get(pid),

    signal(pid, signal) {
      const info = live.get(pid);
      if (!info) return 1;          // ESRCH — no such process
      if (info.system) return 1;    // EPERM — the kernel's own processes
      pending.set(info.windowId, signal);
      if (signal === 'KILL') opts.killClose(info.windowId);
      else opts.requestClose(info.windowId);
      return 0;
    },

    on(cb: () => void): Unsubscribe {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },

    dispose() {
      offLaunched();
      offClosed();
      offWindow();
      listeners.clear();
    },
  };
}
