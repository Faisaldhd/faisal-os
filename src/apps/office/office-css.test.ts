/// <reference types="node" />
/*
 * `node` types are pulled in for THIS FILE only (the root tsconfig does not include them), because
 * the test reads the stylesheet as text: jsdom has no layout engine, so the CSS CONTRACT is what
 * can be pinned here.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Office's stylesheet is isolated per app.
 *
 * The bug this guards: one global sheet defined `.fo-canvas` for Writer's page AND for Impress's
 * slide, and the Impress rule (`position: absolute`) shrank a new Writer page to 48px. It also
 * defined `.fo-fillhandle` twice, and the older rule painted a 44px solid blue square over the
 * sheet's first cells. Now the file has a shared section and one section per app, and every rule
 * of an app section begins with that app's scope, so a class name can be reused by two apps
 * without either rule reaching the other.
 */
function readSource(relative: string): string {
  return readFileSync(resolve(process.cwd(), relative), 'utf8').replace(/\r\n/g, '\n');
}

const css = readSource('src/apps/office/office.css');

type Section = 'shared' | 'writer' | 'calc' | 'impress';
const APPS: Exclude<Section, 'shared'>[] = ['writer', 'calc', 'impress'];

/** What an app's selectors may begin with: its editor root, or the window root with its document kind. */
const SCOPES: Record<Exclude<Section, 'shared'>, readonly string[]> = {
  writer: ['.fo-writer', '.faisal-office[data-kind="docx"]'],
  calc: ['.fo-calc', '.faisal-office[data-kind="xlsx"]', '.faisal-office[data-kind="csv"]'],
  impress: ['.fo-impress', '.faisal-office[data-kind="pptx"]'],
};

/** A leading theme compound (`:root[data-theme='dark'] `, `body.is-dark `) is not a scope. */
const THEME_PREFIX = /^(?::root(?:\[[^\]]*\]|:not\([^)]*\))*|body\.is-dark)\s+/;

interface Rule { section: Section; selector: string }

/** Splits the file at its section markers and lists every style rule's selectors (inside @media/@container too). */
function rules(): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (c) => {
    const m = /═+\s*(?:app:\s*(\w+)|(shared))\s*═+/.exec(c);
    return m ? `@@section ${m[1] ?? m[2]};` : ' ';
  });
  const out: Rule[] = [];
  let section: Section = 'shared';
  let i = 0;
  /** Reads rules until the matching `}` of the current block (or the end). */
  const block = (keyframes: boolean): void => {
    let prelude = '';
    while (i < text.length) {
      const ch = text[i];
      if (ch === '}') { i++; return; }
      if (ch === ';') {
        const m = /@@section (\w+)$/.exec(prelude.trim());
        if (m) section = m[1] as Section;
        prelude = '';
        i++;
        continue;
      }
      if (ch !== '{') { prelude += ch; i++; continue; }
      i++;
      const head = prelude.trim();
      prelude = '';
      if (head.startsWith('@keyframes')) { block(true); continue; }
      if (head.startsWith('@')) { block(false); continue; }
      // A style rule: skip its declarations.
      let depth = 1;
      while (i < text.length && depth) { if (text[i] === '{') depth++; else if (text[i] === '}') depth--; i++; }
      if (keyframes) continue;
      for (const selector of head.split(/,(?![^(]*\))/)) out.push({ section, selector: selector.trim().replace(/\s+/g, ' ') });
    }
  };
  block(false);
  return out;
}

const all = rules();

/** The scope a selector starts with, if any (after a theme prefix). */
function scopeOf(selector: string): string | null {
  const bare = selector.replace(THEME_PREFIX, '');
  for (const app of APPS) {
    for (const scope of SCOPES[app]) {
      const next = bare.charAt(scope.length);
      if (bare.startsWith(scope) && (next === '' || /[\s.:[>]/.test(next))) return app;
    }
  }
  return null;
}

/** Class names in a selector (outside attribute values). */
function classes(selector: string): string[] {
  return [...selector.replace(/\[[^\]]*\]/g, '').matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
}

describe('office.css — one shared section and one isolated section per app', () => {
  it('has the shared section and all three app sections, in that order', () => {
    const order = [...new Set(all.map((r) => r.section))];
    expect(order).toEqual(['shared', 'writer', 'calc', 'impress']);
    for (const app of APPS) expect(all.filter((r) => r.section === app).length, app).toBeGreaterThan(20);
  });

  it('scopes every rule of an app section to that app (nothing app-specific is left at top level)', () => {
    const loose = all.filter((r) => r.section !== 'shared' && scopeOf(r.selector) !== r.section);
    expect(loose.map((r) => `${r.section}: ${r.selector}`)).toEqual([]);
  });

  it('never styles one app from the shared section', () => {
    const leaking = all.filter((r) => r.section === 'shared' && scopeOf(r.selector) !== null);
    expect(leaking.map((r) => r.selector)).toEqual([]);
  });

  it('defines no class selector at top level in two different sections', () => {
    // "Top level" = a rule that is not behind an app scope. A class styled that way in two
    // sections is exactly the collision that broke Writer's page (`.fo-canvas`).
    const owner = new Map<string, Section>();
    const clashes: string[] = [];
    for (const r of all) {
      if (scopeOf(r.selector) !== null) continue;
      for (const c of classes(r.selector)) {
        const was = owner.get(c);
        if (was && was !== r.section) clashes.push(`.${c}: ${was} + ${r.section}`);
        else owner.set(c, r.section);
      }
    }
    expect(clashes).toEqual([]);
  });

  it("keeps Impress's absolute canvas away from Writer's page", () => {
    const canvas = all.filter((r) => classes(r.selector).includes('fo-canvas'));
    expect(canvas.length).toBeGreaterThan(0);
    for (const r of canvas) expect(scopeOf(r.selector), r.selector).toBe(r.section);
    expect(canvas.some((r) => r.section === 'writer')).toBe(true);
    expect(canvas.some((r) => r.section === 'impress')).toBe(true);
  });

  it('draws the fill handle from one transparent rule with a small dot', () => {
    // One base rule (the touch query only widens its grab area through `--fo-grab`).
    expect(css.match(/^\.fo-calc \.fo-fillhandle \{/gm)).toHaveLength(1);
    expect(all.filter((r) => classes(r.selector).includes('fo-fillhandle')).every((r) => r.section === 'calc')).toBe(true);
    const body = /\.fo-calc \.fo-fillhandle \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(body).toMatch(/background:\s*transparent/);
    const dot = /\.fo-calc \.fo-fillhandle::after \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(dot).toMatch(/width:\s*8px/);
  });
});

describe('office.css — the ribbon shrinks instead of running off the window', () => {
  it('folds groups by their data-mode, keeping labels as the accessible name', () => {
    expect(css).toMatch(/\.fo-group\[data-mode="icon"\] \.fo-btn-label \{[^}]*clip: rect\(0 0 0 0\)/);
    expect(css).toMatch(/\.fo-group\[data-mode="menu"\] \.fo-group-tools \{ display: none; \}/);
    expect(css).toMatch(/\.fo-group\[data-mode="menu"\] \.fo-group-menu \{ display: inline-flex;/);
  });

  it('gives the scroll arrows a 44px target on touch', () => {
    expect(css).toMatch(/@media \(pointer: coarse\) \{ \.fo-rscroll\.fo-btn \{ min-width: 44px; width: 44px; \} \}/);
  });
});
