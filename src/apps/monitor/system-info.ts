/**
 * Pure, DOM-free collector for the System Monitor's "System" tab.
 *
 * The whole point of this module is honesty: it reports only what the browser
 * environment it is handed actually exposes. Anything the environment does not
 * provide comes back with `available: false` and `value: null`, and the caller
 * renders the explicit "not available in this browser" string. There are no
 * placeholder numbers, no `?? 0` and no invented fallbacks anywhere here.
 *
 * The browser has no API for CPU/GPU temperature, fan speed, sensor readings or
 * real hardware memory usage, so no row for any of those can ever be produced.
 *
 * Every property is read through a `safe()` guard, so a getter that throws
 * (locked-down or exotic environments) degrades to "unavailable" instead of
 * taking the tab down.
 */

export type SystemInfoSection = 'browser' | 'display' | 'system' | 'network' | 'storage' | 'runtime';

export interface SystemInfoRow {
  /** Stable identifier, used as the DOM key so refreshes update instead of rebuild. */
  id: string;
  /** i18n key for the row label (resolved with `t()` by the caller). */
  labelKey: string;
  /** Ready-to-render value, or null when the browser does not expose it. */
  value: string | null;
  available: boolean;
  /** Optional i18n key explaining exactly where the value comes from. */
  noteKey?: string;
  section: SystemInfoSection;
}

/**
 * Just enough of `navigator.userAgentData` (User-Agent Client Hints) to be useful.
 * Typed structurally because the DOM lib used here does not ship it.
 */
export interface UserAgentBrand {
  brand: string;
  version: string;
}

export interface UserAgentDataLike {
  brands?: UserAgentBrand[];
  mobile?: boolean;
  platform?: string;
}

/** The handful of `navigator.connection` (Network Information API) fields we report. */
export interface ConnectionLike {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
}

export interface ScreenLike {
  width?: number;
  height?: number;
}

/** The browser environment handed to the collector. Pass exactly what you want reported. */
export interface SystemInfoEnv {
  /** Where the values come from; the app passes `window`. */
  source: {
    navigator?: unknown;
    screen?: unknown;
    /** `window.devicePixelRatio`. */
    devicePixelRatio?: number;
    /** `window.innerWidth`. */
    innerWidth?: number;
    /** `window.innerHeight`. */
    innerHeight?: number;
    /** `navigator.onLine`. */
    onLine?: boolean;
    /** `performance.timeOrigin`. */
    timeOrigin?: number;
    /** `Intl.DateTimeFormat().resolvedOptions().timeZone`. */
    timeZone?: string;
  };
  /** Open applications and windows, supplied by the app so the collector stays pure. */
  appsOpen: number;
  windowsOpen: number;
  /** Current time in ms; supplied by the caller so the collector stays deterministic. */
  nowMs: number;
}

/** Reads a property defensively: a throwing getter becomes `undefined`, never an exception. */
function safe(obj: unknown, key: string): unknown {
  if (obj === null || obj === undefined) return undefined;
  try {
    return (obj as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function positiveInt(value: unknown): number | null {
  const n = num(value);
  if (n === null || n <= 0) return null;
  return Math.round(n);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function row(
  id: string,
  labelKey: string,
  value: string | null,
  section: SystemInfoSection,
  noteKey?: string,
): SystemInfoRow {
  const ok = typeof value === 'string' && value !== '';
  return {
    id,
    labelKey,
    value: ok ? value : null,
    available: ok,
    section,
    ...(noteKey ? { noteKey } : {}),
  };
}

interface NumFormat {
  min?: number;
  max?: number;
  unit?: string;
  decimals?: number;
  integer?: boolean;
}

/** Formats a number with String() semantics (never `toFixed(0)`, which turns 1e21 into "1e+21"). */
function fmtNum(value: unknown, o: NumFormat = {}): string | null {
  const n = num(value);
  if (n === null) return null;
  if (o.min !== undefined && n < o.min) return null;
  if (o.max !== undefined && n > o.max) return null;
  const body = o.integer || Number.isInteger(n) ? String(n) : String(Number(n.toFixed(o.decimals ?? 2)));
  return o.unit ? `${body} ${o.unit}` : body;
}

/** `navigator.deviceMemory` is reported in GiB, already rounded by the browser. */
function fmtGiB(value: unknown): string | null {
  const n = num(value);
  if (n === null || n <= 0) return null;
  return `${String(n)} GB`;
}

/** Renders the client-hint brand list, e.g. "Chromium 126, Google Chrome 126". */
function fmtBrands(brands: unknown): string | null {
  if (!Array.isArray(brands) || brands.length === 0) return null;
  const parts: string[] = [];
  for (const b of brands) {
    const brand = text(safe(b, 'brand'));
    if (!brand) continue;
    const version = text(safe(b, 'version'));
    parts.push(version ? `${brand} ${version}` : brand);
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

/** The UA-CH platform string, with a mobile/desktop fallback when only `mobile` is exposed. */
function uaDataPlatform(ua: UserAgentDataLike | undefined): string | null {
  if (!ua) return null;
  const p = text(safe(ua, 'platform'));
  if (p) return p;
  const mobile = safe(ua, 'mobile');
  return typeof mobile === 'boolean' ? `${mobile ? 'mobile' : 'desktop'} (client hints)` : null;
}

/** Browser and platform: client hints win, the raw UA/platform strings are the fallback. */
function browserRows(env: SystemInfoEnv, uaData: UserAgentDataLike | undefined): SystemInfoRow[] {
  const nav = env.source.navigator;
  const rawUA = text(safe(nav, 'userAgent'));
  const rawPlatform = text(safe(nav, 'platform'));

  // No version is ever parsed out of either string.
  const browserValue = fmtBrands(uaData ? safe(uaData, 'brands') : undefined) ?? rawUA;
  const platformValue = uaDataPlatform(uaData) ?? rawPlatform;
  const mobile = uaData ? safe(uaData, 'mobile') : undefined;
  const languages = safe(nav, 'languages');

  return [
    row(
      'browser',
      'monitor.sysBrowser',
      browserValue,
      'browser',
      uaData ? 'monitor.noteClientHints' : 'monitor.noteRawUserAgent',
    ),
    row('platform', 'monitor.sysPlatform', platformValue, 'browser'),
    row(
      'mobile',
      'monitor.sysMobile',
      typeof mobile === 'boolean' ? (mobile ? 'yes' : 'no') : null,
      'browser',
      'monitor.noteClientHintsOnly',
    ),
    row('language', 'monitor.sysLanguage', text(safe(nav, 'language')), 'browser'),
    row(
      'languages',
      'monitor.sysLanguages',
      Array.isArray(languages)
        ? languages.map((l) => text(l)).filter((l): l is string => !!l).join(', ') || null
        : null,
      'browser',
    ),
  ];
}

/** Screen size/ratio/colour depth, plus the current viewport (the app re-reads it on resize). */
function displayRows(env: SystemInfoEnv): SystemInfoRow[] {
  const screen = env.source.screen;
  const w = positiveInt(safe(screen, 'width'));
  const h = positiveInt(safe(screen, 'height'));
  const ratio = num(env.source.devicePixelRatio);
  const vw = positiveInt(env.source.innerWidth);
  const vh = positiveInt(env.source.innerHeight);

  return [
    row('screen', 'monitor.sysScreen', w !== null && h !== null ? `${w} × ${h} px` : null, 'display'),
    row('devicePixelRatio', 'monitor.sysDpr', ratio !== null && ratio > 0 ? String(ratio) : null, 'display'),
    row(
      'colorDepth',
      'monitor.sysColorDepth',
      fmtNum(safe(screen, 'colorDepth'), { min: 1, max: 64, unit: 'bit', integer: true }),
      'display',
    ),
    row('viewport', 'monitor.sysViewport', vw !== null && vh !== null ? `${vw} × ${vh} px` : null, 'display'),
  ];
}

/** Concurrency, browser-reported device memory, online state and the Network Information API. */
function systemRows(env: SystemInfoEnv, conn: ConnectionLike | undefined): SystemInfoRow[] {
  const nav = env.source.navigator;
  const online = env.source.onLine;
  const effectiveType = conn ? text(safe(conn, 'effectiveType')) : null;
  const downlink = conn ? fmtNum(safe(conn, 'downlink'), { min: 0, unit: 'Mbit/s', decimals: 1 }) : null;
  const rtt = conn ? fmtNum(safe(conn, 'rtt'), { min: 0, unit: 'ms', integer: true }) : null;
  const saveData = conn ? safe(conn, 'saveData') : undefined;

  return [
    row('cpuThreads', 'monitor.sysCpuThreads', fmtNum(safe(nav, 'hardwareConcurrency'), { min: 1, integer: true }), 'system'),
    // Approximate, browser-rounded GiB — explicitly not a measured hardware memory figure.
    row('deviceMemory', 'monitor.sysDeviceMemory', fmtGiB(safe(nav, 'deviceMemory')), 'system', 'monitor.noteApproximate'),
    row(
      'online',
      'monitor.sysOnline',
      typeof online === 'boolean' ? (online ? 'yes' : 'no') : null,
      'system',
      'monitor.noteOnlineEvents',
    ),
    row(
      'connection',
      'monitor.sysConnection',
      effectiveType && downlink ? `${effectiveType} · ${downlink}` : (effectiveType ?? downlink),
      'network',
      'monitor.noteNetworkInformation',
    ),
    row('rtt', 'monitor.sysRtt', rtt, 'network', 'monitor.noteNetworkInformation'),
    row(
      'saveData',
      'monitor.sysSaveData',
      typeof saveData === 'boolean' ? (saveData ? 'yes' : 'no') : null,
      'network',
      'monitor.noteNetworkInformation',
    ),
  ];
}

/** Persistence only: the byte estimate itself belongs to the File Systems tab. */
function storageRows(persisted: unknown): SystemInfoRow[] {
  const known = typeof persisted === 'boolean';
  return [
    row(
      'storagePersisted',
      'monitor.sysPersisted',
      known ? (persisted ? 'yes' : 'no') : null,
      'storage',
      known ? 'monitor.noteEstimateInFileSystems' : 'monitor.notePersistedUnavailable',
    ),
  ];
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** Page uptime from the Performance API, the resolved time zone, and the app/window counts. */
function runtimeRows(env: SystemInfoEnv): SystemInfoRow[] {
  const origin = num(env.source.timeOrigin);
  const now = num(env.nowMs);
  const uptime = origin !== null && now !== null ? Math.max(0, Math.round(now - origin)) : null;

  return [
    row(
      'pageUptime',
      'monitor.sysPageUptime',
      uptime !== null ? formatDuration(uptime) : null,
      'runtime',
      'monitor.noteTimeOrigin',
    ),
    row('timeZone', 'monitor.sysTimezone', text(env.source.timeZone), 'runtime'),
    row('appsWindows', 'monitor.sysAppsWindows', `${env.appsOpen} / ${env.windowsOpen}`, 'runtime', 'monitor.noteAppsFromRegistry'),
  ];
}

function buildRows(env: SystemInfoEnv): SystemInfoRow[] {
  const uaData = safe(env.source.navigator, 'userAgentData') as UserAgentDataLike | undefined;
  const conn = safe(env.source.navigator, 'connection') as ConnectionLike | undefined;
  return [
    ...browserRows(env, uaData),
    ...displayRows(env),
    ...systemRows(env, conn),
    ...runtimeRows(env),
  ];
}

/**
 * Collects every honest, browser-exposed row. The returned rows always cover the same ids
 * in the same order, so the caller can update values in place without rebuilding its DOM.
 * Storage persistence is not included here — use the async variant for that one API.
 */
export function collectSystemInfo(env: SystemInfoEnv): SystemInfoRow[] {
  return [...buildRows(env), ...storageRows(undefined)];
}

/** Row ids whose value is expected to change while the System tab stays open. */
export const LIVE_SYSTEM_ROW_IDS: readonly string[] = ['viewport', 'online', 'pageUptime'];

/**
 * What the FPS card must show, decided without touching the DOM or a clock.
 *
 * `requestAnimationFrame` is throttled to ~0 fps whenever the page is hidden, so a
 * reading taken then is an artefact of the browser's throttling, not of this page's
 * responsiveness. While hidden the card shows the paused state instead of that
 * misleading near-zero number, and until one full one-second window has been
 * sampled it shows "measuring" rather than a zero it has not measured.
 */
export type FpsDisplay =
  | { state: 'paused' }
  | { state: 'measuring' }
  | { state: 'value'; value: number };

export function fpsDisplay(framesPerSecond: readonly number[], hidden: boolean): FpsDisplay {
  if (hidden) return { state: 'paused' };
  const latest = framesPerSecond[framesPerSecond.length - 1];
  if (typeof latest !== 'number' || !Number.isFinite(latest)) return { state: 'measuring' };
  return { state: 'value', value: latest };
}

/** True for the literal yes/no values the collector emits; the caller localises them. */
export function isYesNoValue(value: string): boolean {
  return value === 'yes' || value === 'no';
}

/** Resolves `navigator.storage.persisted()` (the collector's only async API) and returns all rows. */
export async function collectSystemInfoAsync(env: SystemInfoEnv): Promise<SystemInfoRow[]> {
  const storage = safe(env.source.navigator, 'storage');
  const persistedFn = safe(storage, 'persisted');
  let persisted: unknown;
  if (typeof persistedFn === 'function') {
    try {
      persisted = await (persistedFn as () => Promise<unknown>).call(storage);
    } catch {
      persisted = undefined;
    }
  }
  return [...buildRows(env), ...storageRows(persisted)];
}
