/**
 * Readiness marks (زمن الجاهزية) — when each phase of "open this video" happens.
 *
 * Opening one file is not one event. The bytes are read from the VFS, the element is handed a
 * blob URL, it reports its metadata, the duration is resolved, the filmstrip seeks the decoder
 * a dozen times, the waveform decodes the whole audio track, and only then does the engine park
 * an element on the first frame. The owner's number ("17.4 s to a playable video") is the end of
 * that chain, and guessing which link costs the seconds is how a wrong fix gets written: this
 * module records the boundaries so the answer is measured, not argued.
 *
 * Nothing here decides anything. Every entry is a timestamp in memory, the app never reads it,
 * and a measurement harness reads it from the page:
 *
 *   window.__faisalVideoPerf.report()
 *
 * Deliberately free of DOM, timers and policy: `perf.test.ts` drives it with a fake clock, and
 * a phase that is never marked simply does not appear.
 */

export type PerfKind = 'mark' | 'span';

export interface PerfEntry {
  phase: string;
  kind: PerfKind;
  /** Milliseconds from the start of the current session. */
  at: number;
  /** The wait this entry measured: 0 for a mark, the elapsed span otherwise. */
  ms: number;
  note?: string;
}

export interface PerfSpanSummary {
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface PerfReport {
  label: string;
  /** Milliseconds from the start of the session to the last entry recorded. */
  totalMs: number;
  entries: PerfEntry[];
  /** phase → how often it ran and what it cost in total, so 12 thumbnails read as one line. */
  spans: Record<string, PerfSpanSummary>;
}

/**
 * The clock is injectable so a test can drive time instead of waiting for it. `performance.now()`
 * is monotonic and unaffected by wall-clock changes; `Date.now()` is only the fallback for an
 * environment without it (a bare node test runner, not the browser).
 */
let clock: () => number = () =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();

/** Test seam: replaces the clock, returns the previous one. */
export function setPerfClock(next: () => number): () => number {
  const previous = clock;
  clock = next;
  return previous;
}

let label = '';
let startedAt = 0;
let entries: PerfEntry[] = [];
/** Rounded to microseconds: float noise in a bug report helps nobody. */
const round = (ms: number) => Math.round(ms * 1000) / 1000;

/** Starts a new session: the timeline every later `at` is measured from. */
export function perfBegin(nextLabel = 'open'): void {
  label = nextLabel;
  startedAt = clock();
  entries = [];
}

export function perfReset(): void {
  label = '';
  startedAt = 0;
  entries = [];
}

/** Records an instant (an event fired, a state was reached). */
export function perfMark(phase: string, note?: string): PerfEntry {
  const entry: PerfEntry = { phase, kind: 'mark', at: round(clock() - startedAt), ms: 0 };
  if (note !== undefined) entry.note = note;
  entries.push(entry);
  return entry;
}

/**
 * Starts a span and returns the function that closes it. The returned function reports the
 * elapsed milliseconds and is safe to call more than once: only the first call records, and a
 * later call returns the number that was recorded rather than re-reading the clock (a `finally`
 * block that closes a span the happy path already closed must not invent a longer wait).
 */
export function perfSpan(phase: string, note?: string): (endNote?: string) => number {
  const from = clock();
  let recorded = 0;
  let closed = false;
  return (endNote?: string): number => {
    if (closed) return recorded;
    recorded = round(clock() - from);
    closed = true;
    const entry: PerfEntry = { phase, kind: 'span', at: round(from - startedAt), ms: recorded };
    const text = endNote ?? note;
    if (text !== undefined) entry.note = text;
    entries.push(entry);
    return recorded;
  };
}

export function perfReport(): PerfReport {
  const spans: Record<string, PerfSpanSummary> = {};
  for (const entry of entries) {
    if (entry.kind !== 'span') continue;
    const bucket = spans[entry.phase] ?? { count: 0, totalMs: 0, maxMs: 0 };
    bucket.count += 1;
    bucket.totalMs = round(bucket.totalMs + entry.ms);
    bucket.maxMs = Math.max(bucket.maxMs, entry.ms);
    spans[entry.phase] = bucket;
  }
  const last = entries.length > 0 ? entries[entries.length - 1].at + entries[entries.length - 1].ms : 0;
  return { label, totalMs: round(Math.max(last, entries.length > 0 ? clock() - startedAt : 0)), entries: [...entries], spans };
}

export interface PerfHandle {
  begin(label?: string): void;
  mark(phase: string, note?: string): void;
  span(phase: string, note?: string): (endNote?: string) => number;
  report(): PerfReport;
  reset(): void;
}

/**
 * The harness reads `window.__faisalVideoPerf`; the app itself never does. Installed on import
 * so the handle exists before the first video is opened, and inert everywhere else.
 */
export function installPerfHandle(target: object = globalThis): PerfHandle {
  const handle: PerfHandle = {
    begin: (l?: string) => perfBegin(l),
    mark: (phase: string, note?: string) => { perfMark(phase, note); },
    span: (phase: string, note?: string) => perfSpan(phase, note),
    report: () => perfReport(),
    reset: () => perfReset(),
  };
  (target as { __faisalVideoPerf?: PerfHandle }).__faisalVideoPerf = handle;
  return handle;
}

installPerfHandle();
