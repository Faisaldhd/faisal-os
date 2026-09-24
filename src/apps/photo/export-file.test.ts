import { describe, expect, it } from 'vitest';
import {
  HOME_ROOT, assertWithinHome, backupPathFor, basenameOf, dirnameOf, exportFileName, exportPathFor,
  formatOfTarget, isWithinHome, nextCopyPath, normalisePath, planExport, sameTarget, stemOf,
} from './export-file';

const ORIGINAL = '/home/user/Pictures/holiday.png';

describe('export-file — the permission rule', () => {
  it('accepts /home/user and everything under it, and refuses everything else', () => {
    expect(isWithinHome('/home/user')).toBe(true);
    expect(isWithinHome('/home/user/Pictures/a.png')).toBe(true);
    expect(isWithinHome('/tmp/a.png')).toBe(false);
    expect(isWithinHome('/etc/passwd')).toBe(false);
    expect(isWithinHome('/home/user2/a.png')).toBe(false);
    expect(isWithinHome('/home/username/a.png')).toBe(false);
  });

  it('resolves .. escapes BEFORE checking, so a traversal is refused like the escape it is', () => {
    expect(normalisePath('/home/user/../../etc/passwd')).toBe('/etc/passwd');
    expect(isWithinHome('/home/user/../../etc/passwd')).toBe(false);
    expect(isWithinHome('/home/user/./Pictures/../Pictures/a.png')).toBe(true);
    expect(normalisePath('//home//user//a.png')).toBe('/home/user/a.png');
  });

  it('assertWithinHome throws for an outside path and stays silent for an inside one', () => {
    expect(() => assertWithinHome('/home/user/a.png')).not.toThrow();
    expect(() => assertWithinHome('/root/a.png')).toThrow(/outside/);
  });
});

describe('export-file — path arithmetic', () => {
  it('splits a path into its parts', () => {
    expect(dirnameOf(ORIGINAL)).toBe('/home/user/Pictures');
    expect(basenameOf(ORIGINAL)).toBe('holiday.png');
    expect(stemOf(ORIGINAL)).toBe('holiday');
    expect(stemOf('/home/user/a.tar.gz')).toBe('a.tar');
    expect(basenameOf('/')).toBe('/');
    expect(dirnameOf('/a')).toBe('/');
  });

  it('names a copy after the original with the target format extension, not the source one', () => {
    expect(exportFileName(ORIGINAL, 'jpeg')).toBe('holiday.jpg');
    expect(exportFileName(ORIGINAL, 'webp', ' (edited)')).toBe('holiday (edited).webp');
    // The copy lands beside its original, never in the home root.
    expect(exportPathFor(ORIGINAL, 'jpeg')).toBe('/home/user/Pictures/holiday.jpg');
    expect(exportPathFor('/home/user/a.png', 'png')).toBe('/home/user/a.png');
  });

  it('finds the first free copy name', () => {
    const dir = '/home/user/Pictures';
    expect(nextCopyPath(dir, 'holiday', 'png', [])).toBe(`${dir}/holiday (edited).png`);
    expect(nextCopyPath(dir, 'holiday', 'png', [`${dir}/holiday (edited).png`])).toBe(`${dir}/holiday (edited 2).png`);
    expect(nextCopyPath(dir, 'holiday', 'png', [`${dir}/holiday (edited).png`, `${dir}/holiday (edited 2).png`]))
      .toBe(`${dir}/holiday (edited 3).png`);
  });

  it('compares two targets after normalisation', () => {
    expect(sameTarget('/home/user/a.png', '/home/user/./a.png')).toBe(true);
    expect(sameTarget('/home/user/a.png', '/home/user/b.png')).toBe(false);
  });

  it('reads the export format a target name implies, and refuses one it cannot write', () => {
    expect(formatOfTarget('/home/user/a.JPG')).toBe('jpeg');
    expect(formatOfTarget('/home/user/a.webp')).toBe('webp');
    expect(formatOfTarget('/home/user/a.gif')).toBeNull();
    expect(formatOfTarget('/home/user/a')).toBeNull();
  });
});

describe('export-file — save a copy', () => {
  it('never targets the original, even when the name is taken', () => {
    const plan = planExport({
      original: ORIGINAL, action: 'copy', format: 'png',
      existing: [ORIGINAL, '/home/user/Pictures/holiday (edited).png'],
    });
    expect(plan.steps).toEqual(['write-target']);
    expect(plan.target).toBe('/home/user/Pictures/holiday (edited 2).png');
    expect(plan.overwritesOriginal).toBe(false);
    expect(plan.backup).toBe(false);
  });

  it('works with no original at all (an untitled document)', () => {
    const plan = planExport({ original: null, action: 'copy', format: 'jpeg', existing: [] });
    expect(plan.target).toBe(`${HOME_ROOT}/untitled.jpg`);
    expect(plan.overwritesOriginal).toBe(false);
  });

  it('refuses a copy outside the home folder', () => {
    const plan = planExport({ original: '/etc/passwd', action: 'copy', format: 'png', existing: [] });
    expect(plan.error).toBe('out-of-home');
    expect(plan.steps).toEqual([]);
  });
});

describe('export-file — overwrite keeps exactly ONE .bak', () => {
  it('when the original exists: rename to .bak first, then write the original', () => {
    const plan = planExport({ original: ORIGINAL, action: 'overwrite', format: 'png', existing: [ORIGINAL] });
    expect(plan.steps).toEqual(['backup-original', 'write-original']);
    expect(plan.target).toBe(ORIGINAL);
    expect(plan.overwritesOriginal).toBe(true);
    expect(plan.backup).toBe(true);
    expect(backupPathFor(ORIGINAL)).toBe('/home/user/Pictures/holiday.png.bak');
  });

  it('a SECOND overwrite still leaves one backup: the destination is replaced, not added to', () => {
    // After the first overwrite the directory holds exactly these two files; there is no
    // "holiday.png.bak.bak" anywhere in the plan, and the rename replaces the old backup.
    const first = planExport({ original: ORIGINAL, action: 'overwrite', format: 'png', existing: [ORIGINAL] });
    const afterFirst = [first.target, backupPathFor(ORIGINAL)];
    const second = planExport({ original: ORIGINAL, action: 'overwrite', format: 'png', existing: afterFirst });
    expect(second.steps).toEqual(['backup-original', 'write-original']);
    expect(second.target).toBe(ORIGINAL);
    expect(afterFirst.filter((p) => p.endsWith('.bak'))).toHaveLength(1);
    expect(afterFirst.some((p) => p.endsWith('.bak.bak'))).toBe(false);
  });

  it('an original that does not exist is written without a backup step', () => {
    const plan = planExport({ original: ORIGINAL, action: 'overwrite', format: 'png', existing: [] });
    expect(plan.steps).toEqual(['write-original']);
    expect(plan.backup).toBe(false);
    expect(plan.target).toBe(ORIGINAL);
  });

  it('refuses "overwrite the original" when there is no original', () => {
    const plan = planExport({ original: null, action: 'overwrite', format: 'png', existing: [] });
    expect(plan.error).toBe('no-target');
    expect(plan.steps).toEqual([]);
  });

  it('refuses an overwrite outside the home folder', () => {
    expect(planExport({ original: '/tmp/a.png', action: 'overwrite', format: 'png', existing: ['/tmp/a.png'] }).error)
      .toBe('out-of-home');
  });

  it('walks a whole simulated overwrite and leaves exactly two files', () => {
    // A miniature of what the window does: an in-memory set of paths, the plan's steps applied
    // in order. The point is the arithmetic of the backup, not the VFS.
    const files = new Map<string, string>([[ORIGINAL, 'old-bytes']]);
    const plan = planExport({ original: ORIGINAL, action: 'overwrite', format: 'png', existing: [...files.keys()] });
    for (const step of plan.steps) {
      if (step === 'backup-original') {
        const bak = backupPathFor(plan.target);
        const old = files.get(plan.target)!;
        files.delete(plan.target);
        files.set(bak, old);
      } else if (step === 'write-original') {
        files.set(plan.target, 'new-bytes');
      }
    }
    expect([...files.keys()].sort()).toEqual([ORIGINAL, `${ORIGINAL}.bak`].sort());
    expect(files.get(`${ORIGINAL}.bak`)).toBe('old-bytes');
    expect(files.get(ORIGINAL)).toBe('new-bytes');
  });
});
