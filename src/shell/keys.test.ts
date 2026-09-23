import { describe, expect, it } from 'vitest';
import { cycleTarget, isKey } from './keys';

const press = (init: KeyboardEventInit & { key: string }) => new KeyboardEvent('keydown', init);

describe('isKey', () => {
  it('matches the physical code', () => {
    expect(isKey(press({ key: 't', code: 'KeyT' }), 'T')).toBe(true);
  });

  it('matches the key when the event carries no standard code', () => {
    expect(isKey(press({ key: 'T', code: 'T' }), 't')).toBe(true);
  });

  it('ignores a different letter', () => {
    expect(isKey(press({ key: 'y', code: 'KeyY' }), 'T')).toBe(false);
  });
});

describe('cycleTarget', () => {
  /** Bottom → top, as WindowManager.list() returns them. */
  const ids = ['w1', 'w2', 'w3'];

  it('walks down the stack from the focused window', () => {
    expect(cycleTarget(ids, 'w3')).toBe('w2');
    expect(cycleTarget(ids, 'w2')).toBe('w1');
  });

  it('wraps from the bottom back to the top', () => {
    expect(cycleTarget(ids, 'w1')).toBe('w3');
  });

  it('walks the other way when asked', () => {
    expect(cycleTarget(ids, 'w1', true)).toBe('w2');
    expect(cycleTarget(ids, 'w3', true)).toBe('w1');
  });

  it('starts from the top when nothing is focused', () => {
    expect(cycleTarget(ids, null)).toBe('w2');
  });

  it('does nothing when there is nothing to switch to', () => {
    expect(cycleTarget(['w1'], 'w1')).toBeNull();
    expect(cycleTarget([], null)).toBeNull();
  });

  it('survives a focused id that no longer exists', () => {
    expect(cycleTarget(ids, 'w9')).toBe('w2');
  });
});
