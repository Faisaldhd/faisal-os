import { describe, expect, it } from 'vitest';
import { ByteHistory } from './history';

const b = (n: number, size = 4): Uint8Array => new Uint8Array(size).fill(n);

describe('ByteHistory', () => {
  it('undoes and redoes in order, and a new edit clears redo', () => {
    const h = new ByteHistory();
    h.record(b(1));
    h.record(b(2));
    expect(h.undo(b(3))?.[0]).toBe(2);
    expect(h.undo(b(2))?.[0]).toBe(1);
    expect(h.undo(b(1))).toBeNull();
    expect(h.redo(b(1))?.[0]).toBe(2);
    expect(h.canRedo).toBe(true);
    h.record(b(9));
    expect(h.canRedo).toBe(false);
  });

  it('keeps at least 50 steps of a small document', () => {
    const h = new ByteHistory();
    for (let i = 0; i < 60; i++) h.record(b(i));
    expect(h.undoCount).toBe(60);
  });

  it('drops the oldest steps past the step and memory bounds, never the latest', () => {
    const h = new ByteHistory(3, 10);
    for (let i = 0; i < 5; i++) h.record(b(i));
    expect(h.undoCount).toBe(2);
    expect(h.undo(b(9))?.[0]).toBe(4);
    const big = new ByteHistory(10, 5);
    big.record(b(1, 100));
    expect(big.undoCount).toBe(1);
  });

  it('ignores empty buffers and clears', () => {
    const h = new ByteHistory();
    h.record(new Uint8Array(0));
    expect(h.canUndo).toBe(false);
    h.record(b(1));
    h.clear();
    expect(h.canUndo).toBe(false);
  });
});
