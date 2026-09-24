import { describe, expect, it } from 'vitest';
import { commandFor, matches, parseCombo, SHORTCUTS, shortcutSheet } from './shortcuts';
import { ICONS, icon } from './icons';
import { registeredKeys } from '../../kernel/i18n';
import './strings';

describe('pdf shortcuts table', () => {
  it('parses combos, including Ctrl++', () => {
    expect(parseCombo('Ctrl+Shift+S')).toEqual({ ctrl: true, shift: true, alt: false, key: 'S' });
    expect(parseCombo('Ctrl++').key).toBe('+');
    expect(parseCombo('F1')).toEqual({ ctrl: false, shift: false, alt: false, key: 'F1' });
  });

  it('matches ⌘ like Ctrl and an Arabic layout by the physical key', () => {
    expect(matches({ key: 's', ctrlKey: true }, 'Ctrl+S')).toBe(true);
    expect(matches({ key: 's', metaKey: true }, 'Ctrl+S')).toBe(true);
    expect(matches({ key: 'س', code: 'KeyS', ctrlKey: true }, 'Ctrl+S')).toBe(true);
    expect(matches({ key: 'S', ctrlKey: true, shiftKey: true }, 'Ctrl+S')).toBe(false);
    expect(matches({ key: '+', ctrlKey: true, shiftKey: true }, 'Ctrl++')).toBe(true);
  });

  it('maps events to commands and leaves typing alone', () => {
    expect(commandFor({ key: 's', ctrlKey: true }, true)).toBe('save');
    expect(commandFor({ key: 'S', ctrlKey: true, shiftKey: true }, false)).toBe('saveAs');
    expect(commandFor({ key: 'z', ctrlKey: true }, false)).toBe('undo');
    expect(commandFor({ key: 'z', ctrlKey: true }, true)).toBeNull();
    expect(commandFor({ key: 'Z', ctrlKey: true, shiftKey: true }, false)).toBe('redoAlt');
    expect(commandFor({ key: 'Delete' }, true)).toBeNull();
    expect(commandFor({ key: 'x' }, false)).toBeNull();
  });

  it('generates the F1 sheet from the same table, every label translated', () => {
    const sheet = shortcutSheet();
    expect(sheet.find((row) => row.label === 'keyRedo')?.combos).toEqual(['Ctrl+Y', 'Ctrl+Shift+Z']);
    const keys = registeredKeys('ar');
    for (const s of SHORTCUTS) expect(keys, s.label).toContain(`pdf.${s.label}`);
    expect(new Set(SHORTCUTS.map((s) => s.combo)).size).toBe(SHORTCUTS.length);
  });
});

describe('pdf icons', () => {
  it('renders every icon as a line SVG in currentColor, with nothing executable', () => {
    for (const name of Object.keys(ICONS) as (keyof typeof ICONS)[]) {
      const node = icon(name);
      expect(node.nodeName.toLowerCase(), name).toBe('svg');
      expect(node.getAttribute('stroke'), name).toBe('currentColor');
      expect(node.getAttribute('stroke-width'), name).toBe('1.75');
      expect(node.querySelector('script'), name).toBeNull();
      expect(node.children.length, name).toBeGreaterThan(0);
    }
    expect(icon('undo').classList.contains('is-mirrored')).toBe(true);
    expect(icon('print').classList.contains('is-mirrored')).toBe(false);
  });
});
