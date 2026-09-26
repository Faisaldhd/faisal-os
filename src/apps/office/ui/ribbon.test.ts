import { afterEach, describe, expect, it } from 'vitest';
import { Ribbon, type RibbonTab } from './ribbon';

const tab = (id: string, n = 2): RibbonTab => ({
  id,
  label: id,
  groups: [{ label: `${id}-g`, controls: Array.from({ length: n }, (_, i) => ({ type: 'button' as const, id: `${id}-${i}`, icon: 'bold' as const, label: `${id} ${i}`, run: () => undefined })) }],
});
const docTabs = (): RibbonTab[] => [tab('file'), tab('home'), tab('insert'), tab('view')];

function mount(): Ribbon {
  const host = document.createElement('div');
  host.className = 'faisal-office';
  const ribbon = new Ribbon({ more: 'More', tabs: 'Tools', scrollStart: 'Back', scrollEnd: 'Next' });
  host.append(ribbon.element, ribbon.phoneBar);
  document.body.append(host);
  return ribbon;
}
const selected = (r: Ribbon): string | undefined => r.element.querySelector<HTMLElement>('.fo-tab[aria-selected="true"]')?.dataset.tab;
const shownPanel = (r: Ribbon): string | undefined => r.element.querySelector<HTMLElement>('.fo-toolpanel:not([hidden])')?.dataset.tab;

afterEach(() => { document.body.replaceChildren(); });

describe('Ribbon — which tab is on show', () => {
  it('opens a document on Home even when the start screen left File selected', () => {
    const r = mount();
    r.setTabs([tab('file')], 'file', false);
    expect(selected(r)).toBe('file');
    r.setTabs(docTabs(), 'home', false);
    expect(selected(r)).toBe('home');
    expect(shownPanel(r)).toBe('home');
    expect(r.current).toBe('home');
  });

  it('keeps the owner\'s tab when the same tabs are set again with keep', () => {
    const r = mount();
    r.setTabs(docTabs(), 'home', false);
    r.select('insert');
    r.setTabs(docTabs(), 'home', true);
    expect(selected(r)).toBe('insert');
    r.setTabs(docTabs(), 'home', false);
    expect(selected(r)).toBe('home');
  });

  it('falls back to the tab after File when no initial tab is given', () => {
    const r = mount();
    r.setTabs(docTabs());
    expect(selected(r)).toBe('home');
  });
});

describe('Ribbon — keyboard and roles', () => {
  it('links tabs and panels with roles, ids and one tab stop', () => {
    const r = mount();
    r.setTabs(docTabs(), 'home', false);
    const tabs = [...r.element.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(r.element.querySelector('[role="tablist"]')).not.toBeNull();
    expect(tabs.map((t) => t.tabIndex)).toEqual([-1, 0, -1, -1]);
    for (const t of tabs) {
      const panel = document.getElementById(t.getAttribute('aria-controls') ?? '');
      expect(panel?.getAttribute('role')).toBe('tabpanel');
      expect(panel?.getAttribute('aria-labelledby')).toBe(t.id);
    }
  });

  it('moves between tabs with the arrow keys (mirrored in RTL), Home and End, keeping focus', () => {
    const r = mount();
    r.setTabs(docTabs(), 'home', false);
    const key = (k: string): void => {
      (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    };
    r.element.querySelector<HTMLElement>('.fo-tab[data-tab="home"]')!.focus();
    key('ArrowRight');
    expect(selected(r)).toBe('insert');
    expect((document.activeElement as HTMLElement).dataset.tab).toBe('insert');
    key('End');
    expect(selected(r)).toBe('view');
    key('ArrowRight');
    expect(selected(r)).toBe('file');
    key('Home');
    expect(selected(r)).toBe('file');
    key('ArrowLeft');
    expect(selected(r)).toBe('view');

    document.documentElement.dir = 'rtl';
    try {
      r.element.querySelector<HTMLElement>('.fo-tab[data-tab="home"]')!.focus();
      r.select('home');
      key('ArrowLeft');
      expect(selected(r)).toBe('insert');
    } finally {
      document.documentElement.removeAttribute('dir');
    }
  });

  it('switching tabs toggles panels instead of rebuilding the tools', () => {
    const r = mount();
    r.setTabs(docTabs(), 'home', false);
    const node = r.element.querySelector('[data-control="insert-0"]');
    r.select('insert');
    expect(r.element.querySelector('[data-control="insert-0"]')).toBe(node);
    expect(shownPanel(r)).toBe('insert');
  });
});

describe('Ribbon — folded groups', () => {
  it('builds a dropdown for every group and shows the same tools in it, then puts them back', () => {
    const r = mount();
    r.setTabs(docTabs(), 'home', false);
    const group = r.element.querySelector<HTMLElement>('.fo-toolpanel[data-tab="home"] .fo-group')!;
    expect(group.dataset.mode).toBe('full');
    const tools = group.querySelector('.fo-group-tools')!;
    const fold = group.querySelector<HTMLButtonElement>('.fo-group-menu')!;
    expect(fold.getAttribute('aria-haspopup')).toBe('true');
    expect(fold.getAttribute('aria-label')).toBe('home-g');
    expect(fold.textContent).toBe('');
    group.dataset.mode = 'menu';
    fold.click();
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    const pop = document.querySelector('.fo-pop, .fo-sheet')!;
    expect(pop.contains(tools)).toBe(true);
    // A command closes the dropdown and the tools go home.
    tools.querySelector<HTMLButtonElement>('[data-control="home-0"]')!.click();
    expect(document.querySelector('.fo-pop, .fo-sheet')).toBeNull();
    expect(tools.parentElement).toBe(group);
    expect(fold.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps the scroll arrows hidden while the row fits', () => {
    const r = mount();
    r.setTabs(docTabs(), 'home', false);
    const arrows = [...r.element.querySelectorAll<HTMLElement>('.fo-rscroll')];
    expect(arrows).toHaveLength(2);
    expect(arrows.every((a) => a.hidden)).toBe(true);
  });
});
