/**
 * Batch 2 of the function library: the common Excel functions that were missing.
 *
 * Each one is checked three ways — the ordinary case, the edges (zero, negative, text where a
 * number belongs, a missing argument), and what Excel itself answers, because a wrong number shown
 * confidently is worse than an error. `#NUM!`/`#VALUE!`/`#DIV/0!` are asserted as the error codes
 * the engine returns, never as a made-up value.
 */
import { describe, expect, it } from 'vitest';
import { canonicalName, listFunctions } from './registry';
import { isError, type Scalar } from './values';
import { Workbook } from './workbook';

const NEW = ['PERCENTILE', 'PERCENTILE.INC', 'QUARTILE', 'QUARTILE.INC', 'AVERAGEA', 'MAXA', 'MINA', 'GCD', 'LCM',
  'RADIANS', 'DEGREES', 'QUOTIENT', 'MROUND', 'CLEAN', 'WEEKNUM', 'TIMEVALUE', 'DAYS360', 'NETWORKDAYS', 'SLN'];

function ev(formula: string, rows: Array<Array<string | number | boolean | null>> = []): Scalar | string {
  const wb = new Workbook({ now: () => new Date(2026, 0, 5, 12, 0, 0) });
  wb.addSheet('Sheet1');
  rows.forEach((line, r) => line.forEach((v, c) => {
    if (v === null) return;
    if (typeof v === 'string') wb.setCell(0, r, c, v); else wb.setValue(0, r, c, v);
  }));
  wb.setCell(0, 99, 25, formula);
  const out = wb.getValue(0, 99, 25);
  return isError(out) ? out.code : out;
}

const close = (v: unknown, expected: number, digits = 9): void => {
  expect(typeof v, `expected a number, got ${String(v)}`).toBe('number');
  expect(v as number).toBeCloseTo(expected, digits);
};

describe('the registry knows them', () => {
  it('lists every function this batch adds', () => {
    const names = listFunctions();
    for (const n of NEW) expect(canonicalName(n), n).toBe(n.replace('.INC', ''));
    for (const n of ['PERCENTILE', 'QUARTILE', 'AVERAGEA', 'MAXA', 'MINA', 'GCD', 'LCM', 'RADIANS', 'DEGREES',
      'QUOTIENT', 'MROUND', 'CLEAN', 'WEEKNUM', 'TIMEVALUE', 'DAYS360', 'NETWORKDAYS', 'SLN']) {
      expect(names, n).toContain(n);
    }
  });
});

describe('PERCENTILE and QUARTILE', () => {
  const data = [[1], [2], [3], [4]];

  it('interpolates between the two nearest values, exactly as Excel does', () => {
    close(ev('=PERCENTILE(A1:A4,0.25)', data), 1.75);
    close(ev('=PERCENTILE(A1:A4,0)', data), 1);
    close(ev('=PERCENTILE(A1:A4,1)', data), 4);
    close(ev('=PERCENTILE(A1:A4,0.5)', data), 2.5);
    close(ev('=PERCENTILE.INC(A1:A4,0.75)', data), 3.25);
  });

  it('answers the quartiles Excel answers', () => {
    close(ev('=QUARTILE(A1:A4,0)', data), 1);
    close(ev('=QUARTILE(A1:A4,1)', data), 1.75);
    close(ev('=QUARTILE(A1:A4,2)', data), 2.5);
    close(ev('=QUARTILE(A1:A4,3)', data), 3.25);
    close(ev('=QUARTILE(A1:A4,4)', data), 4);
  });

  it('refuses what it cannot answer instead of inventing a value', () => {
    expect(ev('=PERCENTILE(A1:A4,1.5)', data)).toBe('#NUM!');
    expect(ev('=PERCENTILE(A1:A4,-0.1)', data)).toBe('#NUM!');
    expect(ev('=QUARTILE(A1:A4,5)', data)).toBe('#NUM!');
    expect(ev('=QUARTILE(A1:A4,-1)', data)).toBe('#NUM!');
    expect(ev('=PERCENTILE(B1:B3,0.5)', data)).toBe('#NUM!');   // nothing numeric in the range
    expect(ev('=PERCENTILE(A1:A4,"x")', data)).toBe('#VALUE!');
  });
});

describe('AVERAGEA, MAXA, MINA', () => {
  it('count text as zero and booleans as one, as Excel does', () => {
    close(ev('=AVERAGEA(1,"x",TRUE)'), 2 / 3);
    close(ev('=MAXA(1,"x",TRUE)'), 1);
    close(ev('=MINA(1,"x",TRUE)'), 0);
    close(ev('=AVERAGEA(A1:A2)', [['5'], ['x']]), 2.5);
  });

  it('has no answer for an empty set', () => {
    expect(ev('=AVERAGEA(B1:B3)')).toBe('#DIV/0!');
    close(ev('=MAXA(B1:B3)'), 0);
    close(ev('=MINA(B1:B3)'), 0);
  });
});

describe('GCD, LCM, RADIANS, DEGREES, QUOTIENT, MROUND', () => {
  it('answers the arithmetic Excel answers', () => {
    close(ev('=GCD(24,36)'), 12);
    close(ev('=GCD(7,13)'), 1);
    close(ev('=LCM(4,6)'), 12);
    close(ev('=LCM(0,5)'), 0);
    close(ev('=RADIANS(180)'), Math.PI);
    close(ev('=DEGREES(PI())'), 180);
    close(ev('=QUOTIENT(7,2)'), 3);
    close(ev('=QUOTIENT(-7,2)'), -3);
    close(ev('=MROUND(10,3)'), 9);
    close(ev('=MROUND(-10,-3)'), -9);
  });

  it('refuses negatives where Excel refuses them, and divides by nothing safely', () => {
    expect(ev('=GCD(-1,2)')).toBe('#NUM!');
    expect(ev('=LCM(-1,2)')).toBe('#NUM!');
    expect(ev('=QUOTIENT(1,0)')).toBe('#DIV/0!');
    expect(ev('=MROUND(10,-3)')).toBe('#NUM!');
    close(ev('=MROUND(10,0)'), 0);
    expect(ev('=GCD("x",2)')).toBe('#VALUE!');
  });
});

describe('CLEAN', () => {
  it('strips the control characters and keeps the rest, Arabic included', () => {
    expect(ev('=CLEAN(CHAR(9)&"شهري"&CHAR(10))')).toBe('شهري');
    expect(ev('=CLEAN("سنوي")')).toBe('سنوي');
    expect(ev('=CLEAN(5)')).toBe('5');
  });
});

describe('WEEKNUM, TIMEVALUE, DAYS360, NETWORKDAYS', () => {
  it('counts weeks the two Excel ways', () => {
    // 2026-01-01 is a Thursday: with Sunday weeks it is week 1, and Sunday the 4th is week 2.
    expect(ev('=WEEKNUM("2026-01-01",1)')).toBe(1);
    expect(ev('=WEEKNUM("2026-01-04",1)')).toBe(2);
    // With Monday weeks the 4th is still the first week, and Monday the 5th opens the second.
    expect(ev('=WEEKNUM("2026-01-04",2)')).toBe(1);
    expect(ev('=WEEKNUM("2026-01-05",2)')).toBe(2);
    expect(ev('=WEEKNUM("2026-01-05",3)')).toBe('#NUM!');
  });

  it('reads a time text as the fraction of a day it means', () => {
    close(ev('=TIMEVALUE("13:30")'), 0.5625);
    close(ev('=TIMEVALUE("1:30 PM")'), 0.5625);
    close(ev('=TIMEVALUE("12:00 AM")'), 0);
    expect(ev('=TIMEVALUE("25:00")')).toBe('#VALUE!');
    expect(ev('=TIMEVALUE("نص")')).toBe('#VALUE!');
  });

  it('counts a 360-day year, and working days with weekends and holidays off', () => {
    expect(ev('=DAYS360("2026-01-31","2026-03-31")')).toBe(60);
    expect(ev('=DAYS360("2026-01-01","2027-01-01")')).toBe(360);
    expect(ev('=NETWORKDAYS("2026-01-05","2026-01-09")')).toBe(5);   // Monday to Friday
    expect(ev('=NETWORKDAYS("2026-01-05","2026-01-11")')).toBe(5);   // the weekend is not counted
    expect(ev('=NETWORKDAYS("2026-01-09","2026-01-05")')).toBe(-5);  // backwards is negative
    expect(ev('=NETWORKDAYS("2026-01-05","2026-01-09","2026-01-07")')).toBe(4);  // one holiday
  });
});

describe('SLN', () => {
  it('spreads the depreciable amount evenly, and refuses a zero life', () => {
    close(ev('=SLN(1000,100,5)'), 180);
    close(ev('=SLN(1000,1000,5)'), 0);
    expect(ev('=SLN(1000,100,0)')).toBe('#DIV/0!');
    expect(ev('=SLN("x",100,5)')).toBe('#VALUE!');
  });
});
