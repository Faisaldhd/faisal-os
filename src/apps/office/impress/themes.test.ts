/**
 * Impress — design themes and the slide size: what applying one does to the model, and that both
 * survive a real save and reopen (the theme part, the master, `<p:sldSz>`).
 */
import { describe, expect, it } from 'vitest';
import { newDeckPptx } from '../pptx';
import { readRawZip, entryData } from '../zip';
import { readDeck } from './deck';
import { patchDeck } from './deckpatch';
import { addSlide, newShape, addShape } from './ops';
import { applyTheme, currentTheme, DEFAULT_THEME, setSlideSize, SLIDE_SIZES, slideSizeOf, THEMES, themeById } from './themes';
import { pickDeckTheme } from './newdeck';

const partText = async (bytes: Uint8Array, name: string): Promise<string> =>
  new TextDecoder().decode((await entryData(readRawZip(bytes), name)) ?? new Uint8Array());

describe('the themes', () => {
  it('offers eight designs with distinct ids, full colour schemes and readable text', () => {
    expect(THEMES.length).toBe(8);
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(8);
    const lum = (hex: string): number => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    };
    const contrast = (a: string, b: string): number => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
    for (const t of THEMES) {
      expect(Object.values(t.colors).every((c) => /^#[0-9A-F]{6}$/i.test(c))).toBe(true);
      expect(contrast(t.title, t.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.body, t.bg)).toBeGreaterThanOrEqual(4.5);
      expect(t.ar && t.en).toBeTruthy();
    }
  });

  it('paints every inheriting slide through the master, and keeps a slide background of its own', async () => {
    let deck = await readDeck(newDeckPptx('T', 'S'));
    deck = addSlide(deck, 0, 'content');
    deck = { ...deck, slides: deck.slides.map((s, i) => (i === 1 ? { ...s, bgOwn: '#123456', bg: '#123456' } : s)) };
    const midnight = themeById('midnight')!;
    const out = applyTheme(deck, midnight);
    expect(out.masters[0]!.bg).toBe(midnight.bg);
    expect(out.masters[0]!.title.color).toBe(midnight.title);
    expect(out.masters[0]!.title.font).toBeNull();
    expect(out.slides[0]!.bg).toBe(midnight.bg);
    expect(out.slides[1]!.bg).toBe('#123456');
    expect(out.scheme.accent1).toBe(midnight.colors.accent1);
    expect(out.fonts).toEqual({ major: midnight.major, minor: midnight.minor });
    expect(currentTheme(out)?.id).toBe('midnight');
    // A new shape takes the theme's accent.
    expect(newShape(out, 'rect').fill).toBe(midnight.colors.accent1);
  });

  it('is written into the theme part and the master, and read back the same', async () => {
    const bytes = newDeckPptx('T', 'S');
    const base = await readDeck(bytes);
    for (const theme of [themeById('ocean')!, themeById('slate')!]) {
      const cur = applyTheme(base, theme);
      const out = await patchDeck(readRawZip(bytes), base, cur);
      expect(out).not.toBeNull();
      expect(out!.changed).toContain('ppt/theme/theme1.xml');
      expect(out!.changed).toContain('ppt/slideMasters/slideMaster1.xml');
      const read = await readDeck(out!.bytes);
      expect(currentTheme(read)?.id).toBe(theme.id);
      expect(read.masters[0]!.bg).toBe(theme.bg);
      expect(read.masters[0]!.title.color).toBe(theme.title);
      expect(read.masters[0]!.body.color).toBe(theme.body);
      expect(read.slides[0]!.bg).toBe(theme.bg);
      const xml = await partText(out!.bytes, 'ppt/theme/theme1.xml');
      expect(xml).toContain(`<a:latin typeface="${theme.major}"/>`);
      expect(xml).toContain(`<a:accent1><a:srgbClr val="${theme.colors.accent1.slice(1)}"/></a:accent1>`);
      // A second save of the reopened deck changes nothing.
      const again = await patchDeck(readRawZip(out!.bytes), read, read);
      expect(again!.changed).toEqual([]);
    }
  });
});

describe('the slide size', () => {
  it('scales every shape into the new size and writes <p:sldSz>', async () => {
    const bytes = newDeckPptx('T', 'S');
    const base = await readDeck(bytes);
    expect(slideSizeOf(base)).toBe('wide');
    const box = addShape(base, 0, newShape(base, 'rect'));
    const rect = box.slides[0]!.shapes.at(-1)!;
    const { cx, cy } = SLIDE_SIZES.standard;
    const cur = setSlideSize(box, cx, cy);
    expect(slideSizeOf(cur)).toBe('standard');
    const scaled = cur.slides[0]!.shapes.at(-1)!;
    expect(scaled.x).toBe(Math.round(rect.x * cx / base.cx));
    expect(scaled.w).toBe(Math.round(rect.w * cx / base.cx));
    expect(scaled.h).toBe(rect.h);
    const out = await patchDeck(readRawZip(bytes), base, cur);
    expect(out).not.toBeNull();
    const read = await readDeck(out!.bytes);
    expect([read.cx, read.cy]).toEqual([cx, cy]);
    expect(read.slides[0]!.shapes[0]!.w).toBe(cur.slides[0]!.shapes[0]!.w);
    expect(await partText(out!.bytes, 'ppt/presentation.xml')).toContain(`<p:sldSz cx="${cx}" cy="${cy}"/>`);
  });
});

describe('a new presentation', () => {
  it('is born in a design theme, never blank white', async () => {
    const plain = await readDeck(newDeckPptx('T', 'S'));
    expect(currentTheme(plain)?.id).toBe(DEFAULT_THEME.id);
    expect(plain.slides[0]!.bg ?? plain.masters[0]!.bg).not.toBe('#FFFFFF');
    const midnight = themeById('midnight')!;
    const dark = await readDeck(newDeckPptx('T', 'S', midnight));
    expect(currentTheme(dark)?.id).toBe('midnight');
    expect(dark.masters[0]!.bg).toBe(midnight.bg);
    expect(dark.masters[0]!.title.color).toBe(midnight.title);
    expect(dark.fonts).toEqual({ major: midnight.major, minor: midnight.minor });
    // The master says "the theme's fonts" (+mj-lt / +mn-lt), so a new theme changes the fonts too.
    expect(dark.masters[0]!.title.font).toBeNull();
  });

  it('asks for a design first: OK creates in the picked one, Cancel creates nothing', async () => {
    const host = document.createElement('div');
    host.dataset.kind = 'start';
    document.body.append(host);
    const picked = pickDeckTheme(host);
    expect(host.dataset.kind).toBe('pptx');
    host.querySelector<HTMLButtonElement>('.fo-imp-theme[data-theme="forest"]')!.click();
    expect(host.querySelector('.fo-imp-theme[data-theme="forest"]')!.getAttribute('aria-pressed')).toBe('true');
    host.querySelector<HTMLButtonElement>('.fo-modal .is-primary')!.click();
    expect((await picked)?.id).toBe('forest');

    const cancelled = pickDeckTheme(host);
    [...host.querySelectorAll<HTMLButtonElement>('.fo-modal .fo-btn')].find((b) => !b.classList.contains('is-primary'))!.click();
    expect(await cancelled).toBeNull();
    host.remove();
  });
});
