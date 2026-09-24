import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { showContextMenu, placeMenu, closeAnyContextMenu, type ContextMenuItem } from './contextmenu';

describe('placeMenu (pure clamping helper)', () => {
  it('keeps the menu inside the viewport when opened near the bottom-right corner', () => {
    const { left, top } = placeMenu(780, 580, 220, 160, 800, 600, false);
    expect(left + 220).toBeLessThanOrEqual(800 - 4 + 0.001);
    expect(top + 160).toBeLessThanOrEqual(600 - 4 + 0.001);
    expect(left).toBeGreaterThanOrEqual(4 - 0.001);
    expect(top).toBeGreaterThanOrEqual(4 - 0.001);
  });

  it('places the menu at (x, y) when there is plenty of room (LTR)', () => {
    const { left, top } = placeMenu(100, 100, 200, 150, 1200, 800, false);
    expect(left).toBe(100);
    expect(top).toBe(100);
  });

  it('opens to the start side (mirrors left) in RTL', () => {
    const { left } = placeMenu(600, 100, 200, 150, 1200, 800, true);
    expect(left).toBe(400); // x - menuW
  });

  it('never produces a negative-sized or out-of-bounds box on a tiny viewport', () => {
    const { left, top } = placeMenu(50, 50, 300, 300, 320, 240, false);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
  });
});

describe('showContextMenu', () => {
  beforeEach(() => {
    document.documentElement.dir = 'ltr';
  });
  afterEach(() => {
    closeAnyContextMenu();
    document.body.replaceChildren();
  });

  function items(onA = () => {}, onB = () => {}): ContextMenuItem[] {
    return [
      { label: 'Open', action: onA },
      { separator: true },
      { label: 'Disabled', disabled: true, action: () => { throw new Error('should not fire'); } },
      { label: 'Danger', danger: true, action: onB },
    ];
  }

  it('renders items with role=menu / menuitem and skips rendering a button for separators', () => {
    showContextMenu(10, 10, items());
    const menu = document.querySelector('.faisal-ctxmenu')!;
    expect(menu).toBeTruthy();
    expect(menu.getAttribute('role')).toBe('menu');
    const buttons = menu.querySelectorAll('[role="menuitem"]');
    expect(buttons).toHaveLength(3);
    expect(menu.querySelectorAll('.faisal-ctxmenu-sep')).toHaveLength(1);
  });

  it('only one menu is open at a time', () => {
    showContextMenu(10, 10, items());
    showContextMenu(20, 20, items());
    expect(document.querySelectorAll('.faisal-ctxmenu')).toHaveLength(1);
  });

  it('clicking an item invokes its action and closes the menu', () => {
    let clicked = false;
    showContextMenu(10, 10, items(() => { clicked = true; }));
    const openBtn = document.querySelector('.faisal-ctxmenu-item') as HTMLButtonElement;
    openBtn.click();
    expect(clicked).toBe(true);
    expect(document.querySelector('.faisal-ctxmenu')).toBeNull();
  });

  it('Escape closes the menu', () => {
    showContextMenu(10, 10, items());
    expect(document.querySelector('.faisal-ctxmenu')).toBeTruthy();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.faisal-ctxmenu')).toBeNull();
  });

  it('stops listening for keys once it is closed', () => {
    let picked = 0;
    const close = showContextMenu(10, 10, items(() => { picked += 1; }));
    close();
    // The key handler used to stay bound: Space re-ran the first item on a menu that no longer
    // existed and swallowed the key, which broke typing in the terminal after a right-click.
    const ev = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    expect(picked).toBe(0);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('keyboard navigation (ArrowDown/End/Home) skips disabled items and separators', () => {
    showContextMenu(10, 10, items());
    const menu = document.querySelector('.faisal-ctxmenu')!;
    const enabled = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].filter((b) => !b.disabled);
    expect(enabled).toHaveLength(2); // "Open" and "Danger" — "Disabled" excluded

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement?.textContent).toContain('Danger');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(document.activeElement?.textContent).toContain('Open');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement?.textContent).toContain('Danger');
  });

  it('outside pointerdown closes the menu', () => {
    showContextMenu(10, 10, items());
    expect(document.querySelector('.faisal-ctxmenu')).toBeTruthy();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(document.querySelector('.faisal-ctxmenu')).toBeNull();
  });

  it('returns focus to the invoker element when closed', () => {
    const invoker = document.createElement('button');
    document.body.append(invoker);
    invoker.focus();
    const close = showContextMenu(10, 10, items(), { invoker });
    close();
    expect(document.activeElement).toBe(invoker);
  });
});
