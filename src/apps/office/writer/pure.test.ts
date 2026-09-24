/** Pure Writer helpers: run edits, find (Arabic-aware), pagination, export, and the recent list. */
import { describe, expect, it } from 'vitest';
import { countText, diffText, formatRange, mergeBlocks, propsInRange, replaceText, splitBlock, startsRtl } from './docops';
import { findAll, foldText } from './find';
import { paginate } from './paginate';
import { toHtml, toMarkdown } from './export';
import { cssAlign, logicalAlign } from './view';
import { pushRecent, RECENT_LIMIT } from '../start';
import type { DocBlock, Run } from './types';

const runs = (): Run[] => [
  { t: 'text', text: 'normal ', props: {}, src: 0 },
  { t: 'text', text: 'bold', props: { b: true }, src: 1 },
  { t: 'opaque', text: '', xml: '<w:bookmarkStart/>', kind: 'mark', src: 2 },
  { t: 'text', text: ' end', props: {}, src: 3 },
];
const text = (r: Run[]): string => r.map((x) => x.text).join('');

describe('run operations', () => {
  it('types with the formatting of the character before, and over a selection with the first replaced one', () => {
    const typed = replaceText(runs(), 11, 11, 'er');
    expect(text(typed)).toBe('normal bolder end');
    expect(propsInRange(typed, 7, 13).b).toBe(true);
    const over = replaceText(runs(), 7, 11, 'BIG');
    expect(propsInRange(over, 7, 10).b).toBe(true);
    expect(over.some((r) => r.t === 'opaque')).toBe(true);
  });

  it('formats a range, splitting runs at its edges', () => {
    const out = formatRange(runs(), 0, 6, { i: true });
    expect(propsInRange(out, 0, 6).i).toBe(true);
    expect(propsInRange(out, 6, 7).i).toBeUndefined();
    expect(text(out)).toBe(text(runs()));
  });

  it('splits and merges paragraphs losslessly', () => {
    const block: DocBlock = { id: 1, runs: runs() };
    const [a, b] = splitBlock(block, 9, 9);
    expect(text(a.runs) + text(b.runs)).toBe('normal bold end');
    expect(b.tpl).toBe(1);
    expect(text(mergeBlocks(a, b).runs)).toBe('normal bold end');
  });

  it('diffs text and counts Arabic words', () => {
    expect(diffText('abcdef', 'abXdef')).toEqual({ start: 2, del: 1, ins: 'X' });
    expect(countText(['مرحبا بالعالم', 'two words']).words).toBe(4);
    expect(startsRtl('  مرحبا')).toBe(true);
    expect(startsRtl('Hello')).toBe(false);
  });
});

describe('find', () => {
  it('ignores tashkeel, tatweel and hamza forms, and reports real offsets', () => {
    const texts = ['مُحَمَّد أحمد', 'اِبحث عن احمــد'];
    const hits = findAll(texts, 'محمد');
    expect(hits).toEqual([{ block: 0, start: 0, end: 8 }]);
    expect(findAll(texts, 'احمد').map((h) => h.block)).toEqual([0, 1]);
    expect(foldText('Hello').folded).toBe('hello');
  });
});

describe('pagination', () => {
  it('pushes a block that would cross the bottom margin to the next page', () => {
    const geo = { height: 100, gap: 10, top: 0, bottom: 20 };
    const out = paginate([40, 30, 30], geo);
    expect(out.pages).toBe(2);
    expect(out.pushes).toEqual([0, 0, 40]);
    expect(out.pageOf).toEqual([0, 0, 1]);
    expect(paginate([10, 10], geo, new Set([1])).pageOf).toEqual([0, 1]);
  });
});

describe('export and alignment', () => {
  it('escapes content and keeps structure', () => {
    const model = { kind: 'docx' as const, paragraphs: ['<b>x</b>', 'item'], blocks: [
      { id: 0, runs: [{ t: 'text' as const, text: '<b>x</b>', props: { b: true } }] },
      { id: 1, runs: [{ t: 'text' as const, text: 'item', props: {} }] },
    ], formats: { 0: { style: 'Heading1' }, 1: { list: 'bullet' as const } } };
    const html = toHtml(model, 'T');
    expect(html).toContain('<h1 dir="auto"><strong>&lt;b&gt;x&lt;/b&gt;</strong></h1>');
    expect(html).toContain('<ul>');
    expect(toMarkdown(model)).toBe('# **<b\\>x</b\\>**\n\n- item\n');
  });

  it('reads Word alignment logically in right-to-left paragraphs', () => {
    expect(cssAlign('right')).toBe('end');
    expect(cssAlign(undefined)).toBe('start');
    expect(logicalAlign('right', true)).toBe('left');
    expect(logicalAlign('right', false)).toBe('right');
  });
});

describe('recent files', () => {
  it('keeps the newest first, without duplicates, capped', () => {
    let list = pushRecent([], '/a', 1);
    list = pushRecent(list, '/b', 2);
    list = pushRecent(list, '/a', 3);
    expect(list.map((e) => e.path)).toEqual(['/a', '/b']);
    for (let i = 0; i < 20; i++) list = pushRecent(list, `/f${i}`, i);
    expect(list.length).toBe(RECENT_LIMIT);
  });
});
