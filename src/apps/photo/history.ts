/**
 * Photo Editor — the undo/redo history.
 *
 * MEMORY POLICY (this is the promise the UI repeats to the user):
 *  • A step is a full flattened RGBA raster of the document, so a step costs exactly
 *    `width × height × 4` bytes. The cost of the current version is NOT charged twice: the
 *    working buffer the editor displays is the same object the newest step holds.
 *  • Two independent bounds are enforced on push:
 *      1. at least `minSteps` (20) steps are always kept — the task's floor — even if that
 *         exceeds the byte budget, because lying about "20 steps of undo" is worse than the
 *         memory;
 *      2. above that floor a step is dropped once it would push the total past
 *         `maxBytes` (192 MB by default), oldest first.
 *  • `maxSteps` (60) is a hard ceiling; beyond it the oldest step is dropped even when the
 *    byte budget has room.
 *  • Nothing is ever dropped from a redo branch by the user's own undo: undoing moves the
 *    cursor, it does not trim. Pushing a NEW step while the cursor is not at the end drops
 *    the redo tail (the standard, and the only behaviour that keeps redo honest).
 *  • `trimmed` counts how many steps were dropped for memory; the UI shows it, so the user
 *    is told when old history has actually gone.
 */

export interface HistoryStep<T> {
  id: number;
  label: string;
  /** Exact bytes this step holds. */
  bytes: number;
  /**
   * The same payload, but shared instead of copied: `undo`/`redo` return it as-is, so the
   * editor can present it without cloning a full raster on every keystroke-level action.
   */
  payload: T;
}

export interface HistoryLimits {
  /** Never fewer than this many steps, whatever they cost (default 20). */
  minSteps: number;
  /** Ceiling on the number of steps (default 60). */
  maxSteps: number;
  /** Byte budget applied above `minSteps` (default 192 MB). */
  maxBytes: number;
  /** Index into `limits` below. */
  limitId?: number;
}

export const DEFAULT_LIMITS: HistoryLimits = {
  minSteps: 20,
  maxSteps: 60,
  maxBytes: 192 * 1024 * 1024,
  limitId: 0,
};

/** Alternative policies the user can switch to from the memory line in the UI. */
export const HISTORY_PRESETS: HistoryLimits[] = [
  { minSteps: 20, maxSteps: 60, maxBytes: 192 * 1024 * 1024, limitId: 0 },
  { minSteps: 20, maxSteps: 60, maxBytes: 64 * 1024 * 1024, limitId: 1 },
  { minSteps: 20, maxSteps: 60, maxBytes: 512 * 1024 * 1024, limitId: 2 },
];

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export class History<T> {
  private entries: HistoryStep<T>[] = [];
  private cursor = 0; // index of the current step
  private nextId = 1;
  private trimmedCount = 0;
  private limits: HistoryLimits;

  constructor(limits: HistoryLimits = DEFAULT_LIMITS) {
    this.limits = { ...limits };
    if (limits.limitId === undefined) {
      const match = HISTORY_PRESETS.find((p) => p.maxBytes === limits.maxBytes && p.minSteps === limits.minSteps);
      this.limits.limitId = match ? match.limitId : 0;
    }
  }

  get limitsValue(): HistoryLimits {
    return { ...this.limits };
  }

  setLimits(limits: HistoryLimits): void {
    this.limits = { ...limits };
    this.enforce();
  }

  get steps(): readonly HistoryStep<T>[] {
    return this.entries;
  }

  get index(): number {
    return this.cursor;
  }

  get trimmed(): number {
    return this.trimmedCount;
  }

  get canUndo(): boolean {
    return this.cursor > 0;
  }

  get canRedo(): boolean {
    return this.cursor < this.entries.length - 1;
  }

  /** Total bytes held by the history right now. */
  get bytes(): number {
    let sum = 0;
    for (const e of this.entries) sum += e.bytes;
    return sum;
  }

  current(): HistoryStep<T> | null {
    return this.entries[this.cursor] ?? null;
  }

  get length(): number {
    return this.entries.length;
  }

  /**
   * Records a new state. `dedupeKey` is a cheap identity for the operation that produced it
   * (e.g. "crop:0,0,100,50"); pushing the identical key twice in a row is ignored so a
   * slider that ends where it started does not cost a step.
   */
  push(label: string, payload: T, bytes: number, dedupeKey?: string): HistoryStep<T> {
    const at = this.entries[this.cursor];
    const keyed = dedupeKey !== undefined ? `${label}#${dedupeKey}` : null;
    if (at && keyed && at.label === keyed) return at;

    // A new step invalidates the redo tail.
    if (this.cursor < this.entries.length - 1) this.entries = this.entries.slice(0, this.cursor + 1);

    const step: HistoryStep<T> = {
      id: this.nextId++,
      label: keyed ?? label,
      bytes: Math.max(0, bytes),
      payload,
    };
    this.entries.push(step);
    this.cursor = this.entries.length - 1;
    this.enforce();
    return step;
  }

  /** Steps back one state, or null at the start of history. */
  undo(): T | null {
    if (!this.canUndo) return null;
    this.cursor--;
    return this.current()?.payload ?? null;
  }

  /** Steps forward one state, or null at the newest state. */
  redo(): T | null {
    if (!this.canRedo) return null;
    this.cursor++;
    return this.current()?.payload ?? null;
  }

  /** Jumps to an absolute index (the history list in the UI is clickable). */
  goTo(index: number): T | null {
    if (index < 0 || index >= this.entries.length) return null;
    this.cursor = index;
    return this.current()?.payload ?? null;
  }

  /**
   * The whole policy in one place: the count ceiling, then the byte budget, and never below
   * `minSteps`. Dropping always starts at the oldest step and never removes the current one.
   */
  private enforce(): void {
    while (this.entries.length > this.limits.maxSteps) {
      if (this.entries.length <= this.limits.minSteps) break;
      this.dropOldest();
    }
    while (this.entries.length > this.limits.minSteps && this.bytes > this.limits.maxBytes) {
      this.dropOldest();
    }
  }

  private dropOldest(): void {
    if (this.entries.length <= 1) return;
    this.entries.shift();
    if (this.cursor > 0) this.cursor--;
    this.trimmedCount++;
  }
}
