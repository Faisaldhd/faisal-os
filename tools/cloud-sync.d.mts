/** Types for tools/cloud-sync.mjs, so the vitest suite imports the real handler. */
export interface SyncItem { key: string; kind: 'file' | 'dir' | 'value'; mtime: number; deleted: boolean; data?: string | null; rev?: number }
export interface SyncStore {
  init(): Promise<unknown>;
  put(items: SyncItem[]): Promise<{ accepted: { key: string; rev: number }[]; rev: number }>;
  since(after: number, limit: number, maxBytes: number): Promise<{ items: SyncItem[]; rev: number; more: boolean }>;
}
export const SYNC_VERSION: string;
export const SYNC_PREFIX: string;
export const MAX_ITEM_DATA: number;
export const MAX_PUSH_ITEMS: number;
export function isSyncKey(key: unknown): boolean;
export function checkItem(raw: unknown): { ok: true; item: SyncItem } | { ok: false; reason: string };
export function createMemoryStore(): SyncStore;
export function createD1Store(db: unknown): SyncStore;
export function handleCloudSync(request: Request, env?: Record<string, unknown>, store?: SyncStore | null): Promise<Response>;
