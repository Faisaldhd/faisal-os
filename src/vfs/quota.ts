/**
 * Storage policy — the ONE place that decides how much the OS may keep.
 *
 * The numbers are measured, not taste. Writing through the browser's IndexedDB on a desktop
 * profile was timed at ~300 ms for 100 MB, ~1.4 s for 500 MB and ~2.7 s for 1 GB, and the VFS
 * reads every file whole into memory, so one file costs roughly twice its size in the tab's
 * heap (4.1 GB in desktop Chrome, far less on a phone). The desktop tier is what that leaves
 * comfortable, a phone keeps less, and the desktop app writes into its own Electron profile
 * where no browser eviction applies, so it can afford more.
 */
export type StorageTier = 'desktop' | 'mobile' | 'app';

export interface StorageQuota {
  /** Largest single file. */
  file: number;
  /** Largest total across the whole tree. */
  total: number;
}

export const MB = 1024 * 1024;

export const STORAGE_QUOTAS: Record<StorageTier, StorageQuota> = {
  desktop: { file: 100 * MB, total: 1024 * MB },
  mobile: { file: 30 * MB, total: 300 * MB },
  app: { file: 500 * MB, total: 4096 * MB },
};

/** What the platform looks like at boot; the kernel fills it in (`src/main.ts`). */
export interface StorageEnvironment {
  /** The Electron build exposes `window.faisalDesktop`; a browser tab does not. */
  desktop?: boolean;
  /** Touch-first device (phone or tablet), from the shell's `isCoarsePointer()`. */
  coarsePointer?: boolean;
  /** `navigator.deviceMemory` in GiB, when the browser reports it. */
  deviceMemory?: number;
}

/**
 * The tier decides the limits. The desktop app wins first (it is the same person on the same
 * machine, just without the browser's eviction), then a touch-first device, then low memory —
 * a phone class device that reports a coarse pointer is mobile even when its RAM looks large.
 */
export function storageTierFor(env: StorageEnvironment): StorageTier {
  if (env.desktop) return 'app';
  if (env.coarsePointer) return 'mobile';
  const ram = env.deviceMemory;
  if (typeof ram === 'number' && Number.isFinite(ram) && ram > 0 && ram <= 4) return 'mobile';
  return 'desktop';
}

export function quotaFor(tier: StorageTier): StorageQuota {
  return STORAGE_QUOTAS[tier];
}
