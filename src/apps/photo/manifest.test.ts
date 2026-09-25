import { describe, expect, it } from 'vitest';
import { manifest } from './manifest';
import { MANIFEST_OPENS, OPEN_EXTENSIONS } from './formats';

/**
 * The install default, the capability claims and the format table, pinned.
 *
 * The owner's decision (2026-09-25) is that the four suite apps ship installed, so this
 * manifest keeps `defaultInstalled: true`: `isInstalled` (src/kernel/apps.ts) then reads
 * "installed unless its id is in the owner's `removed` list". `core: false` stays, so the
 * editor can still be removed from the Store — and that removal is remembered.
 */
describe('photo manifest — installed by default, home-only, honest about formats', () => {
  it('is installed by default and still removable (not core)', () => {
    expect(manifest.core).toBe(false);
    expect(manifest.defaultInstalled).toBe(true);
    expect(manifest.id).toBe('org.faisal.Photo');
  });

  it('requests fs:home and nothing else — no network, no settings, no notifications', () => {
    expect(manifest.permissions).toEqual(['fs:home']);
  });

  it('declares the extensions the editor really decodes, so the kernel can offer it for a file', () => {
    expect(manifest.opens).toEqual(MANIFEST_OPENS);
    // Phase 2: iPhone photos (.heic/.heif, decoded by the on-demand libheif codec) and the
    // layered project (.fphoto), so a project double-clicked in the Files app opens here.
    expect(manifest.opens).toEqual(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif', '.svg', '.heic', '.heif', '.fphoto']);
    expect([...(manifest.opens ?? [])].sort()).toEqual([...OPEN_EXTENSIONS, '.fphoto'].sort());
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
