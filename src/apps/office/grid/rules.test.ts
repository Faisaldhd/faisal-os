/** Validation rules by range, and validation messages mapped to the app's strings. */
import { describe, expect, it } from 'vitest';
import { VALIDATION_MESSAGES } from '../calc/index';
import '../strings';
import { t, setLocale } from '../../../kernel/i18n';
import { validationAt, validationProblem, withoutRules } from './rules';

describe('clearing validation from a selection', () => {
  it('drops the rules that overlap it', () => {
    const rules = [{ range: { r0: 0, c0: 0, r1: 2, c1: 0 } }, { range: { r0: 5, c0: 5, r1: 6, c1: 6 } }];
    expect(withoutRules(rules, { r0: 1, c0: 0, r1: 1, c1: 0 })).toEqual([rules[1]]);
  });
});

describe('data validation in the grid', () => {
  const list = [{ range: { r0: 1, c0: 1, r1: 9, c1: 1 }, rule: { kind: 'list' as const, items: ['Yes', 'No'] } }];

  it('finds the rule of a cell', () => {
    expect(validationAt(list, 3, 1)?.kind).toBe('list');
    expect(validationAt(list, 0, 1)).toBeNull();
  });

  it('turns a rejection into a translated message', () => {
    setLocale('en');
    const bad = validationProblem('Maybe', list[0].rule);
    expect(bad && t(bad.key, bad.params)).toBe(VALIDATION_MESSAGES.en.notInList);
    expect(validationProblem('yes', list[0].rule)).toBeNull();
    const range = validationProblem('50', { kind: 'whole', op: 'between', min: 1, max: 10 });
    expect(range && t(range.key, range.params)).toBe('Enter a value between 1 and 10.');
    setLocale('ar');
    expect(range && t(range.key, range.params)).toBe('أدخل قيمة بين 1 و10.');
    const len = validationProblem('abcdef', { kind: 'textLength', op: 'lte', min: 3 });
    expect(len?.prefix).toBe(true);
  });

  it('carries every engine message in both languages', () => {
    for (const lang of ['ar', 'en'] as const) {
      setLocale(lang);
      for (const [key, text] of Object.entries(VALIDATION_MESSAGES[lang])) expect(t(`office.validation_${key}`, { a: '{a}', b: '{b}' })).toBe(text);
    }
    setLocale('ar');
  });
});
