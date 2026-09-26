/**
 * Mail merge, pure: the fields a document carries, the columns a CSV brings, the copies one row
 * each, and the names those copies may take.
 *
 * The cases the brief names are the cases here: a row with fewer values than columns, a field the
 * CSV has no column for, a broken or empty CSV, values holding commas and Arabic and new lines, and
 * two rows that would want the same name.
 */
import { describe, expect, it } from 'vitest';
import {
  buildFileName, FIELD_CLASS, FIELD_SKIP_ATTR, fieldText, fieldsIn, fieldsInDocument, fillParagraph,
  matchFields, mergeDocuments, parseSource, resultMessage, rowIsEmpty, safeFileName, valuesOfRow,
} from './mailmerge';

const LETTER = ['عزيزي {{الاسم}}،', 'مبلغك {{المبلغ}} ريال.', 'وشكرًا.'];
const CSV = 'الاسم,المبلغ\nأحمد,100\nسارة,250\n';

describe('the fields a document carries', () => {
  it('finds them in order, once each, and tolerates spaces', () => {
    expect(fieldsIn('عزيزي {{الاسم}} و{{ الاسم }} و{{المبلغ}}')).toEqual(['الاسم', 'المبلغ']);
    expect(fieldsIn('لا حقول هنا')).toEqual([]);
    expect(fieldsIn('{{}}')).toEqual([]);
  });

  it('collects them from the whole document in paragraph order', () => {
    expect(fieldsInDocument(LETTER)).toEqual(['الاسم', 'المبلغ']);
    expect(fieldsInDocument(['{{ب}}', '{{أ}}'])).toEqual(['ب', 'أ']);
  });

  it('names the mark the editor inserts, so text is never read as a field marker', () => {
    // The marker must carry the editor's own skip attribute or `reconcile()` would read it as text.
    expect(FIELD_CLASS).toBe('fo-marker');
    expect(FIELD_SKIP_ATTR).toBe('data-skip');
    expect(fieldText('الاسم')).toBe('{{الاسم}}');
  });
});

describe('the CSV source', () => {
  it('reads a header and its rows, keeping Arabic and commas in quotes', () => {
    const source = parseSource('الاسم,المدينة\n"أحمد، علي",جدة\nسارة,"الرياض، السعودية"\n');
    expect(source.columns).toEqual(['الاسم', 'المدينة']);
    expect(source.rows).toEqual([['أحمد، علي', 'جدة'], ['سارة', 'الرياض، السعودية']]);
  });

  it('pads a short row so every column has a value, and skips blank lines', () => {
    const source = parseSource('a,b,c\n1,2\n\n3,4,5\n');
    expect(source.rows).toEqual([['1', '2', ''], ['3', '4', '5']]);
  });

  it('answers an empty source for an empty or broken CSV instead of throwing', () => {
    expect(parseSource('')).toEqual({ columns: [], rows: [] });
    expect(parseSource('\n\n')).toEqual({ columns: [], rows: [] });
    expect(parseSource('الاسم\n').rows).toEqual([]);              // a header with no rows
    expect(parseSource('"غير مغلق\nسطر')).toEqual({ columns: ['غير مغلق\nسطر'], rows: [] });   // never throws
  });

  it('reads a tab-separated paste as well', () => {
    const source = parseSource('الاسم\tالمبلغ\nأحمد\t100\n', '\t');
    expect(source.rows).toEqual([['أحمد', '100']]);
  });
});

describe('matching the document to the columns', () => {
  it('matches ignoring case and spaces, and reports what does not match', () => {
    const source = parseSource('الاسم, المبلغ ,ملاحظة\nأحمد,100,شكرًا\n');
    const match = matchFields(['الاسم', 'المبلغ', 'العنوان'], source);
    expect(match.matched).toEqual(['الاسم', 'المبلغ']);
    expect(match.missing).toEqual(['العنوان']);
    expect(match.unused).toEqual(['ملاحظة']);
  });

  it('answers every field as missing when the CSV has no header', () => {
    const match = matchFields(['الاسم'], parseSource(''));
    expect(match.missing).toEqual(['الاسم']);
    expect(match.matched).toEqual([]);
  });
});

describe('filling one paragraph', () => {
  it('puts the value in, and takes a field with no value out', () => {
    const values = { الاسم: 'أحمد', المبلغ: '' };
    expect(fillParagraph('عزيزي {{الاسم}}، مبلغك {{المبلغ}} ريال.', values)).toBe('عزيزي أحمد، مبلغك  ريال.');
  });

  it('leaves commas, Arabic, quotes and new lines exactly as they are', () => {
    const values = { نص: 'سطر أول، "باقتباس"\nسطر ثانٍ' };
    expect(fillParagraph('[{{نص}}]', values)).toBe('[سطر أول، "باقتباس"\nسطر ثانٍ]');
    expect(fillParagraph('بلا حقول', values)).toBe('بلا حقول');
  });
});

describe('safe, unique file names', () => {
  it('removes what a path cannot hold and prefixes a reserved name', () => {
    expect(safeFileName('رسالة/أحمد')).toBe('رسالة أحمد');
    expect(safeFileName('a:b*c?d"e<f>g|h')).toBe('a b c d e f g h');
    expect(safeFileName('nul')).toBe('_nul');
    expect(safeFileName('   ')).toBe('نسخة');
    expect(safeFileName('x'.repeat(100)).length).toBeLessThanOrEqual(64);
  });

  it('never repeats a name, and numbers the second one', () => {
    const taken = new Set<string>();
    expect(safeFileName('رسالة أحمد', taken)).toBe('رسالة أحمد');
    taken.add('رسالة أحمد');
    expect(safeFileName('رسالة أحمد', taken)).toBe('رسالة أحمد-2');
    taken.add('رسالة أحمد-2');
    expect(safeFileName('رسالة أحمد', taken)).toBe('رسالة أحمد-3');
  });

  it('builds the name from the row it belongs to', () => {
    const taken = new Set<string>();
    const first = buildFileName('رسالة {{الاسم}}', { الاسم: 'أحمد' }, 0, taken);
    expect(first).toBe('رسالة أحمد');
    taken.add(first);
    expect(buildFileName('رسالة {{الاسم}}', { الاسم: 'أحمد' }, 1, taken)).toBe('رسالة أحمد-2');
    expect(buildFileName('{n}-{{الاسم}}', { الاسم: '' }, 4, new Set())).toBe('5-');
    expect(buildFileName('ملف', {}, 0, new Set())).toBe('ملف');
    expect(buildFileName('{{الاسم}}', { الاسم: '' }, 2, new Set())).toBe('رسالة 3');
  });
});

describe('one copy per row', () => {
  const source = parseSource(CSV);

  it('makes a letter per row, with the row values and its own name', () => {
    const result = mergeDocuments(LETTER, source);
    expect(result.copies).toHaveLength(2);
    expect(result.copies[0]).toMatchObject({ row: 0, name: 'أحمد' });
    expect(result.copies[0].paragraphs[0]).toBe('عزيزي أحمد،');
    expect(result.copies[1].paragraphs).toContain('مبلغك 250 ريال.');
    expect(result.skipped).toEqual([]);
    expect(result.match.missing).toEqual([]);
  });

  it('skips a row that brings nothing for the fields, and says which one', () => {
    const sparse = parseSource('الاسم,المبلغ\nأحمد,100\n,\nسارة,250\n');
    const result = mergeDocuments(LETTER, sparse);
    expect(result.copies).toHaveLength(2);
    expect(result.skipped).toEqual([{ row: 1, reason: 'empty' }]);
    // The skipped row is not an empty letter: nothing was created for it at all.
    expect(result.copies.map((c) => c.row)).toEqual([0, 2]);
  });

  it('answers no copies and an honest reason when there is nothing to merge', () => {
    expect(mergeDocuments(['لا حقول'], source).copies).toEqual([]);
    expect(mergeDocuments(LETTER, parseSource('الاسم,المبلغ\n')).skipped).toEqual([{ row: 0, reason: 'no-source' }]);
    expect(mergeDocuments(LETTER, parseSource('')).match.missing).toEqual(['الاسم', 'المبلغ']);
  });

  it('leaves the field empty, and reports it, when the CSV has no such column', () => {
    const partial = parseSource('الاسم\nأحمد\nسارة\n');
    const result = mergeDocuments(LETTER, partial);
    expect(result.match.missing).toEqual(['المبلغ']);
    expect(result.copies[0].paragraphs[1]).toBe('مبلغك  ريال.');
  });

  it('gives two rows with the same name two files', () => {
    const twins = parseSource('الاسم,المبلغ\nأحمد,1\nأحمد,2\n');
    const names = mergeDocuments(LETTER, twins).copies.map((c) => c.name);
    expect(new Set(names).size).toBe(2);
    expect(names).toEqual(['أحمد', 'أحمد-2']);
  });

  it('holds a row as empty only when none of the fields has a value', () => {
    const named = parseSource(CSV);
    expect(rowIsEmpty(['الاسم', 'المبلغ'], named, ['', ''])).toBe(true);
    expect(rowIsEmpty(['الاسم', 'المبلغ'], named, ['', 'x'])).toBe(false);
    // A field the CSV has no column for can never make a row non-empty.
    expect(rowIsEmpty(['أ', 'ب'], named, ['x', 'y'])).toBe(true);
    expect(valuesOfRow(['الاسم', 'المبلغ'], named, ['1'])).toEqual({ الاسم: '1', المبلغ: '' });
  });

  it('writes the sentence the window will show, including what did not happen', () => {
    const sparse = parseSource('الاسم\nأحمد\n,\n');
    const result = mergeDocuments(LETTER, sparse);
    const message = resultMessage(result, {
      created: (n) => `أُنشئ ${n} ملف`,
      skipped: (n, rows) => `تُخطّي ${n} صف (${rows})`,
      missing: (fields) => `بلا عمود: ${fields}`,
    });
    expect(message).toBe('أُنشئ 1 ملف · تُخطّي 1 صف (2) · بلا عمود: المبلغ');
  });
});
