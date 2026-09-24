/**
 * Undo/redo for the editor — pure, generic, no DOM.
 *
 * The editor's state is one immutable project object, so history is a stack of
 * snapshots: `record(before)` is called *before* a change is applied, `undo` hands
 * back the previous snapshot and remembers the present for `redo`.
 *
 * A slider drag must be one step, not one per `input` event: the caller opens a
 * gesture with `begin(state)` (the first call wins), applies live changes freely,
 * and closes it with `commit()`. A gesture that changed nothing is dropped by
 * `commit(current)` when the snapshot equals the present.
 */
export class History<T> {
  private readonly past: T[] = [];
  private future: T[] = [];
  private pending: T | null = null;

  constructor(private readonly limit = 200, private readonly same: (a: T, b: T) => boolean = (a, b) => a === b) {}

  /** Saves `before` as an undo step and clears the redo stack. */
  record(before: T): void {
    this.pending = null;
    this.past.push(before);
    if (this.past.length > this.limit) this.past.splice(0, this.past.length - this.limit);
    this.future = [];
  }

  /** Opens a gesture: remembers the state before its first change. */
  begin(before: T): void {
    if (this.pending === null) this.pending = before;
  }

  /** Closes a gesture; nothing is recorded when the state did not change. */
  commit(current?: T): void {
    if (this.pending === null) return;
    const before = this.pending;
    this.pending = null;
    if (current !== undefined && this.same(before, current)) return;
    this.record(before);
  }

  get inGesture(): boolean {
    return this.pending !== null;
  }

  get canUndo(): boolean {
    return this.past.length > 0 || this.pending !== null;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get size(): number {
    return this.past.length;
  }

  /** The state to go back to, or null. `current` becomes the redo step. */
  undo(current: T): T | null {
    if (this.pending !== null) this.commit(current);
    const previous = this.past.pop();
    if (previous === undefined) return null;
    this.future.push(current);
    return previous;
  }

  redo(current: T): T | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(current);
    return next;
  }

  clear(): void {
    this.past.length = 0;
    this.future = [];
    this.pending = null;
  }
}
