import { describe, expect, it } from 'vitest';
import { clampZoom, StatusBar, stepZoom } from './statusbar';

const labels = { bar: 'Status bar', zoomIn: 'Zoom in', zoomOut: 'Zoom out', zoomLevel: 'Zoom level' };

describe('status bar zoom steps', () => {
  it('steps by 10% and snaps an odd value onto the grid', () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(0.93, 1)).toBe(1);
    expect(stepZoom(0.93, -1)).toBe(0.9);
    expect(stepZoom(2, 1)).toBe(2);
    expect(stepZoom(0.5, -1)).toBe(0.5);
  });

  it('clamps and rounds', () => {
    expect(clampZoom(3)).toBe(2);
    expect(clampZoom(0.1)).toBe(0.5);
    expect(clampZoom(1.234)).toBe(1.23);
    expect(clampZoom(Number.NaN)).toBe(1);
  });
});

describe('StatusBar', () => {
  it('shows the editor parts and message, and a zoom control only when the editor has one', () => {
    const bar = new StatusBar(labels);
    bar.update({ parts: ['Page 1 of 2', '12 words'] }, 'Saved.');
    expect([...bar.element.querySelectorAll('.fo-status-part')].map((p) => p.textContent)).toEqual(['Page 1 of 2', '12 words']);
    expect(bar.message.textContent).toBe('Saved.');
    expect(bar.message.getAttribute('role')).toBe('status');
    expect(bar.element.querySelector<HTMLElement>('.fo-zoom')!.hidden).toBe(true);

    let value = 1;
    const zoom = { value, set: (v: number) => { value = v; } };
    bar.update({ parts: ['Slide 1 of 3'], zoom }, '');
    const box = bar.element.querySelector<HTMLElement>('.fo-zoom')!;
    expect(box.hidden).toBe(false);
    expect(box.querySelector('.fo-zoom-value')!.textContent).toBe('100%');
    box.querySelector<HTMLButtonElement>('button[title="Zoom in"]')!.click();
    expect(value).toBe(1.1);
    const slider = box.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(slider.getAttribute('aria-label')).toBe('Zoom level');
    slider.value = '150';
    slider.dispatchEvent(new Event('input'));
    expect(value).toBe(1.5);
    expect(box.querySelector('.fo-zoom-value')!.textContent).toBe('150%');
  });

  it('disables the steps at the ends of the range', () => {
    const bar = new StatusBar(labels);
    bar.update({ parts: [], zoom: { value: 2, set: () => undefined } }, '');
    expect(bar.element.querySelector<HTMLButtonElement>('button[title="Zoom in"]')!.disabled).toBe(true);
    expect(bar.element.querySelector<HTMLButtonElement>('button[title="Zoom out"]')!.disabled).toBe(false);
  });
});
