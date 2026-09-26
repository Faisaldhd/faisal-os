import { describe, expect, it } from 'vitest';
import { columnName } from '../xml';
import { colorScaleRule, dataBarRule, topRule } from './sheetview';
import type { CellStyle, CondRule } from '../calc/index';
import { writeXlsx } from '../ooxml';
import { entryData, readRawZip } from '../zip';
import { readBookLook } from './xlsxlook';
import type { Editor, EditorContext } from '../editor';
import type { OfficeModel, SheetsModel } from '../model';
import '../strings';
import { createSheet } from './view';
import { cfRuleXml, conditionalFormattingXml, dxfBody, ourOperator, parseConditionalFormatting, parseDxfs, sqrefOf } from './condfmt-xml';

/** A cell-comparison rule, built here because the panels make them from their own dialogs. */
const cellIsRule = (op: 'gt' | 'lt' | 'gte' | 'lte' | 'eq' | 'neq' | 'between' | 'notBetween', value: number | string, style: Partial<CellStyle>): CondRule =>
  ({ type: 'cellIs', op, value, style: style as CellStyle });

/**
 * Conditional formatting as the file keeps it: a `<cfRule>` per rule inside one
 * `<conditionalFormatting sqref="…">`, pointing at a `<dxf>` in styles.xml by index, in the
 * element order the schema fixes. A rule the file cannot carry exactly is not written at all.
 */
const range = { r0: 1, c0: 0, r1: 39, c1: 3 };

describe('the square the rules cover', () => {
  it('names it the way the file does', () => {
    expect(sqrefOf(range, columnName)).toBe('A2:D40');
    expect(sqrefOf({ r0: 0, c0: 0, r1: 0, c1: 0 }, columnName)).toBe('A1:A1');
    expect(sqrefOf({ r0: 39, c0: 3, r1: 1, c1: 0 }, columnName)).toBe('A2:D40');
  });
});

describe('a dxf', () => {
  it('carries the font flags, the colour and the fill', () => {
    expect(dxfBody({ bold: true, color: 'FF0000', fill: 'FFC000' })).toBe('<dxf><font><b/><color rgb="FFFF0000"/></font><fill><patternFill><bgColor rgb="FFFFC000"/></patternFill></fill></dxf>');
  });

  it('is null when the style says nothing a dxf can hold', () => {
    expect(dxfBody({})).toBeNull();
    expect(dxfBody(undefined)).toBeNull();
  });
});

describe('one cfRule', () => {
  it('writes a cell comparison with its formula and its style index', () => {
    const rule = cellIsRule('gt', 100, { bold: true, fill: 'FFC000' });
    const xml = cfRuleXml(rule, 3, 1) as string;
    expect(xml).toContain('type="cellIs"');
    expect(xml).toContain('operator="greaterThan"');
    expect(xml).toContain('dxfId="3"');
    expect(xml).toContain('priority="1"');
    expect(xml).toContain('<formula>100</formula>');
  });

  it('writes a colour scale with its stops and colours', () => {
    const xml = cfRuleXml(colorScaleRule(), null, 2) as string;
    expect(xml).toContain('type="colorScale"');
    expect(xml).toContain('<cfvo type="min"/>');
    expect(xml).toContain('<cfvo type="max"/>');
    expect(xml).toContain('<color rgb=');
    expect(xml).not.toContain('dxfId');
  });

  it('writes a data bar', () => {
    expect(cfRuleXml(dataBarRule(), null, 3)).toContain('type="dataBar"');
  });

  it('writes a top-N rule with rank and percent', () => {
    const xml = cfRuleXml(topRule(10), 1, 4) as string;
    expect(xml).toContain('type="top10"');
    expect(xml).toContain('rank="10"');
    expect(xml.endsWith('/>')).toBe(true);
  });

  it('escapes a text rule and writes the formula Excel expects beside it', () => {
    const rule: CondRule = { type: 'text', op: 'contains', text: 'شهري & "ثابت"', style: { bold: true } };
    const xml = cfRuleXml(rule, 0, 1) as string;
    expect(xml).toContain('type="containsText"');
    expect(xml).toContain('&amp;');
    expect(xml).toContain('<formula>NOT(ISERROR(SEARCH(');
  });

  it('has no spelling for a rule that is not a rule', () => {
    expect(cfRuleXml({ type: 'nonsense' } as unknown as CondRule, null, 1)).toBeNull();
  });
});

describe('the conditionalFormatting block', () => {
  const rules: CondRule[] = [
    cellIsRule('lt', 0, { color: 'FF0000' }),
    colorScaleRule(),
    { type: 'duplicate', style: { italic: true } },
  ];

  it('holds every rule with its own priority and style index', () => {
    const xml = conditionalFormattingXml(rules, 'A2:D40', [0, null, 1]) as string;
    expect(xml.startsWith('<conditionalFormatting sqref="A2:D40">')).toBe(true);
    expect(xml.match(/<cfRule/g)).toHaveLength(3);
    expect(xml).toContain('priority="1"');
    expect(xml).toContain('priority="3"');
    expect(xml).toContain('type="duplicateValues"');
  });

  it('is null when there is nothing to write', () => {
    expect(conditionalFormattingXml([], 'A1:A1', [])).toBeNull();
  });

  it('round-trips the rules this app can read back', () => {
    const xml = conditionalFormattingXml(rules, 'A2:D40', [0, null, 1]) as string;
    const parsed = parseConditionalFormatting(`<worksheet><sheetData/>${xml}</worksheet>`);
    expect(parsed).toHaveLength(3);
    expect(parsed[0].sqref).toBe('A2:D40');
    expect(parsed[0].rule).toMatchObject({ type: 'cellIs', operator: 'lessThan', dxfId: 0, priority: 1 });
    expect(parsed[1].rule.type).toBe('colorScale');
    expect(parsed[1].rule.colors).toHaveLength(2);   // min and max: this rule has no mid stop
    expect(parsed[2].rule.type).toBe('duplicateValues');
    expect(ourOperator(parsed[0].rule.operator as string)).toBe('lt');
  });

  it('answers an empty list for a sheet with no conditional formatting', () => {
    expect(parseConditionalFormatting('<worksheet><sheetData/></worksheet>')).toEqual([]);
  });
});

describe('the dxfs in styles.xml', () => {  it('reads every dxf body back, in file order', () => {
    const styles = '<styleSheet><dxfs count="2"><dxf><font><b/></font></dxf><dxf><fill><patternFill><bgColor rgb="FFFFC000"/></patternFill></fill></dxf></dxfs><cellXfs count="1"/></styleSheet>';
    const bodies = parseDxfs(styles);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain('<b/>');
    expect(bodies[1]).toContain('FFFFC000');
  });

  it('answers an empty list when the file has no dxfs at all', () => {
    expect(parseDxfs('<styleSheet><cellXfs count="1"/></styleSheet>')).toEqual([]);
  });
});
describe('round trip: rules written into the file and read back', () => {
  const grid = { name: 'S', rows: [['Cat', 'Qty'], ['ألف', '2'], ['باء', '300']], truncated: false };
  const rules: CondRule[] = [
    cellIsRule('gte', 100, { bold: true, fill: 'FFC000' }),
    colorScaleRule(),
    { type: 'duplicate', style: { italic: true } },
  ];

  it('writes the element and its dxfs, and the reader hands the rules back', async () => {
    const saved = writeXlsx([grid], undefined, undefined, undefined, { 0: rules });
    const sheetXml = new TextDecoder().decode((await entryData(readRawZip(saved), 'xl/worksheets/sheet1.xml')) ?? new Uint8Array());
    const stylesXml = new TextDecoder().decode((await entryData(readRawZip(saved), 'xl/styles.xml')) ?? new Uint8Array());
    expect(sheetXml).toContain('<conditionalFormatting sqref="A1:B3">');
    expect(sheetXml.indexOf('</sheetData>')).toBeLessThan(sheetXml.indexOf('<conditionalFormatting'));
    expect(sheetXml).toContain('type="cellIs"');
    expect(sheetXml).toContain('operator="greaterThanOrEqual"');
    expect(sheetXml).toContain('dxfId="0"');
    expect(stylesXml).toContain('<dxfs count="2">');
    expect(stylesXml.indexOf('<dxfs')).toBeLessThan(stylesXml.indexOf('<tableStyles') === -1 ? stylesXml.length : stylesXml.indexOf('<tableStyles'));

    const look = await readBookLook(saved);
    const back = look.sheets[0].condRules ?? [];
    expect(back).toHaveLength(3);
    expect(back[0]).toMatchObject({ type: 'cellIs', op: 'gte', value: 100 });
    expect((back[0] as { style: { bold?: boolean; fill?: string } }).style).toMatchObject({ bold: true, fill: 'FFC000' });
    expect(back[1].type).toBe('colorScale');
    expect(back[2].type).toBe('duplicate');
  });

  it('writes nothing at all for a sheet with no rules', async () => {
    const saved = writeXlsx([grid], undefined, undefined, undefined, {});
    const sheetXml = new TextDecoder().decode((await entryData(readRawZip(saved), 'xl/worksheets/sheet1.xml')) ?? new Uint8Array());
    const stylesXml = new TextDecoder().decode((await entryData(readRawZip(saved), 'xl/styles.xml')) ?? new Uint8Array());
    expect(sheetXml).not.toContain('<conditionalFormatting');
    expect(stylesXml).not.toContain('<dxfs');
    expect((await readBookLook(saved)).sheets[0].condRules).toBeUndefined();
  });
});
describe('the Data tab conditional-format buttons save what they set', () => {
  it('records the rule in the model, so the file can carry it', () => {
    let model: OfficeModel = { kind: 'xlsx', active: 0, delimiter: ',', grids: [{ name: 'S', rows: [['Cat', 'Qty'], ['word1', '2'], ['word2', '300']], truncated: false }] };
    const ctx: EditorContext = {
      model: () => model,
      commit: (edit) => { model = edit.apply(model); },
      undo: () => {}, redo: () => {},
      editable: () => true, refresh: () => {}, setStatus: () => {}, host: () => document.body,
      filePath: () => '/home/user/budget_2026.xlsx',
      fileTab: () => ({ id: 'file', label: 'File', groups: [] }),
      exportFile: async () => {}, print: () => {},
    };
    document.body.replaceChildren();
    const editor: Editor = createSheet(ctx, null);
    document.body.append(editor.element);
    editor.render();
    const control = editor.tabs().find((t) => t.id === 'data')?.groups.flatMap((g) => g.controls).find((c) => c.id === 'colorscale') as unknown as { run: () => void };
    control.run();
    const rules = (model as SheetsModel).condRules?.[0] ?? [];
    expect(rules).toHaveLength(1);
    expect(rules[0].type).toBe('colorScale');
    // …and clearing them takes the model entry away again, so nothing false is saved.
    const clear = editor.tabs().find((t) => t.id === 'data')?.groups.flatMap((g) => g.controls).find((c) => c.id === 'condclear') as unknown as { run: () => void };
    clear.run();
    expect((model as SheetsModel).condRules).toBeUndefined();
  });
});
