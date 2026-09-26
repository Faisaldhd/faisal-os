/**
 * Office — how the ribbon shrinks (تقليص الشريط), as a pure function.
 *
 * WPS and Word shrink a ribbon one group at a time, starting from the end of the row:
 * a group first drops its button captions (icons only), and when every group is
 * already icon-only, groups fold into a single dropdown button, again from the end.
 * Only when even that does not fit does the row scroll (behind arrow buttons).
 *
 * The view measures each group's width in the three modes and asks this function
 * what to draw; nothing here reads the DOM, so the rule is tested directly.
 */

export type GroupMode = 'full' | 'icon' | 'menu';

export interface GroupWidths {
  /** Width with captions (the group's natural layout). */
  full: number;
  /** Width with icon-only buttons. */
  icon: number;
  /** Width of the single dropdown button that stands for the group. */
  menu: number;
}

export interface RibbonLayout {
  modes: GroupMode[];
  /** True when the row is still wider than the room: it scrolls behind arrows. */
  overflow: boolean;
}

/** The row's width for given modes, with `gap` pixels between neighbouring groups. */
export function rowWidth(groups: readonly GroupWidths[], modes: readonly GroupMode[], gap = 0): number {
  let sum = 0;
  groups.forEach((g, i) => { sum += g[modes[i] ?? 'full']; });
  return sum + gap * Math.max(0, groups.length - 1);
}

/**
 * Picks a mode for every group so the row fits in `available` pixels, shrinking as little
 * as possible: captions go first (from the last group back), then groups fold into
 * dropdowns (again from the last group back). A step that would not make a group
 * narrower is skipped, so a group is never folded for nothing.
 */
export function layoutRibbon(groups: readonly GroupWidths[], available: number, gap = 0): RibbonLayout {
  const modes: GroupMode[] = groups.map(() => 'full');
  if (!(available > 0) || rowWidth(groups, modes, gap) <= available) return { modes, overflow: false };
  for (const step of ['icon', 'menu'] as const) {
    for (let i = groups.length - 1; i >= 0; i--) {
      const current = groups[i][modes[i]];
      if (groups[i][step] >= current) continue;
      modes[i] = step;
      if (rowWidth(groups, modes, gap) <= available) return { modes, overflow: false };
    }
  }
  return { modes, overflow: rowWidth(groups, modes, gap) > available };
}
