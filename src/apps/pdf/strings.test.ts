import { describe, expect, it } from 'vitest';
import { registeredKeys, setLocale, t } from '../../kernel/i18n';
import type { Locale } from '../../kernel/types';
// Vite's `?raw` gives the window's own source as text, with no filesystem access from the
// test (this repo deliberately has no `@types/node`, so `node:fs` would not type-check).
import windowSource from './index.ts?raw';
import './strings';

/*
 * The window is split into several modules (viewer, thumbnails, ribbon…). Every non-test source
 * file of the app is scanned together with index.ts, so a key written in any of them must exist
 * and a key used only by one of them is not an orphan. index.ts stays in the set explicitly.
 */
const otherSources = import.meta.glob(['./*.ts', '!./*.test.ts', '!./index.ts', '!./strings.ts'], {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;
const indexSource = [windowSource, ...Object.values(otherSources)].join('\n');

/**
 * The PDF namespace is not covered by the repo-wide parity test
 * (`src/apps/web/strings.test.ts`) because that file lists its app imports by hand and this
 * app is registered by the owner later. These tests pin the same properties for `pdf.*`,
 * and add the check that file-level one cannot make: every `pdf.…` key written in the app's
 * own source really exists, so a rename can never leave a raw key on screen.
 */
const keysIn = (locale: Locale): string[] => registeredKeys(locale).filter((key) => key.startsWith('pdf.'));

/** Refusal keys are built from a code by `refusalKey()` in index.ts, so they never appear literally. */
const DYNAMIC = /^pdf\.refusal/;

describe('pdf strings', () => {
  it('has exactly the same keys in Arabic and English', () => {
    expect(keysIn('ar')).toEqual(keysIn('en'));
    expect(keysIn('ar').length).toBeGreaterThan(80);
  });

  it('resolves every key to real text in both languages, never to the key itself', () => {
    for (const locale of ['ar', 'en'] as Locale[]) {
      setLocale(locale);
      for (const key of keysIn(locale)) {
        const value = t(key);
        expect(value, `${key} [${locale}]`).not.toBe(key);
        expect(value.trim().length, `${key} [${locale}]`).toBeGreaterThan(0);
      }
    }
    setLocale('ar');
  });

  it('keeps the same {placeholder} names in both languages', () => {
    const placeholders = (value: string): string[] => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of keysIn('ar')) {
      setLocale('ar');
      const inAr = placeholders(t(key));
      setLocale('en');
      expect(placeholders(t(key)), key).toEqual(inAr);
    }
    setLocale('ar');
  });

  it('carries a message for every refusal the app can produce', () => {
    for (const code of [
      'empty', 'notPdf', 'encrypted', 'corrupt', 'imageUnsupported', 'imageBroken',
      'textNotRenderable', 'noForm', 'emptyResult', 'outsideHome', 'writeFailed', 'unknown',
    ]) {
      expect(keysIn('ar'), code).toContain(`pdf.refusal${code[0].toUpperCase()}${code.slice(1)}`);
    }
    // `refusalKey('noBytes')` maps to this one instead of inventing `pdf.refusalNoBytes`.
    expect(keysIn('ar')).toContain('pdf.saveNoBytes');
  });

  it('describes every page operation in both languages', () => {
    for (const base of [
      'info', 'text', 'cover', 'pageops', 'form', 'delete', 'rotate', 'crop', 'watermark',
      'metadata', 'split', 'merge', 'images',
    ]) {
      expect(keysIn('ar'), base).toContain(`pdf.${base}Desc`);
      expect(keysIn('en'), base).toContain(`pdf.${base}Desc`);
    }
  });

  it('states the honest limits, including no text editing, no redaction, no OCR and no signatures', () => {
    for (const key of [
      'limitTextEdit', 'limitNoRedaction', 'limitNoOcr', 'limitNoSign', 'limitNoForms',
      'limitNoRaster', 'limitNoFonts',
    ]) {
      expect(keysIn('ar'), key).toContain(`pdf.${key}`);
      expect(keysIn('en'), key).toContain(`pdf.${key}`);
    }
  });

  it('labels covering as hiding in both languages, never as redaction', () => {
    setLocale('ar');
    expect(t('pdf.coverNote')).toContain('ليست حجباً');
    setLocale('en');
    expect(t('pdf.coverNote')).toContain('NOT redaction');
    setLocale('ar');
  });

  it('registers every pdf.* key the window source writes', () => {
    const found = [...indexSource.matchAll(/'pdf\.[A-Za-z0-9]+'/g)].map((match) => match[0].slice(1, -1));
    expect(found.length).toBeGreaterThan(60);
    for (const key of new Set(found)) {
      expect(keysIn('ar'), key).toContain(key);
      expect(keysIn('en'), key).toContain(key);
    }
  });

  it('has no orphan string: every non-dynamic key is used by the window source', () => {
    const orphans = keysIn('ar').filter((key) => !DYNAMIC.test(key) && !indexSource.includes(key.slice('pdf.'.length)));
    expect(orphans).toEqual([]);
  });
});
