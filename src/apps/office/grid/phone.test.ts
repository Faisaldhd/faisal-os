import { describe, expect, it } from 'vitest';
import { barTopAboveKeyboard, keyboardInset } from './phone';

describe('the formula bar above the on-screen keyboard', () => {
  it('sees a keyboard only when it covers a real part of the window', () => {
    expect(keyboardInset(844, 844, 0)).toBe(0);
    expect(keyboardInset(844, 780, 0)).toBe(0);          // a browser toolbar, not a keyboard
    expect(keyboardInset(844, 500, 0)).toBe(344);
    expect(keyboardInset(844, 500, 40)).toBe(304);       // the page scrolled inside the viewport
  });
  it('puts the bar right on top of it', () => {
    expect(barTopAboveKeyboard(500, 0, 52)).toBe(448);
    expect(barTopAboveKeyboard(500, 40, 52)).toBe(488);
    expect(barTopAboveKeyboard(30, 0, 52)).toBe(0);
  });
});
