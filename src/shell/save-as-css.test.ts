/// <reference types="node" />
/*
 * `node` types are opted into for THIS FILE only (the root tsconfig lists `types: ["vite/client"]`),
 * because the checks below read the stylesheet and the module source as text — jsdom has no
 * layout engine and no way to see a container query.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { registeredKeys } from '../kernel/i18n';
import './strings';

/**
 * The design-bar contract of the shared Save as dialog.
 *
 * The rules the Creative Director checks (glass first, copper/blue, 4px grid, 6/10/14 radii,
 * 140/220ms motion, 44px targets on a phone, layout keyed off the WINDOW rather than the
 * screen) are all expressed in CSS, so this test pins them where a later edit could quietly
 * drop one — and pins the two safety properties that live in the module itself: no `innerHTML`
 * on anything, and every `shell.saveas.*` key really registered in BOTH languages (the shell
 * namespace is prefixed, and a missing prefix renders the raw key to the user).
 */
function readSource(relative: string): string {
  return readFileSync(resolve(process.cwd(), relative), 'utf8').replace(/\r\n/g, '\n');
}

const css = readSource('src/shell/theme.css');
const source = readSource('src/shell/save-as.ts');

/** Everything from our own section header to the end of the file. */
const block = css.slice(css.indexOf('«حفظ باسم / تصدير»'));

const ruleBody = (selector: string): string => {
  const at = block.indexOf(`${selector} {`);
  expect(at, `${selector} rule exists`).toBeGreaterThanOrEqual(0);
  const open = block.indexOf('{', at);
  const close = block.indexOf('}', open);
  return block.slice(open + 1, close);
};

describe('save-as CSS — the design bar', () => {
  it('is glass first: blur + saturate, a hairline and a soft shadow, with an opaque fallback', () => {
    const card = ruleBody('.faisal-saveas');
    expect(card).toContain('backdrop-filter: blur(18px) saturate(140%)');
    expect(card).toContain('border: 1px solid var(--sa-hairline)');
    expect(card).toContain('box-shadow: 0 8px 32px rgba(0, 0, 0, .35)');
    expect(block).toContain('@supports not (backdrop-filter: blur(1px))');
    expect(block).toContain('@media (prefers-reduced-transparency: reduce)');
  });

  it('uses the suite accents — copper and calm blue — and only 6/10/14 radii', () => {
    expect(block).toContain('var(--app-copper, #C8894B)');
    expect(block).toContain('var(--app-copper-2, #E0A96D)');
    expect(block).toContain('var(--app-blue, #5B8DEF)');
    expect(block).toContain('var(--app-blue-soft, rgba(91, 141, 239, .16))');
    const radii = [...block.matchAll(/border-radius:\s*([^;]+);/g)].map((m) => m[1].trim());
    for (const value of radii) {
      expect(value, `radius ${value}`).toMatch(/^(6px|10px|14px|var\(--sa-radius\)|14px 14px 0 0)$/);
    }
  });

  it('spaces everything on the 4px scale and never uses a physical horizontal side', () => {
    for (const line of block.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;
      expect(trimmed, `physical horizontal property in: ${trimmed}`).not.toMatch(/^(padding|margin|border)-(left|right):/);
      const size = /^(gap|padding|margin|padding-inline|padding-block|padding-inline-end):\s*(\d+)px/.exec(trimmed);
      if (size) expect(Number(size[2]) % 4, `4px grid: ${trimmed}`).toBe(0);
    }
  });

  it('moves at 140/220ms on the shell easing curve and stops on request', () => {
    expect(block).toContain('140ms var(--faisal-ease, cubic-bezier(0.2, 0, 0, 1))');
    expect(block).toContain('220ms var(--faisal-ease, cubic-bezier(0.2, 0, 0, 1))');
    expect(block).toContain('@media (prefers-reduced-motion: reduce)');
    const reduced = block.slice(block.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('.faisal-saveas,');
    expect(reduced).toContain('animation: none');
  });

  it('keys the phone layout off the WINDOW, not the screen, and keeps 44px targets there', () => {
    const container = block.slice(
      block.indexOf('@container faisal-window (max-width: 700px)'),
      block.indexOf('@media (max-width: 700px)'),
    );
    expect(container.length).toBeGreaterThan(0);
    expect(container).toContain('--sa-ctl: 44px');
    expect(container).toContain('--sa-align: flex-end');
    expect(container).toContain('--sa-dialog-w: 100%');
    // Every control is sized from the token, so 44px really reaches the buttons and inputs.
    expect(ruleBody('.faisal-saveas-btn')).toContain('min-height: var(--sa-ctl)');
    expect(ruleBody('.faisal-saveas-iconbtn')).toContain('height: var(--sa-ctl)');
    expect(ruleBody('.faisal-saveas-input,\n.faisal-saveas-select')).toContain('height: var(--sa-ctl)');
    // A viewport media query repeats the same tokens for a host that is not a window.
    expect(block).toContain('@media (max-width: 700px)');
  });

  it('cannot scroll sideways: inputs shrink, paths wrap, names ellipsise', () => {
    expect(ruleBody('.faisal-saveas')).toContain('max-width: 100%');
    expect(ruleBody('.faisal-saveas')).toContain('min-width: 0');
    expect(ruleBody('.faisal-saveas-body')).toContain('overflow-x: hidden');
    expect(ruleBody('.faisal-saveas-input,\n.faisal-saveas-select')).toContain('min-width: 0');
    expect(ruleBody('.faisal-saveas-replace-text')).toContain('min-width: 160px');
    expect(block).toContain('overflow-wrap: anywhere');
  });

  it('shows a copper focus ring on every control, on keyboard focus', () => {
    expect(block).toContain('outline: 2px solid var(--sa-copper-2)');
    expect(block).toContain('outline-offset: 2px');
    expect(block).toContain(':focus-visible');
  });
});

describe('save-as module — the rules that are not CSS', () => {
  it('never parses markup: no innerHTML / outerHTML / insertAdjacentHTML anywhere', () => {
    for (const forbidden of ['innerHTML', 'outerHTML', 'insertAdjacentHTML']) {
      expect(source, `save-as.ts must not use ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('confirms a replacement with the shell dialog, never window.confirm or alert', () => {
    expect(source).toContain("import { shellConfirm } from './dialog'");
    expect(source).toContain('shellConfirm({');
    expect(source).not.toContain('window.confirm');
    expect(source).not.toContain('window.alert');
    expect(source).not.toContain('window.prompt');
  });

  it('registers every string it uses in BOTH languages, under the shell namespace', () => {
    const keys = [...source.matchAll(/t\('((?:shell\.)?saveas\.[A-Za-z0-9_.]+)'/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(20);
    const ar = new Set(registeredKeys('ar'));
    const en = new Set(registeredKeys('en'));
    for (const key of keys) {
      // The shell namespace prefixes its keys, so a bare `saveas.x` would render as the raw key.
      expect(key.startsWith('shell.'), `${key} carries the shell namespace`).toBe(true);
      expect(ar.has(key), `${key} in ar`).toBe(true);
      expect(en.has(key), `${key} in en`).toBe(true);
    }
  });
});
