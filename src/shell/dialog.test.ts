import { describe, expect, it } from 'vitest';
import { shellChoice } from './dialog';

const ask = () => shellChoice<'copy' | 'move'>({
  title: 'نسخة أو نقل؟',
  message: '«a.txt» — نسخة تُبقي الأصل، أو نقل ينقله إلى هنا.',
  options: [
    { value: 'copy', label: 'نسخة' },
    { value: 'move', label: 'نقل', primary: true },
  ],
  cancelLabel: 'إلغاء',
});

const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('.faisal-shell-dialog-btn')];

describe('shellChoice', () => {
  it('offers cancel plus every answer, and resolves with the one that was clicked', async () => {
    const answer = ask();
    expect(buttons().map((b) => b.textContent)).toEqual(['إلغاء', 'نسخة', 'نقل']);
    expect(document.querySelector('.faisal-shell-overlay')).not.toBeNull();

    buttons()[2].click();
    await expect(answer).resolves.toBe('move');
    expect(document.querySelector('.faisal-shell-overlay')).toBeNull();
  });

  it('resolves null when the owner cancels or presses Escape', async () => {
    const cancelled = ask();
    buttons()[0].click();
    await expect(cancelled).resolves.toBeNull();

    const escaped = ask();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await expect(escaped).resolves.toBeNull();
    expect(document.querySelector('.faisal-shell-overlay')).toBeNull();
  });
});
