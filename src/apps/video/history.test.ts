import { describe, expect, it } from 'vitest';
import { History } from './history';

describe('History', () => {
  it('undoes and redoes snapshots in order', () => {
    const h = new History<number>();
    h.record(1);
    h.record(2);
    expect(h.undo(3)).toBe(2);
    expect(h.undo(2)).toBe(1);
    expect(h.undo(1)).toBeNull();
    expect(h.redo(1)).toBe(2);
    expect(h.redo(2)).toBe(3);
    expect(h.canRedo).toBe(false);
  });

  it('clears redo when a new change is recorded', () => {
    const h = new History<number>();
    h.record(1);
    h.undo(2);
    h.record(1);
    expect(h.canRedo).toBe(false);
  });

  it('keeps at least 100 steps and drops the oldest past the limit', () => {
    const h = new History<number>(150);
    for (let i = 0; i < 200; i++) h.record(i);
    expect(h.size).toBe(150);
    let state = 200;
    let steps = 0;
    for (;;) {
      const prev = h.undo(state);
      if (prev === null) break;
      state = prev;
      steps++;
    }
    expect(steps).toBe(150);
    expect(state).toBe(50);
  });

  it('turns a gesture (slider drag) into one step', () => {
    const h = new History<number>();
    h.begin(1);
    h.begin(2);
    h.begin(3);
    h.commit(4);
    expect(h.size).toBe(1);
    expect(h.undo(4)).toBe(1);
  });

  it('drops a gesture that changed nothing', () => {
    const h = new History<number>();
    h.begin(5);
    h.commit(5);
    expect(h.canUndo).toBe(false);
  });

  it('closes an open gesture before undoing it', () => {
    const h = new History<number>();
    h.begin(1);
    expect(h.inGesture).toBe(true);
    expect(h.undo(9)).toBe(1);
    expect(h.inGesture).toBe(false);
  });
});
