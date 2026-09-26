/**
 * Writer — rows and columns of a table inserted in this session (عمليات الجدول).
 *
 * A new table is a run of paragraphs, one per cell, each carrying its cell's place
 * (`cell: { table, row, col, rows, cols }`). Inserting or deleting a row or a column
 * rewrites that run: the cells move, every cell learns the new size, and new cells
 * start empty. The result is always in reading order (row by row), which is the
 * order the save writes the table in.
 *
 * Every cell of the result is a NEW paragraph of a NEW table (fresh ids): a table the
 * file already holds is then replaced as a whole by the save, never patched cell by
 * cell into a shape the file's own table markup cannot express.
 */
import type { ParagraphFormat } from '../model';
import type { DocBlock } from './types';

export type TableOp = 'rowAbove' | 'rowBelow' | 'colBefore' | 'colAfter' | 'deleteRow' | 'deleteCol';

export interface CellItem { block: DocBlock; format: ParagraphFormat | undefined }

/**
 * Applies one operation to the cells of a table (`items`, all of the same table) at the
 * cell `row`/`col`. New cells take ids from `nextId`. Returns null when the operation
 * would leave no cell at all (delete the table instead).
 */
export function tableOp(items: readonly CellItem[], op: TableOp, row: number, col: number, nextId: () => number): CellItem[] | null {
  const first = items[0]?.block.cell;
  if (!first) return null;
  let rows = first.rows;
  let cols = first.cols;
  const moved: CellItem[] = [];
  const at = (r: number, c: number): CellItem => {
    const tpl = items.find((it) => it.block.cell?.row === Math.min(r, first.rows - 1) && it.block.cell?.col === Math.min(c, first.cols - 1));
    return { block: { id: nextId(), runs: [{ t: 'text', text: '', props: {} }], cell: { ...first, row: r, col: c } }, format: tpl?.format };
  };
  for (const it of items) {
    const cell = it.block.cell;
    if (!cell) continue;
    let r = cell.row;
    let c = cell.col;
    if (op === 'rowAbove' && r >= row) r++;
    if (op === 'rowBelow' && r > row) r++;
    if (op === 'colBefore' && c >= col) c++;
    if (op === 'colAfter' && c > col) c++;
    if (op === 'deleteRow') { if (r === row) continue; if (r > row) r--; }
    if (op === 'deleteCol') { if (c === col) continue; if (c > col) c--; }
    moved.push({ block: { ...it.block, cell: { ...cell, row: r, col: c } }, format: it.format });
  }
  if (op === 'rowAbove' || op === 'rowBelow') {
    const r = op === 'rowAbove' ? row : row + 1;
    rows++;
    for (let c = 0; c < cols; c++) moved.push(at(r, c));
  } else if (op === 'colBefore' || op === 'colAfter') {
    const c = op === 'colBefore' ? col : col + 1;
    cols++;
    for (let r = 0; r < rows; r++) moved.push(at(r, c));
  } else if (op === 'deleteRow') rows--;
  else cols--;
  if (rows < 1 || cols < 1) return null;
  const table = nextId();
  const out = moved.map((it) => ({
    block: { ...it.block, id: nextId(), cell: { ...(it.block.cell as NonNullable<DocBlock['cell']>), table, rows, cols } },
    format: it.format,
  }));
  // Reading order; paragraphs of one cell keep the order they had.
  const order = new Map(out.map((it, i) => [it, i]));
  out.sort((a, b) => {
    const ca = a.block.cell as NonNullable<DocBlock['cell']>;
    const cb = b.block.cell as NonNullable<DocBlock['cell']>;
    return ca.row - cb.row || ca.col - cb.col || (order.get(a) ?? 0) - (order.get(b) ?? 0);
  });
  return out;
}
