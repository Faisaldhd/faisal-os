/**
 * Sheet — a chart as the FILE keeps it (مخططات `.xlsx`).
 *
 * A chart in xlsx is three parts and two relationships, and every one of them has to be right or
 * Excel offers to repair the file:
 *
 *   xl/worksheets/sheet1.xml        <drawing r:id="rId3"/>   (near the end of CT_Worksheet)
 *   xl/worksheets/_rels/sheet1.xml.rels   → ../drawings/drawing1.xml   (type .../drawing)
 *   xl/drawings/drawing1.xml        <xdr:wsDr><xdr:absoluteAnchor>…<xdr:graphicFrame>…<c:chart r:id="rId1"/>
 *   xl/drawings/_rels/drawing1.xml.rels   → ../charts/chart1.xml        (type .../chart)
 *   xl/charts/chart1.xml            <c:chartSpace><c:chart><c:plotArea><c:barChart>…
 *   [Content_Types].xml             an Override for the drawing (…drawing+xml) and the chart (…chart+xml)
 *
 * A floating chart's position is what this app stores anyway (pixels), so the anchor is absolute —
 * 9525 EMU to the pixel — with no cell arithmetic to get wrong. The data is cached in the part
 * (`c:cat`/`c:val` with their points), which is what makes the chart show something before Excel
 * recalculates, and what this app reads back to redraw it.
 *
 * Pure string → string: the writer and the reader share one spelling.
 */
import { xmlText } from '../xml';

export type ChartKind = 'bar' | 'line' | 'pie';

/** One chart's place and data, as the writer needs it. */
export interface ChartToWrite {
  /** The part number: chart1.xml, chart2.xml… */
  index: number;
  kind: ChartKind;
  title: string;
  /** The series values, with the range each came from (for the `c:f` reference). */
  values: number[];
  categories: string[];
  /** The reference text the chart points at, e.g. `S!$B$2:$B$9`. */
  valueRef: string;
  categoryRef: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const EMU = 9525;                                   // one pixel
const C_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XDR_NS = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';

const num = (v: number): string => (Number.isFinite(v) ? String(v) : '0');

/** The `<c:chartSpace>` part: the plot area, the series with their cached points, and the title. */
export function chartSpaceXml(chart: ChartToWrite): string {
  const points = (values: readonly number[]): string =>
    `<c:ptCount val="${values.length}"/>` + values.map((v, i) => `<c:pt idx="${i}"><c:v>${num(v)}</c:v></c:pt>`).join('');
  const strPoints = (values: readonly string[]): string =>
    `<c:ptCount val="${values.length}"/>` + values.map((v, i) => `<c:pt idx="${i}"><c:v>${xmlText(v)}</c:v></c:pt>`).join('');

  const series =
    `<c:ser><c:idx val="0"/><c:order val="0"/>` +
    (chart.title ? `<c:tx><c:strRef><c:f>${xmlText(chart.title)}</c:f></c:strRef></c:tx>` : '') +
    `<c:cat><c:strRef><c:f>${xmlText(chart.categoryRef)}</c:f><c:strCache>${strPoints(chart.categories)}</c:strCache></c:strRef></c:cat>` +
    `<c:val><c:numRef><c:f>${xmlText(chart.valueRef)}</c:f><c:numCache><c:formatCode>General</c:formatCode>${points(chart.values)}</c:numCache></c:numRef></c:val>` +
    '</c:ser>';

  const plot = chart.kind === 'pie'
    ? `<c:pieChart><c:varyColors val="1"/>${series}</c:pieChart>`
    : chart.kind === 'line'
      ? `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}<c:marker val="1"/><c:axId val="1"/><c:axId val="2"/></c:lineChart>`
      : `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${series}<c:gapWidth val="150"/><c:axId val="1"/><c:axId val="2"/></c:barChart>`;

  // A pie has no axes; a bar or a line needs both of them or Excel shows an empty frame.
  const axes = chart.kind === 'pie' ? '' :
    '<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx>' +
    '<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:crossAx val="1"/></c:valAx>';

  const title = chart.title
    ? `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${xmlText(chart.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`
    : '<c:autoTitleDeleted val="1"/>';

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<c:chartSpace xmlns:c="${C_NS}" xmlns:a="${A_NS}" xmlns:r="${R_NS}">` +
    `<c:chart>${title}<c:plotArea><c:layout/>${plot}${axes}</c:plotArea><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>` +
    '</c:chartSpace>';
}

/** The `<xdr:wsDr>` drawing part: one absolute anchor per chart, each pointing at its chart part. */
export function drawingXml(charts: readonly ChartToWrite[]): string {
  const anchors = charts.map((chart) =>
    '<xdr:absoluteAnchor>' +
    `<xdr:pos x="${Math.max(0, Math.round(chart.x)) * EMU}" y="${Math.max(0, Math.round(chart.y)) * EMU}"/>` +
    `<xdr:ext cx="${Math.max(1, Math.round(chart.w)) * EMU}" cy="${Math.max(1, Math.round(chart.h)) * EMU}"/>` +
    '<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr>' +
    `<xdr:cNvPr id="${chart.index + 1}" name="Chart ${chart.index + 1}"/><xdr:cNvGraphicFramePr/>` +
    '</xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
    `<c:chart xmlns:c="${C_NS}" xmlns:r="${R_NS}" r:id="rId${chart.index + 1}"/>` +
    '</a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:absoluteAnchor>').join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<xdr:wsDr xmlns:xdr="${XDR_NS}" xmlns:a="${A_NS}">${anchors}</xdr:wsDr>`;
}

/** The relationships of a drawing part: one chart per anchor. */
export function drawingRelsXml(charts: readonly ChartToWrite[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    charts.map((chart) => `<Relationship Id="rId${chart.index + 1}" Type="${R_NS}/chart" Target="../charts/chart${chart.index + 1}.xml"/>`).join('') +
    '</Relationships>';
}

/** The `<drawing>` element a worksheet carries, pointing at its drawing part. */
export const drawingElement = (relId: string): string => `<drawing r:id="${relId}"/>`;

/**
 * The worksheet with its `<drawing>` in place. `CT_Worksheet` puts it after the page setup and the
 * breaks and before `legacyDrawing`/`picture`/`tableParts` — the order Excel insists on.
 */
export function withDrawing(worksheetXml: string, element: string | null): string {
  const stripped = worksheetXml.replace(/<drawing\b[^>]*\/>|<drawing\b[^>]*>[\s\S]*?<\/drawing>/g, '');
  if (!element) return stripped;
  const later = /<(?:\w+:)?(legacyDrawing|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b/.exec(stripped);
  if (later) return `${stripped.slice(0, later.index)}${element}${stripped.slice(later.index)}`;
  const close = stripped.lastIndexOf('</');
  return close < 0 ? stripped : `${stripped.slice(0, close)}${element}${stripped.slice(close)}`;
}

/** What a chart part says: the kind, the title and the range each series reads. */
export interface ParsedChart {
  kind: ChartKind;
  title: string;
  valueRef?: string;
  categoryRef?: string;
  values: number[];
  categories: string[];
}

/** Reads a `<c:chartSpace>` back into the little this app redraws from. */
export function parseChartSpace(xml: string): ParsedChart | null {
  const kind: ChartKind | null = /<c:barChart\b/.test(xml) ? 'bar' : /<c:lineChart\b/.test(xml) ? 'line' : /<c:pieChart\b/.test(xml) ? 'pie' : null;
  if (!kind) return null;
  const title = /<c:title>[\s\S]*?<a:t>([\s\S]*?)<\/a:t>/.exec(xml)?.[1] ?? '';
  const valueRef = /<c:val>[\s\S]*?<c:f>([\s\S]*?)<\/c:f>/.exec(xml)?.[1];
  const categoryRef = /<c:cat>[\s\S]*?<c:f>([\s\S]*?)<\/c:f>/.exec(xml)?.[1];
  const values = [...(/<c:numCache>([\s\S]*?)<\/c:numCache>/.exec(xml)?.[1] ?? '').matchAll(/<c:pt\b[^>]*><c:v>([\s\S]*?)<\/c:v><\/c:pt>/g)]
    .map((m) => Number(unescapeXml(m[1])))
    .filter((n) => Number.isFinite(n));
  const categories = [...(/<c:strCache>([\s\S]*?)<\/c:strCache>/.exec(xml)?.[1] ?? '').matchAll(/<c:pt\b[^>]*><c:v>([\s\S]*?)<\/c:v><\/c:pt>/g)]
    .map((m) => unescapeXml(m[1]));
  return { kind, title: unescapeXml(title), valueRef, categoryRef, values, categories };
}

/** One anchor of a drawing part: where it sits (px) and which chart part it shows. */
export interface ParsedAnchor {
  x: number;
  y: number;
  w: number;
  h: number;
  /** The `rId` its `<c:chart>` points at, which the drawing's rels turn into a part name. */
  relId?: string;
}

/** Reads the anchors of a `<xdr:wsDr>` back: position in px, size in px, and the chart it points at. */
export function parseAnchors(xml: string): ParsedAnchor[] {
  const out: ParsedAnchor[] = [];
  for (const m of xml.matchAll(/<xdr:absoluteAnchor>([\s\S]*?)<\/xdr:absoluteAnchor>/g)) {
    const body = m[1];
    const pos = /<xdr:pos\b[^>]*x="(-?\d+)"[^>]*y="(-?\d+)"/.exec(body);
    const ext = /<xdr:ext\b[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(body);
    out.push({
      x: Math.round(Number(pos?.[1] ?? 0) / EMU),
      y: Math.round(Number(pos?.[2] ?? 0) / EMU),
      w: Math.round(Number(ext?.[1] ?? 0) / EMU),
      h: Math.round(Number(ext?.[2] ?? 0) / EMU),
      relId: /<c:chart\b[^>]*r:id="([^"]*)"/.exec(body)?.[1],
    });
  }
  return out;
}

/** The overrides `[Content_Types].xml` needs for a drawing part and a chart part. */
export const drawingContentType = 'application/vnd.openxmlformats-officedocument.drawing+xml';
export const chartContentType = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';

const unescapeXml = (text: string): string =>
  text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d))).replace(/&amp;/g, '&');
