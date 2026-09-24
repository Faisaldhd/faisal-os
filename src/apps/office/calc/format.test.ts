/** Number formats, conditional formatting and data validation. */
import { describe, expect, it } from 'vitest';
import { dateToSerial } from '../formula/dates';
import { ERR } from '../formula/values';
import { evaluateConditionalFormats, interpolateColor } from './condfmt';
import { BUILTIN_FORMATS, formatValue, isDateFormat, makeFormat, parseEntry } from './numfmt';
import { listOptions, parseListSource, validateEntry, VALIDATION_MESSAGES } from './validation';

const fmt = (v: Parameters<typeof formatValue>[0], p: string, o?: Parameters<typeof formatValue>[2]): string => formatValue(v, p, o).text;

describe('number formats', () => {
  it('General', () => {
    expect(fmt(1234.5, 'General')).toBe('1234.5');
    expect(fmt(1 / 3, 'General')).toBe('0.3333333333');
    expect(fmt(-2, 'General')).toBe('-2');
    expect(fmt(0.1 + 0.2, 'General')).toBe('0.3');
    expect(fmt('abc', 'General')).toBe('abc');
    expect(fmt(true, 'General')).toBe('TRUE');
    expect(fmt(true, 'General', { locale: 'ar' })).toBe('صحيح');
    expect(fmt(ERR.DIV0, '0.00')).toBe('#DIV/0!');
    expect(fmt(null, '0.00')).toBe('');
  });

  it('decimals, grouping, scaling and rounding', () => {
    expect(fmt(3.14159, '0.00')).toBe('3.14');
    expect(fmt(2.005, '0.00')).toBe('2.01');
    expect(fmt(-2.5, '0')).toBe('-3');
    expect(fmt(1234567.891, '#,##0')).toBe('1,234,568');
    expect(fmt(1234567.891, '#,##0.00')).toBe('1,234,567.89');
    expect(fmt(-1234.5, '#,##0.00')).toBe('-1,234.50');
    expect(fmt(0.5, '#.00')).toBe('.50');
    expect(fmt(5, '000')).toBe('005');
    expect(fmt(1.5, '0.0#')).toBe('1.5');
    expect(fmt(1.567, '0.0#')).toBe('1.57');
    expect(fmt(1.5, '0.??')).toBe('1.5 ');
    expect(fmt(1234567, '#,##0,')).toBe('1,235');
    expect(fmt(1234567, '0.0,,"M"')).toBe('1.2M');
    expect(fmt(5551234, '000-0000')).toBe('555-1234');
    expect(fmt(0, '#,##0')).toBe('0');
  });

  it('percent, scientific, fractions', () => {
    expect(fmt(0.256, '0%')).toBe('26%');
    expect(fmt(0.256, '0.0%')).toBe('25.6%');
    expect(fmt(-0.05, '0%')).toBe('-5%');
    expect(fmt(12345, '0.00E+00')).toBe('1.23E+04');
    expect(fmt(0.00012, '0.0E+0')).toBe('1.2E-4');
    expect(fmt(12345, '##0.0E+0')).toBe('12.3E+3');
    expect(fmt(1.25, '# ?/?')).toBe('1 1/4');
    expect(fmt(0.333, '?/?')).toBe('1/3');
    expect(fmt(2.5, '# ?/8')).toBe('2 4/8');
    expect(fmt(3, '# ?/?')).toBe('3    ');
  });

  it('currency, literals, colours, sections and conditions', () => {
    expect(fmt(1234.5, '"$"#,##0.00')).toBe('$1,234.50');
    expect(fmt(-1234.5, '"$"#,##0.00')).toBe('-$1,234.50');
    expect(fmt(1234.5, '#,##0.00 "ر.س"')).toBe('1,234.50 ر.س');
    expect(fmt(9.5, '[$€-407]#,##0.00')).toBe('€9.50');
    expect(fmt(-5, '#,##0;(#,##0)')).toBe('(5)');
    expect(formatValue(-5, '#,##0;[Red]-#,##0').color).toBe('#E5484D');
    expect(fmt(0, '0;-0;"zero"')).toBe('zero');
    expect(fmt('x', '0;-0;0;"text: "@')).toBe('text: x');
    expect(fmt('x', '@')).toBe('x');
    expect(fmt(5, '0;;')).toBe('5');
    expect(fmt(-5, '0;;')).toBe('');
    expect(fmt(150, '[>100]"big";"small"')).toBe('big');
    expect(fmt(50, '[>100]"big";"small"')).toBe('small');
    expect(fmt(3, '0\\x')).toBe('3x');
    expect(fmt(3, '_(0_)')).toBe(' 3 ');
  });

  it('dates and times', () => {
    const d = dateToSerial(2024, 1, 5) + (14 * 3600 + 7 * 60 + 9) / 86400;
    expect(fmt(d, 'yyyy-mm-dd')).toBe('2024-01-05');
    expect(fmt(d, 'dd/mm/yy')).toBe('05/01/24');
    expect(fmt(d, 'd mmm yyyy')).toBe('5 Jan 2024');
    expect(fmt(d, 'dddd, mmmm d')).toBe('Friday, January 5');
    expect(fmt(d, 'mmmmm')).toBe('J');
    expect(fmt(d, 'h:mm AM/PM')).toBe('2:07 PM');
    expect(fmt(d, 'hh:mm:ss')).toBe('14:07:09');
    expect(fmt(d, 'm/d/yyyy h:mm')).toBe('1/5/2024 14:07');
    expect(fmt(1.5, '[h]:mm')).toBe('36:00');
    expect(fmt(d, 'd mmmm yyyy', { locale: 'ar' })).toBe('5 يناير 2024');
    expect(fmt(d, 'dddd h:mm AM/PM', { locale: 'ar' })).toBe('الجمعة 2:07 م');
    expect(fmt(-1, 'yyyy-mm-dd')).toBe('########');
    expect(isDateFormat('dd/mm/yyyy')).toBe(true);
    expect(isDateFormat('#,##0.00')).toBe(false);
    expect(isDateFormat(BUILTIN_FORMATS[14])).toBe(true);
  });

  it('writes Arabic-Indic digits on request, leaving quoted text alone', () => {
    expect(fmt(1234.5, '#,##0.00', { digits: 'arabic' })).toBe('١٬٢٣٤٫٥٠');
    expect(fmt(0.25, '0%', { digits: 'arabic' })).toBe('٢٥%');
    expect(fmt(5, '0 "Q1"', { digits: 'arabic' })).toBe('٥ Q1');
    expect(fmt(dateToSerial(2024, 3, 9), 'yyyy/mm/dd', { digits: 'arabic' })).toBe('٢٠٢٤/٠٣/٠٩');
  });

  it('builds patterns from toolbar choices', () => {
    expect(makeFormat({ kind: 'number' })).toBe('#,##0.00');
    expect(makeFormat({ kind: 'number', decimals: 0, grouping: false })).toBe('0');
    expect(makeFormat({ kind: 'percent', decimals: 1 })).toBe('0.0%');
    expect(makeFormat({ kind: 'currency', symbol: 'ر.س', symbolAfter: true })).toBe('#,##0.00 "ر.س"');
    expect(makeFormat({ kind: 'currency' })).toBe('"$"#,##0.00');
    expect(makeFormat({ kind: 'date', style: 'iso' })).toBe('yyyy-mm-dd');
    expect(makeFormat({ kind: 'time', seconds: true })).toBe('hh:mm:ss');
    expect(makeFormat({ kind: 'scientific', decimals: 1 })).toBe('0.0E+00');
    expect(makeFormat({ kind: 'text' })).toBe('@');
    expect(makeFormat({ kind: 'general' })).toBe('General');
  });

  it('reads typed entries the way Excel does', () => {
    expect(parseEntry('12%')).toEqual({ value: 0.12, format: '0%' });
    expect(parseEntry('12.5%')).toEqual({ value: 0.125, format: '0.0%' });
    expect(parseEntry('$1,200.50')).toEqual({ value: 1200.5, format: '"$"#,##0.00' });
    expect(parseEntry('1,200')).toEqual({ value: 1200, format: '#,##0' });
    expect(parseEntry('2024-01-15')).toEqual({ value: 45306, format: 'yyyy-mm-dd' });
    expect(parseEntry('15/1/2024')).toEqual({ value: 45306, format: 'dd/mm/yyyy' });
    expect(parseEntry('1/15/2024', { dateOrder: 'mdy' })).toEqual({ value: 45306, format: 'mm/dd/yyyy' });
    expect(parseEntry('31/02/2024')).toEqual({ value: '31/02/2024' });
    expect(parseEntry('14:30')).toEqual({ value: 14.5 / 24, format: 'h:mm' });
    expect(parseEntry('2:30 pm').value).toBeCloseTo(14.5 / 24, 10);
    expect(parseEntry('١٢٣')).toEqual({ value: 123 });
    expect(parseEntry('-4.5')).toEqual({ value: -4.5 });
    expect(parseEntry("'007")).toEqual({ value: '007' });
    expect(parseEntry('true')).toEqual({ value: true });
    expect(parseEntry('')).toEqual({ value: null });
    expect(parseEntry('مرحبا')).toEqual({ value: 'مرحبا' });
  });
});

describe('conditional formatting', () => {
  it('interpolates colours', () => {
    expect(interpolateColor('#000000', '#FFFFFF', 0.5)).toBe('#808080');
    expect(interpolateColor('#F00', '#00F', 0)).toBe('#FF0000');
    expect(interpolateColor('#F00', '#00F', 2)).toBe('#0000FF');
  });

  it('applies 2- and 3-point colour scales to numbers only', () => {
    const v = [['0', '50', '100', 'x', '']];
    const two = evaluateConditionalFormats(v, [{ type: 'colorScale', min: { kind: 'min', color: '#FFFFFF' }, max: { kind: 'max', color: '#000000' } }]);
    expect(two[0].map((s) => s?.fill)).toEqual(['#FFFFFF', '#808080', '#000000', undefined, undefined]);
    const three = evaluateConditionalFormats([[0, 25, 50, 100]], [{
      type: 'colorScale', min: { kind: 'number', value: 0, color: '#FF0000' }, mid: { kind: 'percentile', value: 50, color: '#FFFF00' }, max: { kind: 'max', color: '#00FF00' },
    }]);
    // the median of 0, 25, 50, 100 is 37.5
    expect(three[0][0]!.fill).toBe('#FF0000');
    expect(three[0][2]!.fill).toBe(interpolateColor('#FFFF00', '#00FF00', 12.5 / 62.5));
    expect(three[0][3]!.fill).toBe('#00FF00');
  });

  it('draws data bars from a zero axis, negatives to the other side', () => {
    const [row] = evaluateConditionalFormats([[-50, 0, 50, 100]], [{ type: 'dataBar', color: '#5B8DEF', showValue: false }]);
    expect(row[0]!.bar).toEqual({ start: 0, end: 1 / 3, color: '#E5484D', negative: true });
    expect(row[3]!.bar).toMatchObject({ start: 1 / 3, end: 1, negative: false });
    expect(row[2]!.bar!.end - row[2]!.bar!.start).toBeCloseTo(1 / 3);
    expect(row[1]!.hideValue).toBe(true);
    const [pos] = evaluateConditionalFormats([[5, 10]], [{ type: 'dataBar', color: '#123456' }]);
    expect(pos[0]!.bar).toMatchObject({ start: 0, end: 0.5 });
  });

  it('matches simple rules with priority and stopIfTrue', () => {
    const red = { fill: '#E5484D' };
    const bold = { bold: true, fill: '#3DD68C' };
    const values = [['5', '15', '25', 'Apple pie', '', '#N/A']];
    const [row] = evaluateConditionalFormats(values, [
      { type: 'cellIs', op: 'gt', value: 10, style: red },
      { type: 'cellIs', op: 'between', value: 20, value2: 30, style: bold },
    ]);
    expect(row[0]).toBeNull();
    expect(row[1]).toEqual({ fill: '#E5484D' });
    expect(row[2]).toEqual({ fill: '#E5484D', bold: true }); // the first rule keeps its fill
    const [stop] = evaluateConditionalFormats(values, [
      { type: 'cellIs', op: 'gt', value: 10, style: red, stopIfTrue: true },
      { type: 'cellIs', op: 'gt', value: 0, style: { italic: true } },
    ]);
    expect(stop[2]).toEqual({ fill: '#E5484D' });
    expect(stop[0]).toEqual({ italic: true });
    const [text] = evaluateConditionalFormats(values, [{ type: 'text', op: 'contains', text: 'PIE', style: red }]);
    expect(text.map(Boolean)).toEqual([false, false, false, true, false, false]);
    const [kinds] = evaluateConditionalFormats(values, [
      { type: 'blank', style: { fill: '#111111' } },
      { type: 'error', style: { color: '#E5484D' } },
    ]);
    expect(kinds[4]).toEqual({ fill: '#111111' });
    expect(kinds[5]).toEqual({ color: '#E5484D' });
    const [eq] = evaluateConditionalFormats([['تم', 'لا']], [{ type: 'cellIs', op: 'eq', value: 'تم', style: bold }]);
    expect(eq.map(Boolean)).toEqual([true, false]);
  });

  it('finds duplicates, uniques, top/bottom and above average', () => {
    const v = [['a', 'A', 'b', '1', '2', '3', '10']];
    const [dup] = evaluateConditionalFormats(v, [{ type: 'duplicate', style: { bold: true } }]);
    expect(dup.map(Boolean)).toEqual([true, true, false, false, false, false, false]);
    const [uni] = evaluateConditionalFormats(v, [{ type: 'unique', style: { bold: true } }]);
    expect(uni.map(Boolean)).toEqual([false, false, true, true, true, true, true]);
    const [top] = evaluateConditionalFormats(v, [{ type: 'top', count: 2, style: { bold: true } }]);
    expect(top.map(Boolean)).toEqual([false, false, false, false, false, true, true]);
    const [bottom] = evaluateConditionalFormats(v, [{ type: 'top', count: 25, percent: true, bottom: true, style: { bold: true } }]);
    expect(bottom.map(Boolean)).toEqual([false, false, false, true, false, false, false]);
    const [avg] = evaluateConditionalFormats(v, [{ type: 'average', style: { bold: true } }]);
    expect(avg.map(Boolean)).toEqual([false, false, false, false, false, false, true]);
  });
});

describe('data validation', () => {
  it('checks list entries, ignoring case, and returns the list item', () => {
    const rule = { kind: 'list' as const, items: ['نعم', 'لا', 'Maybe', 'maybe', ' '] };
    expect(listOptions(rule)).toEqual(['نعم', 'لا', 'Maybe']);
    expect(validateEntry('maybe', rule)).toEqual({ ok: true, value: 'Maybe' });
    expect(validateEntry('نعم', rule)).toEqual({ ok: true, value: 'نعم' });
    const bad = validateEntry('x', rule);
    expect(bad).toMatchObject({ ok: false, reason: 'notInList' });
    if (!bad.ok) expect(bad.message).toEqual({ ar: 'اختر قيمة من القائمة.', en: 'Choose a value from the list.' });
    expect(validateEntry('MAYBE', { ...rule, caseSensitive: true }).ok).toBe(false);
    expect(parseListSource('a, b ;c،د')).toEqual(['a', 'b', 'c', 'د']);
  });

  it('checks whole and decimal ranges', () => {
    const whole = { kind: 'whole' as const, op: 'between' as const, min: 1, max: 10 };
    expect(validateEntry('5', whole)).toEqual({ ok: true, value: 5 });
    expect(validateEntry('5.5', whole)).toMatchObject({ ok: false, reason: 'notWhole' });
    expect(validateEntry('abc', whole)).toMatchObject({ ok: false, reason: 'notNumber', message: { en: 'Enter a whole number.' } });
    const out = validateEntry('11', whole);
    expect(out).toMatchObject({ ok: false, reason: 'outOfRange' });
    if (!out.ok) expect(out.message).toEqual({ ar: 'أدخل قيمة بين 1 و10.', en: 'Enter a value between 1 and 10.' });
    const dec = { kind: 'decimal' as const, op: 'gte' as const, min: 0.5 };
    expect(validateEntry('0.75', dec)).toEqual({ ok: true, value: 0.75 });
    expect(validateEntry('٠٫٢', dec)).toMatchObject({ ok: false, reason: 'outOfRange' });
    expect(validateEntry('x', dec)).toMatchObject({ ok: false, reason: 'notNumber' });
    expect(validateEntry(3, { kind: 'decimal', op: 'notBetween', min: 1, max: 5 }).ok).toBe(false);
    expect(validateEntry('7', { kind: 'whole', op: 'neq', min: 7 }).ok).toBe(false);
    expect(validateEntry('7', { kind: 'whole', op: 'lt', min: 8 }).ok).toBe(true);
  });

  it('checks dates and text length', () => {
    const rule = { kind: 'date' as const, op: 'between' as const, min: '2024-01-01', max: '2024-12-31' };
    expect(validateEntry('2024-06-01', rule)).toEqual({ ok: true, value: dateToSerial(2024, 6, 1) });
    const late = validateEntry('2025-01-01', rule);
    expect(late).toMatchObject({ ok: false, reason: 'outOfRange' });
    if (!late.ok) expect(late.message.en).toBe('Enter a value between 2024-01-01 and 2024-12-31.');
    expect(validateEntry('soon', rule)).toMatchObject({ ok: false, reason: 'notDate' });
    const len = validateEntry('abcdef', { kind: 'textLength', op: 'lte', min: 5 });
    expect(len).toMatchObject({ ok: false });
    if (!len.ok) expect(len.message.ar).toBe('طول النص: أدخل 5 أو أقل.');
    expect(validateEntry('فيصل', { kind: 'textLength', op: 'eq', min: 4 }).ok).toBe(true);
  });

  it('handles blanks and custom messages', () => {
    expect(validateEntry('', { kind: 'whole', op: 'gt', min: 0 })).toEqual({ ok: true, value: null });
    expect(validateEntry('  ', { kind: 'whole', op: 'gt', min: 0, allowBlank: false })).toMatchObject({ ok: false, reason: 'blank' });
    const custom = validateEntry('0', { kind: 'whole', op: 'gt', min: 0, error: { ar: 'موجب فقط', en: 'Positive only' } });
    expect(custom).toMatchObject({ ok: false, message: { ar: 'موجب فقط', en: 'Positive only' } });
  });

  it('has the same message keys in Arabic and English', () => {
    expect(Object.keys(VALIDATION_MESSAGES.ar).sort()).toEqual(Object.keys(VALIDATION_MESSAGES.en).sort());
  });
});
