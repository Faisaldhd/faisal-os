/**
 * Office Calc helpers — public API (أدوات الجداول). All pure and DOM-free.
 *
 *   sort.ts        sortPermutation(rows, keys, { header }) · sortRows · compareCells
 *   filter.ts      distinctValues(rows, col) · filterRows / visibleRows(rows, filters) · matchesCondition
 *   condfmt.ts     evaluateConditionalFormats(values, rules) → CellStyle | null per cell · interpolateColor
 *   validation.ts  validateEntry(input, rule) → ok | { reason, message: { ar, en } } · listOptions · parseListSource
 *                  VALIDATION_MESSAGES (copy into strings.ts)
 *   numfmt.ts      formatValue(value, pattern, { locale, digits }) · makeFormat(spec) · parseEntry(text)
 *                  isDateFormat · BUILTIN_FORMATS
 */
export { compareCells, sortPermutation, sortRows, type CellInput, type SortKey, type SortOptions } from './sort';
export {
  columnStats, distinctValues, filterRows, matchesCondition, valueKey, visibleRows,
  type ColumnStats, type DistinctValue, type FilterCondition,
} from './filter';
export { evaluateConditionalFormats, interpolateColor, type CellStyle, type CondRule, type ScaleStop } from './condfmt';
export {
  listOptions, parseListSource, validateEntry, VALIDATION_MESSAGES,
  type Bilingual, type CompareOp, type ValidationReason, type ValidationResult, type ValidationRule,
} from './validation';
export {
  BUILTIN_FORMATS, formatValue, isDateFormat, makeFormat, parseEntry,
  type FormatSpec, type FormattedValue, type NumberFormatOptions, type ParsedEntry,
} from './numfmt';
