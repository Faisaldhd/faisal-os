/**
 * Photo Editor — the pure format layer: what this editor can open, what it can write, and
 * exactly why it refuses anything else.
 *
 * The browser decides what is *actually* decodable (a build without the AVIF decoder, a
 * browser that refuses WebP in a Worker, …), so the table below says what the editor is
 * prepared to handle and `probeFormats` checks the runtime claim per format. A format the
 * runtime refuses is refused with a message that names it, in both languages, instead of a
 * blank canvas.
 */
import type { Locale } from '../../kernel/types';

export type SourceFormat = 'png' | 'jpeg' | 'webp' | 'gif' | 'bmp' | 'avif' | 'svg';
export type ExportFormat = 'png' | 'jpeg' | 'webp';

export interface FormatInfo {
  id: SourceFormat;
  /** Extensions that map to this format, lowercase, with the dot. */
  extensions: string[];
  mime: string;
  /** The `<canvas>`/VFS mime used when writing this format back out. */
  exportMime?: string;
  /** True when the editor can decode it (the runtime still has the last word). */
  canOpen: boolean;
  /** True when the editor can write it. */
  canExport: boolean;
  /** True for formats that can carry multiple frames. The editor opens frame 1 only. */
  animated: boolean;
  /** True when a probe is required: the browser may lack this codec entirely. */
  needsProbe: boolean;
  /** Lossy formats take a quality slider. */
  lossy: boolean;
}

export const FORMATS: Record<SourceFormat, FormatInfo> = {
  png: {
    id: 'png', extensions: ['.png'], mime: 'image/png', exportMime: 'image/png',
    canOpen: true, canExport: true, animated: true, needsProbe: false, lossy: false,
  },
  jpeg: {
    id: 'jpeg', extensions: ['.jpg', '.jpeg'], mime: 'image/jpeg', exportMime: 'image/jpeg',
    canOpen: true, canExport: true, animated: false, needsProbe: false, lossy: true,
  },
  webp: {
    id: 'webp', extensions: ['.webp'], mime: 'image/webp', exportMime: 'image/webp',
    canOpen: true, canExport: true, animated: true, needsProbe: false, lossy: true,
  },
  gif: {
    id: 'gif', extensions: ['.gif'], mime: 'image/gif',
    canOpen: true, canExport: false, animated: true, needsProbe: false, lossy: false,
  },
  bmp: {
    id: 'bmp', extensions: ['.bmp'], mime: 'image/bmp',
    canOpen: true, canExport: false, animated: false, needsProbe: false, lossy: false,
  },
  avif: {
    id: 'avif', extensions: ['.avif'], mime: 'image/avif',
    canOpen: true, canExport: false, animated: false, needsProbe: true, lossy: true,
  },
  svg: {
    id: 'svg', extensions: ['.svg'], mime: 'image/svg+xml',
    canOpen: true, canExport: false, animated: true, needsProbe: false, lossy: false,
  },
};

export const SOURCE_FORMAT_LIST: SourceFormat[] = ['png', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg'];
export const EXPORT_FORMAT_LIST: ExportFormat[] = ['png', 'jpeg', 'webp'];

/** Everything the editor advertises as openable, for the manifest copy and the open dialog. */
export const OPEN_EXTENSIONS: string[] = SOURCE_FORMAT_LIST.flatMap((id) => FORMATS[id].extensions);

/**
 * The extension list the MANIFEST declares (`opens`). It is the same list the editor actually
 * attempts to decode, so the kernel's "first installed app that declares this extension" rule
 * (src/kernel/apps.ts:192) sends images here: the editor is installed by default (the owner's
 * decision, 2026-09-25), so this list is in force from the first run.
 *
 * `.avif` is included because the app really is built to open it: the runtime probe decides
 * per browser, and a build without an AVIF decoder refuses the file with a message that names
 * the format instead of failing silently. Nothing in this list is claimed without a decode
 * path behind it.
 */
export const MANIFEST_OPENS: string[] = [...OPEN_EXTENSIONS];

/** The one place an extension becomes a format: lowercased, dot included. */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

export function formatForExtension(ext: string): FormatInfo | null {
  const e = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  for (const id of SOURCE_FORMAT_LIST) {
    if (FORMATS[id].extensions.includes(e)) return FORMATS[id];
  }
  return null;
}

export function sourceFormatOf(path: string): SourceFormat | null {
  const info = formatForExtension(extensionOf(path));
  return info && info.canOpen ? info.id : null;
}

export function exportFormatForExtension(ext: string): ExportFormat | null {
  const e = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  for (const id of EXPORT_FORMAT_LIST) {
    if (FORMATS[id].extensions.includes(e)) return id;
  }
  return null;
}

/** The canonical extension an export format writes (so a copy never claims the wrong type). */
export function canonicalExtension(format: ExportFormat): string {
  return FORMATS[format].extensions[0];
}

/** What a refusal is about, so the UI can pick a sentence instead of guessing. */
export type RefusalReason =
  | 'no-path'
  | 'no-extension'
  | 'not-an-image'
  | 'cannot-open'
  | 'cannot-export'
  | 'runtime-decode'
  | 'decode-failed'
  | 'too-large'
  | 'out-of-home';

export interface DecodeDecision {
  kind: 'ok' | 'refuse';
  format: SourceFormat | null;
  reason?: RefusalReason;
  /** The format/extension as written by the user, for the message. */
  named: string;
}

/**
 * The refusal mapping: given a path, the runtime's probe results and the image's pixel
 * count, decides whether the editor opens it — and if not, which sentence it shows.
 *
 * `runtime` holds the probed ability per format (`true` decodable, `false` refused). A
 * format missing from the map is treated as decodable when the table says no probe is
 * needed, which is what keeps a browser without `createImageBitmap` usable.
 */
export function decideDecode(
  path: string,
  runtime: Partial<Record<SourceFormat, boolean>>,
  pixels: number | null,
  maxPixels: number,
): DecodeDecision {
  const named = extensionOf(path) || path;
  if (!path) return { kind: 'refuse', format: null, reason: 'no-path', named };
  const ext = extensionOf(path);
  if (!ext) return { kind: 'refuse', format: null, reason: 'no-extension', named };
  const info = formatForExtension(ext);
  if (!info) return { kind: 'refuse', format: null, reason: 'not-an-image', named };
  if (!info.canOpen) return { kind: 'refuse', format: info.id, reason: 'cannot-open', named };
  // A probe that explicitly failed outranks the table: that is the honest answer.
  if (runtime[info.id] === false) return { kind: 'refuse', format: info.id, reason: 'runtime-decode', named };
  if (info.needsProbe && runtime[info.id] !== true) {
    return { kind: 'refuse', format: info.id, reason: 'runtime-decode', named };
  }
  if (info.id === 'svg' && runtime.svg === false) {
    return { kind: 'refuse', format: 'svg', reason: 'runtime-decode', named };
  }
  if (pixels !== null && pixels > maxPixels) {
    return { kind: 'refuse', format: info.id, reason: 'too-large', named };
  }
  return { kind: 'ok', format: info.id, named };
}

/** True when a decode failure means "the file itself is broken", not "the codec is missing". */
export function decodeFailureReason(format: SourceFormat | null, probed: boolean | undefined): RefusalReason {
  if (format && probed === false) return 'runtime-decode';
  return 'decode-failed';
}

/* ─────────────────────────────── refusal copy ─────────────────────────────── */

/**
 * Every refusal, as data rather than prose: the UI interpolates `{named}` with the extension
 * or format it could not handle, so a message always names what was refused. Kept next to
 * `RefusalReason` so a new reason cannot be added without a sentence in both languages.
 */
export const REFUSAL_MESSAGES: Record<RefusalReason, { ar: string; en: string }> = {
  'no-path': { ar: 'لم يصل أي مسار ملف إلى المحرّر.', en: 'No file path reached the editor.' },
  'no-extension': {
    ar: 'الملف «{named}» بلا امتداد، فلا يمكن معرفة نوعه.',
    en: '“{named}” has no extension, so its type cannot be determined.',
  },
  'not-an-image': {
    ar: 'صيغة «{named}» ليست صيغة صورة يدعمها هذا المحرّر.',
    en: '“{named}” is not an image format this editor supports.',
  },
  'cannot-open': {
    ar: 'لا يمكن فتح صيغة «{named}» في هذا المحرّر.',
    en: 'The format “{named}” cannot be opened in this editor.',
  },
  'cannot-export': {
    ar: 'لا يمكن التصدير بصيغة «{named}». المتاح: PNG وJPEG وWebP.',
    en: 'Exporting as “{named}” is not supported. Available: PNG, JPEG, WebP.',
  },
  'runtime-decode': {
    ar: 'هذا المتصفح لا يستطيع فك ترميز «{named}» — الصيغة معروفة لكن وحدة فك الترميز غير متوفّرة هنا.',
    en: 'This browser cannot decode “{named}” — the format is known but its decoder is missing here.',
  },
  'decode-failed': {
    ar: 'تعذّر فك ترميز الملف بصيغة «{named}»؛ قد يكون تالفاً أو لا يطابق امتداده.',
    en: 'The “{named}” file could not be decoded; it may be corrupt or not match its extension.',
  },
  'too-large': {
    ar: 'الصورة أكبر من الحدّ الذي يفتحه المحرّر ({named} بكسل).',
    en: 'The image is larger than the editor opens ({named} pixels).',
  },
  'out-of-home': {
    ar: 'لا يسمح المحرّر بالكتابة إلا داخل المجلد الرئيسي /home/user.',
    en: 'The editor only writes inside the home folder /home/user.',
  },
};

/** The sentence for one reason, with `{named}` filled in for this locale. */
export function refusalSentence(reason: RefusalReason, locale: Locale, named: string): string {
  const m = REFUSAL_MESSAGES[reason];
  return (locale === 'ar' ? m.ar : m.en).split('{named}').join(named);
}


/* ─────────────────────────────── runtime probe ─────────────────────────────── */

/** The one browser capability the probe needs, injected so it can be stubbed in tests. */
export interface DecodeProbe {
  /** Try to decode these bytes as an image; true only when a real decode happened. */
  decodes(bytes: Uint8Array, mime: string): Promise<boolean>;
}

/** A 1×1 transparent PNG, the smallest thing that is definitely an image. */
export const PROBE_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

/**
 * A minimal valid 1×1 image for each format, so the probe has real bytes to hand to the
 * browser's decoder. The bytes are built by the caller (the UI encodes them once with a
 * canvas), because hand-writing a valid AVIF in source is not possible; when no sample
 * exists for a format, the probe reports "unknown" instead of claiming support.
 */
export type ProbeSamples = Partial<Record<SourceFormat, { bytes: Uint8Array; mime: string }>>;

export interface ProbeResult {
  support: Partial<Record<SourceFormat, boolean>>;
  /** Formats that could not be probed at all (no sample bytes). */
  unknown: SourceFormat[];
}

/**
 * Probes every format for which sample bytes exist. A missing sample is reported as
 * `unknown` — never as `true` — so `decideDecode` refuses a `needsProbe` format it could not
 * confirm, which is the honest direction: refuse rather than promise a decode that fails.
 */
export async function probeFormats(probe: DecodeProbe, samples: ProbeSamples): Promise<ProbeResult> {
  const support: Partial<Record<SourceFormat, boolean>> = {};
  const unknown: SourceFormat[] = [];
  for (const id of SOURCE_FORMAT_LIST) {
    const info = FORMATS[id];
    if (!info.needsProbe && id !== 'svg') {
      support[id] = true;
      continue;
    }
    const sample = samples[id];
    if (!sample || sample.bytes.length === 0) {
      // No bytes to test with: report the format as unknown. `decideDecode` refuses a
      // `needsProbe` format it could not confirm — refuse rather than promise.
      unknown.push(id);
      continue;
    }
    // try/catch per format: one missing codec must not abort the whole probe.
    try {
      support[id] = await probe.decodes(sample.bytes, sample.mime);
    } catch {
      support[id] = false;
    }
  }
  return { support, unknown };
}

/* ─────────────────────────────── size limits ─────────────────────────────── */

/** The pixel count the editor will allocate (24 MP ≈ 100 MB of RGBA). */
export const MAX_PIXELS = 24_000_000;
/**
 * The EDITOR'S OWN cap for one encoded export — a policy of this app, not a platform limit.
 *
 * A canvas encode of a very large image costs far more memory than the file it produces, so the
 * editor stays well below what the file system would accept. The file system's real limits live
 * in `src/vfs/quota.ts` and follow the platform tier (desktop 100 MB per file / 1 GB in total,
 * mobile 30 MB / 300 MB, the desktop app 500 MB / 4 GB); the user-visible limit text quotes those
 * numbers at run time, so nothing here has to be kept in step with them.
 */
export const MAX_EXPORT_BYTES = 20 * 1024 * 1024;

/** True when `pixels` fits the editor's budget; the message names the limit. */
export function pixelLimitExceeded(pixels: number): boolean {
  return pixels > MAX_PIXELS;
}

/** The quality range a lossy export accepts, as a 0..1 fraction. */
export function clampQuality(quality: number): number {
  if (!Number.isFinite(quality)) return 0.92;
  return Math.min(1, Math.max(0.05, quality));
}

/**
 * The export format a typed target name implies, so a copy named `x.jpg` is really encoded as
 * JPEG. An extension the editor cannot write (or none at all) reports null, and the caller
 * then keeps the format the user picked from the list.
 */
export function formatOfTarget(path: string): ExportFormat | null {
  const info = formatForExtension(extensionOf(path));
  if (!info || !info.canExport) return null;
  return EXPORT_FORMAT_LIST.find((id) => FORMATS[id].id === info.id) ?? null;
}
