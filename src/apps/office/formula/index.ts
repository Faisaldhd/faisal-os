/**
 * Office Calc formula engine — public API (واجهة محرّك المعادلات).
 *
 * Workbook (workbook.ts): cells + formulas + dependency graph, incremental recalc.
 *   new Workbook({ now? }) · addSheet · renameSheet · removeSheet · sheetNames
 *   setCell(sheet, row, col, "text" | "=formula") → { ok } · setValue · getValue · getText
 *   getFormula · formulas(sheet) · extent · recalc() → changed cells · evaluate(formula, sheet, row, col)
 *   isCircular · invalidateAll
 *
 * Model bridge (sheets.ts): workbookFromModel(model) · computeSheets(model) · evaluateInModel(input, model, sheet, self)
 *
 * Parser (parser.ts): parseFormula(text) · formatFormula(ast, { xlfn }) · translateFormula(text, dRows, dCols)
 *   shiftFormula(text, formulaSheet, { sheet, axis, at, count }) · collectRefs · refText
 *
 * Registry (registry.ts): registerFunction(name, impl, { minArgs, maxArgs, volatile?, xlfn?, aliases? })
 *   getFunction · canonicalName · listFunctions
 *
 * Values (values.ts): Scalar / Area / Value, CellError + ERR, toNumber · toText · toBool
 *   compareScalars · textToNumber · formatGeneral · scalarFromText · scalarToText
 *
 * Dates (dates.ts): dateToSerial · serialToDate · serialToTime · dateFromJs
 */
export { Workbook, type CellAddress, type SetResult, type WorkbookOptions } from './workbook';
export { computeSheets, evaluateInModel, workbookFromModel, type EngineOutcome } from './sheets';
export {
  collectRefs, formatFormula, parseFormula, refText, shiftFormula, translateFormula,
  type Node, type ParseResult, type RefNode, type StructureChange,
} from './parser';
export {
  canonicalName, getFunction, listFunctions, registerFunction,
  type CallContext, type FunctionImpl, type FunctionMeta,
} from './registry';
export {
  ArrayArea, CellError, ERR, ERROR_CODES, RefArea, compareScalars, errorFromText, formatGeneral, isArea, isError,
  scalarFromText, scalarToText, textToNumber, toBool, toNumber, toText,
  type Area, type ErrorCode, type Scalar, type Value,
} from './values';
export { dateFromJs, dateToSerial, serialToDate, serialToTime } from './dates';
