/**
 * PDF app — saving through the VFS (الحفظ عبر نظام الملفات).
 *
 * Two rules decide everything here, and both are pinned by tests:
 *  1. the default never writes over the file that was opened — it writes a sibling copy
 *     with a new name, and the name search is the caller's `planSave`;
 *  2. replacing the original happens only when the owner asks for it, and then exactly
 *     one `.bak` of the original is written first. If the original cannot be read, the
 *     overwrite is refused instead of proceeding without a backup.
 *
 * Nothing outside `/home/user` is ever written (also enforced by the kernel: the app's
 * only permission is `fs:home`).
 */
import { HOME, type SystemAPI } from '../../kernel/types';
import { planSave, type SaveErrorCode, type SavePlan, type SavePlanResult, type SaveRequest } from './ops';

export type SaveOutcome =
  | { ok: true; path: string; backup: string | null; isCopy: boolean }
  | { ok: false; code: SaveErrorCode; reason?: WriteFailureReason };

/**
 * Why a write was refused. The kernel refuses BOTH quota cases with the same `EINVAL` code and
 * the message "quota" — one file above the per-file limit, or a store that is full — so the reason
 * comes from comparing the bytes with the limit the VFS reports right now: that is the difference
 * between "make it smaller" and "delete something", and the window can only say it if it is told.
 */
export type WriteFailureReason = 'file-too-big' | 'storage-full' | 'write-failed';

export function writeFailureReason(err: unknown, bytes: number, quota: { file: number }): WriteFailureReason {
  const code = (err as { code?: string } | null)?.code;
  const message = err instanceof Error ? err.message : '';
  if (code === 'EINVAL' || message === 'quota') return bytes > quota.file ? 'file-too-big' : 'storage-full';
  return 'write-failed';
}

/** The path a save would use, so the window can show it before writing anything. */
export async function previewSave(sys: SystemAPI, request: SaveRequest): Promise<SavePlanResult> {
  return planSave(request, (path) => sys.vfs.exists(path), HOME);
}

/** Writes `bytes` according to `plan`: the copy, or the original after one `.bak`. */
export async function writePlan(sys: SystemAPI, plan: SavePlan, bytes: Uint8Array): Promise<SaveOutcome> {
  if (bytes.length === 0) return { ok: false, code: 'noBytes' };
  try {
    if (plan.backup) {
      // The backup is the original as the filesystem holds it right now — read back, not
      // the copy this window has been editing. One `.bak`, overwritten if it already exists.
      const original = await sys.vfs.readFile(plan.source);
      await sys.vfs.writeFile(plan.backup, original);
    }
    await sys.vfs.writeFile(plan.target, bytes);
  } catch (err) {
    // The reason travels with the failure when it names a limit: the window then says which one
    // was hit instead of "could not save". A plain failure keeps the exact failure shape the
    // rest of the app (and its tests) already knows.
    const reason = writeFailureReason(err, bytes.length, sys.vfs.quota);
    return reason === 'write-failed'
      ? { ok: false, code: 'writeFailed' }
      : { ok: false, code: 'writeFailed', reason };
  }
  return { ok: true, path: plan.target, backup: plan.backup, isCopy: plan.isCopy };
}

/** Plans and performs one save in a single call. */
export async function saveBytes(sys: SystemAPI, request: SaveRequest, bytes: Uint8Array): Promise<SaveOutcome> {
  if (bytes.length === 0) return { ok: false, code: 'noBytes' };
  const planned = await previewSave(sys, request);
  if (!planned.ok) return { ok: false, code: planned.error };
  return writePlan(sys, planned.plan, bytes);
}
