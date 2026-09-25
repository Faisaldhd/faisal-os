import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBus } from '../../kernel/bus';
import { scopeVFS } from '../../kernel/apps';
import { VFSError, type SystemAPI, type VFS } from '../../kernel/types';
import { createVFS } from '../../vfs';
import { backupPathFor, planSave } from './ops';
import { previewSave, saveBytes, writeFailureReason, writePlan } from './save';

/**
 * The save path runs against the REAL VFS (IndexedDB through fake-indexeddb), not a mock:
 * "a new file by default" and "exactly one .bak before an overwrite" are properties of the
 * filesystem after the call, and that is what these tests read back.
 */
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const read = async (vfs: VFS, path: string): Promise<string> => new TextDecoder().decode(await vfs.readFile(path));

describe('saving through the VFS', () => {
  let vfs: VFS;
  let sys: SystemAPI;

  beforeEach(async () => {
    vfs = await createVFS(createBus());
    // save.ts only ever touches `vfs`; the rest of SystemAPI is not part of this test.
    sys = { vfs } as unknown as SystemAPI;
  });

  it('writes a NEW file by default and leaves the opened file untouched', async () => {
    await vfs.writeFile('/home/user/report.pdf', text('ORIGINAL'));
    const saved = await saveBytes(sys, { sourcePath: '/home/user/report.pdf', suffix: '-copy', overwrite: false }, text('EDITED'));
    expect(saved).toEqual({ ok: true, path: '/home/user/report-copy.pdf', backup: null, isCopy: true });
    expect(await read(vfs, '/home/user/report.pdf')).toBe('ORIGINAL');
    expect(await read(vfs, '/home/user/report-copy.pdf')).toBe('EDITED');
    expect(await vfs.exists('/home/user/report.pdf.bak')).toBe(false);
  });

  it('never reuses the copy name: the second save lands on -copy-2', async () => {
    await vfs.writeFile('/home/user/twice.pdf', text('ORIGINAL'));
    const first = await saveBytes(sys, { sourcePath: '/home/user/twice.pdf', suffix: '-copy', overwrite: false }, text('ONE'));
    const second = await saveBytes(sys, { sourcePath: '/home/user/twice.pdf', suffix: '-copy', overwrite: false }, text('TWO'));
    expect(first.ok && first.path).toBe('/home/user/twice-copy.pdf');
    expect(second.ok && second.path).toBe('/home/user/twice-copy-2.pdf');
    expect(await read(vfs, '/home/user/twice.pdf')).toBe('ORIGINAL');
    expect(await read(vfs, '/home/user/twice-copy.pdf')).toBe('ONE');
    expect(await read(vfs, '/home/user/twice-copy-2.pdf')).toBe('TWO');
  });

  it('previewSave names the same path the save then uses', async () => {
    await vfs.writeFile('/home/user/pv.pdf', text('X'));
    const predicted = await previewSave(sys, { sourcePath: '/home/user/pv.pdf', suffix: '-copy', overwrite: false });
    const saved = await saveBytes(sys, { sourcePath: '/home/user/pv.pdf', suffix: '-copy', overwrite: false }, text('Y'));
    expect(predicted.ok && predicted.plan.target).toBe(saved.ok ? saved.path : '');
  });

  it('an explicit overwrite keeps exactly ONE .bak of the original', async () => {
    await vfs.writeFile('/home/user/doc.pdf', text('FIRST'));
    const saved = await saveBytes(sys, { sourcePath: '/home/user/doc.pdf', suffix: '-copy', overwrite: true }, text('SECOND'));
    expect(saved).toEqual({ ok: true, path: '/home/user/doc.pdf', backup: '/home/user/doc.pdf.bak', isCopy: false });
    expect(await read(vfs, '/home/user/doc.pdf')).toBe('SECOND');
    expect(await read(vfs, '/home/user/doc.pdf.bak')).toBe('FIRST');
    expect(await vfs.exists('/home/user/doc.pdf.bak.bak')).toBe(false);

    // A second overwrite updates that same single backup; it never grows another.
    const again = await saveBytes(sys, { sourcePath: '/home/user/doc.pdf', suffix: '-copy', overwrite: true }, text('THIRD'));
    expect(again.ok && again.backup).toBe('/home/user/doc.pdf.bak');
    expect(await read(vfs, '/home/user/doc.pdf')).toBe('THIRD');
    expect(await read(vfs, '/home/user/doc.pdf.bak')).toBe('SECOND');
    expect(await vfs.exists('/home/user/doc.pdf.bak.bak')).toBe(false);
    const listed = (await vfs.readdir('/home/user')).map((entry) => entry.name).filter((name) => name.startsWith('doc.pdf'));
    expect(listed.sort()).toEqual(['doc.pdf', 'doc.pdf.bak']);
  });

  it('refuses to overwrite when the original cannot be read, and writes nothing', async () => {
    const saved = await saveBytes(sys, { sourcePath: '/home/user/ghost.pdf', suffix: '-copy', overwrite: true }, text('BODY'));
    expect(saved).toEqual({ ok: false, code: 'writeFailed' });
    expect(await vfs.exists('/home/user/ghost.pdf')).toBe(false);
    expect(await vfs.exists('/home/user/ghost.pdf.bak')).toBe(false);
  });

  it('never writes outside /home/user, and falls back into it', async () => {
    await vfs.writeFile('/tmp/out.pdf', text('TMP'));
    const refused = await saveBytes(sys, { sourcePath: '/tmp/out.pdf', suffix: '-copy', overwrite: true }, text('NEW'));
    expect(refused).toEqual({ ok: false, code: 'outsideHome' });
    expect(await read(vfs, '/tmp/out.pdf')).toBe('TMP');

    const copied = await saveBytes(sys, { sourcePath: '/tmp/out.pdf', suffix: '-copy', overwrite: false }, text('NEW'));
    expect(copied.ok && copied.path).toBe('/home/user/out-copy.pdf');
    expect(await read(vfs, '/home/user/out-copy.pdf')).toBe('NEW');
  });

  it('refuses an empty result instead of writing a zero-byte file', async () => {
    const saved = await saveBytes(sys, { sourcePath: '/home/user/empty.pdf', suffix: '-copy', overwrite: false }, new Uint8Array(0));
    expect(saved).toEqual({ ok: false, code: 'noBytes' });
    expect(await vfs.exists('/home/user/empty-copy.pdf')).toBe(false);
  });

  it('writePlan is what performs the write, and it obeys the same plan', async () => {
    await vfs.writeFile('/home/user/plan.pdf', text('OLD'));
    const planned = await planSave(
      { sourcePath: '/home/user/plan.pdf', suffix: '-copy', overwrite: true },
      (path) => vfs.exists(path),
    );
    if (!planned.ok) throw new Error(planned.error);
    const written = await writePlan(sys, planned.plan, text('NEW'));
    expect(written.ok && written.path).toBe('/home/user/plan.pdf');
    expect(await read(vfs, '/home/user/plan.pdf.bak')).toBe('OLD');
  });

  it('the kernel’s own scope agrees: fs:home cannot write outside /home/user', async () => {
    const scoped = scopeVFS(vfs, ['fs:home']);
    await expect(scoped.writeFile('/etc/evil.conf', text('nope'))).rejects.toBeInstanceOf(VFSError);
    await expect(scoped.readFile('/etc/passwd')).rejects.toBeInstanceOf(VFSError);
    await scoped.writeFile('/home/user/allowed.txt', text('yes'));
    expect(await read(vfs, '/home/user/allowed.txt')).toBe('yes');
    // /tmp is inside the fs:home grant, which is why save.ts does its own /home/user check.
    await scoped.writeFile('/tmp/inside.txt', text('tmp'));
    expect(await vfs.exists('/tmp/inside.txt')).toBe(true);
  });

  it('backupPathFor is the one and only backup name', () => {
    expect(backupPathFor('/home/user/a.pdf')).toBe('/home/user/a.pdf.bak');
    // Nothing in the module ever feeds a backup path back in, so a `.bak.bak` cannot appear;
    // the policy test above reads the directory after two overwrites to prove it.
    expect(backupPathFor('/home/user/a.pdf')).not.toContain('.bak.bak');
  });

  it('carries the reason of a refused write, so the window can name the limit', async () => {
    // A small quota of its own: the mapping is what is under test, and the real tier would mean
    // allocating 100 MB to reach the same branch.
    const small = await createVFS(createBus(), { quota: { file: 1000, total: 1500 } });
    const tiny: SystemAPI = { vfs: small } as unknown as SystemAPI;
    const refused = await saveBytes(tiny, { sourcePath: '/home/user/big.pdf', suffix: '-copy', overwrite: false }, new Uint8Array(1001));
    expect(refused.ok).toBe(false);
    expect(refused.ok ? null : refused.reason).toBe('file-too-big');
    expect(await small.exists('/home/user/big-copy.pdf')).toBe(false);
  });

  it('names a full store when the bytes themselves would fit', async () => {
    const small = await createVFS(createBus(), { quota: { file: 1000, total: 4000 } });
    const tiny: SystemAPI = { vfs: small } as unknown as SystemAPI;
    // Fill the tree until it really refuses, whatever the seeded files already weigh.
    let filled = 0;
    for (; filled < 12; filled++) {
      try { await small.writeFile(`/home/user/fill-${filled}.bin`, new Uint8Array(1000)); } catch { break; }
    }
    expect(filled).toBeGreaterThan(0);
    // 600 bytes is well under the 1000-byte per-file limit, so it is the TOTAL that refuses.
    const refused = await saveBytes(tiny, { sourcePath: '/home/user/small.pdf', suffix: '-copy', overwrite: false }, new Uint8Array(600));
    expect(refused.ok).toBe(false);
    expect(refused.ok ? null : refused.reason).toBe('storage-full');
    expect(await small.exists('/home/user/small-copy.pdf')).toBe(false);
  });
});

describe('writeFailureReason', () => {
  const quota = { file: 100 };

  it('separates a per-file refusal from a full store, on the boundary', () => {
    expect(writeFailureReason(new VFSError('EINVAL', '/home/user/a.pdf', 'quota'), 101, quota)).toBe('file-too-big');
    expect(writeFailureReason(new VFSError('EINVAL', '/home/user/a.pdf', 'quota'), 100, quota)).toBe('storage-full');
    expect(writeFailureReason(new VFSError('EINVAL', '/home/user/a.pdf', 'quota'), 1, quota)).toBe('storage-full');
  });

  it('reports anything else as a plain failure instead of guessing', () => {
    expect(writeFailureReason(new Error('boom'), 10, quota)).toBe('write-failed');
    expect(writeFailureReason(new VFSError('EACCES', '/etc/x'), 10, quota)).toBe('write-failed');
    expect(writeFailureReason(undefined, 10, quota)).toBe('write-failed');
  });
});
