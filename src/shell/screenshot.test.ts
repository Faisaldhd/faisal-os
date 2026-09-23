import { describe, it, expect } from 'vitest';
import { fileName } from './screenshot';

describe('screenshot fileName', () => {
  it('builds a sortable, zero-padded PNG name', () => {
    expect(fileName(new Date(2026, 8, 3, 7, 5, 9))).toBe('Screenshot_2026-09-03_07-05-09.png');
  });
});
