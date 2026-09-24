import { describe, expect, it } from 'vitest';
import { manifest } from './manifest';
import { MANIFEST_OPENS, OPEN_EXTENSIONS } from './formats';

/**
 * The store-only rule and the capability claims, pinned.
 *
 * `isInstalled` (src/kernel/apps.ts:131) counts an app whose `defaultInstalled` is false only
 * after its id is in the owner's `added` list — that is what makes this app load from the
 * Store instead of shipping pre-installed. Flipping either flag below would silently
 * pre-install the editor, which is the one thing this app must not do.
 */
describe('photo manifest — store-only, home-only, honest about formats', () => {
  it('is not core and not installed by default, so the owner installs it from the Store', () => {
    expect(manifest.core).toBe(false);
    expect(manifest.defaultInstalled).toBe(false);
    expect(manifest.id).toBe('org.faisal.Photo');
  });

  it('requests fs:home and nothing else — no network, no settings, no notifications', () => {
    expect(manifest.permissions).toEqual(['fs:home']);
  });

  it('declares the extensions the editor really decodes, so the kernel can offer it for a file', () => {
    expect(manifest.opens).toEqual(MANIFEST_OPENS);
    expect(manifest.opens).toEqual(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif', '.svg']);
    expect([...(manifest.opens ?? [])].sort()).toEqual([...OPEN_EXTENSIONS].sort());
  });

  it('is a media app with both names, in Arabic and English', () => {
    expect(manifest.category).toBe('media');
    expect(manifest.name.ar.length).toBeGreaterThan(0);
    expect(manifest.name.en.length).toBeGreaterThan(0);
    expect(manifest.description?.ar.length).toBeGreaterThan(0);
    expect(manifest.description?.en.length).toBeGreaterThan(0);
    expect(manifest.icon).toContain('<svg');
  });

  it('is not single-instance: two images can be edited side by side', () => {
    expect(manifest.singleInstance).toBe(false);
  });
});
