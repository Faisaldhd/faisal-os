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
 */
import { button, el, setPressed } from './dom';
import { icon, type IconName } from './icons';
import { menuList, openPopover, type MenuItem } from './popover';

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

export class Ribbon {
  readonly element: HTMLElement;
  readonly phoneBar: HTMLElement;
  private readonly strip: HTMLElement;
  private readonly row: HTMLElement;
  private tabs: RibbonTab[] = [];
  private active = '';
  private bound: Bound[] = [];

  constructor(private readonly labels: { more: string; tabs: string }) {
    this.element = el('div', 'fo-ribbon');
    this.strip = el('div', 'fo-tabs');
    this.strip.setAttribute('role', 'tablist');
    this.strip.setAttribute('aria-label', labels.tabs);
    this.row = el('div', 'fo-toolrow');
    this.row.setAttribute('role', 'toolbar');
    this.element.append(this.strip, this.row);
    this.phoneBar = el('div', 'fo-phonebar');
    this.phoneBar.setAttribute('role', 'toolbar');
  }

  /** Replaces the tabs (a different editor was loaded). */
  setTabs(tabs: RibbonTab[], initial?: string): void {
    this.tabs = tabs;
    const keep = tabs.some((t) => t.id === this.active);
    this.active = keep ? this.active : initial ?? tabs[1]?.id ?? tabs[0]?.id ?? '';
    this.render();
  }

  select(id: string): void {
    if (!this.tabs.some((t) => t.id === id)) return;
    this.active = id;
    this.render();
  }

  private render(): void {
    this.bound = [];
    this.strip.replaceChildren();
    for (const tab of this.tabs) {
      const b = el('button', 'fo-tab', tab.label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(tab.id === this.active));
      b.dataset.tab = tab.id;
      b.addEventListener('click', () => this.select(tab.id));
      this.strip.append(b);
    }
    this.row.replaceChildren();
    // Every tab's tools exist in the DOM (hidden unless active), so a shortcut or a
    // test can reach any command without switching tabs first.
    for (const tab of this.tabs) {
      const panel = el('div', 'fo-toolpanel');
      panel.dataset.tab = tab.id;
      panel.setAttribute('role', 'tabpanel');
      panel.hidden = tab.id !== this.active;
      for (const group of tab.groups) {
        const g = el('div', 'fo-group');
        g.setAttribute('role', 'group');
        g.setAttribute('aria-label', group.label);
        const tools = el('div', 'fo-group-tools');
        for (const control of group.controls) tools.append(this.build(control, 'ribbon'));
        g.append(tools, el('div', 'fo-group-label', group.label));
        panel.append(g);
      }
      this.row.append(panel);
    }
    this.renderPhoneBar();
    this.sync();
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
    let shown = this.active;
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
