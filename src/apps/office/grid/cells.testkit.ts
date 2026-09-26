/**
 * Test helpers for the sheet's cells (not a test file itself).
 *
 * A cell is a `td.fo-td` carrying its model row (`data-r`) and column (`data-c`), with its shown
 * text in `.fo-cellview`; the content (the formula when there is one) is what the formula bar
 * holds once the cell is selected; and typing goes through the ONE floating editor. These helpers
 * do exactly what a person does: click the cell, read the bar, double-click and type, press Enter.
 */

/** The drawn cell holding model row `r`, column `c` (`null` when that row is not drawn). */
export function cellEl(root: ParentNode, r: number, c: number): HTMLTableCellElement | null {
  return root.querySelector<HTMLTableCellElement>(`.fo-td[data-r="${r}"][data-c="${c}"]`);
}

/** The text a cell shows (its formatted value). */
export function shownAt(root: ParentNode, r: number, c: number): string | undefined {
  const td = cellEl(root, r, c);
  return td ? td.querySelector('.fo-cellview')?.textContent ?? '' : undefined;
}

/** Clicks a drawn cell (pointer down and up), the way a person selects it. */
export function clickCell(td: HTMLElement): void {
  td.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, pointerType: 'mouse' }));
  document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, pointerType: 'mouse' }));
}

/** The sheet's root (the `.fo-calc` element) around a node. */
function calcOf(node: Element): HTMLElement {
  return (node.closest('.fo-calc') ?? node) as HTMLElement;
}

/** What a cell holds — its formula, else its value — read from the formula bar after selecting it. */
export function rawAt(root: ParentNode, r: number, c: number): string | undefined {
  const td = cellEl(root, r, c);
  if (!td) return undefined;
  clickCell(td);
  return calcOf(td).querySelector<HTMLInputElement>('.fo-fxinput')?.value;
}

/** The floating editor, when an entry is open. */
export function openEditor(root: ParentNode): HTMLInputElement | null {
  return root.querySelector<HTMLInputElement>('.fo-celleditor:not(.is-idle)');
}

/**
 * Types `text` into a cell and presses Enter: select it, double-click to open the editor, replace
 * the text, commit. Returns false when no editor opened (a read-only sheet or cell).
 */
export function typeInto(td: HTMLElement, text: string): boolean {
  clickCell(td);
  td.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  const editor = openEditor(calcOf(td));
  if (!editor) return false;
  editor.value = text;
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  return true;
}

/** `typeInto` by model row and column. */
export function typeAt(root: ParentNode, r: number, c: number, text: string): boolean {
  const td = cellEl(root, r, c);
  if (!td) throw new Error(`no drawn cell at model row ${r}, column ${c}`);
  return typeInto(td, text);
}

/**
 * Filters a column the way a person does: Data → Filter shows the ▼ arrows (unless they are
 * already on), the column's arrow opens its list, the values in `keep` stay ticked, OK.
 */
export function filterColumn(root: HTMLElement, col: number, keep: readonly string[], toggleArrows: () => void): void {
  if (!root.querySelector('.fo-filterbtn')) toggleArrows();
  const arrow = root.querySelector<HTMLButtonElement>(`.fo-filterbtn[data-c="${col}"]`);
  if (!arrow) throw new Error(`no filter arrow on column ${col}`);
  arrow.click();
  const pop = document.querySelector<HTMLElement>('.fo-filterpop');
  if (!pop) throw new Error('the filter list did not open');
  for (const line of [...pop.querySelectorAll<HTMLElement>('.fo-filteritem:not(.is-all)')]) {
    const box = line.querySelector('input');
    if (!box) continue;
    // The line reads "2 (1)": the value, then how many rows carry it.
    const value = (line.textContent ?? '').replace(/\s*\(\d+\)\s*$/, '').trim();
    box.checked = keep.includes(value);
    box.dispatchEvent(new Event('change', { bubbles: true }));
  }
  pop.querySelector<HTMLButtonElement>('.fo-filterpop-ok')!.click();
}
