/**
 * The custom presets' ONLY entry point for outside data is `parsePresets`, so that is what these
 * tests hammer: unknown keys, out-of-range values, wrong types, corrupt files, huge files and
 * round-trips. A hostile or broken import must never reach the editor's state.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { NEUTRAL_ADJUST } from './ops';
import {
  PRESETS_KEY, PRESETS_MAX, PRESETS_TEXT_MAX, PRESET_NAME_MAX, exportPresets, isNeutralPreset,
  loadPresets, makePreset, mergePresets, movePreset, parsePresets, removePreset, renamePreset,
  sanitizeName, savePresets, type CustomPreset,
} from './presets';

const params = (over: Partial<typeof NEUTRAL_ADJUST> = {}) => ({ ...NEUTRAL_ADJUST, ...over });

describe('photo presets — strict parsing', () => {
  it('accepts a well-formed file and keeps every value', () => {
    const text = exportPresets([makePreset('دافئ', params({ temperature: 30, saturation: 12, hue: -20 }))]);
    const parsed = parsePresets(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.presets).toHaveLength(1);
    expect(parsed.presets[0].name).toBe('دافئ');
    expect(parsed.presets[0].params).toEqual(params({ temperature: 30, saturation: 12, hue: -20 }));
    expect(parsed.dropped).toBe(0);
  });

  it('also accepts a bare list of presets', () => {
    const parsed = parsePresets(JSON.stringify([{ name: 'X', params: { exposure: 10 } }]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.presets[0].params.exposure).toBe(10);
    // …and every key absent from the file is neutral, not undefined.
    expect((parsed.presets[0].params as unknown as Record<string, unknown>).whites).toBeUndefined();
    expect(parsed.presets[0].params.grayscale).toBe(false);
  });

  it('drops unknown keys instead of copying them through', () => {
    const parsed = parsePresets(JSON.stringify([{
      name: 'Sneaky',
      params: { exposure: 5, whites: 90, levels: { master: { gamma: 3 } }, curves: { master: [[0, 0]] }, junk: 'x' },
    }]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const p = parsed.presets[0].params as unknown as Record<string, unknown>;
    expect(p.exposure).toBe(5);
    for (const banned of ['whites', 'levels', 'curves', 'junk']) expect(p[banned]).toBeUndefined();
    // Exactly the documented keys, nothing else.
    expect(Object.keys(p).sort()).toEqual([...Object.keys(NEUTRAL_ADJUST)].sort());
  });

  it('cannot be polluted through __proto__ in the file', () => {
    const parsed = parsePresets('{"presets":[{"name":"p","params":{"__proto__":{"polluted":1},"exposure":3}}]}');
    expect(parsed.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(parsed.ok && parsed.presets[0].params.exposure).toBe(3);
  });

  it('clamps out-of-range numbers to the engine ranges and neutralises wrong types', () => {
    const parsed = parsePresets(JSON.stringify([{
      name: 'Wild',
      params: {
        exposure: 500, hue: 999, saturation: -1000, contrast: 'lots', brightness: null,
        vibrance: Number.NaN, tint: Number.POSITIVE_INFINITY, highlights: 12.6,
        invert: 'yes', grayscale: 1,
      },
    }]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const p = parsed.presets[0].params;
    expect(p.exposure).toBe(100);      // clamped to +100
    expect(p.hue).toBe(180);           // hue has its own range
    expect(p.saturation).toBe(-100);
    expect(p.highlights).toBe(13);     // rounded
    expect(p.contrast).toBe(0);        // a string is not a number
    expect(p.brightness).toBe(0);
    expect(p.vibrance).toBe(0);        // NaN is not a number
    expect(p.tint).toBe(0);            // Infinity is not finite
    expect(p.invert).toBe(false);      // only real booleans count
    expect(p.grayscale).toBe(false);
  });

  it('keeps real booleans', () => {
    const parsed = parsePresets('{"presets":[{"name":"g","params":{"grayscale":true,"invert":true}}]}');
    expect(parsed.ok && parsed.presets[0].params.grayscale).toBe(true);
    expect(parsed.ok && parsed.presets[0].params.invert).toBe(true);
  });

  it('refuses corrupt JSON, non-lists and empty text without throwing', () => {
    for (const bad of ['{', 'null', '42', '"text"', '', '   ']) {
      const parsed = parsePresets(bad);
      expect(parsed.ok).toBe(false);
    }
    expect(parsePresets('{"presets":{}}').ok).toBe(false);
    expect(parsePresets('{"presets":"nope"}').ok).toBe(false);
  });

  it('refuses an oversized file instead of parsing it', () => {
    const huge = `{"presets":[${'{"name":"x"},'.repeat(PRESETS_TEXT_MAX)}]}`;
    expect(parsePresets(huge).ok).toBe(false);
  });

  it('caps the list and counts what it dropped', () => {
    const list = Array.from({ length: PRESETS_MAX + 5 }, (_, i) => ({ name: `p${i}`, params: { exposure: 1 } }));
    const parsed = parsePresets(JSON.stringify({ presets: list }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.presets).toHaveLength(PRESETS_MAX);
    expect(parsed.dropped).toBe(5);
  });

  it('drops entries that are not objects at all', () => {
    const parsed = parsePresets('{"presets":[null, 7, "x", [], {"name":"ok","params":{"exposure":2}}]}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.presets).toHaveLength(1);
    expect(parsed.dropped).toBe(4);
  });

  it('sanitises names: control characters, whitespace and length', () => {
    expect(sanitizeName('  my\u0000filter \n', 0)).toBe('my filter');
    expect(sanitizeName('x'.repeat(PRESET_NAME_MAX + 20), 0)).toHaveLength(PRESET_NAME_MAX);
    expect(sanitizeName('', 3)).toBe('Preset 4');
    expect(sanitizeName(undefined, 0)).toBe('Preset 1');
  });

  it('always mints a fresh id, so an import cannot overwrite an existing preset', () => {
    const existing = [makePreset('Mine', params({ exposure: 20 }))];
    const incoming = parsePresets(JSON.stringify([{ id: existing[0].id, name: 'Mine', params: { exposure: -20 } }]));
    expect(incoming.ok).toBe(true);
    if (!incoming.ok) return;
    expect(incoming.presets[0].id).not.toBe(existing[0].id);
    const merged = mergePresets(existing, incoming.presets);
    expect(merged).toHaveLength(2);
    expect(merged[0].params.exposure).toBe(20);   // the existing one is untouched
  });
});

describe('photo presets — list operations', () => {
  const a = { ...makePreset('a', params({ exposure: 1 })), id: 'a' };
  const b = { ...makePreset('b', params({ exposure: 2 })), id: 'b' };
  const c = { ...makePreset('c', params({ exposure: 3 })), id: 'c' };

  it('merges without mutating and respects the cap', () => {
    const existing = [a];
    const out = mergePresets(existing, [b, c]);
    expect(existing).toHaveLength(1);
    expect(out.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    const full = Array.from({ length: PRESETS_MAX }, (_, i) => ({ ...a, id: `x${i}` }));
    expect(mergePresets(full, [b])).toHaveLength(PRESETS_MAX);
  });

  it('reorders by one step and stops at the ends', () => {
    const list = [a, b, c];
    expect(movePreset(list, 'b', -1).map((p) => p.id)).toEqual(['b', 'a', 'c']);
    expect(movePreset(list, 'b', 1).map((p) => p.id)).toEqual(['a', 'c', 'b']);
    expect(movePreset(list, 'a', -1).map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(movePreset(list, 'c', 1).map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(movePreset(list, 'missing', 1).map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(list.map((p) => p.id)).toEqual(['a', 'b', 'c']);   // pure
  });

  it('renames and removes without touching the others', () => {
    const renamed = renamePreset([a, b], 'b', '  New name  ');
    expect(renamed[1].name).toBe('New name');
    expect(renamed[0]).toBe(a);
    expect(removePreset([a, b, c], 'b').map((p) => p.id)).toEqual(['a', 'c']);
  });

  it('knows a preset that would change nothing', () => {
    expect(isNeutralPreset(makePreset('n', params()))).toBe(true);
    expect(isNeutralPreset(makePreset('n', params({ exposure: 1 })))).toBe(false);
    expect(isNeutralPreset(makePreset('n', params({ grayscale: true })))).toBe(false);
  });

  it('round-trips through export → parse → export', () => {
    const list = [makePreset('واحد', params({ exposure: 10, hue: -45, invert: true })), makePreset('two', params({ temperature: -20 }))];
    const once = exportPresets(list);
    const parsed = parsePresets(once);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const twice = exportPresets(parsed.presets);
    // Names and parameters survive both directions (the ids are local and are always re-minted).
    expect(JSON.parse(twice).presets).toEqual(JSON.parse(once).presets);
    expect(parsed.presets.map((p: CustomPreset) => p.name)).toEqual(['واحد', 'two']);
    expect(parsed.presets[1].params.temperature).toBe(-20);
  });
});

describe('photo presets — local storage', () => {
  beforeEach(() => { window.localStorage.clear(); });

  it('round-trips through localStorage and survives a corrupt value', () => {
    const list = [makePreset('محفوظ', params({ saturation: 25 }))];
    savePresets(list);
    const loaded = loadPresets();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe('محفوظ');
    expect(loaded[0].params.saturation).toBe(25);

    window.localStorage.setItem(PRESETS_KEY, '{"broken":');
    expect(loadPresets()).toEqual([]);
    window.localStorage.setItem(PRESETS_KEY, JSON.stringify({ presets: 'no' }));
    expect(loadPresets()).toEqual([]);
  });

  it('clamps what it reads back, even if the stored value was tampered with', () => {
    window.localStorage.setItem(PRESETS_KEY, JSON.stringify([{ id: 'x', name: 'z', params: { exposure: 9999 } }]));
    const loaded = loadPresets();
    expect(loaded[0].params.exposure).toBe(100);
  });
});
