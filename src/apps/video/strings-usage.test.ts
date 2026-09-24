import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registeredKeys } from '../../kernel/i18n';
import './strings';
import { SHORTCUTS } from './shortcuts';
import { COLOR_PRESETS } from './render-math';

/**
 * Every `s('key')` the app calls must exist in both languages — a missing key
 * would show the raw key to the owner. Keys built at run time are listed here
 * from the same tables the code builds them from.
 */
describe('video strings in use', () => {
  const dir = __dirname;
  const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => readFileSync(join(dir, f), 'utf8'));
  const literal = new Set<string>();
  for (const src of sources) for (const m of src.matchAll(/\bs\('([A-Za-z0-9_]+)'/g)) literal.add(m[1]);
  const dynamic = [
    ...['none', 'fade', 'slide', 'pop'].map((k) => `anim_${k}`),
    ...['sans', 'naskh', 'kufi', 'display', 'mono'].map((k) => `font_${k}`),
    ...SHORTCUTS.map((sc) => `key_${sc.action}`),
    ...Object.keys(COLOR_PRESETS).map((k) => `look_${k}`),
    ...['title', 'subtitle', 'lower', 'caption'].flatMap((k) => [`preset_${k}`, `preset_${k}_sample`]),
    ...['json', 'format', 'version', 'shape'].map((k) => `projectError_${k}`),
    ...['none', 'crossfade', 'dip', 'slide'].map((k) => `transition_${k}`),
    ...['video', 'image', 'audio', 'text'].map((k) => `type_${k}`),
    'tabEdit', 'tabAudio', 'tabText', 'tabEffects',
  ];

  it('finds the literal keys (sanity)', () => {
    expect(literal.size).toBeGreaterThan(200);
  });

  for (const locale of ['ar', 'en'] as const) {
    it(`has every used key in ${locale}`, () => {
      const known = new Set(registeredKeys(locale));
      const missing = [...literal, ...dynamic].filter((k) => !known.has(`video.${k}`));
      expect(missing).toEqual([]);
    });
  }
});
