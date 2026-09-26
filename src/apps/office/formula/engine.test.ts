/**
 * The formula engine's machinery: tokenizer/parser/serializer, operators and
 * precedence, references (absolute, whole rows/columns, cross-sheet, quoted
 * sheet names), the dependency graph (incremental recalc, cycles, volatile
 * functions, sheet rename/remove), formula copy/shift, the SheetsModel bridge,
 * and a performance budget.
 */
import { describe, expect, it } from 'vitest';
import type { SheetsModel } from '../model';
import { formatFormula, parseFormula, shiftFormula, translateFormula } from './parser';
import { registerFunction } from './registry';
import { computeSheets, evaluateInModel, workbookFromModel } from './sheets';
import { ERR, formatGeneral, isError, textToNumber, type Scalar } from './values';
import { Workbook } from './workbook';

/**
 * This machine's speed, measured here rather than assumed: the same fixed arithmetic workload that
 * the budgets are expressed against. Load (a teammate's gate, a parallel test file) slows this by
 * the same factor it slows the engine, so the ratio below survives a busy machine while a genuine
 * regression — which adds work to the engine alone — still fails it.
 */
function referenceMs(): number {
  let sink = 0;
  const t0 = performance.now();
  for (let i = 0; i < 4_000_000; i++) sink += Math.sqrt(i & 1023);
  const ms = performance.now() - t0;
  return sink > 0 ? ms : ms; // the result is used, so the loop cannot be optimised away
}

/** A budget: at least `floorMs`, and never tighter than `factor` x this machine's own reference. */
function budgetMs(factor: number, floorMs: number): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) best = Math.min(best, referenceMs());
  return Math.max(floorMs, best * factor);
}


const show = (v: Scalar): Scalar | string => (isError(v) ? v.code : v);

function one(formula: string): Scalar | string {
  const wb = new Workbook();
  wb.addSheet('S');
  wb.setCell('S', 0, 0, formula);
  return show(wb.getValue('S', 0, 0));
}

const canon = (text: string): string => {
  const p = parseFormula(text);
  if (!p.ok) throw new Error(p.error);
  return formatFormula(p.ast);
};

describe('parsing and canonical text', () => {
  it('reads every reference shape', () => {
    expect(canon('=a1+$b$2+c$3+$d4')).toBe('A1+$B$2+C$3+$D4');
    expect(canon('=sum(a1:b9)')).toBe('SUM(A1:B9)');
    expect(canon('=SUM(B9:A1)')).toBe('SUM(A1:B9)');
    expect(canon('=SUM(a:a,$C:$D,1:1,$2:$5)')).toBe('SUM(A:A,$C:$D,1:1,$2:$5)');
    expect(canon('=Sheet2!A1+sheet2!b2:c3')).toBe('Sheet2!A1+sheet2!B2:C3');
    expect(canon("='My Sheet'!A1+'O''Brien'!B2")).toBe("'My Sheet'!A1+'O''Brien'!B2");
    expect(canon('=بيانات!A1')).toBe('بيانات!A1');
    expect(canon("='A1'!B2")).toBe("'A1'!B2");
    expect(canon('=XFD1048576')).toBe('XFD1048576');
    expect(parseFormula('=XFE1').ok).toBe(true); // not a cell: a name (#NAME? when evaluated)
    expect(one('=XFE1')).toBe('#NAME?');
  });

  it('reads functions, text, booleans, errors, arrays and missing arguments', () => {
    expect(canon('=if(a1,"x ""y""",false)')).toBe('IF(A1,"x ""y""",FALSE)');
    expect(canon('=IF(A1,,1)')).toBe('IF(A1,,1)');
    expect(canon('=TODAY()')).toBe('TODAY()');
    expect(canon('={1,2;3,-4}')).toBe('{1,2;3,-4}');
    expect(canon('=#N/A')).toBe('#N/A');
    expect(canon('=_xlfn.XLOOKUP(1,A:A,B:B)')).toBe('XLOOKUP(1,A:A,B:B)');
    expect(canon('=SUM(1;2؛3)'.replace('؛', ';'))).toBe('SUM(1,2,3)');
    expect(canon('=SUM(1،2)')).toBe('SUM(1,2)');
    expect(canon('=المتوسط(A1:A3)')).toBe('AVERAGE(A1:A3)');
    expect(canon('=STDEV.P(A1:A3)')).toBe('STDEV.P(A1:A3)');
    expect(canon('=LOG10(100)')).toBe('LOG10(100)');
    expect(canon('=( 1 + 2 ) * 3')).toBe('(1+2)*3');
  });

  it('adds _xlfn. for the file format when asked', () => {
    const p = parseFormula('=XLOOKUP(1,A1:A3,B1:B3)+SUM(1)+IFS(TRUE,1)');
    if (!p.ok) throw new Error('parse');
    expect(formatFormula(p.ast, { xlfn: true })).toBe('_xlfn.XLOOKUP(1,A1:A3,B1:B3)+SUM(1)+_xlfn.IFS(TRUE,1)');
  });

  it('refuses what does not parse, with a position', () => {
    for (const bad of ['=1+', '=SUM(1', '=(1', '="abc', '=1 2', "='Sheet!A1", '=#BOGUS', '={1,2;3}', '=@1', '=']) {
      expect(parseFormula(bad).ok, bad).toBe(false);
    }
    const r = parseFormula('=1+*2');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.at).toBe(2);
  });

  it('accepts Arabic-Indic digits', () => {
    expect(one('=٥+٣')).toBe(8);
    expect(one('=٢٫٥*2')).toBe(5);
  });
});

describe('operators', () => {
  it('follows Excel precedence', () => {
    expect(one('=1+2*3')).toBe(7);
    expect(one('=(1+2)*3')).toBe(9);
    expect(one('=2^3^2')).toBe(64);
    expect(one('=-2^2')).toBe(4);
    expect(one('=2^-1')).toBe(0.5);
    expect(one('=50%*4')).toBe(2);
    expect(one('=10%%')).toBe(0.001);
    expect(one('=1+2&3')).toBe('33');
    expect(one('=1+1=2')).toBe(true);
    expect(one('=--"3"')).toBe(3);
    expect(one('=+"a"')).toBe('a');
  });
  it('compares like Excel: numbers < text < booleans, text ignoring case', () => {
    expect(one('="a"="A"')).toBe(true);
    expect(one('=1<"a"')).toBe(true);
    expect(one('="z"<TRUE')).toBe(true);
    expect(one('="abc"<"abd"')).toBe(true);
    expect(one('=1<>1')).toBe(false);
    expect(one('=2>=2')).toBe(true);
    expect(one('="ب">"أ"')).toBe(true);
  });
  it('coerces text and produces Excel errors', () => {
    expect(one('="3"+"4"')).toBe(7);
    expect(one('="1,000"*2')).toBe(2000);
    expect(one('="a"+1')).toBe('#VALUE!');
    expect(one('=1/0')).toBe('#DIV/0!');
    expect(one('=0^0')).toBe('#NUM!');
    expect(one('=(-8)^(1/3)')).toBe('#NUM!');
    expect(one('=10^400')).toBe('#NUM!');
    expect(one('=#N/A+1')).toBe('#N/A');
    expect(one('=unknownName')).toBe('#NAME?');
    expect(one('=0.1+0.2')).toBe(0.30000000000000004);
    expect(formatGeneral(0.1 + 0.2)).toBe('0.3');
    expect(formatGeneral(1e21)).toBe('1E+21');
  });
  it('reads a blank cell as 0 and a range as its implicit intersection', () => {
    const wb = new Workbook();
    wb.addSheet('S');
    ['1', '2', '3'].forEach((v, r) => wb.setCell('S', r, 0, v));
    wb.setCell('S', 1, 1, '=A1:A3*10');
    wb.setCell('S', 5, 1, '=A1:A3');
    wb.setCell('S', 0, 2, '=Z99');
    expect(wb.getValue('S', 1, 1)).toBe(20);
    expect(wb.getValue('S', 5, 1)).toBe(ERR.VALUE);
    expect(wb.getValue('S', 0, 2)).toBe(0);
  });
});

describe('text to number', () => {
  it('reads what Excel reads', () => {
    expect(textToNumber(' 12 ')).toBe(12);
    expect(textToNumber('-1,234.5')).toBe(-1234.5);
    expect(textToNumber('15%')).toBe(0.15);
    expect(textToNumber('$4')).toBe(4);
    expect(textToNumber('1e3')).toBe(1000);
    expect(textToNumber('.5')).toBe(0.5);
    expect(textToNumber('١٢٣')).toBe(123);
    expect(textToNumber('2024-01-15')).toBe(45306);
    expect(textToNumber('12:00')).toBe(0.5);
    expect(textToNumber('1:30 PM')).toBeCloseTo(13.5 / 24, 10);
    expect(textToNumber('abc')).toBeNull();
    expect(textToNumber('1,23')).toBeNull();
    expect(textToNumber('')).toBeNull();
    expect(textToNumber('2024-13-01')).toBeNull();
  });
});

describe('the workbook and its dependency graph', () => {
  it('recalculates only what depends on a change', () => {
    let calls = 0;
    registerFunction('TESTCOUNT', (args) => { calls++; return args[0]; }, { minArgs: 1, maxArgs: 1 });
    const wb = new Workbook();
    wb.addSheet('S');
    wb.setCell('S', 0, 0, '1');
    wb.setCell('S', 0, 1, '2');
    wb.setCell('S', 1, 0, '=TESTCOUNT(A1)*2');
    wb.setCell('S', 1, 1, '=TESTCOUNT(B1)*2');
    wb.setCell('S', 2, 0, '=A2+B2');
    wb.recalc();
    expect(calls).toBe(2);
    expect(wb.getValue('S', 2, 0)).toBe(6);
    wb.setCell('S', 0, 0, '10');
    const changed = wb.recalc();
    expect(calls).toBe(3); // B2 was not recomputed
    expect(changed).toEqual([{ sheet: 'S', row: 1, col: 0 }, { sheet: 'S', row: 2, col: 0 }]);
    expect(wb.getValue('S', 2, 0)).toBe(24);
    expect(wb.recalc()).toEqual([]);
  });

  it('follows ranges, whole columns and long chains', () => {
    const wb = new Workbook();
    wb.addSheet('S');
    wb.setCell('S', 0, 0, '1');
    for (let r = 1; r < 5000; r++) wb.setCell('S', r, 0, `=A${r}+1`);
    wb.setCell('S', 0, 1, '=SUM(A:A)');
    wb.setCell('S', 1, 1, '=SUM(A4990:A5000)');
    expect(wb.getValue('S', 4999, 0)).toBe(5000);
    expect(wb.getValue('S', 0, 1)).toBe(5000 * 5001 / 2);
    wb.setCell('S', 0, 0, '2');
    expect(wb.getValue('S', 4999, 0)).toBe(5001);
    expect(wb.getValue('S', 1, 1)).toBe(11 * (4991 + 5001) / 2);
  });

  it('reports cycles as #REF! and recovers when they are broken', () => {
    const wb = new Workbook();
    wb.addSheet('S');
    wb.setCell('S', 0, 0, '=B1+1');
    wb.setCell('S', 0, 1, '=A1+1');
    wb.setCell('S', 0, 2, '=A1*2');
    wb.setCell('S', 1, 0, '=SUM(A1:A2)');
    wb.setCell('S', 2, 0, '=A3');
    expect(wb.getValue('S', 0, 0)).toBe(ERR.REF);
    expect(wb.getValue('S', 0, 1)).toBe(ERR.REF);
    expect(wb.getValue('S', 0, 2)).toBe(ERR.REF); // reads a cycle, is not in it
    expect(wb.isCircular('S', 0, 0)).toBe(true);
    expect(wb.isCircular('S', 0, 2)).toBe(false);
    expect(wb.isCircular('S', 1, 0)).toBe(true); // a range that contains itself
    expect(wb.isCircular('S', 2, 0)).toBe(true);
    wb.setCell('S', 0, 1, '5');
    expect(wb.getValue('S', 0, 0)).toBe(6);
    expect(wb.getValue('S', 0, 2)).toBe(12);
    expect(wb.isCircular('S', 0, 0)).toBe(false);
  });

  it('reads other sheets, quoted names and follows their changes', () => {
    const wb = new Workbook();
    wb.addSheet('Main');
    wb.addSheet('My Data');
    wb.addSheet('بيانات');
    wb.setCell('My Data', 0, 0, '5');
    wb.setCell('بيانات', 0, 0, '7');
    wb.setCell('Main', 0, 0, "='My Data'!A1*2+بيانات!A1");
    wb.setCell('Main', 0, 1, '=SUM(\'my data\'!A:A)');
    wb.setCell('Main', 0, 2, '=Nope!A1');
    expect(wb.getValue('Main', 0, 0)).toBe(17);
    expect(wb.getValue('Main', 0, 2)).toBe(ERR.REF);
    wb.setCell('My Data', 1, 0, '10');
    expect(wb.getValue('Main', 0, 1)).toBe(15);
    wb.addSheet('Nope');
    wb.setCell('Nope', 0, 0, '3');
    expect(wb.getValue('Main', 0, 2)).toBe(3);
  });

  it('rewrites formulas when a sheet is renamed and gives #REF! when it is removed', () => {
    const wb = new Workbook();
    wb.addSheet('A');
    wb.addSheet('Data');
    wb.setCell('Data', 0, 0, '4');
    wb.setCell('A', 0, 0, '=Data!A1*2');
    expect(wb.getValue('A', 0, 0)).toBe(8);
    wb.renameSheet('Data', 'My Data');
    expect(wb.getFormula('A', 0, 0)).toBe("='My Data'!A1*2");
    expect(wb.getValue('A', 0, 0)).toBe(8);
    wb.removeSheet('My Data');
    expect(wb.getValue('A', 0, 0)).toBe(ERR.REF);
    expect(wb.sheetNames()).toEqual(['A']);
    expect(() => wb.addSheet('a')).toThrow();
  });

  it('recalculates volatile functions every time', () => {
    let now = new Date(2026, 0, 1);
    const wb = new Workbook({ now: () => now });
    wb.addSheet('S');
    wb.setCell('S', 0, 0, '=TODAY()');
    wb.setCell('S', 0, 1, '=A1+1');
    expect(wb.getValue('S', 0, 1)).toBe(46024);
    now = new Date(2026, 0, 2);
    expect(wb.recalc()).toHaveLength(2);
    expect(wb.getValue('S', 0, 1)).toBe(46025);
  });

  it('follows references only known when evaluated (OFFSET, INDEX)', () => {
    const wb = new Workbook();
    wb.addSheet('S');
    wb.setCell('S', 0, 0, '1');
    wb.setCell('S', 1, 0, '=A1*10');
    wb.setCell('S', 0, 1, '=OFFSET(A1,1,0)+1');
    wb.setCell('S', 1, 1, '=INDEX(A1:A2,2)+2');
    expect(wb.getValue('S', 0, 1)).toBe(11);
    expect(wb.getValue('S', 1, 1)).toBe(12);
    wb.setCell('S', 0, 0, '2');
    expect(wb.getValue('S', 0, 1)).toBe(21);
    expect(wb.getValue('S', 1, 1)).toBe(22);
  });

  it('keeps a formula that does not parse as text and says so', () => {
    const wb = new Workbook();
    wb.addSheet('S');
    const r = wb.setCell('S', 0, 0, '=SUM(1');
    expect(r.ok).toBe(false);
    expect(wb.getValue('S', 0, 0)).toBe('=SUM(1');
    expect(wb.getFormula('S', 0, 0)).toBeUndefined();
  });

  it('types entered text and evaluates one-off formulas', () => {
    const wb = new Workbook();
    wb.addSheet('S');
    wb.setCell('S', 0, 0, '12');
    wb.setCell('S', 0, 1, 'true');
    wb.setCell('S', 0, 2, '#N/A');
    wb.setCell('S', 0, 3, 'نص');
    expect(wb.getValue('S', 0, 0)).toBe(12);
    expect(wb.getValue('S', 0, 1)).toBe(true);
    expect(wb.getValue('S', 0, 2)).toBe(ERR.NA);
    expect(wb.getValue('S', 0, 3)).toBe('نص');
    expect(wb.evaluate('=A1*2', 'S', 9, 9)).toBe(24);
    expect(wb.getText('S', 0, 1)).toBe('TRUE');
    wb.setCell('S', 0, 0, '');
    expect(wb.getValue('S', 0, 0)).toBeNull();
    expect(wb.formulas('S')).toEqual([]);
  });

  it('lookups stay right when the looked-up table changes (cached index)', () => {
    const wb = new Workbook();
    wb.addSheet('S');
    for (let r = 0; r < 50; r++) { wb.setCell('S', r, 0, `k${r}`); wb.setCell('S', r, 1, String(r)); }
    for (let r = 0; r < 5; r++) wb.setCell('S', r, 3, `=VLOOKUP("k${r * 10}",A1:B50,2,FALSE)`);
    expect(wb.getValue('S', 4, 3)).toBe(40);
    wb.setCell('S', 40, 0, 'changed');
    expect(wb.getValue('S', 4, 3)).toBe(ERR.NA);
    wb.setCell('S', 45, 0, 'k40');
    expect(wb.getValue('S', 4, 3)).toBe(45);
    wb.setCell('S', 45, 1, '=1+1');
    expect(wb.getValue('S', 4, 3)).toBe(2);
  });
});

describe('copying and shifting formulas', () => {
  it('moves relative references and keeps absolute ones', () => {
    expect(translateFormula('=A1+$B$1+C$1+$D1', 2, 1)).toBe('=B3+$B$1+D$1+$D3');
    expect(translateFormula('=SUM(A1:A3)', 1, 0)).toBe('=SUM(A2:A4)');
    expect(translateFormula('=SUM(A:A)', 5, 1)).toBe('=SUM(B:B)');
    expect(translateFormula("='My Sheet'!A1", 0, 1)).toBe("='My Sheet'!B1");
    expect(translateFormula('=A1', -1, 0)).toBe('=#REF!');
    expect(translateFormula('not a formula', 1, 1)).toBe('not a formula');
  });

  it('follows inserted and deleted rows and columns', () => {
    const ins = { sheet: 'S', axis: 'row' as const, at: 2, count: 2 };
    expect(shiftFormula('=A1+A3+$A$5', 'S', ins)).toBe('=A1+A5+$A$7');
    expect(shiftFormula('=SUM(A1:A10)', 'S', ins)).toBe('=SUM(A1:A12)');
    expect(shiftFormula('=Other!A5', 'S', ins)).toBe('=Other!A5');
    expect(shiftFormula('=S!A5', 'T', ins)).toBe('=S!A7');
    const del = { sheet: 'S', axis: 'row' as const, at: 2, count: -2 }; // rows 3 and 4
    expect(shiftFormula('=A3', 'S', del)).toBe('=#REF!');
    expect(shiftFormula('=A5+A2', 'S', del)).toBe('=A3+A2');
    expect(shiftFormula('=SUM(A1:A10)', 'S', del)).toBe('=SUM(A1:A8)');
    expect(shiftFormula('=SUM(A3:A4)', 'S', del)).toBe('=SUM(#REF!)');
    expect(shiftFormula('=SUM(A4:A6)', 'S', del)).toBe('=SUM(A3:A4)');
    const col = { sheet: 'S', axis: 'col' as const, at: 0, count: 1 };
    expect(shiftFormula('=A1+SUM(B:C)+SUM(1:1)', 'S', col)).toBe('=B1+SUM(C:D)+SUM(1:1)');
  });
});

describe('the SheetsModel bridge', () => {
  const model = (): SheetsModel => ({
    kind: 'xlsx', active: 0, delimiter: ',',
    grids: [
      { name: 'Sales', rows: [['10', '20'], ['30', '']], truncated: false },
      { name: 'Summary', rows: [['']], truncated: false },
    ],
    formulas: { '0:1:1': '=SUM(A1:A2)+B1', '1:0:0': '=MAX(Sales!A1:A2)&" max"' },
  });

  it('computes every formula cell into the grid text', () => {
    const out = computeSheets(model());
    expect(out.grids[0].rows[1][1]).toBe('60');
    expect(out.grids[1].rows[0][0]).toBe('30 max');
    expect(computeSheets(out)).toBe(out); // nothing changed → same object
    const plain: SheetsModel = { ...model(), formulas: undefined };
    expect(computeSheets(plain)).toBe(plain);
  });

  it('builds a workbook to keep for incremental edits', () => {
    const wb = workbookFromModel(model());
    wb.setCell('Sales', 0, 0, '100');
    expect(wb.getText('Summary', 0, 0)).toBe('100 max');
  });

  it('evaluates one typed input like the legacy engine does', () => {
    expect(evaluateInModel('=Sales!A1*2', model(), 1, { row: 3, col: 3 })).toEqual({ ok: true, value: '20', canonical: 'Sales!A1*2' });
    expect(evaluateInModel('=MIN(A1:B2)', model(), 0, { row: 5, col: 0 }).value).toBe('10');
    expect(evaluateInModel('hello', model(), 0, { row: 0, col: 0 })).toEqual({ ok: false, value: 'hello', canonical: null });
    expect(evaluateInModel('=SUM(', model(), 0, { row: 0, col: 0 }).ok).toBe(false);
    expect(evaluateInModel('=A1', model(), 0, { row: 0, col: 0 }).value).toBe('#REF!');
  });
});

/** The wall-clock budget for one recalc of the sheet below, in ms. */
/**
 * The recalc budget for the 10,000-row sheet with 1,000 VLOOKUPs.
 *
 * Measured: **92.9 ms** alone, **87.9 ms** beside two background loaders, **537.7 ms** beside six,
 * and **1404 ms** while three teammates ran their gates — a 15x swing that is the machine's load,
 * not the engine's work. A fixed ceiling therefore has to choose between failing that machine and
 * hiding a regression, so the budget is a multiple of the reference measured in this test (idle:
 * ~20x the reference, floored at 300 ms — about 3x the calm measurement of 92.9 ms). A change that
 * makes the engine do four times the work fails it on any machine; the load alone does not.
 */
const RECALC_BUDGET_MS = budgetMs(20, 300);
/** Samples per measurement: the best one is asserted, so a single stalled sample cannot fail a build. */
const RECALC_SAMPLES = 3;

/** The sheet the budget is about: `rows` rows with a SUM column, `lookups` VLOOKUPs and a total. */
function buildBigSheet(rows = 10_000, lookups = 1_000): Workbook {
  const wb = new Workbook();
  wb.addSheet('S');
  for (let r = 0; r < rows; r++) {
    wb.setValue('S', r, 0, r);
    wb.setValue('S', r, 1, `item${r}`);
    wb.setValue('S', r, 2, r * 1.5);
    wb.setCell('S', r, 3, `=SUM(A${r + 1}:C${r + 1})`);
  }
  for (let i = 0; i < lookups; i++) wb.setCell('S', i, 5, `=VLOOKUP(${(i * 7919) % rows},$A$1:$C$${rows},3,FALSE)`);
  wb.setCell('S', 0, 6, `=SUM(D1:D${rows})`);
  return wb;
}

/**
 * The best (smallest) of up to `samples` measurements, stopping as soon as one is inside `budget`.
 *
 * The claim here is "the engine can do this inside the budget"; on a shared runner one sample can
 * be stretched by a neighbour's CPU steal or a GC pause, and neither is a regression. Asserting the
 * fastest sample keeps the budget strict while making the verdict about the code rather than the
 * machine — the shape the photo engine tests already use
 * (`photo/engine/{histogram,adjust,filters}.test.ts`). A real regression is slow in every sample,
 * so it still fails; the helper itself is pinned by the test below.
 */
function bestOf(samples: number, budget: number, sample: () => number): number {
  let best = Infinity;
  for (let run = 0; run < samples && best >= budget; run++) best = Math.min(best, sample());
  return best;
}

describe('performance', () => {
  it('recalculates a 10,000-row sheet with a SUM column and 1,000 VLOOKUPs inside a budget that scales with the machine', () => {
    // Warm-up on a smaller sheet: the first pass pays for the JIT, the interned formula strings and
    // the empty dependency caches, none of which belong to the measurement.
    buildBigSheet(2_000, 200).recalc();

    let full = Infinity;
    let incremental = Infinity;
    // Exactly RECALC_SAMPLES samples, no early exit: "best of three" is only a claim if three were
    // taken, and the spread between them is what shows how loaded the machine was.
    const samples: string[] = [];
    for (let run = 0; run < RECALC_SAMPLES; run++) {
      // A fresh sheet per sample: `recalc()` only recomputes dirty cells, so re-measuring the same
      // workbook would time nothing and quietly hollow the claim out.
      const wb = buildBigSheet();
      const t0 = performance.now();
      wb.recalc();
      const sampleFull = performance.now() - t0;
      // The functional claims are asserted on EVERY sample: the numbers are the point of the test.
      expect(wb.getValue('S', 999, 5)).toBe(((999 * 7919) % 10_000) * 1.5);
      expect(wb.getValue('S', 0, 6)).toBe(10_000 * (10_000 - 1) / 2 * 2.5);
      wb.setValue('S', 500, 2, 0);
      const t1 = performance.now();
      wb.recalc();
      const sampleIncremental = performance.now() - t1;
      full = Math.min(full, sampleFull);
      incremental = Math.min(incremental, sampleIncremental);
      samples.push(`${sampleFull.toFixed(1)}/${sampleIncremental.toFixed(1)}`);
    }
    // eslint-disable-next-line no-console
    console.log(`[perf] full recalc ${full.toFixed(1)} ms, one-cell edit ${incremental.toFixed(1)} ms (best of ${RECALC_SAMPLES}: full/edit [${samples.join(', ')}]; budget ${RECALC_BUDGET_MS.toFixed(0)} ms, reference ${referenceMs().toFixed(1)} ms)`);
    expect(full).toBeLessThan(RECALC_BUDGET_MS);
    expect(incremental).toBeLessThan(RECALC_BUDGET_MS);
  });

  it('bestOf throws a load spike away and still reports a real regression', () => {
    let calls = 0;
    // First sample stalled by a busy neighbour (5 s), second is the engine's own cost.
    expect(bestOf(3, RECALC_BUDGET_MS, () => { calls += 1; return calls === 1 ? 5_000 : 42; })).toBe(42);
    expect(calls).toBe(2); // and it stops as soon as a sample is inside the budget
    // Every sample over budget is reported, so a regression cannot hide behind the best-of.
    expect(bestOf(3, RECALC_BUDGET_MS, () => 900)).toBe(900);
  });
});
