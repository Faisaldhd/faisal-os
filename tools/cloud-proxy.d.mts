/** Types for tools/cloud-proxy.mjs, so the vitest suite imports the real handler. */
export const CLOUD_PROXY_VERSION: string;
export const CLOUD_FETCH_TIMEOUT_MS: number;
export const CLOUD_MAX_BYTES: number;
export const CLOUD_MAX_REDIRECTS: number;
export const CLOUD_PREFIX: string;
export function validateCloudTarget(raw: string): { ok: true; url: URL } | { ok: false; reason: string };
export function cloudTokenMatches(expected: unknown, provided: unknown): Promise<boolean>;
export function cloudFetchGuarded(
  rawUrl: string,
  fetchImpl?: typeof fetch,
): Promise<{ error: string; status: number } | { error?: undefined; status: number; bytes: Uint8Array; truncated: boolean; finalUrl: string }>;
export function handleCloudProxy(request: Request, env?: { FAISAL_PROXY_TOKEN?: string }, fetchImpl?: typeof fetch): Promise<Response>;
