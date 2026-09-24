import { describe, expect, it } from 'vitest';
import { registeredKeys, setLocale, t } from '../../kernel/i18n';
import type { Locale } from '../../kernel/types';

/*
 * Every module that calls `defineStrings`, imported for its side effect only, so
 * the tables below are the ones the running OS actually has — not a copy.
 *
 * Each is the same module `src/main.ts` reaches (or the app's own `strings.ts`,
 * which its `index.ts` re-exports). None of them renders at import time, so
 * importing a whole app is safe in jsdom — the suite proves that by running.
 *
 * An intermediate version of this file dropped the app imports and kept only the
 * dedicated `strings.ts` modules, on the theory that importing an app makes its
 * keys land in BOTH locale tables. That theory is false, and this file's own
 * first failure is the evidence against it: with `../monitor` imported, the
 * report showed a ONE-SIDED gap (`monitor.systemHonesty*` present in English and
 * absent from Arabic). Keys present in both tables cannot produce a one-sided
 * report. Narrowing the imports would have hidden the exact bug this test exists
 * to find, so the full set is restored and the wrong theory is recorded here
 * rather than quietly deleted.
 */
import '../../main'; // registers the 'kernel' namespace (and mounts nothing at import time)
import '../../vfs';
import '../../shell/strings';
import '../../apps/browser/strings';
import '../settings/strings';
import '../store/strings';
import '../terminal/strings';
import './strings';
import '../ai';
import '../calculator';
import '../clock';
import '../editor';
import '../files';
import '../images';
import '../monitor';
import '../stream';
/*
 * The four store-only editors keep their copy in a dedicated `strings.ts` too, so
 * their namespaces are covered by this parity check from the day they are added —
 * a missing Arabic or English key in an app the owner has to install is still a
 * missing key. Importing the module (not the app) keeps this cheap.
 */
import '../office/strings';
import '../pdf/strings';
import '../photo/strings';
import '../video/strings';
import '../vault';

/*
 * Why this test exists.
 *
 * `t()` resolves `ar → en → key`, so a key that exists in only ONE language does
 * not throw: it silently renders the other language (or the raw key) to the user.
 * That is good runtime behaviour and terrible test behaviour — which is how
 * `web.unusableInputTitle`, `web.unusableInputBody` and `web.backToHome` shipped
 * present in the Arabic block and missing from the English one, with a green
 * suite. There was no parity test anywhere in the repo before this file.
 *
 * The comparison is over WHOLE TABLES — every namespace, both directions — so the
 * same bug in `files.*`, `ai.*` or any future namespace fails here too. It is
 * deliberately not scoped to `web.*`.
 */

/** Every namespace that registered at least one key, derived from the keys themselves. */
function namespaces(locale: Locale): string[] {
  const seen = new Set<string>();
  for (const key of registeredKeys(locale)) seen.add(key.slice(0, key.indexOf('.')));
  return [...seen].sort();
}

/**
 * The symmetric difference of two key lists, as two labelled lists.
 *
 * `onlyAr` is the set of keys that exist in Arabic and NOT in English, so those
 * are the keys MISSING FROM ENGLISH. Naming the result after the language a key
 * was FOUND in, and then reporting it under the language it is MISSING from, is
 * how this file got the direction backwards twice; the call site below names
 * each result explicitly so the mapping is visible where it is used.
 */
function differences(ar: readonly string[], en: readonly string[]): { onlyAr: string[]; onlyEn: string[] } {
  const a = new Set(ar);
  const e = new Set(en);
  return {
    onlyAr: ar.filter((k) => !e.has(k)),
    onlyEn: en.filter((k) => !a.has(k)),
  };
}

const keysIn = (ns: string, locale: Locale): string[] =>
  registeredKeys(locale).filter((k) => k.startsWith(`${ns}.`));

/**
 * The asymmetries allowed to exist, asserted EQUAL to what the test observes —
 * per namespace, in both directions. It is EMPTY today, and that is the point:
 * a new one-sided key anywhere in the OS fails this suite.
 *
 * It held exactly one entry, for exactly one run: this test caught a real gap
 * the moment it existed. `src/apps/monitor/index.ts` had `systemHonestyTitle`
 * and `systemHonesty` in its English block only, so an Arabic user — the primary
 * language of this OS — saw the raw key `monitor.systemHonestyTitle` as a panel
 * heading. Both Arabic strings now exist in that app, so the entry was deleted
 * instead of being kept as an excuse for a bug that was fixed.
 *
 * The list is not an exemption mechanism that can rot: a new gap in any covered
 * namespace fails, and fixing a declared gap fails the companion test until the
 * entry is deleted.
 */
const KNOWN_PARITY_GAPS: Record<string, { missingFromEnglish: string[]; missingFromArabic: string[] }> = {};

describe('i18n tables — parity across every namespace', () => {
  it('registered a realistic number of namespaces, so a broken import cannot pass vacuously', () => {
    // The repo has 17 defineStrings call sites; if an import above stopped running,
    // this count drops and the test fails instead of quietly checking less.
    expect(namespaces('ar').length).toBeGreaterThanOrEqual(15);
    expect(registeredKeys('ar').length).toBeGreaterThan(300);
  });

  it('has exactly the same namespaces in ar and en', () => {
    expect(namespaces('ar')).toEqual(namespaces('en'));
  });

  it('has exactly the same keys in ar and en in EVERY namespace, except the declared gaps', () => {
    // A key is listed under the locale it is MISSING FROM: `onlyAr` keys are
    // missing from English, `onlyEn` keys are missing from Arabic. The companion
    // test below pins that direction per key, against the tables themselves
    // rather than against this construction.
    const missingFromEnglish: string[] = [];
    const missingFromArabic: string[] = [];
    for (const ns of namespaces('ar')) {
      const diff = differences(keysIn(ns, 'ar'), keysIn(ns, 'en'));
      missingFromEnglish.push(...diff.onlyAr);
      missingFromArabic.push(...diff.onlyEn);
    }
    missingFromEnglish.sort();
    missingFromArabic.sort();

    const declaredEnglish = Object.values(KNOWN_PARITY_GAPS).flatMap((g) => g.missingFromEnglish).sort();
    const declaredArabic = Object.values(KNOWN_PARITY_GAPS).flatMap((g) => g.missingFromArabic).sort();
    // Named per language, so a failure says precisely what is missing where —
    // and in which language — which is what made the original gap invisible.
    expect({ missingFromEnglish, missingFromArabic }).toEqual({
      missingFromEnglish: declaredEnglish,
      missingFromArabic: declaredArabic,
    });
  });

  it('keeps every declared gap honest: still real, still one-sided, still the right way round', () => {
    // The authority on direction: ask each locale directly, per key.
    for (const [ns, gap] of Object.entries(KNOWN_PARITY_GAPS)) {
      expect(namespaces('ar'), ns).toContain(ns);
      for (const key of gap.missingFromArabic) {
        expect(keysIn(ns, 'ar'), `${key} should be MISSING from ar`).not.toContain(key);
        expect(keysIn(ns, 'en'), `${key} should be PRESENT in en`).toContain(key);
      }
      for (const key of gap.missingFromEnglish) {
        expect(keysIn(ns, 'en'), `${key} should be MISSING from en`).not.toContain(key);
        expect(keysIn(ns, 'ar'), `${key} should be PRESENT in ar`).toContain(key);
      }
    }
  });

  it('resolves every key to real text in both languages, never to the key itself', () => {
    for (const locale of ['ar', 'en'] as Locale[]) {
      setLocale(locale);
      for (const key of registeredKeys(locale)) {
        const value = t(key);
        expect(value, `${key} [${locale}]`).not.toBe(key);
        expect(value.trim().length, `${key} [${locale}]`).toBeGreaterThan(0);
      }
    }
    setLocale('ar');
  });

  it('keeps the same {placeholder} names in both languages of every key', () => {
    const placeholders = (value: string): string[] => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of registeredKeys('ar')) {
      setLocale('ar');
      const inAr = placeholders(t(key));
      setLocale('en');
      const inEn = placeholders(t(key));
      // A translation that renames {host} to {server} silently loses its value.
      expect(inEn, key).toEqual(inAr);
    }
    setLocale('ar');
  });

  it('carries the monitor honesty panel in both languages, the gap this test first caught', () => {
    // The regression that motivated the whole file: English-only strings in the
    // monitor app left Arabic users reading `monitor.systemHonestyTitle`.
    for (const key of ['monitor.systemHonestyTitle', 'monitor.systemHonesty']) {
      expect(keysIn('monitor', 'ar'), key).toContain(key);
      expect(keysIn('monitor', 'en'), key).toContain(key);
    }
  });
});

describe('web namespace — the specific gap that shipped', () => {
  it('registers the keys that were previously missing from the English table', () => {
    for (const key of ['web.unusableInputTitle', 'web.unusableInputBody', 'web.backToHome']) {
      expect(keysIn('web', 'en'), key).toContain(key);
      expect(keysIn('web', 'ar'), key).toContain(key);
    }
  });

  it('merges a second defineStrings call into the same namespace instead of replacing it', () => {
    // The proxy workstream adds its keys to 'web' too; the table is merged.
    const web = keysIn('web', 'en');
    expect(web).toContain('web.proxyTitle');
    expect(web).toContain('web.back');
    expect(web).toContain('web.placeholder');
  });

  it('reports the search app keys this workstream added', () => {
    for (const key of [
      'web.placeholder', 'web.providerLabel', 'web.openInside', 'web.openResultExternal',
      'web.errorConfig', 'web.errorNetwork', 'web.errorHttp', 'web.errorShape',
      'web.setupTitle', 'web.setupSave', 'web.googleApiKey', 'web.googleCx',
    ]) {
      expect(keysIn('web', 'en'), key).toContain(key);
      expect(keysIn('web', 'ar'), key).toContain(key);
    }
  });
});
