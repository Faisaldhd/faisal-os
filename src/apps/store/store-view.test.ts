/**
 * The Store window driven for real in jsdom: the frozen class contract, the one-card
 * anatomy, the badges row that is always there, search + its honest empty state, the
 * tab/panel wiring including the arrow keys, the detail section order, and the
 * install call reaching `sys.apps`.
 *
 * The system API is a stub in the style of `kernel-install.test.ts`: a tiny catalog
 * with a mutable `installed` flag, a bus that really fires `apps:changed`, and spies on
 * install/uninstall/launch — so the test proves the app's own wiring without the kernel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBus } from '../../kernel/bus';
import { setLocale, t } from '../../kernel/i18n';
import type { AppContext, CatalogEntry, SystemAPI, WindowHandle } from '../../kernel/types';
import storeApp from './index';
import './strings';

const SVG = '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="5"/></svg>';
const RELEASED_AT = '2020-01-01'; // far outside the "new" window

function entry(overrides: Partial<CatalogEntry> & { id: string }): CatalogEntry {
  return {
    name: { ar: `تطبيق ${overrides.id}`, en: `App ${overrides.id}` },
    icon: SVG,
    permissions: [],
    category: 'utilities',
    installed: false,
    ...overrides,
  };
}

interface Scene {
  content: HTMLElement;
  catalog: CatalogEntry[];
  install: ReturnType<typeof vi.fn>;
  uninstall: ReturnType<typeof vi.fn>;
  launch: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  launchApp: (args?: string[]) => void;
}

function scene(entries: Partial<CatalogEntry>[] = []): Scene {
  const catalog: CatalogEntry[] = entries.map((e) => entry(e as Partial<CatalogEntry> & { id: string }));
  const bus = createBus();

  const content = document.createElement('div');
  document.body.append(content);

  const install = vi.fn((id: string) => {
    const target = catalog.find((a) => a.id === id);
    if (target) target.installed = true;
    bus.emit('apps:changed', {});
  });
  const uninstall = vi.fn((id: string) => {
    const target = catalog.find((a) => a.id === id);
    if (target) target.installed = false;
    bus.emit('apps:changed', {});
  });
  const launch = vi.fn();
  const notify = vi.fn();

  const win: WindowHandle = {
    id: 'w-store',
    appId: 'org.faisal.Store',
    content,
    setTitle() {},
    setCloseGuard() {},
    focus() {},
    close() {},
    onClose: () => () => {},
    onResize: () => () => {},
    requestClose: async () => {},
  };

  const sys = {
    bus,
    apps: {
      catalog: () => catalog,
      install,
      uninstall,
      launch,
    },
    locale: () => 'ar' as const,
    t,
    notify,
  } as unknown as SystemAPI;

  return {
    content,
    catalog,
    install,
    uninstall,
    launch,
    notify,
    launchApp: (args: string[] = []) => storeApp.launch({ sys, window: win, args } as AppContext),
  };
}

const q = <T extends HTMLElement>(root: HTMLElement, selector: string): T | null =>
  root.querySelector<T>(selector);
const qa = <T extends HTMLElement>(root: HTMLElement, selector: string): T[] =>
  [...root.querySelectorAll<T>(selector)];

const byText = (nodes: HTMLElement[], text: string): HTMLElement | undefined =>
  nodes.find((n) => n.textContent === text);

/**
 * A button must be fetched at the moment it is clicked: every render rebuilds the panel,
 * so a node captured before a click is already detached and clicking it does nothing.
 */
function button(content: HTMLElement, cls: string, label: string): HTMLButtonElement {
  const found = byText(qa<HTMLButtonElement>(content, `.faisal-store-btn${cls}`), label);
  if (!found) throw new Error(`no ${cls} button labelled ${label}`);
  return found as HTMLButtonElement;
}

/** jsdom has no `window.matchMedia`; reduced motion keeps the install spinner deterministic. */
function stubMatchMedia(): void {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** Lets the async install chain settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function clickAndSettle(node: HTMLElement): Promise<void> {
  node.click();
  await settle();
}

function search(content: HTMLElement, value: string): HTMLInputElement {
  const input = q<HTMLInputElement>(content, '.faisal-store-search');
  if (!input) throw new Error('no search field');
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input;
}

const panel = (content: HTMLElement, tab: 'explore' | 'installed' | 'updates'): HTMLElement => {
  const found = q<HTMLElement>(content, `#faisal-store-panel-${tab}`);
  if (!found) throw new Error(`no ${tab} panel`);
  return found;
};

const cards = (content: HTMLElement): HTMLButtonElement[] =>
  qa<HTMLButtonElement>(panel(content, 'explore'), '.faisal-store-card');

function tabButton(content: HTMLElement, tab: 'explore' | 'installed' | 'updates'): HTMLButtonElement {
  const found = q<HTMLButtonElement>(content, `#faisal-store-tab-${tab}`);
  if (!found) throw new Error(`no ${tab} tab`);
  return found;
}

beforeEach(() => {
  setLocale('ar');
  document.documentElement.dir = 'rtl';
  stubMatchMedia();
});

afterEach(() => {
  document.body.textContent = '';
});

/* ───────────────────────── cards: one per entry, fixed anatomy ───────────────────────── */

describe('store grid', () => {
  it('renders exactly one card per catalog entry, with the frozen class anatomy', () => {
    const s = scene([
      { id: 'org.faisal.Alpha', category: 'system', installed: true },
      { id: 'org.faisal.Beta', category: 'media', releasedAt: RELEASED_AT },
      { id: 'org.faisal.Gamma', category: 'web' },
    ]);
    s.launchApp();

    const grid = q(s.content, '.faisal-store-grid');
    expect(grid).not.toBeNull();
    const rendered = cards(s.content);
    expect(rendered).toHaveLength(s.catalog.length);
    expect(rendered.map((c) => c.tagName)).toEqual(['BUTTON', 'BUTTON', 'BUTTON']);

    for (const card of rendered) {
      expect(card.classList.contains('faisal-store-card')).toBe(true);
      expect(card.getAttribute('type')).toBe('button');
      const top = q<HTMLElement>(card, '.faisal-store-card-top');
      const head = q<HTMLElement>(card, '.faisal-store-card-head');
      expect(top).not.toBeNull();
      expect(q(card, '.faisal-store-card-icon')).not.toBeNull();
      expect(head).not.toBeNull();
      expect(q(card, '.faisal-store-card-name')).not.toBeNull();
      expect(q(card, '.faisal-store-card-cat')).not.toBeNull();
      expect(q(card, '.faisal-store-card-desc')).not.toBeNull();
      expect(q(card, '.faisal-store-badges')).not.toBeNull();
      // icon, name, category, description, (released), badges — in this order.
      expect(top?.contains(q(card, '.faisal-store-card-icon') as Node)).toBe(true);
      expect(head?.contains(q(card, '.faisal-store-card-name') as Node)).toBe(true);
      expect(head?.contains(q(card, '.faisal-store-card-cat') as Node)).toBe(true);
      expect(card.lastElementChild?.classList.contains('faisal-store-badges')).toBe(true);
    }
  });

  it('always renders a badges row, so a card with no badge is as tall as one with a badge', () => {
    const s = scene([
      { id: 'org.faisal.Plain' },
      { id: 'org.faisal.Installed', installed: true },
    ]);
    s.launchApp();

    // The grid is sorted by localized name, so pair each row with its own card rather
    // than assuming the order the entries were declared in.
    const rows = qa<HTMLElement>(panel(s.content, 'explore'), '.faisal-store-card .faisal-store-badges');
    expect(rows).toHaveLength(2);
    const badgeRowFor = (name: string): HTMLElement => {
      const card = rows.find((row) => q(row.closest('.faisal-store-card') as HTMLElement, '.faisal-store-card-name')?.textContent === name);
      if (!card) throw new Error(`no card for ${name}`);
      return card;
    };
    expect(badgeRowFor('تطبيق org.faisal.Plain').children).toHaveLength(0); // no badge, but the row is still there
    expect(qa<HTMLElement>(badgeRowFor('تطبيق org.faisal.Installed'), '.faisal-store-badge.is-installed')).toHaveLength(1);
  });

  it('shows the released line only when the manifest carries releasedAt', () => {
    const s = scene([
      { id: 'org.faisal.Dated', releasedAt: RELEASED_AT },
      { id: 'org.faisal.Undated' },
    ]);
    s.launchApp();

    const [dated, undated] = cards(s.content);
    const line = q<HTMLElement>(dated, '.faisal-store-card-released');
    expect(line).not.toBeNull();
    expect(line?.textContent).toContain('2020');
    expect(q(undated, '.faisal-store-card-released')).toBeNull();
  });
});

/* ───────────────────────── header: search + chips on one row ───────────────────────── */

describe('store header', () => {
  it('keeps the search field and the chips in the one header control row', () => {
    const s = scene([{ id: 'org.faisal.Alpha' }]);
    s.launchApp();

    const header = q(s.content, '.faisal-store-header');
    const controls = q<HTMLElement>(header as HTMLElement, '.faisal-store-controls');
    expect(controls).not.toBeNull();
    expect(controls?.contains(q(s.content, '.faisal-store-search') as Node)).toBe(true);
    expect(controls?.contains(q(s.content, '.faisal-store-chips') as Node)).toBe(true);
  });

  it('does not rebuild the chips under the keyboard when the selection has not changed', () => {
    const s = scene([{ id: 'org.faisal.Alpha' }]);
    s.launchApp();

    // Moving to another category rebuilds the row (expected), and the new active chip is live.
    const first = qa<HTMLButtonElement>(s.content, '.faisal-store-chip')[0];
    first.click();
    const afterSwitch = qa<HTMLButtonElement>(s.content, '.faisal-store-chip.is-active')[0];
    expect(afterSwitch.textContent).toBe(t('store.categoryAll'));

    // Clicking the already-active chip changes nothing, so the node the keyboard stands on
    // must not be replaced behind its back.
    afterSwitch.focus();
    afterSwitch.click();
    expect(qa<HTMLButtonElement>(s.content, '.faisal-store-chip.is-active')[0]).toBe(afterSwitch);
    expect(document.activeElement).toBe(afterSwitch);

    // The search field keeps its own text and focus across a plain re-render.
    const input = search(s.content, 'alpha');
    input.focus();
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('alpha');
  });

  it('marks exactly one chip active, in class and in aria-pressed', () => {
    const s = scene([{ id: 'org.faisal.Alpha' }]);
    s.launchApp();

    const chips = qa<HTMLButtonElement>(s.content, '.faisal-store-chip');
    expect(chips.length).toBeGreaterThan(1);
    expect(chips.filter((c) => c.classList.contains('is-active'))).toHaveLength(1);
    expect(chips.filter((c) => c.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
    expect(qa<HTMLButtonElement>(s.content, '.faisal-store-chip[aria-pressed="false"]').length).toBe(chips.length - 1);

    const media = chips.find((c) => c.textContent === t('store.categoryMedia') && !c.classList.contains('is-active'));
    expect(media).toBeDefined();
    media?.click();
    const after = qa<HTMLButtonElement>(s.content, '.faisal-store-chip.is-active');
    expect(after).toHaveLength(1);
    expect(after[0].getAttribute('aria-pressed')).toBe('true');
    expect(after[0].textContent).toBe(t('store.categoryMedia'));
  });
});

/* ───────────────────────── search narrows the grid + empty state ───────────────────────── */

describe('store search', () => {
  it('narrows the grid and names the searched term when nothing matches', () => {
    const s = scene([
      { id: 'org.faisal.Alpha', name: { ar: 'ألفا', en: 'Alpha' } },
      { id: 'org.faisal.Beta', name: { ar: 'بيتا', en: 'Beta' } },
    ]);
    s.launchApp();
    expect(cards(s.content)).toHaveLength(2);

    search(s.content, 'Beta');
    expect(cards(s.content)).toHaveLength(1);
    expect(q<HTMLElement>(cards(s.content)[0], '.faisal-store-card-name')?.textContent).toBe('بيتا');

    search(s.content, 'zzz-nothing');
    expect(qa(s.content, '.faisal-store-card')).toHaveLength(0);
    const empty = q<HTMLElement>(panel(s.content, 'explore'), '.faisal-store-empty');
    expect(empty).not.toBeNull();
    expect(empty?.getAttribute('role')).toBe('status');
    expect(empty?.textContent).toBe(t('store.emptySearch', { query: 'zzz-nothing' }));
  });

  it('says plainly that no extra app is installed on the installed tab', () => {
    const s = scene([{ id: 'org.faisal.Alpha' }, { id: 'org.faisal.Beta' }]);
    s.launchApp();
    tabButton(s.content, 'installed').click();

    const empty = q<HTMLElement>(panel(s.content, 'installed'), '.faisal-store-empty');
    expect(empty?.textContent).toBe(t('store.emptyInstalled'));
  });
});

/* ───────────────────────── tabs are real tabs over real panels ───────────────────────── */

describe('store tabs', () => {
  it('switches the visible panel and keeps aria in step', () => {
    const s = scene([{ id: 'org.faisal.Alpha' }]);
    s.launchApp();

    const tabs = qa<HTMLButtonElement>(s.content, '.faisal-store-tab');
    expect(tabs).toHaveLength(3);
    for (const tb of tabs) {
      expect(tb.getAttribute('role')).toBe('tab');
      // every tab points at a panel that really exists in the document
      const panelId = tb.getAttribute('aria-controls') as string;
      expect(panelId.length).toBeGreaterThan(0);
      expect(s.content.querySelector(`#${panelId}`)).not.toBeNull();
    }
    expect(tabButton(s.content, 'explore').getAttribute('aria-selected')).toBe('true');
    expect(panel(s.content, 'explore').hidden).toBe(false);
    expect(panel(s.content, 'updates').hidden).toBe(true);

    tabButton(s.content, 'updates').click();
    expect(tabButton(s.content, 'updates').getAttribute('aria-selected')).toBe('true');
    expect(tabButton(s.content, 'explore').getAttribute('aria-selected')).toBe('false');
    expect(panel(s.content, 'updates').hidden).toBe(false);
    expect(panel(s.content, 'explore').hidden).toBe(true);
    expect(panel(s.content, 'updates').textContent).toContain(t('store.builtInTitle'));

    // the panel names the tab that controls it
    expect(panel(s.content, 'updates').getAttribute('aria-labelledby')).toBe('faisal-store-tab-updates');
  });

  it('moves between tabs with the arrow keys, and the active tab holds the focus', () => {
    const s = scene([{ id: 'org.faisal.Alpha' }]);
    s.launchApp();

    const explore = tabButton(s.content, 'explore');
    explore.focus();
    // RTL: ArrowLeft advances, ArrowRight goes back.
    explore.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(tabButton(s.content, 'installed').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tabButton(s.content, 'installed'));

    tabButton(s.content, 'installed').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(tabButton(s.content, 'updates').getAttribute('aria-selected')).toBe('true');

    tabButton(s.content, 'updates').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    // one step past the last tab wraps to the first
    expect(tabButton(s.content, 'explore').getAttribute('aria-selected')).toBe('true');
  });

  it('lands back on Explore when the search is used from another tab', () => {
    const s = scene([{ id: 'org.faisal.Alpha' }]);
    s.launchApp();
    tabButton(s.content, 'installed').click();
    expect(tabButton(s.content, 'installed').getAttribute('aria-selected')).toBe('true');

    search(s.content, 'alpha');
    expect(tabButton(s.content, 'explore').getAttribute('aria-selected')).toBe('true');
    expect(panel(s.content, 'explore').hidden).toBe(false);
  });
});

/* ───────────────────────── detail pane section order ───────────────────────── */

describe('store detail', () => {
  it('opens from a card and presents its sections in the documented order', () => {
    const s = scene([
      { id: 'org.faisal.Alpha', category: 'media', version: '2.1.0', releasedAt: RELEASED_AT, permissions: ['fs:system', 'fs:home'] },
    ]);
    s.launchApp();

    cards(s.content)[0].click();

    const detail = q<HTMLElement>(panel(s.content, 'explore'), '.faisal-store-detail');
    expect(detail).not.toBeNull();
    expect(q(detail as HTMLElement, '.faisal-store-back')).not.toBeNull();
    expect(q(detail as HTMLElement, '.faisal-store-detail-head')).not.toBeNull();
    expect(q(detail as HTMLElement, '.faisal-store-detail-icon')).not.toBeNull();
    expect(q(detail as HTMLElement, '.faisal-store-detail-name')?.textContent).toBe('تطبيق org.faisal.Alpha');
    expect(q(detail as HTMLElement, '.faisal-store-detail-meta')?.textContent).toContain('2.1.0');
    expect(q(detail as HTMLElement, '.faisal-store-detail-meta')?.textContent).toContain('2020');
    expect(q(detail as HTMLElement, '.faisal-store-detail-desc')).not.toBeNull();

    const sections = qa<HTMLElement>(detail as HTMLElement, '.faisal-store-detail-section');
    expect(sections).toHaveLength(4);
    const titles = sections.map((sec) => q(sec, '.faisal-store-detail-section-title')?.textContent);
    expect(titles).toEqual([
      t('store.aboutTitle'),
      t('store.actionsTitle'),
      t('store.permissionsTitle'),
      t('store.limitsTitle'),
    ]);
    // about holds the head + description, actions holds the buttons, permissions the list
    expect(q(sections[0], '.faisal-store-detail-head')).not.toBeNull();
    expect(q(sections[0], '.faisal-store-detail-desc')).not.toBeNull();
    expect(q(sections[1], '.faisal-store-detail-actions')).not.toBeNull();
    expect(q(sections[2], '.faisal-store-perm-item.is-warning')).not.toBeNull();
    expect(qa(sections[2], '.faisal-store-perm-item')).toHaveLength(2);
    expect(q(sections[2], '.faisal-store-perm-dot')).not.toBeNull();
    // the powerful permission carries a sentence, not just a colour
    expect(q(sections[2], '.faisal-store-perm-item.is-warning')?.textContent).toContain(t('store.permissionWarning'));
  });

  it('opens the detail pane straight from the shell deep link [app, id]', () => {
    const s = scene([{ id: 'org.faisal.Alpha' }, { id: 'org.faisal.Beta' }]);
    s.launchApp(['app', 'org.faisal.Beta']);

    const detail = q<HTMLElement>(s.content, '.faisal-store-detail');
    expect(detail).not.toBeNull();
    expect(q(detail as HTMLElement, '.faisal-store-detail-name')?.textContent).toBe('تطبيق org.faisal.Beta');
    // the header row is not a distraction while reading one app
    expect(q<HTMLElement>(s.content, '.faisal-store-controls')?.hidden).toBe(true);

    q<HTMLElement>(detail as HTMLElement, '.faisal-store-back')?.click();
    expect(q(s.content, '.faisal-store-detail')).toBeNull();
    expect(q(s.content, '.faisal-store-grid')).not.toBeNull();
    expect(q<HTMLElement>(s.content, '.faisal-store-controls')?.hidden).toBe(false);
  });

  it('shows the confirm step before removing an installed app', () => {
    const s = scene([{ id: 'org.faisal.Alpha', installed: true }]);
    s.launchApp();
    cards(s.content)[0].click();

    const detail = q<HTMLElement>(s.content, '.faisal-store-detail') as HTMLElement;
    const remove = byText(qa<HTMLButtonElement>(detail, '.faisal-store-btn.is-danger'), t('store.remove')) as HTMLButtonElement;
    expect(remove).toBeDefined();
    remove.click();

    // The question replaces the button that opened it, inside the same actions row.
    const fresh = q<HTMLElement>(panel(s.content, 'explore'), '.faisal-store-detail-actions');
    const confirm = q<HTMLElement>(fresh as HTMLElement, '.faisal-store-confirm');
    expect(fresh).not.toBeNull();
    expect(confirm).not.toBeNull();
    expect(q<HTMLElement>(confirm as HTMLElement, '.faisal-store-confirm-actions')).not.toBeNull();
    expect(q<HTMLButtonElement>(fresh as HTMLElement, '.faisal-store-btn.is-danger')?.textContent).toBe(t('store.removeConfirmYes'));
    expect(q(fresh as HTMLElement, '.faisal-store-btn.is-ghost')?.textContent).toBe(t('store.removeConfirmNo'));
    // The list of danger buttons no longer contains a plain Remove: the only one left is
    // the one inside the confirm step, so the button that opened it cannot be clicked twice.
    expect(qa<HTMLButtonElement>(fresh as HTMLElement, '.faisal-store-btn.is-danger').map((b) => b.textContent))
      .toEqual([t('store.removeConfirmYes')]);
    expect(s.uninstall).not.toHaveBeenCalled();
  });
});

/* ───────────────────────── behaviour kept: install through sys.apps ───────────────────────── */

describe('store install', () => {
  it('calls sys.apps.install and notifies, then reports the app as installed', async () => {
    const s = scene([{ id: 'org.faisal.Alpha' }]);
    s.launchApp();
    cards(s.content)[0].click();

    const install = button(s.content, '.is-primary', t('store.install'));
    install.click();
    // The work is awaited, not done synchronously: right after the click the pane reports
    // the in-progress status and has not reached sys.apps yet.
    expect(q(panel(s.content, 'explore'), '.faisal-store-progress')?.textContent).toBe(t('store.installing'));
    expect(s.install).not.toHaveBeenCalled();
    await settle();

    expect(s.install).toHaveBeenCalledTimes(1);
    expect(s.install).toHaveBeenCalledWith('org.faisal.Alpha');
    expect(s.notify).toHaveBeenCalledWith(t('store.installedNotify', { name: 'تطبيق org.faisal.Alpha' }));
    expect(s.catalog[0].installed).toBe(true);

    // back on the grid the card now carries the installed badge
    q<HTMLElement>(s.content, '.faisal-store-back')?.click();
    expect(qa<HTMLElement>(panel(s.content, 'explore'), '.faisal-store-badge.is-installed')).toHaveLength(1);
  });

  it('removes an installed app through sys.apps.uninstall once confirmed', async () => {
    const s = scene([{ id: 'org.faisal.Alpha', installed: true }]);
    s.launchApp();
    cards(s.content)[0].click();

    const detail = q<HTMLElement>(s.content, '.faisal-store-detail') as HTMLElement;
    byText(qa<HTMLButtonElement>(detail, '.faisal-store-btn.is-danger'), t('store.remove'))?.click();
    const yes = byText(qa<HTMLButtonElement>(s.content, '.faisal-store-btn.is-danger'), t('store.removeConfirmYes'));
    await clickAndSettle(yes as HTMLButtonElement);

    expect(s.uninstall).toHaveBeenCalledTimes(1);
    expect(s.uninstall).toHaveBeenCalledWith('org.faisal.Alpha');
    expect(s.catalog[0].installed).toBe(false);
  });

  it('offers Open for an installed app and never a Remove for a core app', () => {
    const s = scene([
      { id: 'org.faisal.Alpha', installed: true },
      { id: 'org.faisal.Core', installed: true, core: true },
    ]);
    s.launchApp();

    cards(s.content)[0].click();
    let detail = q<HTMLElement>(s.content, '.faisal-store-detail') as HTMLElement;
    byText(qa<HTMLButtonElement>(detail, '.faisal-store-btn.is-primary'), t('store.open'))?.click();
    expect(s.launch).toHaveBeenCalledWith('org.faisal.Alpha');

    q<HTMLElement>(s.content, '.faisal-store-back')?.click();
    cards(s.content)[1].click();
    detail = q<HTMLElement>(s.content, '.faisal-store-detail') as HTMLElement;
    expect(byText(qa<HTMLButtonElement>(detail, '.faisal-store-btn.is-danger'), t('store.remove'))).toBeUndefined();
    const limits = qa<HTMLElement>(detail, '.faisal-store-detail-section')[3];
    expect(limits.textContent).toContain(t('store.coreCantRemove'));
  });
});

/* ───────────────────────── accessibility of the card ───────────────────────── */
describe('store card accessibility', () => {
  it('gives every card a button name with app, category and install state', () => {
    const s = scene([
      { id: 'org.faisal.Alpha', category: 'media' },
      { id: 'org.faisal.Beta', category: 'system', installed: true },
    ]);
    s.launchApp();

    const [plain, installed] = cards(s.content);
    expect(plain.getAttribute('aria-label')).toBe(t('store.cardLabel', {
      name: 'تطبيق org.faisal.Alpha',
      category: t('store.categoryMedia'),
      state: t('store.cardStateNotInstalled'),
    }));
    expect(installed.getAttribute('aria-label')).toContain(t('store.cardStateInstalled'));
    expect(installed.getAttribute('aria-label')).toContain(t('store.categorySystem'));
    expect(installed.getAttribute('aria-label')).toContain('تطبيق org.faisal.Beta');
  });

  it('does not hide the install state behind colour: the badge text is in the card', () => {
    const s = scene([{ id: 'org.faisal.Alpha', installed: true }]);
    s.launchApp();
    const card = cards(s.content)[0];
    expect(q(card, '.faisal-store-badge.is-installed')?.textContent).toBe(t('store.installedBadge'));
    expect(card.getAttribute('aria-label')).toContain(t('store.cardStateInstalled'));
  });
});

/* ───────────────────────── the frozen class contract ───────────────────────── */

describe('the frozen class names the stylesheet shares', () => {
  it('renders every frozen class, in the frozen nesting, so CSS has nothing to guess', () => {
    const s = scene([
      { id: 'org.faisal.Alpha', category: 'media', releasedAt: RELEASED_AT, installed: true, permissions: ['fs:system'] },
    ]);
    s.launchApp();

    // root > header(search, chips > chip) + tabs > tab + body(tabpanel) > banner + grid > card
    const root = q<HTMLElement>(s.content, '.faisal-store');
    const header = q<HTMLElement>(root as HTMLElement, '.faisal-store-header');
    expect(q<HTMLElement>(header as HTMLElement, '.faisal-store-search')).not.toBeNull();
    expect(q<HTMLElement>(header as HTMLElement, '.faisal-store-chips .faisal-store-chip')).not.toBeNull();

    const body = panel(s.content, 'explore');
    expect(body.getAttribute('role')).toBe('tabpanel');
    expect(q(body, '.faisal-store-banner .faisal-store-banner-icon')).not.toBeNull();
    expect(q(body, '.faisal-store-banner .faisal-store-banner-text .faisal-store-banner-eyebrow')).not.toBeNull();
    expect(q(body, '.faisal-store-banner .faisal-store-banner-name')).not.toBeNull();
    expect(q(body, '.faisal-store-banner .faisal-store-banner-desc')).not.toBeNull();
    expect(q(body, '.faisal-store-banner .faisal-store-banner-cta')).not.toBeNull();

    const card = q<HTMLElement>(body, '.faisal-store-grid > .faisal-store-card');
    expect(card).not.toBeNull();
    expect(q(card as HTMLElement, '.faisal-store-card-top > .faisal-store-card-icon')).not.toBeNull();
    expect(q(card as HTMLElement, '.faisal-store-card-top > .faisal-store-card-head > .faisal-store-card-name')).not.toBeNull();
    expect(q(card as HTMLElement, '.faisal-store-card-top > .faisal-store-card-head > .faisal-store-card-cat')).not.toBeNull();
    expect(q(card as HTMLElement, '.faisal-store-card-desc')).not.toBeNull();
    expect(q(card as HTMLElement, '.faisal-store-card-released')).not.toBeNull();
    expect(q(card as HTMLElement, '.faisal-store-badges > .faisal-store-badge.is-installed')).not.toBeNull();

    card?.click();
    expect(q(s.content, '.faisal-store-detail > .faisal-store-back')).not.toBeNull();
    expect(q(s.content, '.faisal-store-detail > .faisal-store-detail-section .faisal-store-detail-head')).not.toBeNull();
    expect(q(s.content, '.faisal-store-detail .faisal-store-detail-icon')).not.toBeNull();
    expect(q(s.content, '.faisal-store-detail .faisal-store-detail-info > .faisal-store-detail-name')).not.toBeNull();
    expect(q(s.content, '.faisal-store-detail .faisal-store-detail-info > .faisal-store-detail-meta')).not.toBeNull();
    expect(q(s.content, '.faisal-store-detail .faisal-store-detail-desc')).not.toBeNull();
    expect(q(s.content, '.faisal-store-detail-actions > .faisal-store-btn.is-primary')).not.toBeNull();
    expect(q(s.content, '.faisal-store-detail-actions > .faisal-store-btn.is-danger')).not.toBeNull();
    expect(q(s.content, '.faisal-store-permissions .faisal-store-perm-item .faisal-store-perm-dot')).not.toBeNull();
    expect(q(s.content, '.faisal-store-permissions .faisal-store-perm-item.is-warning')).not.toBeNull();
  });

  it('uses .faisal-store-empty inside the permissions section when nothing is requested', () => {
    const s = scene([{ id: 'org.faisal.Alpha' }]);
    s.launchApp();
    cards(s.content)[0].click();
    const permissions = qa<HTMLElement>(s.content, '.faisal-store-detail-section')[2];
    expect(q(permissions, '.faisal-store-empty')?.textContent).toBe(t('store.permissionsNone'));
  });
});
