import { describe, it, expect } from 'vitest';
import { calc, formatNumber, CalcError } from './engine';

describe('operator precedence', () => {
  it('multiplication binds tighter than addition', () => {
    expect(calc('2+3*4')).toBe(14);
    expect(calc('2*3+4')).toBe(10);
  });
  it('division binds tighter than subtraction', () => {
    expect(calc('10-8/4')).toBe(8);
  });
  it('exponent binds tighter than unary minus (like Python)', () => {
    expect(calc('-2^2')).toBe(-4);
  });
  it('exponent is right-associative', () => {
    expect(calc('2^3^2')).toBe(2 ** (3 ** 2)); // 512, not 64
  });
  it('exponent binds tighter than multiplication', () => {
    expect(calc('2*3^2')).toBe(18);
  });
});

describe('parentheses', () => {
  it('overrides default precedence', () => {
    expect(calc('(2+3)*4')).toBe(20);
  });
  it('supports nesting', () => {
    expect(calc('((1+2)*(3+4))')).toBe(21);
  });
  it('throws a syntax error on unbalanced parens', () => {
    expect(() => calc('(1+2')).toThrow(CalcError);
    expect(() => calc('1+2)')).toThrow(CalcError);
  });
});

describe('unary minus / plus', () => {
  it('negates a number', () => {
    expect(calc('-5+3')).toBe(-2);
  });
  it('handles double negation', () => {
    expect(calc('--5')).toBe(5);
  });
  it('works after an operator', () => {
    expect(calc('3*-2')).toBe(-6);
    expect(calc('3--2')).toBe(5);
  });
  it('works inside parentheses', () => {
    expect(calc('-(2+3)')).toBe(-5);
  });
});

describe('functions', () => {
  it('computes sqrt', () => {
    expect(calc('sqrt(16)')).toBe(4);
    expect(calc('√(9)')).toBe(3);
  });
  it('computes ln and log', () => {
    expect(calc('ln(1)')).toBe(0);
    expect(calc('log(100)')).toBeCloseTo(2, 10);
  });
  it('computes trig in degrees by default', () => {
    expect(calc('sin(90)', 'deg')).toBeCloseTo(1, 10);
    expect(calc('cos(180)', 'deg')).toBeCloseTo(-1, 10);
  });
  it('computes trig in radians', () => {
    expect(calc('sin(0)', 'rad')).toBeCloseTo(0, 10);
    expect(calc('cos(0)', 'rad')).toBeCloseTo(1, 10);
  });
  it('supports pi and e constants', () => {
    expect(calc('pi')).toBeCloseTo(Math.PI, 10);
    expect(calc('π*2')).toBeCloseTo(Math.PI * 2, 10);
    expect(calc('e')).toBeCloseTo(Math.E, 10);
  });
  it('supports x^y power', () => {
    expect(calc('2^10')).toBe(1024);
  });
  it('supports x² via the square postfix token', () => {
    expect(calc('5²')).toBe(25);
  });
  it('throws domain errors for invalid function inputs', () => {
    expect(() => calc('ln(-1)')).toThrow(CalcError);
    expect(() => calc('sqrt(-4)')).toThrow(CalcError);
    expect(() => calc('log(0)')).toThrow(CalcError);
  });
});

describe('percentages', () => {
  it('converts a postfixed percent to a fraction', () => {
    expect(calc('50%')).toBeCloseTo(0.5, 10);
    expect(calc('200%')).toBeCloseTo(2, 10);
  });
  it('combines with arithmetic', () => {
    expect(calc('50%*200')).toBeCloseTo(100, 10);
  });
});

describe('factorial', () => {
  it('computes factorial of small integers', () => {
    expect(calc('5!')).toBe(120);
    expect(calc('0!')).toBe(1);
  });
  it('chains with other operators', () => {
    expect(calc('3!+1')).toBe(7);
  });
  it('throws for negative or non-integer input', () => {
    expect(() => calc('(-1)!')).toThrow(CalcError);
    expect(() => calc('(1.5)!')).toThrow(CalcError);
  });
});

describe('errors', () => {
  it('throws div0 on division by zero', () => {
    try {
      calc('5/0');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(CalcError);
      expect((e as CalcError).code).toBe('div0');
    }
  });
  it('throws syntax error on garbage input', () => {
    expect(() => calc('2++*3')).toThrow(CalcError);
    expect(() => calc('')).toThrow(CalcError);
    expect(() => calc('2 3')).toThrow(CalcError);
  });
  it('throws on unknown identifiers', () => {
    expect(() => calc('foo(1)')).toThrow(CalcError);
  });
});

describe('formatNumber', () => {
  it('hides floating point artifacts (0.1+0.2)', () => {
    const r = calc('0.1+0.2');
    expect(formatNumber(r)).toBe('0.3');
  });
  it('adds thousands separators', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(formatNumber(-1234.5)).toBe('-1,234.5');
  });
  it('converts to Arabic-Indic digits when requested', () => {
    expect(formatNumber(1234, { arabicDigits: true })).toBe('١,٢٣٤');
  });
  it('renders infinity as a symbol', () => {
    expect(formatNumber(Infinity)).toBe('∞');
  });
});
