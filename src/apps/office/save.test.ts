import { describe, expect, it } from 'vitest';
import { VFSError } from '../../kernel/types';
import { saveFailure } from './save';

/**
 * Why a refused write was refused.
 *
 * The kernel refuses BOTH quota cases with the same `EINVAL` code and the message "quota": one
 * file above the per-file limit, or a store that is full. The window can only tell the owner
 * something they can act on ("make it smaller" vs "delete something") if the app decides which
 * one it was, and that decision is this function — so it is pinned here, including the boundary.
 */
describe('saveFailure', () => {
  const quota = { file: 100 * 1024 * 1024 };

  it('names the per-file limit when the bytes alone are above it', () => {
    expect(saveFailure(new VFSError('EINVAL', '/home/user/a.docx', 'quota'), quota.file + 1, quota)).toBe('file-too-big');
    expect(saveFailure(new VFSError('EINVAL', '/home/user/a.docx', 'quota'), 500 * 1024 * 1024, quota)).toBe('file-too-big');
  });

  it('names a full store when the bytes would fit but the store would not', () => {
    expect(saveFailure(new VFSError('EINVAL', '/home/user/a.docx', 'quota'), 1024, quota)).toBe('storage-full');
    expect(saveFailure(new VFSError('EINVAL', '/home/user/a.docx', 'quota'), quota.file, quota)).toBe('storage-full');
  });

  it('keeps a refusal outside home apart, because it is a different promise', () => {
    expect(saveFailure(new VFSError('EACCES', '/etc/passwd'), 10, quota)).toBe('outside-home');
  });

  it('calls anything else a plain write failure rather than guessing', () => {
    expect(saveFailure(new Error('disk on fire'), 10, quota)).toBe('write-failed');
    expect(saveFailure(new VFSError('ENOENT', '/home/user/gone/a.docx'), 10, quota)).toBe('write-failed');
    expect(saveFailure('not an error at all', 10, quota)).toBe('write-failed');
    expect(saveFailure(null, 10, quota)).toBe('write-failed');
  });
});
