import { describe, expect, it } from 'vitest';
import { isIdentityOrder, moveBlock } from './ops';

describe('moveBlock (thumbnail drag of several pages)', () => {
  it('moves one page before another, or to the end', () => {
    expect(moveBlock(4, [3], 0)).toEqual([3, 0, 1, 2]);
    expect(moveBlock(4, [0], 4)).toEqual([1, 2, 3, 0]);
    expect(moveBlock(4, [1], 3)).toEqual([0, 2, 1, 3]);
  });

  it('keeps a selected block together and in its own order', () => {
    expect(moveBlock(6, [4, 1], 0)).toEqual([1, 4, 0, 2, 3, 5]);
    expect(moveBlock(6, [0, 1], 5)).toEqual([2, 3, 4, 0, 1, 5]);
  });

  it('ignores bad input and reports a no-op', () => {
    expect(moveBlock(3, [7, -1], 1)).toEqual([0, 1, 2]);
    expect(isIdentityOrder(moveBlock(3, [1], 1))).toBe(true);
    expect(isIdentityOrder(moveBlock(3, [1], 2))).toBe(true);
    expect(isIdentityOrder([1, 0])).toBe(false);
  });
});
