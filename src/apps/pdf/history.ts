/**
 * PDF app — undo/redo of the working bytes (التراجع والإعادة).
 *
 * Every operation produces a whole new, verified PDF, so a step is simply the bytes as they
 * were before it. The stack is bounded twice: by a number of steps, and by memory — a large
 * document keeps fewer steps rather than letting the window grow without limit. The oldest
 * step is dropped first. A new edit clears the redo side, as in every editor.
 */
export const HISTORY_STEPS = 100;
export const HISTORY_BYTES = 320 * 1024 * 1024;

export class ByteHistory {
  private past: Uint8Array[] = [];
  private future: Uint8Array[] = [];

  constructor(private readonly maxSteps = HISTORY_STEPS, private readonly maxBytes = HISTORY_BYTES) {}

  /** Remembers `previous` as the state an undo goes back to, and forgets the redo side. */
  record(previous: Uint8Array): void {
    if (!previous.length) return;
    this.past.push(previous);
    this.future = [];
    this.trim();
  }

  /** The bytes to show after an undo (and remembers `current` for redo), or null. */
  undo(current: Uint8Array): Uint8Array | null {
    const back = this.past.pop();
    if (!back) return null;
    if (current.length) this.future.push(current);
    return back;
  }

  redo(current: Uint8Array): Uint8Array | null {
    const next = this.future.pop();
    if (!next) return null;
    if (current.length) this.past.push(current);
    this.trim();
    return next;
  }

  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  get undoCount(): number { return this.past.length; }
  get redoCount(): number { return this.future.length; }

  clear(): void {
    this.past = [];
    this.future = [];
  }

  /** Bytes held by both sides; the same buffer counted once. */
  get bytes(): number {
    const seen = new Set<Uint8Array>();
    let total = 0;
    for (const item of [...this.past, ...this.future]) {
      if (seen.has(item)) continue;
      seen.add(item);
      total += item.length;
    }
    return total;
  }

  private trim(): void {
    while (this.past.length > this.maxSteps) this.past.shift();
    // Memory bound: drop the oldest undo steps first, but always keep the most recent one.
    while (this.past.length > 1 && this.bytes > this.maxBytes) this.past.shift();
  }
}
