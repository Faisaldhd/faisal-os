import { describe, expect, it } from 'vitest';
import { closeTop, escapeLayerCount, pushEscapeLayer, setEscapeFallback } from './esc';

/** Dispatching on `window` is what a real keypress does as far as these listeners are concerned. */
function pressEscape(): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  window.dispatchEvent(ev);
  return ev;
}

describe('escape priority', () => {
  it('closes the surface that opened last, and only that one', () => {
    const closed: string[] = [];
    const releaseA = pushEscapeLayer(() => closed.push('a'));
    const releaseB = pushEscapeLayer(() => closed.push('b'));

    pressEscape();
    expect(closed).toEqual(['b']);
    pressEscape();
    expect(closed).toEqual(['b', 'a']);
    pressEscape(); // nothing left to close
    expect(closed).toEqual(['b', 'a']);

    releaseA();
    releaseB();
    expect(escapeLayerCount()).toBe(0);
  });

  it('consumes the key while a surface is open, so nothing behind it reacts', () => {
    let leaked = 0;
    const listener = () => { leaked++; };
    document.addEventListener('keydown', listener);
    const release = pushEscapeLayer(() => {});

    expect(pressEscape().defaultPrevented).toBe(true);
    expect(leaked).toBe(0);

    release();
    document.removeEventListener('keydown', listener);
  });

  it('leaves Escape completely alone when nothing is open', () => {
    let seen = 0;
    const listener = (ev: KeyboardEvent) => { if (ev.key === 'Escape') seen++; };
    window.addEventListener('keydown', listener);

    expect(pressEscape().defaultPrevented).toBe(false);
    expect(seen).toBe(1);

    window.removeEventListener('keydown', listener);
  });

  it('runs the shell fallback (leave fullscreen) only when nothing of ours is open', () => {
    let left = 0;
    setEscapeFallback(() => { left++; return true; });

    const release = pushEscapeLayer(() => {});
    pressEscape();
    expect(left).toBe(0); // the open popup keeps the key
    release();

    expect(pressEscape().defaultPrevented).toBe(true);
    expect(left).toBe(1);

    setEscapeFallback(null);
  });

  it('leaves Escape for the app when the shell has no use for it', () => {
    setEscapeFallback(() => false);
    let seen = 0;
    const listener = (ev: KeyboardEvent) => { if (ev.key === 'Escape') seen++; };
    window.addEventListener('keydown', listener);

    expect(pressEscape().defaultPrevented).toBe(false);
    expect(seen).toBe(1);

    window.removeEventListener('keydown', listener);
    setEscapeFallback(null);
  });

  it('forgets a surface that closed itself, wherever it sat in the stack', () => {
    const closed: string[] = [];
    const releaseA = pushEscapeLayer(() => closed.push('a'));
    const releaseB = pushEscapeLayer(() => closed.push('b'));
    releaseA(); // the menu below closed on its own (an outside click, say)

    pressEscape();
    expect(closed).toEqual(['b']);
    expect(closeTop()).toBe(false);

    releaseB();
  });

  it('closes the topmost surface when the shell leaves fullscreen', () => {
    // jsdom has no fullscreen element at all, which is the state the owner is in after Escape
    // left fullscreen in Chromium: exactly the case this fallback exists for.
    const closed: string[] = [];
    const releaseA = pushEscapeLayer(() => closed.push('below'));
    const releaseB = pushEscapeLayer(() => closed.push('top'));

    document.dispatchEvent(new Event('fullscreenchange'));
    expect(closed).toEqual(['top']);

    releaseA();
    releaseB();
  });
});
