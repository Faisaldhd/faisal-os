/**
 * Office — the ribbon (الشريط): tabs of grouped tools, built from data.
 *
 * Every editor (Writer, the sheet, the deck) describes its tools as a list of
 * tabs → groups → controls. The same description draws the desktop ribbon (a tab
 * strip plus one tool row with group captions) and, on a narrow window, the
 * phone layout: a bottom bar with the few tools the editor marks as `phone`,
 * plus "More", which opens the whole ribbon in a bottom sheet. Nothing exists in
 * one layout only, and nothing needs hover.
 *
 * Controls keep their state through closures (`pressed`, `enabled`, `value`), and
 * `sync()` re-reads them after every change, so the ribbon never holds a second
 * copy of the document's state.
 *
 * The desktop row shrinks like WPS as the window narrows (`ribbon-layout.ts`):
 * groups drop their captions, then fold into one dropdown each, from the end of
 * the row back; only if that still does not fit does the row scroll behind two
 * arrow buttons. A folded group's dropdown shows the very same control nodes
 * (moved, not copied), so their state and listeners never fork.
 */
import { button, el, observeSize, setPressed } from './dom';
import { icon, type IconName } from './icons';
import { menuList, openPopover, type MenuItem, type Popover } from './popover';
import { layoutRibbon, type GroupMode, type GroupWidths } from './ribbon-layout';

interface Base {
  id: string;
  label: string;
  enabled?: () => boolean;
  /** Shown in the phone bottom bar (at most five per editor). */
  phone?: boolean;
}

export interface ButtonControl extends Base {
  type: 'button';
  icon: IconName;
  run: () => void;
  pressed?: () => boolean;
  /** Show the label next to the icon on desktop. */
  showLabel?: boolean;
  /** Extra data attributes (for example `data-align`). */
  data?: Record<string, string>;
}

export interface SelectControl extends Base {
  type: 'select';
  options: () => ReadonlyArray<{ value: string; label: string }>;
  value: () => string;
  onChange: (value: string) => void;
  cls?: string;
  width?: number;
}

export interface ColorControl extends Base {
  type: 'color';
  icon: IconName;
  palette: readonly string[];
  /** The label of the "no colour / automatic" choice. */
  noneLabel: string;
  value: () => string | null;
  onPick: (hex: string | null) => void;
}

export interface MenuControl extends Base {
  type: 'menu';
  icon: IconName;
  items: () => ReadonlyArray<MenuItem | 'sep'>;
  showLabel?: boolean;
}

export interface CustomControl extends Base {
  type: 'custom';
  render: () => HTMLElement;
  sync?: () => void;
}

export type Control = ButtonControl | SelectControl | ColorControl | MenuControl | CustomControl;
export interface RibbonGroup { label: string; controls: Control[] }
export interface RibbonTab { id: string; label: string; groups: RibbonGroup[] }

/** The palette shared by every colour control (Office's standard colours plus greys). */
export const PALETTE: readonly string[] = [
  '000000', '404040', '7F7F7F', 'BFBFBF', 'FFFFFF',
  'C00000', 'FF0000', 'FFC000', 'FFFF00', '92D050',
  '00B050', '00B0F0', '0070C0', '002060', '7030A0',
  'B87333', 'C8894B', '5B8DEF', '1F4E79', 'DCE6F1',
];

interface Bound { control: Control; nodes: HTMLElement[] }

export interface RibbonLabels {
  more: string;
  tabs: string;
  /** The arrow that scrolls the tool row back towards its start. */
  scrollStart?: string;
  /** The arrow that scrolls the tool row on towards its end. */
  scrollEnd?: string;
}

let ribbonSeq = 0;

export class Ribbon {
  readonly element: HTMLElement;
  readonly phoneBar: HTMLElement;
  private readonly strip: HTMLElement;
  private readonly row: HTMLElement;
  private readonly scrollStart: HTMLButtonElement;
  private readonly scrollEnd: HTMLButtonElement;
  private readonly uid = ++ribbonSeq;
  private tabs: RibbonTab[] = [];
  /** The index of the shown tab (two tabs may share an id, an index never does). */
  private activeIndex = -1;
  private bound: Bound[] = [];
  private groupMenu: Popover | null = null;
  private lastWidth = -1;

  constructor(private readonly labels: RibbonLabels) {
    this.element = el('div', 'fo-ribbon');
    this.strip = el('div', 'fo-tabs');
    this.strip.setAttribute('role', 'tablist');
    this.strip.setAttribute('aria-label', labels.tabs);
    this.strip.addEventListener('keydown', (ev) => this.onTabKey(ev));
    this.row = el('div', 'fo-toolrow');
    this.row.setAttribute('role', 'toolbar');
    this.row.setAttribute('aria-label', labels.tabs);
    this.row.addEventListener('scroll', () => this.syncArrows(), { passive: true });
    this.scrollStart = this.arrow('start', labels.scrollStart ?? labels.more);
    this.scrollEnd = this.arrow('end', labels.scrollEnd ?? labels.more);
    const rowWrap = el('div', 'fo-rowwrap');
    rowWrap.append(this.scrollStart, this.row, this.scrollEnd);
    this.element.append(this.strip, rowWrap);
    this.phoneBar = el('div', 'fo-phonebar');
    this.phoneBar.setAttribute('role', 'toolbar');
    observeSize(this.element, () => {
      const w = this.element.clientWidth;
      if (w !== this.lastWidth) { this.lastWidth = w; this.relayout(); }
    });
    // Captions measured before the UI font arrives would be too narrow or too wide.
    try { void document.fonts?.ready.then(() => this.relayout()); } catch { /* no font loading API */ }
  }

  /** The id of the tab on show ('' before any tabs are set). */
  get current(): string {
    return this.tabs[this.activeIndex]?.id ?? '';
  }

  /**
   * Replaces the tabs (a different editor was loaded). With `keep` (the default) the tab
   * on show stays on show when the new set still has it; otherwise `initial` is shown,
   * or, without one, the second tab (the first one after File).
   */
  setTabs(tabs: RibbonTab[], initial?: string, keep = true): void {
    const was = this.current;
    this.tabs = tabs;
    const at = (id: string | undefined): number => (id ? tabs.findIndex((t) => t.id === id) : -1);
    let index = keep ? at(was) : -1;
    if (index < 0) index = at(initial);
    if (index < 0) index = tabs.length > 1 ? 1 : tabs.length - 1;
    this.activeIndex = index;
    this.render();
  }

  select(id: string): void {
    const index = this.tabs.findIndex((t) => t.id === id);
    if (index >= 0) this.show(index);
  }

  /** Shows one tab: the strip and the panels are toggled, never rebuilt, so focus stays put. */
  private show(index: number): void {
    if (index < 0 || index >= this.tabs.length) return;
    this.groupMenu?.close();
    this.activeIndex = index;
    this.strip.querySelectorAll<HTMLElement>('.fo-tab').forEach((b, i) => {
      b.setAttribute('aria-selected', String(i === index));
      b.tabIndex = i === index ? 0 : -1;
    });
    this.row.querySelectorAll<HTMLElement>(':scope > .fo-toolpanel').forEach((p, i) => { p.hidden = i !== index; });
    this.row.scrollLeft = 0;
    this.relayout();
    this.sync();
  }

  /** Arrow keys move between tabs (mirrored in RTL), Home/End jump; Enter and Space are the buttons' own. */
  private onTabKey(ev: KeyboardEvent): void {
    const tabs = [...this.strip.querySelectorAll<HTMLElement>('.fo-tab')];
    const at = tabs.indexOf(ev.target as HTMLElement);
    if (at < 0) return;
    const rtl = getComputedStyle(this.strip).direction === 'rtl';
    let next: number;
    if (ev.key === 'ArrowRight') next = rtl ? at - 1 : at + 1;
    else if (ev.key === 'ArrowLeft') next = rtl ? at + 1 : at - 1;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = tabs.length - 1;
    else return;
    ev.preventDefault();
    next = (next + tabs.length) % tabs.length;
    this.show(next);
    tabs[next].focus();
  }

  private render(): void {
    this.groupMenu?.close();
    this.bound = [];
    this.strip.replaceChildren();
    this.tabs.forEach((tab, i) => {
      const b = el('button', 'fo-tab', tab.label);
      b.type = 'button';
      b.id = `fo-rtab-${this.uid}-${i}`;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-controls', `fo-rpanel-${this.uid}-${i}`);
      b.setAttribute('aria-selected', String(i === this.activeIndex));
      b.tabIndex = i === this.activeIndex ? 0 : -1;
      b.dataset.tab = tab.id;
      b.addEventListener('click', () => this.show(i));
      this.strip.append(b);
    });
    this.row.replaceChildren();
    // Every tab's tools exist in the DOM (hidden unless active), so a shortcut or a
    // test can reach any command without switching tabs first.
    this.tabs.forEach((tab, i) => {
      const panel = el('div', 'fo-toolpanel');
      panel.id = `fo-rpanel-${this.uid}-${i}`;
      panel.dataset.tab = tab.id;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', `fo-rtab-${this.uid}-${i}`);
      panel.hidden = i !== this.activeIndex;
      for (const group of tab.groups) panel.append(this.buildGroup(group));
      this.row.append(panel);
    });
    this.renderPhoneBar();
    this.relayout();
    this.sync();
  }

  /** One group: its tools, its caption, and the dropdown that stands for it when folded. */
  private buildGroup(group: RibbonGroup): HTMLElement {
    const g = el('div', 'fo-group');
    g.setAttribute('role', 'group');
    g.setAttribute('aria-label', group.label);
    g.dataset.mode = 'full';
    const tools = el('div', 'fo-group-tools');
    for (const control of group.controls) tools.append(this.build(control, 'ribbon'));
    const caption = el('div', 'fo-group-label', group.label);
    caption.title = group.label;
    const first = group.controls.find((c): c is ButtonControl | ColorControl | MenuControl => 'icon' in c);
    // Named by `aria-label` (the caption under it shows the same words), so the group's name is
    // never a second button text next to the command that carries the same words.
    const fold = el('button', 'fo-btn fo-group-menu');
    fold.type = 'button';
    fold.title = group.label;
    fold.setAttribute('aria-label', group.label);
    fold.append(icon(first?.icon ?? 'more'), icon('chevronDown', 16));
    fold.addEventListener('mousedown', (ev) => ev.preventDefault());
    fold.addEventListener('click', () => this.openGroup(g, tools, caption, fold));
    fold.setAttribute('aria-haspopup', 'true');
    fold.setAttribute('aria-expanded', 'false');
    g.append(tools, caption, fold);
    return g;
  }

  /** A folded group's dropdown: the group's own tools move into it, and back when it closes. */
  private openGroup(g: HTMLElement, tools: HTMLElement, caption: HTMLElement, fold: HTMLElement): void {
    if (tools.parentElement !== g) { this.groupMenu?.close(); return; }
    const box = el('div', 'fo-groupdrop');
    box.append(tools);
    const onPick = (ev: MouseEvent): void => {
      const b = (ev.target as HTMLElement).closest<HTMLElement>('.fo-btn');
      // A command closes the dropdown; a control that opens a chooser of its own replaces it.
      if (b && !b.classList.contains('has-menu') && !b.classList.contains('fo-colorbtn')) pop.close();
    };
    tools.addEventListener('click', onPick);
    fold.setAttribute('aria-expanded', 'true');
    const pop = openPopover(fold, box, {
      label: g.getAttribute('aria-label') ?? '',
      onClose: () => {
        tools.removeEventListener('click', onPick);
        g.insertBefore(tools, caption);
        fold.setAttribute('aria-expanded', 'false');
        if (this.groupMenu === pop) this.groupMenu = null;
      },
    });
    this.groupMenu = pop;
  }

  private arrow(side: 'start' | 'end', label: string): HTMLButtonElement {
    const b = button(side === 'start' ? 'chevronStart' : 'chevronEnd', label, () => {
      const rtl = getComputedStyle(this.row).direction === 'rtl';
      const towardsEnd = side === 'end' ? 1 : -1;
      const step = Math.max(120, this.row.clientWidth * 0.7);
      this.row.scrollBy({ left: towardsEnd * (rtl ? -1 : 1) * step, behavior: 'smooth' });
    }, { cls: `fo-rscroll is-${side}` });
    // Keyboard users move through the tools themselves, and the row follows focus.
    b.tabIndex = -1;
    b.hidden = true;
    return b;
  }

  /** The arrows show only on the side(s) where tools are scrolled out of view. */
  private syncArrows(): void {
    const overflow = this.row.dataset.overflow === 'true';
    const scrolled = Math.abs(this.row.scrollLeft);
    const room = this.row.scrollWidth - this.row.clientWidth;
    this.scrollStart.hidden = !overflow || scrolled < 2;
    this.scrollEnd.hidden = !overflow || scrolled > room - 2;
  }

  /**
   * Fits the shown tab's groups into the row: measures every group in each mode, lets
   * `layoutRibbon` choose, and applies the result. A hidden ribbon (the phone layout)
   * measures zero and keeps every group full.
   */
  relayout(): void {
    const panel = this.row.querySelector<HTMLElement>(':scope > .fo-toolpanel:not([hidden])');
    const groups = panel ? [...panel.querySelectorAll<HTMLElement>(':scope > .fo-group')] : [];
    const cs = getComputedStyle(this.row);
    const available = this.row.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    let modes: GroupMode[] = groups.map(() => 'full');
    let overflow = false;
    if (panel && groups.length && available > 0) {
      const measure = (mode: GroupMode): number[] => {
        for (const g of groups) g.dataset.mode = mode;
        return groups.map((g) => g.getBoundingClientRect().width);
      };
      const full = measure('full');
      const icons = measure('icon');
      const menus = measure('menu');
      const widths: GroupWidths[] = groups.map((_, i) => ({ full: full[i], icon: icons[i], menu: menus[i] }));
      const gap = parseFloat(getComputedStyle(panel).columnGap) || 0;
      ({ modes, overflow } = layoutRibbon(widths, Math.floor(available), gap));
    }
    groups.forEach((g, i) => { g.dataset.mode = modes[i]; });
    this.row.dataset.overflow = String(overflow);
    this.syncArrows();
  }

  private renderPhoneBar(): void {
    this.phoneBar.replaceChildren();
    const picks = this.tabs.flatMap((t) => t.groups.flatMap((g) => g.controls)).filter((c) => c.phone).slice(0, 5);
    for (const control of picks) this.phoneBar.append(this.build(control, 'phone'));
    const more = button('more', this.labels.more, () => this.openAll(more), { cls: 'fo-more' });
    this.phoneBar.append(more);
  }

  /** The whole ribbon in a bottom sheet: tabs on top, tools below, large targets. */
  private openAll(anchor: HTMLElement): void {
    const box = el('div', 'fo-sheet-ribbon');
    const tabs = el('div', 'fo-tabs');
    const body = el('div', 'fo-sheet-tools');
    let shown = this.current;
    const draw = (): void => {
      tabs.replaceChildren();
      for (const tab of this.tabs) {
        const b = el('button', 'fo-tab', tab.label);
        b.type = 'button';
        b.setAttribute('aria-selected', String(tab.id === shown));
        b.addEventListener('click', () => { shown = tab.id; draw(); });
        tabs.append(b);
      }
      body.replaceChildren();
      this.bound = this.bound.filter((b) => b.nodes.every((n) => n.isConnected && !body.contains(n)));
      const tab = this.tabs.find((t) => t.id === shown);
      for (const group of tab?.groups ?? []) {
        body.append(el('div', 'fo-sheet-group', group.label));
        const tools = el('div', 'fo-sheet-grid');
        for (const control of group.controls) tools.append(this.build(control, 'sheet'));
        body.append(tools);
      }
      this.sync();
    };
    draw();
    box.append(tabs, body);
    openPopover(anchor, box, { label: this.labels.more, sheet: true });
  }

  private build(control: Control, where: 'ribbon' | 'phone' | 'sheet'): HTMLElement {
    const withLabel = where === 'sheet' || ((control.type === 'button' || control.type === 'menu') && !!control.showLabel && where === 'ribbon');
    let node: HTMLElement;
    switch (control.type) {
      case 'button': {
        const b = button(control.icon, control.label, () => { control.run(); this.sync(); }, {
          showLabel: withLabel, toggle: !!control.pressed, keepFocus: true,
        });
        for (const [k, v] of Object.entries(control.data ?? {})) b.dataset[k] = v;
        node = b;
        break;
      }
      case 'select': {
        const s = el('select', `fo-select${control.cls ? ` ${control.cls}` : ''}`);
        s.setAttribute('aria-label', control.label);
        s.title = control.label;
        if (control.width && where === 'ribbon') s.style.width = `${control.width}px`;
        s.addEventListener('change', () => { control.onChange(s.value); this.sync(); });
        node = s;
        break;
      }
      case 'color': node = this.colorControl(control, withLabel); break;
      case 'menu': {
        const b = button(control.icon, control.label, () => {
          const pop = openPopover(b, menuList(control.items(), () => pop.close()), { label: control.label });
        }, { showLabel: withLabel, keepFocus: true, cls: 'has-menu' });
        b.setAttribute('aria-haspopup', 'menu');
        node = b;
        break;
      }
      default: node = control.render();
    }
    node.dataset.control = control.id;
    this.bound.push({ control, nodes: [node] });
    return node;
  }

  private colorControl(control: ColorControl, withLabel: boolean): HTMLElement {
    const b = button(control.icon, control.label, () => {
      const grid = el('div', 'fo-swatches');
      const none = el('button', 'fo-swatch-none', control.noneLabel);
      none.type = 'button';
      none.addEventListener('click', () => { pop.close(); control.onPick(null); this.sync(); });
      for (const hex of control.palette) {
        const sw = el('button', 'fo-swatch');
        sw.type = 'button';
        sw.style.background = `#${hex}`;
        sw.title = `#${hex}`;
        sw.setAttribute('aria-label', `#${hex}`);
        sw.addEventListener('click', () => { pop.close(); control.onPick(hex); this.sync(); });
        grid.append(sw);
      }
      const custom = el('input');
      custom.type = 'color';
      custom.className = 'fo-swatch-custom';
      custom.setAttribute('aria-label', control.label);
      custom.addEventListener('change', () => { pop.close(); control.onPick(custom.value.slice(1).toUpperCase()); this.sync(); });
      const wrap = el('div', 'fo-colorpop');
      wrap.append(none, grid, custom);
      const pop = openPopover(b, wrap, { label: control.label });
    }, { showLabel: withLabel, keepFocus: true, cls: 'fo-colorbtn' });
    const bar = el('span', 'fo-colorbar');
    bar.setAttribute('aria-hidden', 'true');
    b.append(bar);
    return b;
  }

  /** Re-reads every control's state from its closures. */
  sync(): void {
    this.bound = this.bound.filter((b) => b.nodes.some((n) => n.isConnected));
    for (const { control, nodes } of this.bound) {
      const enabled = control.enabled ? control.enabled() : true;
      for (const node of nodes) {
        if (node instanceof HTMLButtonElement || node instanceof HTMLSelectElement) node.disabled = !enabled;
        if (control.type === 'button' && control.pressed) setPressed(node, control.pressed());
        if (control.type === 'select' && node instanceof HTMLSelectElement) {
          const opts = control.options();
          const want = control.value();
          const sig = opts.map((o) => `${o.value}\u0001${o.label}`).join('\u0002');
          if (node.dataset.sig !== sig) {
            node.replaceChildren(...opts.map((o) => { const op = el('option', undefined, o.label); op.value = o.value; return op; }));
            node.dataset.sig = sig;
          }
          if (!opts.some((o) => o.value === want) && want) {
            const op = el('option', undefined, want);
            op.value = want;
            node.append(op);
            node.dataset.sig = '';
          }
          node.value = want;
        }
        if (control.type === 'color') {
          const bar = node.querySelector<HTMLElement>('.fo-colorbar');
          const value = control.value();
          if (bar) bar.style.background = value ? `#${value}` : 'transparent';
        }
        if (control.type === 'custom') control.sync?.();
      }
    }
  }
}

/** A small icon + label (used in menus). */
export function menuIcon(name: IconName): SVGSVGElement {
  return icon(name);
}
