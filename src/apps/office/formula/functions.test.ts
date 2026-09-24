/**
 * Every built-in function of the formula engine, with edge cases and errors.
 * Each test builds a small workbook and evaluates formulas as Excel would.
 */
import { describe, expect, it } from 'vitest';
import { dateToSerial } from './dates';
import { listFunctions } from './registry';
import { isError, type Scalar } from './values';
import { Workbook } from './workbook';

/** A workbook with `rows` on Sheet1 (strings are typed like the grid: "12" is a number). */
function book(rows: Array<Array<string | number | boolean | null>> = [], extra: Record<string, Array<Array<string | number>>> = {}): Workbook {
  const wb = new Workbook({ now: () => new Date(2026, 8, 24, 14, 30, 0) });
  wb.addSheet('Sheet1');
  rows.forEach((line, r) => line.forEach((v, c) => {
    if (v === null) return;
    if (typeof v === 'string') wb.setCell(0, r, c, v); else wb.setValue(0, r, c, v);
  }));
  for (const [name, data] of Object.entries(extra)) {
    wb.addSheet(name);
    data.forEach((line, r) => line.forEach((v, c) => wb.setCell(name, r, c, typeof v === 'number' ? String(v) : v)));
  }
  return wb;
}

/** Evaluates a formula in a cell far from the data and returns the scalar (errors as their code). */
function ev(formula: string, rows: Array<Array<string | number | boolean | null>> = [], at: [number, number] = [99, 25]): Scalar | string {
  const wb = book(rows);
  wb.setCell(0, at[0], at[1], formula);
  const v = wb.getValue(0, at[0], at[1]);
  return isError(v) ? v.code : v;
}

const close = (v: unknown, expected: number, digits = 6): void => {
  expect(typeof v).toBe('number');
  expect(v as number).toBeCloseTo(expected, digits);
};

describe('the registry', () => {
  it('has well over 60 functions, including every one the roadmap names', () => {
    const names = listFunctions();
    expect(names.length).toBeGreaterThanOrEqual(100);
    for (const n of ['SUM', 'AVERAGE', 'COUNT', 'COUNTA', 'COUNTBLANK', 'MIN', 'MAX', 'MEDIAN', 'MODE', 'STDEV', 'STDEV.P', 'VAR',
      'ROUND', 'ROUNDUP', 'ROUNDDOWN', 'INT', 'ABS', 'MOD', 'POWER', 'SQRT', 'PRODUCT', 'SUMPRODUCT', 'IF', 'IFS', 'IFERROR',
      'IFNA', 'AND', 'OR', 'NOT', 'XOR', 'SWITCH', 'CHOOSE', 'SUMIF', 'SUMIFS', 'COUNTIF', 'COUNTIFS', 'AVERAGEIF', 'AVERAGEIFS',
      'VLOOKUP', 'HLOOKUP', 'XLOOKUP', 'INDEX', 'MATCH', 'XMATCH', 'OFFSET', 'ROW', 'COLUMN', 'ROWS', 'COLUMNS', 'PMT', 'PV',
      'FV', 'NPV', 'IRR', 'RATE', 'CONCAT', 'TEXTJOIN', 'LEFT', 'RIGHT', 'MID', 'LEN', 'TRIM', 'UPPER', 'LOWER', 'PROPER',
      'SUBSTITUTE', 'FIND', 'SEARCH', 'TEXT', 'VALUE', 'TODAY', 'NOW', 'DATE', 'YEAR', 'MONTH', 'DAY', 'WEEKDAY', 'EDATE',
      'EOMONTH', 'DATEDIF']) expect(names, n).toContain(n);
  });

  it('gives #NAME? for an unknown function and #VALUE! for a wrong argument count', () => {
    expect(ev('=NOSUCH(1)')).toBe('#NAME?');
    expect(ev('=ABS()')).toBe('#VALUE!');
    expect(ev('=ABS(1,2)')).toBe('#VALUE!');
  });
});

describe('math', () => {
  const data = [['1', '2', 'x'], ['3', 'TRUE', ''], ['4', '5', '6']];
  it('SUM skips text, TRUE and blanks in ranges, but coerces direct arguments', () => {
    expect(ev('=SUM(A1:C3)', data)).toBe(21);
    expect(ev('=SUM("3",TRUE,2)')).toBe(6);
    expect(ev('=SUM("abc")')).toBe('#VALUE!');
    expect(ev('=SUM(A1:A3,10)', data)).toBe(18);
    expect(ev('=SUM(A:A)', data)).toBe(8);
    expect(ev('=SUM(1:1)', data)).toBe(3);
    expect(ev('=SUM(A1:A2)', [['1'], ['#N/A']])).toBe('#N/A');
  });
  it('AVERAGE, MIN, MAX, PRODUCT, SUMSQ', () => {
    expect(ev('=AVERAGE(A1:C3)', data)).toBe(3.5);
    expect(ev('=AVERAGE(C2:C2)', data)).toBe('#DIV/0!');
    expect(ev('=MIN(A1:C3)', data)).toBe(1);
    expect(ev('=MAX(A1:C3)', data)).toBe(6);
    expect(ev('=MAX(C1:C2)', data)).toBe(0);
    expect(ev('=MIN(-2,"-5")')).toBe(-5);
    expect(ev('=PRODUCT(A1:A3)', data)).toBe(12);
    expect(ev('=SUMSQ(3,4)')).toBe(25);
  });
  it('COUNT, COUNTA, COUNTBLANK', () => {
    expect(ev('=COUNT(A1:C3)', data)).toBe(6);
    expect(ev('=COUNT(1,"2","x",TRUE)')).toBe(3);
    expect(ev('=COUNTA(A1:C3)', data)).toBe(8);
    expect(ev('=COUNTBLANK(A1:C3)', data)).toBe(1);
    expect(ev('=COUNTBLANK(A1:D4)', data)).toBe(8);
  });
  it('MEDIAN, MODE, STDEV, STDEV.P, VAR, VAR.P', () => {
    const d = [['2'], ['4'], ['4'], ['4'], ['5'], ['5'], ['7'], ['9']];
    expect(ev('=MEDIAN(A1:A8)', d)).toBe(4.5);
    expect(ev('=MEDIAN(1,3,2)')).toBe(2);
    expect(ev('=MEDIAN(A20:A21)', d)).toBe('#NUM!');
    expect(ev('=MODE(A1:A8)', d)).toBe(4);
    expect(ev('=MODE(1,2,3)')).toBe('#N/A');
    expect(ev('=MODE.SNGL(3,1,1,3)')).toBe(3);
    expect(ev('=STDEV.P(A1:A8)', d)).toBe(2);
    close(ev('=STDEV(A1:A8)', d), 2.138089935);
    close(ev('=STDEV.S(A1:A8)', d), 2.138089935);
    expect(ev('=VAR.P(A1:A8)', d)).toBe(4);
    close(ev('=VAR(A1:A8)', d), 4.571428571);
    expect(ev('=STDEV(1)')).toBe('#DIV/0!');
  });
  it('LARGE, SMALL, RANK', () => {
    const d = [['5'], ['1'], ['9'], ['7']];
    expect(ev('=LARGE(A1:A4,2)', d)).toBe(7);
    expect(ev('=SMALL(A1:A4,1)', d)).toBe(1);
    expect(ev('=LARGE(A1:A4,5)', d)).toBe('#NUM!');
    expect(ev('=RANK(7,A1:A4)', d)).toBe(2);
    expect(ev('=RANK(7,A1:A4,1)', d)).toBe(3);
    expect(ev('=RANK(8,A1:A4)', d)).toBe('#N/A');
  });
  it('ROUND, ROUNDUP, ROUNDDOWN round half away from zero without float noise', () => {
    expect(ev('=ROUND(2.5,0)')).toBe(3);
    expect(ev('=ROUND(-2.5,0)')).toBe(-3);
    expect(ev('=ROUND(1.005,2)')).toBe(1.01);
    expect(ev('=ROUND(1234.567,-2)')).toBe(1200);
    expect(ev('=ROUNDUP(3.21,1)')).toBe(3.3);
    expect(ev('=ROUNDUP(-3.21,1)')).toBe(-3.3);
    expect(ev('=ROUNDUP(0.1+0.2,1)')).toBe(0.3);
    expect(ev('=ROUNDDOWN(3.99,0)')).toBe(3);
    expect(ev('=ROUNDDOWN(-3.99,1)')).toBe(-3.9);
    expect(ev('=ROUND("x",1)')).toBe('#VALUE!');
  });
  it('INT, TRUNC, ABS, SIGN, MOD, POWER, SQRT', () => {
    expect(ev('=INT(-3.5)')).toBe(-4);
    expect(ev('=INT(3.9)')).toBe(3);
    expect(ev('=TRUNC(-3.59,1)')).toBe(-3.5);
    expect(ev('=TRUNC(8.9)')).toBe(8);
    expect(ev('=ABS(-4)')).toBe(4);
    expect(ev('=SIGN(-0.5)')).toBe(-1);
    expect(ev('=MOD(10,3)')).toBe(1);
    expect(ev('=MOD(-3,2)')).toBe(1);
    expect(ev('=MOD(3,-2)')).toBe(-1);
    expect(ev('=MOD(5.5,1)')).toBe(0.5);
    expect(ev('=MOD(1,0)')).toBe('#DIV/0!');
    expect(ev('=POWER(2,10)')).toBe(1024);
    expect(ev('=POWER(0,0)')).toBe('#NUM!');
    expect(ev('=POWER(-8,1/3)')).toBe('#NUM!');
    expect(ev('=SQRT(16)')).toBe(4);
    expect(ev('=SQRT(-1)')).toBe('#NUM!');
  });
  it('EXP, LN, LOG, LOG10, PI, CEILING, FLOOR, EVEN, ODD', () => {
    close(ev('=EXP(1)'), Math.E);
    close(ev('=LN(EXP(2))'), 2);
    expect(ev('=LN(0)')).toBe('#NUM!');
    expect(ev('=LOG(1000)')).toBe(3);
    expect(ev('=LOG(8,2)')).toBe(3);
    expect(ev('=LOG10(0.01)')).toBe(-2);
    close(ev('=PI()'), Math.PI);
    expect(ev('=CEILING(4.3,0.5)')).toBe(4.5);
    expect(ev('=CEILING(2.5)')).toBe(3);
    expect(ev('=CEILING(3,-1)')).toBe('#NUM!');
    expect(ev('=FLOOR(4.7,0.5)')).toBe(4.5);
    expect(ev('=FLOOR(-2.5,-2)')).toBe(-2);
    expect(ev('=EVEN(1.5)')).toBe(2);
    expect(ev('=EVEN(-1)')).toBe(-2);
    expect(ev('=ODD(2)')).toBe(3);
    expect(ev('=ODD(-2.5)')).toBe(-3);
  });
  it('SUMPRODUCT multiplies ranges item by item, and works with conditions', () => {
    const d = [['1', '10'], ['2', '20'], ['3', 'x']];
    expect(ev('=SUMPRODUCT(A1:A3,B1:B3)', d)).toBe(50);
    expect(ev('=SUMPRODUCT((A1:A3>1)*B1:B2)', d)).toBe('#N/A'); // mismatched sizes leave #N/A items
    expect(ev('=SUMPRODUCT((A1:A2>1)*B1:B2)', d)).toBe(20);
    expect(ev('=SUMPRODUCT(--(A1:A3>=2))', d)).toBe(2);
    expect(ev('=SUMPRODUCT(A1:A3,B1:B2)', d)).toBe('#VALUE!');
    expect(ev('=SUMPRODUCT({1,2;3,4},{1,1;1,1})')).toBe(10);
  });
  it('RAND and RANDBETWEEN stay in range', () => {
    const r = ev('=RAND()') as number;
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThan(1);
    const k = ev('=RANDBETWEEN(3,5)') as number;
    expect([3, 4, 5]).toContain(k);
    expect(ev('=RANDBETWEEN(5,3)')).toBe('#NUM!');
  });
});

describe('logic and information', () => {
  it('IF, IFS, IFERROR, IFNA', () => {
    expect(ev('=IF(1>2,"a","b")')).toBe('b');
    expect(ev('=IF(TRUE,"a")')).toBe('a');
    expect(ev('=IF(FALSE,"a")')).toBe(false);
    expect(ev('=IF(TRUE,,1)')).toBe(0);
    expect(ev('=IF("x",1,2)')).toBe('#VALUE!');
    expect(ev('=IF(1/0,1,2)')).toBe('#DIV/0!');
    expect(ev('=IF(TRUE,1,1/0)')).toBe(1);
    expect(ev('=IFS(1>2,"a",2>1,"b")')).toBe('b');
    expect(ev('=IFS(FALSE,1)')).toBe('#N/A');
    expect(ev('=IFERROR(1/0,"bad")')).toBe('bad');
    expect(ev('=IFERROR(5,"bad")')).toBe(5);
    expect(ev('=IFNA(NA(),0)')).toBe(0);
    expect(ev('=IFNA(1/0,0)')).toBe('#DIV/0!');
  });
  it('AND, OR, NOT, XOR over values and ranges', () => {
    const d = [['TRUE', '1', 'x']];
    expect(ev('=AND(TRUE,1)')).toBe(true);
    expect(ev('=AND(TRUE,0)')).toBe(false);
    expect(ev('=AND(A1:C1)', d)).toBe(true);
    expect(ev('=OR(FALSE,0)')).toBe(false);
    expect(ev('=OR(FALSE,"TRUE")')).toBe(true);
    expect(ev('=OR(E1:E2)', d)).toBe('#VALUE!');
    expect(ev('=NOT(0)')).toBe(true);
    expect(ev('=XOR(TRUE,TRUE)')).toBe(false);
    expect(ev('=XOR(TRUE,FALSE,FALSE)')).toBe(true);
    expect(ev('=AND("x")')).toBe('#VALUE!');
  });
  it('SWITCH and CHOOSE', () => {
    expect(ev('=SWITCH(2,1,"one",2,"two")')).toBe('two');
    expect(ev('=SWITCH(3,1,"one",2,"two","other")')).toBe('other');
    expect(ev('=SWITCH(3,1,"one",2,"two")')).toBe('#N/A');
    expect(ev('=SWITCH("b","A",1,"B",2)')).toBe(2);
    expect(ev('=CHOOSE(2,"a","b","c")')).toBe('b');
    expect(ev('=CHOOSE(4,"a","b","c")')).toBe('#VALUE!');
    expect(ev('=SUM(CHOOSE(2,A1:A2,B1:B2))', [['1', '10'], ['2', '20']])).toBe(30);
  });
  it('the IS functions', () => {
    const d = [['1', 'x', null, 'TRUE', '#N/A']];
    expect(ev('=ISBLANK(C1)', d)).toBe(true);
    expect(ev('=ISBLANK(A1)', d)).toBe(false);
    expect(ev('=ISNUMBER(A1)', d)).toBe(true);
    expect(ev('=ISTEXT(B1)', d)).toBe(true);
    expect(ev('=ISNONTEXT(A1)', d)).toBe(true);
    expect(ev('=ISLOGICAL(D1)', d)).toBe(true);
    expect(ev('=ISNA(E1)', d)).toBe(true);
    expect(ev('=ISERROR(E1)', d)).toBe(true);
    expect(ev('=ISERR(E1)', d)).toBe(false);
    expect(ev('=ISERR(1/0)')).toBe(true);
    expect(ev('=ISEVEN(4)')).toBe(true);
    expect(ev('=ISODD(-3)')).toBe(true);
    expect(ev('=TRUE()')).toBe(true);
    expect(ev('=FALSE()')).toBe(false);
  });
});

describe('conditional aggregates and criteria', () => {
  const d = [
    ['Apple', '10', 'East'],
    ['Banana', '20', 'West'],
    ['apple pie', '30', 'East'],
    ['Cherry', '', 'West'],
    ['تفاح', '50', 'شرق'],
  ];
  it('SUMIF with numbers, comparisons, wildcards, blanks and Arabic', () => {
    expect(ev('=SUMIF(B1:B5,">=20")', d)).toBe(100);
    expect(ev('=SUMIF(B1:B5,20)', d)).toBe(20);
    expect(ev('=SUMIF(B1:B5,"<>20")', d)).toBe(90);
    expect(ev('=SUMIF(A1:A5,"apple*",B1:B5)', d)).toBe(40);
    expect(ev('=SUMIF(A1:A5,"APPLE",B1:B5)', d)).toBe(10);
    expect(ev('=SUMIF(A1:A5,"?anana",B1:B5)', d)).toBe(20);
    expect(ev('=SUMIF(C1:C5,"شرق",B1:B5)', d)).toBe(50);
    expect(ev('=SUMIF(A1:A5,"تفاح",B1)', d)).toBe(50); // the sum range grows to the criteria range's size
    expect(ev('=SUMIF(A1:A5,"<C",B1:B5)', d)).toBe(60);
  });
  it('COUNTIF with "", "<>", "=" and numeric text', () => {
    expect(ev('=COUNTIF(B1:B5,"")', d)).toBe(1);
    expect(ev('=COUNTIF(B1:B5,"<>")', d)).toBe(4);
    expect(ev('=COUNTIF(C1:C5,"East")', d)).toBe(2);
    expect(ev('=COUNTIF(A1:A3,"*e*")', d)).toBe(2);
    expect(ev('=COUNTIF(A1:A2,"~*")', [['*'], ['a']])).toBe(1);
    expect(ev('=COUNTIF(A1:A3,">1")', [['2'], ['x'], ['0']])).toBe(1);
    expect(ev('=COUNTIF(A1:A3,TRUE)', [['TRUE'], ['1'], ['FALSE']])).toBe(1);
  });
  it('AVERAGEIF, SUMIFS, COUNTIFS, AVERAGEIFS, MAXIFS, MINIFS', () => {
    expect(ev('=AVERAGEIF(C1:C5,"West",B1:B5)', d)).toBe(20);
    expect(ev('=AVERAGEIF(C1:C5,"North",B1:B5)', d)).toBe('#DIV/0!');
    expect(ev('=SUMIFS(B1:B5,C1:C5,"East",B1:B5,">15")', d)).toBe(30);
    expect(ev('=COUNTIFS(C1:C5,"West",A1:A5,"C*")', d)).toBe(1);
    expect(ev('=AVERAGEIFS(B1:B5,C1:C5,"East")', d)).toBe(20);
    expect(ev('=MAXIFS(B1:B5,C1:C5,"East")', d)).toBe(30);
    expect(ev('=MINIFS(B1:B5,C1:C5,"East")', d)).toBe(10);
    expect(ev('=SUMIFS(B1:B5,C1:C4,"East")', d)).toBe('#VALUE!');
  });
  it('criteria compare dates written as text', () => {
    const dates = [[String(dateToSerial(2024, 1, 10))], [String(dateToSerial(2024, 3, 1))]];
    expect(ev('=COUNTIF(A1:A2,">=2024-02-01")', dates)).toBe(1);
  });
});

describe('lookup and reference', () => {
  const table = [
    ['id', 'name', 'price'],
    ['1', 'Pen', '1.5'],
    ['2', 'Book', '12'],
    ['3', 'قلم', '4'],
    ['5', 'Bag', '30'],
  ];
  it('VLOOKUP exact and approximate', () => {
    expect(ev('=VLOOKUP(2,A2:C5,2,FALSE)', table)).toBe('Book');
    expect(ev('=VLOOKUP("book",B2:C5,2,0)', table)).toBe(12);
    expect(ev('=VLOOKUP("قلم",B2:C5,2,FALSE)', table)).toBe(4);
    expect(ev('=VLOOKUP("B*",B2:C5,2,FALSE)', table)).toBe(12);
    expect(ev('=VLOOKUP(4,A2:C5,3)', table)).toBe(4);
    expect(ev('=VLOOKUP(4,A2:C5,3,TRUE)', table)).toBe(4);
    expect(ev('=VLOOKUP(0,A2:C5,3)', table)).toBe('#N/A');
    expect(ev('=VLOOKUP(9,A2:C5,2,FALSE)', table)).toBe('#N/A');
    expect(ev('=VLOOKUP(2,A2:C5,4,FALSE)', table)).toBe('#REF!');
    expect(ev('=VLOOKUP(2,A2:C5,0,FALSE)', table)).toBe('#VALUE!');
    expect(ev('=VLOOKUP("2",A2:C5,2,FALSE)', table)).toBe('#N/A'); // text "2" is not the number 2
    expect(ev('=VLOOKUP(3,A:C,2,FALSE)', table)).toBe('قلم');
  });
  it('HLOOKUP', () => {
    const h = [['a', 'b', 'c'], ['1', '2', '3']];
    expect(ev('=HLOOKUP("b",A1:C2,2,FALSE)', h)).toBe(2);
    expect(ev('=HLOOKUP("z",A1:C2,2,FALSE)', h)).toBe('#N/A');
    expect(ev('=HLOOKUP("b",A1:C2,3,FALSE)', h)).toBe('#REF!');
  });
  it('INDEX and MATCH', () => {
    expect(ev('=INDEX(A1:C5,3,2)', table)).toBe('Book');
    expect(ev('=INDEX(B1:B5,4)', table)).toBe('قلم');
    expect(ev('=INDEX(A2:C2,3)', table)).toBe(1.5);
    expect(ev('=SUM(INDEX(A2:C5,0,3))', table)).toBe(47.5);
    expect(ev('=SUM(INDEX(A2:C5,2,0))', table)).toBe(14);
    expect(ev('=INDEX(A1:C5,6,1)', table)).toBe('#REF!');
    expect(ev('=MATCH("Bag",B1:B5,0)', table)).toBe(5);
    expect(ev('=MATCH(4,A2:A5)', table)).toBe(3);
    expect(ev('=MATCH(4,A2:A5,1)', table)).toBe(3);
    expect(ev('=MATCH(0,A2:A5,1)', table)).toBe('#N/A');
    expect(ev('=MATCH(4,{9,7,5,3,1},-1)')).toBe(3);
    expect(ev('=MATCH("x",A1:C5,0)', table)).toBe('#N/A');
    expect(ev('=INDEX(C2:C5,MATCH("Book",B2:B5,0))', table)).toBe(12);
  });
  it('XLOOKUP and XMATCH', () => {
    expect(ev('=XLOOKUP("Bag",B2:B5,C2:C5)', table)).toBe(30);
    expect(ev('=XLOOKUP("zz",B2:B5,C2:C5,"none")', table)).toBe('none');
    expect(ev('=XLOOKUP("zz",B2:B5,C2:C5)', table)).toBe('#N/A');
    expect(ev('=XLOOKUP(4,A2:A5,B2:B5,,-1)', table)).toBe('قلم');
    expect(ev('=XLOOKUP(4,A2:A5,B2:B5,,1)', table)).toBe('Bag');
    expect(ev('=XLOOKUP("b*",B2:B5,C2:C5,,2)', table)).toBe(12);
    expect(ev('=XLOOKUP("b*",B2:B5,C2:C5,,2,-1)', table)).toBe(30);
    expect(ev('=SUM(XLOOKUP(2,A2:A5,A2:C5))', table)).toBe(14);
    expect(ev('=XLOOKUP(1,A2:A5,C2:C4)', table)).toBe('#VALUE!');
    expect(ev('=XMATCH("Book",B2:B5)', table)).toBe(2);
    expect(ev('=XMATCH(4,A2:A5,1)', table)).toBe(4);
    expect(ev('=XMATCH(4,A2:A5,-1)', table)).toBe(3);
    expect(ev('=XMATCH(4,A2:A5,7)', table)).toBe('#VALUE!');
  });
  it('OFFSET, ROW, COLUMN, ROWS, COLUMNS', () => {
    expect(ev('=OFFSET(A1,2,1)', table)).toBe('Book');
    expect(ev('=SUM(OFFSET(C2,0,0,4,1))', table)).toBe(47.5);
    expect(ev('=OFFSET(A1,-1,0)', table)).toBe('#REF!');
    expect(ev('=OFFSET(A1,0,0,0,1)', table)).toBe('#REF!');
    expect(ev('=OFFSET(5,0,0)', table)).toBe('#VALUE!');
    expect(ev('=ROW()', [], [4, 2])).toBe(5);
    expect(ev('=COLUMN()', [], [4, 2])).toBe(3);
    expect(ev('=ROW(B7)')).toBe(7);
    expect(ev('=COLUMN(D2:F9)')).toBe(4);
    expect(ev('=ROW(5)')).toBe('#VALUE!');
    expect(ev('=ROWS(A1:C5)')).toBe(5);
    expect(ev('=COLUMNS(A1:C5)')).toBe(3);
    expect(ev('=ROWS(A:A)')).toBe(1048576);
    expect(ev('=COLUMNS({1,2,3})')).toBe(3);
    expect(ev('=SUM(TRANSPOSE({1,2,3}))')).toBe(6);
  });
});

describe('text', () => {
  it('CONCAT, CONCATENATE, TEXTJOIN and &', () => {
    const d = [['a', '', 'c'], ['1', '2', '3']];
    expect(ev('=CONCAT(A1:C1,"-",1/4)', d)).toBe('ac-0.25');
    expect(ev('=CONCATENATE("x",1,TRUE)')).toBe('x1TRUE');
    expect(ev('=TEXTJOIN(", ",TRUE,A1:C1)', d)).toBe('a, c');
    expect(ev('=TEXTJOIN("-",FALSE,A1:C1)', d)).toBe('a--c');
    expect(ev('="مرحبا"&" "&"بالعالم"')).toBe('مرحبا بالعالم');
    expect(ev('="n="&1/3')).toBe('n=0.333333333333333');
    expect(ev('=CONCAT(A1,1/0)', d)).toBe('#DIV/0!');
  });
  it('LEFT, RIGHT, MID, LEN (Arabic too)', () => {
    expect(ev('=LEFT("Faisal",3)')).toBe('Fai');
    expect(ev('=LEFT("Faisal")')).toBe('F');
    expect(ev('=RIGHT("Faisal",2)')).toBe('al');
    expect(ev('=RIGHT("abc",0)')).toBe('');
    expect(ev('=MID("Faisal OS",8,2)')).toBe('OS');
    expect(ev('=MID("abc",0,1)')).toBe('#VALUE!');
    expect(ev('=LEFT("abc",-1)')).toBe('#VALUE!');
    expect(ev('=LEN("فيصل")')).toBe(4);
    expect(ev('=LEFT("فيصل",2)')).toBe('في');
    expect(ev('=LEN(12.5)')).toBe(4);
  });
  it('TRIM, UPPER, LOWER, PROPER', () => {
    expect(ev('=TRIM("  a   b  ")')).toBe('a b');
    expect(ev('=UPPER("abc ص")')).toBe('ABC ص');
    expect(ev('=LOWER("ABC")')).toBe('abc');
    expect(ev('=PROPER("hello wORLD o\'neil 2nd")')).toBe('Hello World O\'neil 2Nd');
    expect(ev('=PROPER("مرحبا")')).toBe('مرحبا');
  });
  it('SUBSTITUTE, REPLACE, REPT, EXACT', () => {
    expect(ev('=SUBSTITUTE("a-b-c","-","+")')).toBe('a+b+c');
    expect(ev('=SUBSTITUTE("a-b-c","-","+",2)')).toBe('a-b+c');
    expect(ev('=SUBSTITUTE("a-b","-","+",5)')).toBe('a-b');
    expect(ev('=REPLACE("abcdef",2,3,"X")')).toBe('aXef');
    expect(ev('=REPT("ab",3)')).toBe('ababab');
    expect(ev('=REPT("a",-1)')).toBe('#VALUE!');
    expect(ev('=EXACT("a","A")')).toBe(false);
    expect(ev('=EXACT("a","a")')).toBe(true);
  });
  it('FIND is case-sensitive, SEARCH is not and takes wildcards', () => {
    expect(ev('=FIND("b","abcb")')).toBe(2);
    expect(ev('=FIND("b","abcb",3)')).toBe(4);
    expect(ev('=FIND("B","abc")')).toBe('#VALUE!');
    expect(ev('=SEARCH("B","abc")')).toBe(2);
    expect(ev('=SEARCH("c?e","abcdef")')).toBe(3);
    expect(ev('=SEARCH("x","abc")')).toBe('#VALUE!');
    expect(ev('=FIND("سل","فيصل")')).toBe('#VALUE!');
    expect(ev('=FIND("صل","فيصل")')).toBe(3);
  });
  it('TEXT, VALUE, CHAR, CODE, UNICHAR, UNICODE, T, N', () => {
    expect(ev('=TEXT(1234.567,"#,##0.00")')).toBe('1,234.57');
    expect(ev('=TEXT(0.256,"0.0%")')).toBe('25.6%');
    expect(ev('=TEXT(DATE(2024,1,15),"yyyy-mm-dd")')).toBe('2024-01-15');
    expect(ev('=TEXT("12","0.00")')).toBe('12.00');
    expect(ev('=VALUE("1,200.5")')).toBe(1200.5);
    expect(ev('=VALUE("15%")')).toBe(0.15);
    expect(ev('=VALUE("٣٫٥")')).toBe(3.5);
    expect(ev('=VALUE("abc")')).toBe('#VALUE!');
    expect(ev('=CHAR(65)')).toBe('A');
    expect(ev('=CHAR(0)')).toBe('#VALUE!');
    expect(ev('=CODE("A")')).toBe(65);
    expect(ev('=CODE("")')).toBe('#VALUE!');
    expect(ev('=UNICHAR(1601)')).toBe('ف');
    expect(ev('=UNICODE("ف")')).toBe(1601);
    expect(ev('=T(1)')).toBe('');
    expect(ev('=T("a")')).toBe('a');
    expect(ev('=N(TRUE)')).toBe(1);
    expect(ev('=N("a")')).toBe(0);
  });
});

describe('dates and times', () => {
  it('uses Excel serials, including the 1900 leap-year quirk', () => {
    expect(ev('=DATE(2024,1,15)')).toBe(45306);
    expect(ev('=DATE(1900,1,1)')).toBe(1);
    expect(ev('=DATE(1900,3,1)')).toBe(61);
    expect(ev('=DATE(2024,13,1)')).toBe(ev('=DATE(2025,1,1)'));
    expect(ev('=DATE(2024,3,0)')).toBe(ev('=DATE(2024,2,29)'));
    expect(ev('=DATE(24,1,1)')).toBe(ev('=DATE(1924,1,1)'));
    expect(ev('=DATE(10000,1,1)')).toBe('#NUM!');
  });
  it('YEAR, MONTH, DAY, HOUR, MINUTE, SECOND, TIME', () => {
    expect(ev('=YEAR(45306)')).toBe(2024);
    expect(ev('=MONTH(45306)')).toBe(1);
    expect(ev('=DAY(45306)')).toBe(15);
    expect(ev('=DAY("2024-02-29")')).toBe(29);
    expect(ev('=HOUR(0.75)')).toBe(18);
    expect(ev('=MINUTE(TIME(10,45,30))')).toBe(45);
    expect(ev('=SECOND(TIME(10,45,30))')).toBe(30);
    expect(ev('=TIME(12,0,0)')).toBe(0.5);
    expect(ev('=YEAR(-1)')).toBe('#NUM!');
    expect(ev('=MONTH("abc")')).toBe('#VALUE!');
  });
  it('TODAY and NOW read the workbook clock', () => {
    expect(ev('=TODAY()')).toBe(dateToSerial(2026, 9, 24));
    close(ev('=NOW()'), dateToSerial(2026, 9, 24) + 14.5 / 24);
    expect(ev('=اليوم()')).toBe(dateToSerial(2026, 9, 24));
  });
  it('WEEKDAY with return types', () => {
    // 2024-01-15 is a Monday.
    expect(ev('=WEEKDAY(45306)')).toBe(2);
    expect(ev('=WEEKDAY(45306,2)')).toBe(1);
    expect(ev('=WEEKDAY(45306,3)')).toBe(0);
    expect(ev('=WEEKDAY(45306,16)')).toBe(3);
    expect(ev('=WEEKDAY(45306,9)')).toBe('#NUM!');
  });
  it('EDATE and EOMONTH clamp to month ends', () => {
    expect(ev('=EDATE(DATE(2024,1,31),1)')).toBe(ev('=DATE(2024,2,29)'));
    expect(ev('=EDATE(DATE(2024,3,15),-3)')).toBe(ev('=DATE(2023,12,15)'));
    expect(ev('=EOMONTH(DATE(2024,1,15),0)')).toBe(ev('=DATE(2024,1,31)'));
    expect(ev('=EOMONTH(DATE(2024,1,15),1)')).toBe(ev('=DATE(2024,2,29)'));
    expect(ev('=EOMONTH(DATE(2024,1,15),-2)')).toBe(ev('=DATE(2023,11,30)'));
  });
  it('DATEDIF, DAYS, DATEVALUE', () => {
    expect(ev('=DATEDIF(DATE(2020,5,20),DATE(2024,3,10),"Y")')).toBe(3);
    expect(ev('=DATEDIF(DATE(2020,5,20),DATE(2024,3,10),"M")')).toBe(45);
    expect(ev('=DATEDIF(DATE(2020,5,20),DATE(2024,3,10),"D")')).toBe(1390);
    expect(ev('=DATEDIF(DATE(2020,5,20),DATE(2024,3,10),"YM")')).toBe(9);
    expect(ev('=DATEDIF(DATE(2020,5,20),DATE(2024,3,10),"MD")')).toBe(19);
    expect(ev('=DATEDIF(DATE(2020,5,20),DATE(2024,3,10),"YD")')).toBe(295);
    expect(ev('=DATEDIF(DATE(2024,1,2),DATE(2024,1,1),"D")')).toBe('#NUM!');
    expect(ev('=DATEDIF(1,2,"Q")')).toBe('#NUM!');
    expect(ev('=DAYS(DATE(2024,3,1),DATE(2024,2,1))')).toBe(29);
    expect(ev('=DATEVALUE("2024-01-15")')).toBe(45306);
    expect(ev('=DATEVALUE("nope")')).toBe('#VALUE!');
  });
});

describe('financial', () => {
  it('PMT, PV, FV, NPER match Excel', () => {
    close(ev('=PMT(0.08/12,10,10000)'), -1037.03208935, 6);
    close(ev('=PMT(0.08/12,10,10000,0,1)'), -1030.16432717, 6);
    expect(ev('=PMT(0,10,1000)')).toBe(-100);
    close(ev('=FV(0.06/12,10,-200,-500,1)'), 2581.40337406, 6);
    expect(ev('=FV(0,10,-100)')).toBe(1000);
    close(ev('=PV(0.08/12,12*20,500)'), -59777.1458615, 4);
    close(ev('=NPER(0.12/12,-100,-1000,10000,1)'), 59.6738656742, 6);
  });
  it('NPV, IRR, RATE', () => {
    const flows = [['-10000'], ['3000'], ['4200'], ['6800']];
    close(ev('=NPV(0.1,A1:A4)', flows), 1188.44338, 4);
    close(ev('=NPV(0.1,A2:A4)+A1', flows), 1307.28775, 4);
    close(ev('=IRR(A1:A4)', flows), 0.1634056, 6);
    expect(ev('=IRR({1,2,3})')).toBe('#NUM!');
    close(ev('=RATE(4*12,-200,8000)'), 0.00770147, 7);
    expect(ev('=NPV(-1,1)')).toBe('#DIV/0!');
  });
});
