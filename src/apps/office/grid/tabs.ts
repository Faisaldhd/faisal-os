/**
 * The sheet's ribbon, laid out like WPS Spreadsheets: Home (clipboard, font, alignment, number,
 * styles, cells, editing), Insert (tables, charts, links, functions), Formulas (the function
 * library), Data (sort and filter, tools), View (freeze panes, show, zoom).
 *
 * Only the layout lives here: every control calls a command the view hands in (`CalcCommands`),
 * so the ribbon never holds a copy of the sheet's state and the layout can be tested on its own.
 */
import { t } from '../../../kernel/i18n';
import type { MenuItem } from '../ui/popover';
import { PALETTE, type Control, type RibbonTab } from '../ui/ribbon';
import { el } from '../ui/dom';
import { CELL_STYLES, type CellStyleId } from './cellstyles';
import { FUNCTION_CATEGORIES, functionsIn, type FunctionCategory } from './functions';
import type { BorderPreset } from './sheetfmt';
import { chartTypeChoices, formatChoices, type ChartObject } from './sheetview';
import type { CellStyle } from './xlsxlook';
import './strings';

export type AutoFn = 'SUM' | 'AVERAGE' | 'COUNT' | 'MAX' | 'MIN';
export type FreezeKind = 'row' | 'col' | 'panes' | 'none';

export interface CalcCommands {
  fileTab(): RibbonTab;
  /** A sheet is open and may be edited. */
  editable(): boolean;
  /** Formatting is possible (an .xlsx, editable). */
  canFormat(): boolean;
  /** Formulas are possible (an .xlsx, editable). */
  canFormula(): boolean;
  style(): CellStyle | undefined;
  // clipboard
  copy(): void; cut(): void; paste(): void;
  painterOn(): boolean; togglePainter(): void;
  // font
  toggle(key: 'bold' | 'italic' | 'underline' | 'strike'): void;
  setFont(name: string): void; setSize(pt: number): void;
  setColor(hex: string | null): void; setFill(hex: string | null): void;
  borders(preset: BorderPreset): void;
  // alignment
  align(h: 'left' | 'center' | 'right'): void;
  valign(v: 'top' | 'center' | 'bottom'): void;
  toggleWrap(): void;
  merge(kind: 'center' | 'cells' | 'unmerge'): void;
  isMerged(): boolean;
  // number
  numFmt(): string; setNumFmt(code: string): void; decimals(step: 1 | -1): void;
  // styles
  addCond(kind: 'scale' | 'bars' | 'top'): void; clearCond(): void; hasCond(): boolean;
  cellStyle(id: CellStyleId): void;
  // cells
  addRow(): void; addColumn(): void; deleteRow(): void; deleteColumn(): void;
  canDeleteRow(): boolean; canDeleteColumn(): boolean;
  fitColumns(): void; askSize(kind: 'col' | 'row'): void;
  // editing
  autoSum(fn: AutoFn): void;
  sort(order: 'asc' | 'desc'): void; customSort(): void;
  toggleFilter(): void; filterOn(): boolean; isFiltered(): boolean; clearFilters(): void;
  find(): void;
  // insert
  pivot(): void;
  chart(type: ChartObject['type']): void; hasCharts(): boolean; removeCharts(): void;
  link(): void;
  insertFunction(name?: string): void;
  // data
  validation(): void; clearValidation(): void; hasValidation(): boolean;
  dedupe(): void;
  // view
  freeze(kind: FreezeKind): void; frozen(): { rows: number; cols: number };
  gridlines(): boolean; toggleGridlines(): void;
  zoom(): number; setZoom(value: number): void;
}

/** The families the font picker offers (the cell falls back to the UI font when one is missing). */
export const FONT_FAMILIES: readonly string[] = [
  'Calibri', 'Arial', 'Tahoma', 'Times New Roman', 'Segoe UI', 'Verdana', 'Courier New',
  'Noto Naskh Arabic', 'Noto Sans Arabic', 'Traditional Arabic', 'Simplified Arabic',
];
export const FONT_SIZES: readonly number[] = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72];
export const ZOOMS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** A small colour chip for a menu item (a cell style's look). */
function swatch(fill: string, color: string): HTMLElement {
  const s = el('span', 'fo-stylechip', 'A');
  s.style.background = `#${fill}`;
  s.style.color = `#${color}`;
  s.setAttribute('aria-hidden', 'true');
  return s;
}

/** The ribbon for a sheet. */
export function calcTabs(c: CalcCommands): RibbonTab[] {
  const fmt = c.canFormat;
  const style = c.style;
  const alignIs = (h: string): boolean => (style()?.hAlign ?? '') === h;
  const fnMenu = (cat: FunctionCategory): (() => ReadonlyArray<MenuItem>) => () => functionsIn(cat).map((name) => ({ label: name, run: () => c.insertFunction(name) }));
  const autoItems = (): ReadonlyArray<MenuItem> => ([
    ['SUM', 'office.autoSum'], ['AVERAGE', 'office.autoAverage'], ['COUNT', 'office.autoCount'], ['MAX', 'office.autoMax'], ['MIN', 'office.autoMin'],
  ] as const).map(([fn, key]) => ({ label: t(key), run: () => c.autoSum(fn) }));
  const chartItems = (): ReadonlyArray<MenuItem> => chartTypeChoices().map((ch) => ({ label: t(ch.labelKey), run: () => c.chart(ch.value) }));
  const sortFilterItems = (): ReadonlyArray<MenuItem | 'sep'> => [
    { label: t('office.sortAscShort'), run: () => c.sort('asc') },
    { label: t('office.sortDescShort'), run: () => c.sort('desc') },
    { label: t('office.sortCustom'), run: () => c.customSort() },
    'sep',
    { label: t('office.filterToggle'), checked: c.filterOn(), run: () => c.toggleFilter() },
    { label: t('office.filterClearAll'), disabled: !c.isFiltered(), run: () => c.clearFilters() },
  ];
  const condItems = (): ReadonlyArray<MenuItem | 'sep'> => [
    { label: t('office.condScale'), run: () => c.addCond('scale') },
    { label: t('office.condBars'), run: () => c.addCond('bars') },
    { label: t('office.condTop'), run: () => c.addCond('top') },
    'sep',
    { label: t('office.condClear'), disabled: !c.hasCond(), run: () => c.clearCond() },
  ];
  const styleItems = (): ReadonlyArray<MenuItem> => CELL_STYLES.map((s) => ({ label: t(`office.cellStyle_${s.id}`), icon: swatch(s.swatch.fill, s.swatch.color), run: () => c.cellStyle(s.id) }));
  const freezeItems = (): ReadonlyArray<MenuItem | 'sep'> => {
    const f = c.frozen();
    return [
      { label: t('office.freezePanes'), checked: f.rows > 1 || f.cols > 1 || (f.rows > 0 && f.cols > 0), run: () => c.freeze('panes') },
      { label: t('office.freezeTopRow'), checked: f.rows === 1 && f.cols === 0, run: () => c.freeze('row') },
      { label: t('office.freezeFirstCol'), checked: f.cols === 1 && f.rows === 0, run: () => c.freeze('col') },
      'sep',
      { label: t('office.unfreeze'), disabled: !f.rows && !f.cols, run: () => c.freeze('none') },
    ];
  };

  const home: RibbonTab = {
    id: 'home', label: t('office.tabHome'), groups: [
      {
        label: t('office.groupClipboard'), controls: [
          { type: 'button', id: 'paste', icon: 'paste', label: t('office.paste'), enabled: c.editable, run: () => c.paste() },
          { type: 'button', id: 'cut', icon: 'cut', label: t('office.cut'), enabled: c.editable, run: () => c.cut() },
          { type: 'button', id: 'copy', icon: 'copy', label: t('office.copy'), run: () => c.copy() },
          { type: 'button', id: 'painter', icon: 'brush', label: t('office.formatPainter'), enabled: fmt, pressed: () => c.painterOn(), run: () => c.togglePainter() },
        ],
      },
      {
        label: t('office.groupFont'), controls: [
          {
            type: 'select', id: 'fontname', label: t('office.fontName'), width: 132, cls: 'fo-fontpick', enabled: fmt,
            options: () => FONT_FAMILIES.map((f) => ({ value: f, label: f })),
            value: () => style()?.font ?? 'Calibri',
            onChange: (v) => c.setFont(v),
          },
          {
            type: 'select', id: 'fontsize', label: t('office.formatSize'), width: 64, cls: 'fo-sizepick', enabled: fmt,
            options: () => FONT_SIZES.map((n) => ({ value: String(n), label: String(n) })),
            value: () => String(style()?.size ?? 11),
            onChange: (v) => c.setSize(Number(v)),
          },
          { type: 'button', id: 'bold', phone: true, icon: 'bold', label: t('office.bold'), enabled: fmt, pressed: () => !!style()?.bold, run: () => c.toggle('bold') },
          { type: 'button', id: 'italic', icon: 'italic', label: t('office.italic'), enabled: fmt, pressed: () => !!style()?.italic, run: () => c.toggle('italic') },
          { type: 'button', id: 'underline', icon: 'underline', label: t('office.underline'), enabled: fmt, pressed: () => !!style()?.underline, run: () => c.toggle('underline') },
          { type: 'button', id: 'strike', icon: 'strike', label: t('office.formatStrike'), enabled: fmt, pressed: () => !!style()?.strike, run: () => c.toggle('strike') },
          {
            type: 'menu', id: 'borders', icon: 'borders', label: t('office.borders'), enabled: fmt, items: () => [
              { label: t('office.bordersAll'), run: () => c.borders('all') },
              { label: t('office.bordersOuter'), run: () => c.borders('outer') },
              { label: t('office.bordersBottom'), run: () => c.borders('bottom') },
              { label: t('office.bordersTop'), run: () => c.borders('top') },
              'sep',
              { label: t('office.bordersNone'), run: () => c.borders('none') },
            ],
          },
          { type: 'color', id: 'fillcolor', phone: true, icon: 'fill', label: t('office.fillColor'), palette: PALETTE, noneLabel: t('office.noFill'), enabled: fmt, value: () => style()?.fill ?? null, onPick: (hex) => c.setFill(hex) },
          { type: 'color', id: 'fontcolor', icon: 'textColor', label: t('office.fontColor'), palette: PALETTE, noneLabel: t('office.automatic'), enabled: fmt, value: () => style()?.color ?? null, onPick: (hex) => c.setColor(hex) },
        ],
      },
      {
        label: t('office.groupAlignment'), controls: [
          { type: 'button', id: 'alignright', icon: 'alignRight', label: t('office.alignRight'), enabled: fmt, pressed: () => alignIs('right'), run: () => c.align('right') },
          { type: 'button', id: 'aligncenter', icon: 'alignCenter', label: t('office.alignCenter'), enabled: fmt, pressed: () => alignIs('center'), run: () => c.align('center') },
          { type: 'button', id: 'alignleft', icon: 'alignLeft', label: t('office.alignLeft'), enabled: fmt, pressed: () => alignIs('left'), run: () => c.align('left') },
          {
            type: 'menu', id: 'valign', icon: 'layout', label: t('office.verticalAlign'), enabled: fmt, items: () => [
              { label: t('office.alignTop'), checked: style()?.vAlign === 'top', run: () => c.valign('top') },
              { label: t('office.alignMiddle'), checked: style()?.vAlign === 'center', run: () => c.valign('center') },
              { label: t('office.alignBottom'), checked: !style()?.vAlign || style()?.vAlign === 'bottom', run: () => c.valign('bottom') },
            ],
          },
          { type: 'button', id: 'wrap', icon: 'wrap', label: t('office.wrapText'), enabled: fmt, pressed: () => !!style()?.wrap, run: () => c.toggleWrap() },
          {
            type: 'menu', id: 'merge', icon: 'merge', label: t('office.mergeCenter'), enabled: fmt, items: () => [
              { label: t('office.mergeCenter'), run: () => c.merge('center') },
              { label: t('office.mergeCells'), run: () => c.merge('cells') },
              { label: t('office.unmerge'), disabled: !c.isMerged(), run: () => c.merge('unmerge') },
            ],
          },
        ],
      },
      {
        label: t('office.groupNumber'), controls: [
          {
            type: 'select', id: 'numfmt', label: t('office.numFormat'), width: 128, enabled: c.editable,
            options: () => formatChoices().map((ch) => ({ value: ch.value, label: t(ch.labelKey) })),
            value: () => c.numFmt() || 'General',
            onChange: (v) => c.setNumFmt(v),
          },
          { type: 'button', id: 'percent', icon: 'percent', label: t('office.numPercent'), enabled: c.editable, run: () => c.setNumFmt(formatChoices().find((ch) => ch.labelKey === 'office.numPercent')?.value ?? '0%') },
          { type: 'button', id: 'currency', icon: 'currency', label: t('office.numCurrency'), enabled: c.editable, run: () => c.setNumFmt(formatChoices().find((ch) => ch.labelKey === 'office.numCurrency')?.value ?? '#,##0.00') },
          { type: 'button', id: 'decadd', icon: 'decimalAdd', label: t('office.decimalAdd'), enabled: c.editable, run: () => c.decimals(1) },
          { type: 'button', id: 'decremove', icon: 'decimalRemove', label: t('office.decimalRemove'), enabled: c.editable, run: () => c.decimals(-1) },
        ],
      },
      {
        label: t('office.groupStyles'), controls: [
          { type: 'menu', id: 'condfmt', icon: 'condFormat', label: t('office.condFormatting'), enabled: c.editable, items: condItems },
          { type: 'menu', id: 'cellstyles', icon: 'styles', label: t('office.cellStyles'), enabled: fmt, items: styleItems },
        ],
      },
      {
        label: t('office.groupCells'), controls: [
          { type: 'button', id: 'addrow', icon: 'rowAdd', label: t('office.addRow'), enabled: c.editable, run: () => c.addRow() },
          { type: 'button', id: 'addcol', icon: 'colAdd', label: t('office.addColumn'), enabled: c.editable, run: () => c.addColumn() },
          { type: 'button', id: 'delrow', icon: 'rowDelete', label: t('office.deleteRow'), enabled: () => c.editable() && c.canDeleteRow(), run: () => c.deleteRow() },
          { type: 'button', id: 'delcol', icon: 'colDelete', label: t('office.deleteColumn'), enabled: () => c.editable() && c.canDeleteColumn(), run: () => c.deleteColumn() },
          {
            type: 'menu', id: 'cellsize', icon: 'columns', label: t('office.cellSize'), enabled: fmt, items: () => [
              { label: t('office.autoFitColumns'), run: () => c.fitColumns() },
              { label: t('office.columnWidth'), run: () => c.askSize('col') },
              { label: t('office.rowHeight'), run: () => c.askSize('row') },
            ],
          },
        ],
      },
      {
        label: t('office.groupEditing'), controls: [
          { type: 'button', id: 'autosum', phone: true, icon: 'sum', label: t('office.autoSum'), enabled: c.canFormula, run: () => c.autoSum('SUM') },
          { type: 'menu', id: 'autofns', icon: 'fx', label: t('office.autoFunctions'), enabled: c.canFormula, items: autoItems },
          { type: 'menu', id: 'sortfilter', phone: true, icon: 'filter', label: t('office.sortFilter'), enabled: c.editable, items: sortFilterItems },
          { type: 'button', id: 'find', icon: 'find', label: t('office.findReplace'), run: () => c.find() },
        ],
      },
    ],
  };

  const insert: RibbonTab = {
    id: 'insert', label: t('office.tabInsert'), groups: [
      {
        label: t('office.groupSheetTables'), controls: [
          { type: 'button', id: 'pivot', icon: 'table', label: t('office.pivotInsert'), showLabel: true, enabled: c.editable, run: () => c.pivot() },
        ],
      },
      {
        label: t('office.groupCharts'), controls: [
          { type: 'menu', id: 'chart', icon: 'chart', label: t('office.chartInsert'), showLabel: true, enabled: c.editable, items: chartItems },
          { type: 'button', id: 'chartclear', icon: 'close', label: t('office.chartRemoveAll'), enabled: () => c.hasCharts(), run: () => c.removeCharts() },
        ],
      },
      {
        label: t('office.groupLinks'), controls: [
          { type: 'button', id: 'link', icon: 'link', label: t('office.insertLink'), showLabel: true, enabled: c.canFormula, run: () => c.link() },
        ],
      },
      {
        label: t('office.groupFunctions'), controls: [
          { type: 'button', id: 'insertfn', phone: true, icon: 'fx', label: t('office.insertFunction'), showLabel: true, enabled: c.canFormula, run: () => c.insertFunction() },
        ],
      },
    ],
  };

  const formulas: RibbonTab = {
    id: 'formulas', label: t('office.tabFormulas'), groups: [
      {
        label: t('office.groupFunctionLibrary'), controls: [
          { type: 'button', id: 'fx', icon: 'fx', label: t('office.insertFunction'), showLabel: true, enabled: c.canFormula, run: () => c.insertFunction() },
          { type: 'menu', id: 'fnauto', icon: 'sum', label: t('office.autoSum'), showLabel: true, enabled: c.canFormula, items: autoItems },
          ...FUNCTION_CATEGORIES.filter((cat) => cat.id !== 'info').map((cat): Control => ({
            type: 'menu', id: `fn_${cat.id}`, icon: 'fx', label: t(`office.fnCat_${cat.id}`), showLabel: true, enabled: c.canFormula, items: fnMenu(cat.id),
          })),
          { type: 'menu', id: 'fn_info', icon: 'more', label: t('office.fnCat_more'), showLabel: true, enabled: c.canFormula, items: fnMenu('info') },
        ],
      },
    ],
  };

  const data: RibbonTab = {
    id: 'data', label: t('office.tabData'), groups: [
      {
        label: t('office.groupSortFilter'), controls: [
          { type: 'button', id: 'sortasc', icon: 'sortAsc', label: t('office.sortAscShort'), showLabel: true, enabled: c.editable, run: () => c.sort('asc') },
          { type: 'button', id: 'sortdesc', icon: 'sortDesc', label: t('office.sortDescShort'), showLabel: true, enabled: c.editable, run: () => c.sort('desc') },
          { type: 'button', id: 'sort', icon: 'sortAsc', label: t('office.sortCustom'), showLabel: true, enabled: c.editable, run: () => c.customSort() },
          { type: 'button', id: 'filter', icon: 'filter', label: t('office.filterToggle'), showLabel: true, enabled: c.editable, pressed: () => c.filterOn(), run: () => c.toggleFilter() },
          { type: 'button', id: 'unfilter', icon: 'close', label: t('office.filterClearAll'), showLabel: true, enabled: () => c.isFiltered(), run: () => c.clearFilters() },
        ],
      },
      {
        label: t('office.groupDataTools'), controls: [
          {
            type: 'menu', id: 'validation', icon: 'check', label: t('office.dataValidation'), showLabel: true, enabled: c.canFormat, items: () => [
              { label: t('office.dataValidation'), run: () => c.validation() },
              { label: t('office.clearValidation'), run: () => c.clearValidation(), disabled: !c.hasValidation() },
            ],
          },
          { type: 'button', id: 'dedupe', icon: 'duplicate', label: t('office.removeDuplicates'), showLabel: true, enabled: c.editable, run: () => c.dedupe() },
        ],
      },
    ],
  };

  const view: RibbonTab = {
    id: 'view', label: t('office.tabView'), groups: [
      {
        label: t('office.groupWindow'), controls: [
          { type: 'menu', id: 'freeze', icon: 'freeze', label: t('office.freezeMenu'), showLabel: true, items: freezeItems },
        ],
      },
      {
        label: t('office.groupShow'), controls: [
          { type: 'button', id: 'gridlines', icon: 'table', label: t('office.gridlines'), showLabel: true, pressed: () => c.gridlines(), run: () => c.toggleGridlines() },
        ],
      },
      {
        label: t('office.groupZoom'), controls: [
          { type: 'button', id: 'zoomout', icon: 'zoomOut', label: t('office.zoomOut'), run: () => c.setZoom(Math.max(0.5, Math.round((c.zoom() - 0.1) * 10) / 10)) },
          {
            type: 'menu', id: 'zoom', icon: 'find', label: t('office.zoomLevel'), items: () => ZOOMS.map((z) => ({ label: `${Math.round(z * 100)}%`, checked: Math.abs(c.zoom() - z) < 0.01, run: () => c.setZoom(z) })),
          },
          { type: 'button', id: 'zoomin', icon: 'zoomIn', label: t('office.zoomIn'), run: () => c.setZoom(Math.min(2, Math.round((c.zoom() + 0.1) * 10) / 10)) },
        ],
      },
    ],
  };

  return [c.fileTab(), home, insert, formulas, data, view];
}
