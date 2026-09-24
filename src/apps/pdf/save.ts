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
  | { ok: false; code: SaveErrorCode };

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
  } catch {
    return { ok: false, code: 'writeFailed' };
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
