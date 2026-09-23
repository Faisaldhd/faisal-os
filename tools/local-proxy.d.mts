/**
 * Types for tools/local-proxy.mjs, so the vitest suite can import the REAL
 * validator instead of a copy of it. The runtime implementation is the .mjs file;
 * this declaration only exists because the project has no @types/node and the
 * importer is in the TypeScript `include` set.
 */

export const PROXY_VERSION: string;
export const DEFAULT_PORT: number;
export const LOOPBACK_HOST: string;
export const FETCH_TIMEOUT_MS: number;
export const MAX_BYTES: number;
export const MAX_REDIRECTS: number;
/** /view ticket policy: lifetime in ms, and the cap on live tickets (single-use). */
export const TICKET_TTL_MS: number;
export const MAX_LIVE_TICKETS: number;
export const USER_AGENT: string;

export type ValidationResult = { ok: true; url: URL } | { ok: false; reason: string };

export function isPrivateAddress(host: string): boolean;
export function isBlockedHostname(host: string): boolean;
export function validateTargetUrl(
  raw: string,
  opts?: { allow?: string[] | null; resolve?: boolean },
): Promise<ValidationResult>;
export function allowedOrigin(reqOrigin: string): string;
export function stripFrameAncestors(csp: string): string | null;
export function proxyResponseHeaders(
  upstreamHeaders: Record<string, unknown>,
  mode: 'reader' | 'raw',
  origin: string,
): Record<string, string>;
export function upstreamRequestHeaders(target: URL): Record<string, string>;
export function fetchGuarded(
  rawUrl: string,
  opts?: { allow?: string[] | null; fetchImpl?: typeof fetch },
): Promise<{
  status: number;
  headers: Record<string, string>;
  buffer: Uint8Array;
  truncated: boolean;
  finalUrl: string;
  contentType: string;
}>;
export function assertLoopbackHost(host: string): string;
/**
 * `ticketTtlMs` is the only option added for /ticket: a test needs to expire one
 * deterministically. The declared signature stays a plain record so nothing that
 * already calls this has to change.
 */
export function createProxyServer(options?: Record<string, unknown>): unknown;
export function start(options?: Record<string, unknown>): Promise<{
  server: unknown;
  host: string;
  port: number;
  token: string;
  auth: 'token-required';
  base: string;
}>;
export function parseArgs(argv: string[]): Record<string, unknown>;
export function main(argv?: string[]): Promise<unknown>;
