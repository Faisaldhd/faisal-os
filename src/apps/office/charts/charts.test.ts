/** Chart geometry (ticks, pie angles, arcs), scene layout per chart type, RTL, and safe SVG output. */
import { describe, expect, it } from 'vitest';
import { buildChart, type Mark } from './chart';
import { arcPath, formatTick, niceTicks, pieAngles, textWidth } from './geometry';
import { CHART_THEMES, seriesColor } from './palette';
import { escapeXml, renderSvg } from './svg';

const byRole = (marks: Mark[], role: Mark['role']): Mark[] => marks.filter((m) => m.role === role);

describe('geometry', () => {
  it('computes nice ticks', () => {
    expect(niceTicks(0, 97)).toEqual({ min: 0, max: 100, step: 20, ticks: [0, 20, 40, 60, 80, 100] });
    expect(niceTicks(0, 1, 6).ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(niceTicks(-35, 42, 6)).toMatchObject({ min: -40, max: 60, step: 20 });
    expect(niceTicks(0, 10, 5)).toMatchObject({ step: 2.5, max: 10 });
    expect(niceTicks(0, 11, 5)).toMatchObject({ step: 5, max: 15 });
    expect(niceTicks(5, 5)).toMatchObject({ min: 0 });
    expect(niceTicks(0, 0).ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(niceTicks(10, 2).min).toBe(2);
    expect(niceTicks(NaN, 3).ticks.length).toBeGreaterThan(1);
    const t = niceTicks(0.1, 0.7);
    expect(t.ticks.every((v) => String(v).length < 6)).toBe(true); // no float noise
  });

  it('splits a pie by value, clockwise from 12 o’clock', () => {
    const s = pieAngles([1, 1, 2]);
    expect(s.map((x) => x.fraction)).toEqual([0.25, 0.25, 0.5]);
    expect(s[0].start).toBeCloseTo(-Math.PI / 2);
    expect(s[0].end).toBeCloseTo(0);
    expect(s[2].end).toBeCloseTo(Math.PI * 1.5);
    expect(s[1].mid).toBeCloseTo(Math.PI / 4);
    expect(pieAngles([3, -1, null, 1]).map((x) => x.fraction)).toEqual([0.75, 0, 0, 0.25]);
    expect(pieAngles([0, 0]).every((x) => x.fraction === 0)).toBe(true);
  });

  it('draws arcs, whole circles and doughnut rings', () => {
    expect(arcPath(50, 50, 10, 0, Math.PI / 2)).toBe('M50 50L60 50A10 10 0 0 1 50 60Z');
    expect(arcPath(50, 50, 10, 0, Math.PI * 1.5)).toContain(' 0 1 1 ');
    expect(arcPath(50, 50, 10, 0, Math.PI * 2)).toMatch(/^M60 50A.*Z$/);
    expect(arcPath(50, 50, 10, 0, Math.PI / 2, 5)).toBe('M60 50A10 10 0 0 1 50 60L50 55A5 5 0 0 0 55 50Z');
    expect(arcPath(0, 0, 1, 1, 1)).toBe('');
  });

  it('formats tick labels and estimates text width', () => {
    expect(formatTick(0.30000000000000004, 0.1)).toBe('0.3');
    expect(formatTick(25000, 5000)).toBe('25K');
    expect(formatTick(2500000, 500000)).toBe('2.5M');
    expect(formatTick(-40, 20)).toBe('-40');
    expect(textWidth('abc', 10)).toBeGreaterThan(10);
    expect(textWidth('مرحبا', 10)).toBe(25);
  });

  it('starts the palette with the suite accents and never cycles', () => {
    expect(seriesColor(0, 'dark')).toBe('#5B8DEF');
    expect(new Set(CHART_THEMES.dark.series).size).toBe(8);
    expect(seriesColor(8, 'dark')).toBe(CHART_THEMES.dark.other);
  });
});

describe('bar charts', () => {
  const spec = { type: 'bar' as const, categories: ['Q1', 'Q2', 'Q3'], series: [{ name: 'Sales', values: [10, 20, 30] }, { name: 'Cost', values: [5, null, 15] }] };

  it('draws clustered bars from the zero line with a legend', () => {
    const scene = buildChart(spec);
    const bars = byRole(scene.marks, 'bar');
    expect(bars).toHaveLength(5); // the null is skipped
    expect(bars[0]).toMatchObject({ series: 0, index: 0, label: 'Sales · Q1: 10', fill: seriesColor(0) });
    expect(byRole(scene.marks, 'legend-label').map((m) => (m as { text: string }).text)).toEqual(['Sales', 'Cost']);
    expect(scene.valueTicks).toMatchObject({ min: 0, max: 30 });
    const labels = byRole(scene.marks, 'category-label') as Array<Extract<Mark, { kind: 'text' }>>;
    expect(labels.map((l) => l.text)).toEqual(['Q1', 'Q2', 'Q3']);
    expect(labels[0].x).toBeLessThan(labels[2].x);
  });

  it('stacks positive and negative values separately', () => {
    const scene = buildChart({ type: 'bar', stacked: true, categories: ['a'], series: [{ name: 'x', values: [10] }, { name: 'y', values: [-4] }, { name: 'z', values: [5] }] });
    expect(scene.valueTicks!.min).toBeLessThanOrEqual(-4);
    expect(scene.valueTicks!.max).toBeGreaterThanOrEqual(15);
    expect(byRole(scene.marks, 'bar')).toHaveLength(3);
  });

  it('mirrors categories and the value axis in RTL', () => {
    const ltr = buildChart(spec);
    const rtl = buildChart({ ...spec, rtl: true, categories: ['الأول', 'الثاني', 'الثالث'] });
    const labels = byRole(rtl.marks, 'category-label') as Array<Extract<Mark, { kind: 'text' }>>;
    expect(labels[0].x).toBeGreaterThan(labels[2].x);
    expect(labels[0].rtl).toBe(true);
    const tick = (s: typeof ltr): number => (byRole(s.marks, 'tick-label')[0] as { x: number }).x;
    expect(tick(ltr)).toBeLessThan(ltr.plot.x);
    expect(tick(rtl)).toBeGreaterThan(rtl.plot.x + rtl.plot.w);
  });

  it('lays horizontal bars along the x axis', () => {
    const scene = buildChart({ ...spec, horizontal: true });
    const labels = byRole(scene.marks, 'category-label') as Array<Extract<Mark, { kind: 'text' }>>;
    expect(labels[0].y).toBeLessThan(labels[2].y);
    expect(labels[0].anchor).toBe('end');
  });
});

describe('line, scatter, pie and doughnut', () => {
  it('draws one path per series, breaking at gaps, with markers', () => {
    const scene = buildChart({ type: 'line', categories: ['a', 'b', 'c', 'd'], series: [{ name: 's', values: [1, 2, null, 4] }] });
    const [line] = byRole(scene.marks, 'line') as Array<Extract<Mark, { kind: 'path' }>>;
    expect(line.d.match(/M/g)).toHaveLength(2);
    expect(line.strokeWidth).toBe(2);
    expect(byRole(scene.marks, 'marker')).toHaveLength(3);
    expect(byRole(scene.marks, 'legend-label')).toHaveLength(0); // one series: the title names it
  });

  it('places scatter points on both scales', () => {
    const scene = buildChart({ type: 'scatter', series: [{ name: 'p', points: [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: NaN, y: 1 }] }] });
    const pts = byRole(scene.marks, 'marker') as Array<Extract<Mark, { kind: 'circle' }>>;
    expect(pts).toHaveLength(2);
    expect(pts[1].cx).toBeGreaterThan(pts[0].cx);
    expect(pts[1].cy).toBeLessThan(pts[0].cy);
    expect(scene.xTicks).toMatchObject({ min: 0, max: 10 });
  });

  it('draws pie slices with percentages and a legend of categories', () => {
    const scene = buildChart({ type: 'pie', categories: ['A', 'B', 'C'], series: [{ name: 'v', values: [50, 30, 20] }] });
    const slices = byRole(scene.marks, 'slice');
    expect(slices).toHaveLength(3);
    expect(slices[0].label).toBe('A: 50 (50%)');
    expect(byRole(scene.marks, 'slice-label').map((m) => (m as { text: string }).text)).toEqual(['50%', '30%', '20%']);
    expect(byRole(scene.marks, 'legend-label')).toHaveLength(3);
  });

  it('draws a doughnut ring with the total in the middle, and an empty ring for no data', () => {
    const scene = buildChart({ type: 'doughnut', categories: ['A', 'B'], series: [{ name: 'v', values: [1, 3] }] });
    expect((byRole(scene.marks, 'slice')[0] as { d: string }).d).toContain('L');
    expect(byRole(scene.marks, 'slice-label').some((m) => (m as { text: string }).text === '4')).toBe(true);
    const empty = buildChart({ type: 'pie', series: [{ name: 'v', values: [0, 0] }] });
    expect(byRole(empty.marks, 'empty')).toHaveLength(1);
  });
});

describe('SVG output', () => {
  it('escapes every text and attribute', () => {
    const scene = buildChart({ type: 'bar', title: '<script>alert("x")</script>', categories: ['a&b', '"q"'], series: [{ name: "O'Neil <b>", values: [1, 2] }] });
    const svg = renderSvg(scene, { title: 'T & "t"' });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toContain('a&amp;b');
    expect(svg).toContain('O&apos;Neil &lt;b&gt;');
    expect(svg).toContain('aria-label="T &amp; &quot;t&quot;"');
    expect(escapeXml('<&>"\'')).toBe('&lt;&amp;&gt;&quot;&apos;');
  });

  it('writes RTL text with direction and parses as XML', () => {
    const svg = renderSvg(buildChart({ type: 'pie', rtl: true, categories: ['شمال', 'جنوب'], series: [{ name: 'v', values: [1, 2] }], theme: 'light' }));
    expect(svg).toContain('direction="rtl"');
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
    expect(doc.documentElement.getAttribute('width')).toBe('640');
  });
});
