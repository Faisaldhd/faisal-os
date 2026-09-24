/** Binds the dialogs to one window (its host element, file system and language). */
import type { Stat, SystemAPI } from '../../kernel/types';
import type { CapabilityProbe } from './capabilities';
import { pickFromFiles, scanFiles, showLimits, showShortcuts, type PickerCategory } from './dialogs';

export interface AppDialogs {
  pick(opts: { title: string; categories: PickerCategory[]; initial?: string; multiple: boolean; okLabel: string }): Promise<string[]>;
  shortcuts(): void;
  limits(recorder: Array<{ mime: string; ok: boolean }>): void;
  scan(exts: readonly string[]): Promise<Stat[]>;
}

export function dialogsFor(opts: { host: HTMLElement; sys: SystemAPI; status: (text: string) => void; probe: () => CapabilityProbe }): AppDialogs {
  return {
    pick: (p) => pickFromFiles({ ...p, host: opts.host, vfs: opts.sys.vfs, locale: opts.sys.locale() }),
    shortcuts: () => showShortcuts(opts.host),
    limits: (recorder) => showLimits(opts.host, opts.probe(), recorder),
    scan: (exts) => scanFiles(opts.sys.vfs, exts),
  };
}
