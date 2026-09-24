import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, HISTORY_PRESETS, History, formatBytes } from './history';

/** A stand-in payload with an explicit byte cost, so the policy can be driven exactly. */
interface Snap { id: number }

const MB = 1024 * 1024;

function pushN(history: History<Snap>, count: number, bytes = 100): void {
  for (let i = 0; i < count; i++) history.push(`step ${i}`, { id: i }, bytes);
}

describe('history — push, undo, redo', () => {
  it('starts empty with nothing to undo or redo', () => {
    const h = new History<Snap>();
    expect(h.length).toBe(0);
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
    expect(h.undo()).toBeNull();
    expect(h.redo()).toBeNull();
    expect(h.current()).toBeNull();
  });

  it('walks back and forward through the recorded states', () => {
    const h = new History<Snap>();
    pushN(h, 3);
    expect(h.index).toBe(2);
    expect(h.undo()?.id).toBe(1);
    expect(h.undo()?.id).toBe(0);
    expect(h.canUndo).toBe(false);
    expect(h.undo()).toBeNull();
    expect(h.canRedo).toBe(true);
    expect(h.redo()?.id).toBe(1);
    expect(h.redo()?.id).toBe(2);
    expect(h.redo()).toBeNull();
  });

  it('drops the redo tail when a new step is pushed after an undo', () => {
    const h = new History<Snap>();
    pushN(h, 4);
    h.undo();
    h.undo();
    expect(h.length).toBe(4);
    h.push('branch', { id: 99 }, 100);
    expect(h.length).toBe(3);
    expect(h.current()?.payload.id).toBe(99);
    expect(h.canRedo).toBe(false);
    expect(h.steps.map((s) => s.payload.id)).toEqual([0, 1, 99]);
  });

  it('ignores a repeated identical dedupe key, so a slider that returns to its start costs nothing', () => {
    const h = new History<Snap>();
    h.push('crop', { id: 1 }, 10, '0,0,10,10');
    h.push('crop', { id: 2 }, 10, '0,0,10,10'); // identical operation: not recorded
    expect(h.length).toBe(1);
    expect(h.current()?.payload.id).toBe(1);
    h.push('crop', { id: 3 }, 10, '0,0,5,5');   // a different crop IS recorded
    expect(h.length).toBe(2);
    expect(h.current()?.payload.id).toBe(3);
  });

  it('goTo jumps to an absolute index and refuses an out-of-range one', () => {
    const h = new History<Snap>();
    pushN(h, 4);
    expect(h.goTo(1)?.id).toBe(1);
    expect(h.index).toBe(1);
    expect(h.goTo(99)).toBeNull();
    expect(h.goTo(-1)).toBeNull();
    expect(h.index).toBe(1);
  });
});

describe('history — the memory policy', () => {
  it('always keeps at least 20 steps even when the byte budget cannot pay for them', () => {
    const h = new History<Snap>({ minSteps: 20, maxSteps: 60, maxBytes: 1000, limitId: 0 });
    pushN(h, 25, 500); // 25 × 500 = 12.5 KB against a 1 KB budget
    expect(h.length).toBe(20);
    expect(h.bytes).toBe(20 * 500);
    expect(h.trimmed).toBe(5);
    expect(h.current()?.payload.id).toBe(24);
  });

  it('drops the OLDEST steps above the floor once the byte budget is exceeded', () => {
    const h = new History<Snap>({ minSteps: 20, maxSteps: 60, maxBytes: 30 * 100, limitId: 0 });
    pushN(h, 20, 100); // exactly at the floor, 2000 bytes
    expect(h.length).toBe(20);
    for (let i = 20; i < 35; i++) h.push(`step ${i}`, { id: i }, 100); // 35 steps, 3500 bytes
    expect(h.length).toBe(30);
    expect(h.bytes).toBe(3000);
    expect(h.steps[0].payload.id).toBe(5);
    expect(h.current()?.payload.id).toBe(34);
    expect(h.trimmed).toBe(5);
  });

  it('enforces the hard step ceiling even when the budget has room', () => {
    const h = new History<Snap>({ minSteps: 20, maxSteps: 25, maxBytes: Number.MAX_SAFE_INTEGER, limitId: 0 });
    pushN(h, 40, 1);
    expect(h.length).toBe(25);
    expect(h.steps[0].payload.id).toBe(15);
    expect(h.current()?.payload.id).toBe(39);
    expect(h.trimmed).toBe(15);
  });

  it('never drops the current state and never empties the stack', () => {
    const h = new History<Snap>({ minSteps: 1, maxSteps: 1, maxBytes: 0, limitId: 0 });
    pushN(h, 5, 10);
    expect(h.length).toBe(1);
    expect(h.current()?.payload.id).toBe(4);
    expect(h.canUndo).toBe(false);
  });

  it('keeps the cursor pointing at the same state after trimming', () => {
    const h = new History<Snap>({ minSteps: 20, maxSteps: 25, maxBytes: Number.MAX_SAFE_INTEGER, limitId: 0 });
    pushN(h, 30, 1);
    h.undo();
    h.undo();
    const before = h.current()?.payload.id;
    h.push('new', { id: 500 }, 1);
    expect(h.current()?.payload.id).toBe(500);
    expect(before).toBe(27);
  });

  it('reports the bytes it holds and the limits in force', () => {
    const h = new History<Snap>(HISTORY_PRESETS[1]);
    pushN(h, 4, 1024);
    expect(h.bytes).toBe(4096);
    expect(h.limitsValue.maxBytes).toBe(64 * MB);
    expect(h.limitsValue.limitId).toBe(1);
    // Switching the budget down trims immediately, but never below the 2-step floor here.
    h.setLimits({ minSteps: 2, maxSteps: 3, maxBytes: 1024, limitId: 2 });
    expect(h.limitsValue.maxBytes).toBe(1024);
    expect(h.length).toBe(2);
    expect(h.bytes).toBe(2048); // the floor wins over the byte budget, by design
  });

  it('ships a documented default: 20 steps minimum, 60 maximum, one budget', () => {
    expect(DEFAULT_LIMITS.minSteps).toBe(20);
    expect(DEFAULT_LIMITS.maxSteps).toBe(60);
    expect(HISTORY_PRESETS.map((p) => p.limitId)).toEqual([0, 1, 2]);
    for (const preset of HISTORY_PRESETS) expect(preset.minSteps).toBe(20);
  });

  it('formats a byte count for the memory line', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(100 * 1024)).toBe('100 KB');
    expect(formatBytes(1.5 * MB)).toBe('1.5 MB');
  });
});

describe('history — the exact 20-step floor the task requires', () => {
  it('survives 20 full snapshots of a real-sized image within the default budget', () => {
    // 1920×1080×4 = 8.29 MB per step, so 20 steps is ~166 MB — under the 192 MB default.
    const stepBytes = 1920 * 1080 * 4;
    const h = new History<Snap>();
    for (let i = 0; i < 20; i++) h.push(`edit ${i}`, { id: i }, stepBytes);
    expect(h.length).toBe(20);
    expect(h.bytes).toBeLessThanOrEqual(DEFAULT_LIMITS.maxBytes);
    expect(h.canUndo).toBe(true);
    for (let i = 0; i < 19; i++) expect(h.undo()).not.toBeNull();
    expect(h.index).toBe(0);
  });
});
