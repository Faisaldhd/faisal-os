/**
 * Sheet — conditional formatting as the FILE spells it (التنسيق الشرطي في `.xlsx`).
 *
 * One sheet carries the rules in its worksheet part, and the styles they apply live in `styles.xml`
 * as `<dxfs>` entries the rules point at by index:
 *
 *   <conditionalFormatting sqref="A2:D40">
 *     <cfRule type="cellIs" operator="greaterThan" dxfId="0" priority="1"><formula>100</formula></cfRule>
 *   </conditionalFormatting>
 *   …
 *   <dxfs count="1"><dxf><font><b/></font><fill><patternFill><bgColor rgb="FFFFC000"/></patternFill></fill></dxf></dxfs>
 *
 * The element goes after `<autoFilter>` and before `<dataValidations>` — the order the schema fixes,
 * and the reason a saved sheet opens instead of being repaired.
 *
 * A rule whose meaning the file cannot carry exactly is NOT written (`null`), the same promise the
 * AutoFilter keeps: better a rule that stays on screen than one the file tells a lie about.
 */
import { xmlText } from '../xml';
import type { CellStyle, CondRule, ScaleStop } from '../calc/index';

/** The rectangle the rules apply to, in the drawn sheet's own coordinates. */
export interface UsedRange {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

/** "A2:D40" — the `<sqref>` the file points a conditional format at. */
export function sqrefOf(range: UsedRange, columnName: (col: number) => string): string {
  const r0 = Math.min(range.r0, range.r1);
  const r1 = Math.max(range.r0, range.r1);
  const c0 = Math.min(range.c0, range.c1);
  const c1 = Math.max(range.c0, range.c1);
  return `${columnName(c0)}${r0 + 1}:${columnName(c1)}${r1 + 1}`;
}

/** The rgb the file uses: eight hex digits, alpha first. */
const rgb = (colour: string | undefined): string | null => {
  if (!colour) return null;
  const hex = colour.replace('#', '').trim().toUpperCase();
  if (/^[0-9A-F]{8}$/.test(hex)) return hex;
  if (/^[0-9A-F]{6}$/.test(hex)) return `FF${hex}`;
  return null;
};

/** The `<dxf>` body for a rule's style, or null when it has nothing a dxf can carry. */
export function dxfBody(style: Partial<CellStyle> | undefined): string | null {
  if (!style) return null;
  const font: string[] = [];
  if (style.bold) font.push('<b/>');
  if (style.italic) font.push('<i/>');
  if (style.underline) font.push('<u/>');
  if (style.strike) font.push('<strike/>');
  const colour = rgb(style.color);
  if (colour) font.push(`<color rgb="${colour}"/>`);
  const fill = rgb(style.fill);
  const body = (font.length ? `<font>${font.join('')}</font>` : '') +
    (fill ? `<fill><patternFill><bgColor rgb="${fill}"/></patternFill></fill>` : '');
  return body ? `<dxf>${body}</dxf>` : null;
}

const OPERATOR: Record<string, string> = {
  gt: 'greaterThan', lt: 'lessThan', gte: 'greaterThanOrEqual', lte: 'lessThanOrEqual',
  eq: 'equal', neq: 'notEqual', between: 'between', notBetween: 'notBetween',
};
const OUR_OPERATOR: Record<string, 'gt' | 'lt' | 'gte' | 'lte' | 'eq' | 'neq' | 'between' | 'notBetween'> = {
  greaterThan: 'gt', lessThan: 'lt', greaterThanOrEqual: 'gte', lessThanOrEqual: 'lte',
  equal: 'eq', notEqual: 'neq', between: 'between', notBetween: 'notBetween',
};

const CFVO = (stop: ScaleStop): string => {
  switch (stop.kind) {
    case 'min': return '<cfvo type="min"/>';
    case 'max': return '<cfvo type="max"/>';
    case 'percent': return `<cfvo type="percent" val="${stop.value ?? 0}"/>`;
    case 'percentile': return `<cfvo type="percentile" val="${stop.value ?? 50}"/>`;
    default: return `<cfvo type="num" val="${stop.value ?? 0}"/>`;
  }
};

/** One `<cfRule>`, or null when this rule has no exact spelling in the file. */
export function cfRuleXml(rule: CondRule, dxfId: number | null, priority: number): string | null {
  const style = dxfId === null ? '' : ` dxfId="${dxfId}"`;
  const head = (rest: string): string => `<cfRule ${rest}${style} priority="${priority}"`;
  switch (rule.type) {
    case 'colorScale':
      return `${head('type="colorScale"')}>` +
        `<colorScale>${CFVO(rule.min)}${rule.mid ? CFVO(rule.mid) : ''}${CFVO(rule.max)}` +
        `<color rgb="${rgb(rule.min.color) ?? 'FFFFFFFF'}"/>` +
        (rule.mid ? `<color rgb="${rgb(rule.mid.color) ?? 'FFFFEB9C'}"/>` : '') +
        `<color rgb="${rgb(rule.max.color) ?? 'FFF8696B'}"/></colorScale></cfRule>`;
    case 'dataBar':
      return `${head('type="dataBar"')}>` +
        `<dataBar><cfvo type="min"/><cfvo type="max"/><color rgb="${rgb(rule.color) ?? 'FF638EC6'}"/></dataBar></cfRule>`;
    case 'cellIs': {
      const op = OPERATOR[rule.op];
      if (!op) return null;
      const values = rule.op === 'between' || rule.op === 'notBetween'
        ? `<formula>${xmlText(String(rule.value))}</formula><formula>${xmlText(String(rule.value2 ?? ''))}</formula>`
        : `<formula>${xmlText(String(rule.value))}</formula>`;
      return `${head(`type="cellIs" operator="${op}"`)}>${values}</cfRule>`;
    }
    case 'text': {
      const type = rule.op === 'contains' ? 'containsText' : rule.op === 'notContains' ? 'notContainsText' : rule.op === 'begins' ? 'beginsWith' : 'endsWith';
      const operator = type;
      // Excel writes a SEARCH/LEFT/RIGHT formula beside the type; without it a reader shows nothing.
      const text = xmlText(rule.text);
      const formula = rule.op === 'contains' ? `NOT(ISERROR(SEARCH("${text}",A1)))`
        : rule.op === 'notContains' ? `ISERROR(SEARCH("${text}",A1))`
        : rule.op === 'begins' ? `LEFT(A1,${rule.text.length})="${text}"`
        : `RIGHT(A1,${rule.text.length})="${text}"`;
      return `${head(`type="${type}" operator="${operator}" text="${text}"`)}><formula>${formula}</formula></cfRule>`;
    }
    case 'blank': return `${head('type="containsBlanks"')}><formula>LEN(TRIM(A1))=0</formula></cfRule>`;
    case 'notBlank': return `${head('type="notContainsBlanks"')}><formula>LEN(TRIM(A1))&gt;0</formula></cfRule>`;
    case 'error': return `${head('type="containsErrors"')}><formula>ISERROR(A1)</formula></cfRule>`;
    case 'duplicate': return `${head('type="duplicateValues"')}/>`;
    case 'unique': return `${head('type="uniqueValues"')}/>`;
    case 'top':
      return `${head(`type="top10"${rule.bottom ? ' bottom="1"' : ''}${rule.percent ? ' percent="1"' : ''} rank="${Math.max(1, Math.round(rule.count))}"`)}/>`;
    case 'average':
      return `${head(`type="aboveAverage"${rule.below ? ' aboveAverage="0"' : ' aboveAverage="1"'}`)}/>`;
    default: return null;
  }
}

/**
 * The sheet's `<conditionalFormatting>` blocks, in the order the rules were added. `dxfIds` gives
 * the index of each rule's style in `<dxfs>` (null when the rule has no style to write).
 */
export function conditionalFormattingXml(
  rules: readonly CondRule[],
  sqref: string,
  dxfIds: ReadonlyArray<number | null>,
): string | null {
  const out: string[] = [];
  rules.forEach((rule, i) => {
    const body = cfRuleXml(rule, dxfIds[i] ?? null, i + 1);
    if (body) out.push(body);
  });
  if (!out.length) return null;
  return `<conditionalFormatting sqref="${sqref}">${out.join('')}</conditionalFormatting>`;
}

/** What the file says about one rule, as much as this app can read back. */
export interface ParsedCfRule {
  type: string;
  operator?: string;
  text?: string;
  dxfId?: number;
  priority?: number;
  formulas: string[];
  rank?: number;
  bottom?: boolean;
  percent?: boolean;
  aboveAverage?: boolean;
  stops?: ScaleStop[];
  colors?: string[];
}

/** Every `<cfRule>` of a worksheet part, with its `<sqref>` and its own attributes. */
export function parseConditionalFormatting(worksheetXml: string): Array<{ sqref: string; rule: ParsedCfRule }> {
  const out: Array<{ sqref: string; rule: ParsedCfRule }> = [];
  const block = /<conditionalFormatting\b[^>]*sqref="([^"]*)"[^>]*>([\s\S]*?)<\/conditionalFormatting>/g;
  for (let b = block.exec(worksheetXml); b; b = block.exec(worksheetXml)) {
    const ruleRe = /<cfRule\b([^>]*?)(\/>|>([\s\S]*?)<\/cfRule>)/g;
    for (let r = ruleRe.exec(b[2]); r; r = ruleRe.exec(b[2])) {
      const attrs = r[1];
      const attr = (name: string): string | undefined => new RegExp(`${name}="([^"]*)"`).exec(attrs)?.[1];
      const body = r[3] ?? '';
      const formulas = [...body.matchAll(/<formula>([\s\S]*?)<\/formula>/g)].map((m) => unescapeXml(m[1]));
      const stops: ScaleStop[] = [...body.matchAll(/<cfvo\b([^>]*)\/>/g)].map((m) => {
        const kind = /type="([^"]*)"/.exec(m[1])?.[1] ?? 'min';
        const value = Number(/val="([^"]*)"/.exec(m[1])?.[1] ?? '0');
        if (kind === 'min') return { kind: 'min', color: '' } as ScaleStop;
        if (kind === 'max') return { kind: 'max', color: '' } as ScaleStop;
        if (kind === 'percent') return { kind: 'percent', value, color: '' } as ScaleStop;
        if (kind === 'percentile') return { kind: 'percentile', value, color: '' } as ScaleStop;
        return { kind: 'number', value, color: '' } as ScaleStop;
      });
      const colors = [...body.matchAll(/<color\b([^>]*)\/>/g)].map((m) => (/rgb="([^"]*)"/.exec(m[1])?.[1] ?? '').slice(2));
      out.push({
        sqref: b[1],
        rule: {
          type: attr('type') ?? '',
          operator: attr('operator'),
          text: attr('text') !== undefined ? unescapeXml(attr('text') as string) : undefined,
          dxfId: attr('dxfId') !== undefined ? Number(attr('dxfId')) : undefined,
          priority: attr('priority') !== undefined ? Number(attr('priority')) : undefined,
          formulas,
          rank: attr('rank') !== undefined ? Number(attr('rank')) : undefined,
          bottom: attr('bottom') === '1',
          percent: attr('percent') === '1',
          aboveAverage: attr('aboveAverage') !== '0',
          stops: stops.length ? stops : undefined,
          colors: colors.length ? colors : undefined,
        },
      });
    }
  }
  return out;
}

/** The `<dxf>` bodies a styles part holds, in file order. */
export function parseDxfs(stylesXml: string): string[] {
  const section = /<dxfs\b[^>]*>([\s\S]*?)<\/dxfs>/.exec(stylesXml);
  if (!section) return [];
  return [...section[1].matchAll(/<dxf\b[^>]*>([\s\S]*?)<\/dxf>|<dxf\b[^>]*\/>/g)].map((m) => m[1] ?? '');
}

/** Our operator name for what the file wrote, or null when this app has no such condition. */
export const ourOperator = (fileOperator: string): string | null => OUR_OPERATOR[fileOperator] ?? null;

const unescapeXml = (text: string): string =>
  text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d))).replace(/&amp;/g, '&');
