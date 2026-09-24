/**
 * Capability truth for the video app — pure logic, with the browser reached
 * through one injectable probe.
 *
 * THE RULE THIS FILE EXISTS FOR: the app never assumes a format plays. Every
 * answer comes from the browser at runtime (`canPlayType`, and
 * `MediaSource.isTypeSupported` as a second opinion), and the reason a file was
 * refused names the format, so the user is never told "unsupported" without
 * knowing which thing is unsupported.
 *
 * `.mkv` and `.avi` are listed as *unlikely*: they are not claimed as playable,
 * and when a browser surprises everyone and reports support the row says "maybe"
 * and the refusal screen offers an explicit "try anyway" instead of a lie.
 */
import { extensionOf } from '../viewer/formats';

/** How the browser answered. `maybe` is not a promise — the UI says so. */
export type PlayAnswer = 'probably' | 'maybe' | 'no';

/** Which API produced the answer. */
export type ProbeVia = 'element' | 'source' | 'none';

export interface MediaFormat {
  /** Lower-case, leading dot. */
  ext: string;
  /** Container/codec description used for the request and the table. */
  mime: string;
  kind: 'video' | 'audio';
  label: string;
  /** A rough record of how widely this plays in browsers — documentation only. */
  likely: 'common' | 'uncommon' | 'unlikely';
}

/** The formats this app names. The order is the order of the capability table. */
export const MEDIA_FORMATS: readonly MediaFormat[] = [
  { ext: '.mp4', mime: 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"', kind: 'video', label: 'MP4 / H.264 + AAC', likely: 'common' },
  { ext: '.m4v', mime: 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"', kind: 'video', label: 'M4V (MPEG-4)', likely: 'common' },
  { ext: '.webm', mime: 'video/webm; codecs="vp9, opus"', kind: 'video', label: 'WebM / VP9 + Opus', likely: 'common' },
  { ext: '.webm', mime: 'video/webm; codecs="vp8, vorbis"', kind: 'video', label: 'WebM / VP8 + Vorbis', likely: 'common' },
  { ext: '.mov', mime: 'video/quicktime', kind: 'video', label: 'MOV (QuickTime)', likely: 'uncommon' },
  { ext: '.ogv', mime: 'video/ogg; codecs="theora, vorbis"', kind: 'video', label: 'Ogg video / Theora', likely: 'uncommon' },
  { ext: '.mkv', mime: 'video/x-matroska; codecs="avc1.42E01E, opus"', kind: 'video', label: 'MKV (Matroska)', likely: 'unlikely' },
  { ext: '.avi', mime: 'video/x-msvideo', kind: 'video', label: 'AVI', likely: 'unlikely' },
  { ext: '.mp3', mime: 'audio/mpeg', kind: 'audio', label: 'MP3', likely: 'common' },
  { ext: '.m4a', mime: 'audio/mp4; codecs="mp4a.40.2"', kind: 'audio', label: 'M4A / AAC', likely: 'common' },
  { ext: '.aac', mime: 'audio/aac', kind: 'audio', label: 'AAC (raw)', likely: 'uncommon' },
  { ext: '.wav', mime: 'audio/wav', kind: 'audio', label: 'WAV', likely: 'common' },
  { ext: '.ogg', mime: 'audio/ogg; codecs="vorbis"', kind: 'audio', label: 'Ogg / Vorbis', likely: 'common' },
  { ext: '.oga', mime: 'audio/ogg', kind: 'audio', label: 'Ogg audio', likely: 'common' },
  { ext: '.opus', mime: 'audio/ogg; codecs="opus"', kind: 'audio', label: 'Opus (Ogg)', likely: 'common' },
  { ext: '.flac', mime: 'audio/flac', kind: 'audio', label: 'FLAC', likely: 'uncommon' },
];

/** Every extension this app opens, de-duplicated and ordered. */
export const VIDEO_EXTENSIONS: string[] = [...new Set(MEDIA_FORMATS.map((f) => f.ext))];

/** All rows for one extension (a `.webm` has two candidate codec strings). */
export function formatsFor(ext: string): MediaFormat[] {
  const key = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  return MEDIA_FORMATS.filter((f) => f.ext === key);
}

/** The one best candidate row for a path; the first match is the preferred codec set. */
export function formatForPath(path: string): MediaFormat | undefined {
  return formatsFor(extensionOf(path))[0];
}

/** Everything the browser itself can answer about decodability. */
export interface CapabilityProbe {
  /** `HTMLMediaElement.canPlayType`; takes an empty string for "no answer". */
  canPlayType(mime: string): string;
  /** `MediaSource.isTypeSupported` when the browser exposes MediaSource at all. */
  isTypeSupported?(mime: string): boolean;
  /** `VideoEncoder.isConfigSupported` when the browser exposes WebCodecs. */
  isEncoderSupported?(config: { codec: string; width: number; height: number }): boolean;
}

/** One catalog row, already asked of the browser. */
export interface CapabilityRow {
  format: MediaFormat;
  /** The strongest answer the browser gave for this row. */
  answer: PlayAnswer;
  via: ProbeVia;
  /** The literal request string, kept so the table can show what was asked. */
  mime: string;
}

/** A browser cannot play it (`no`/empty) — the strongest evidence this app can get. */
export function choseRefusal(probe: CapabilityProbe, format: MediaFormat): boolean {
  const answer = probeAnswer(probe, format).answer;
  return answer === 'no';
}

/** The browser's answer for one row, without guessing. */
export function probeAnswer(probe: CapabilityProbe, format: MediaFormat): { answer: PlayAnswer; via: ProbeVia } {
  const raw = probe.canPlayType(format.mime);
  if (raw === 'probably' || raw === 'maybe') return { answer: raw, via: 'element' };
  // `canPlayType` said no (or gave nothing): a container-only answer is the
  // second opinion, and it is the one MediaSource playback would actually use.
  if (probe.isTypeSupported?.(format.mime)) return { answer: 'probably', via: 'source' };
  // Nothing at all: the browser gave no answer, which is a refusal for this app's
  // purposes — but the table says "no answer" rather than pretending it said no.
  return { answer: 'no', via: raw === '' ? 'none' : 'element' };
}

/** Turns a probe answer into the short status word the table shows. */
export function answerWord(answer: PlayAnswer): 'no' | 'maybe' | 'probably' {
  return answer;
}

/** Every catalog row asked of the browser, in catalog order. */
export function capabilityTable(probe: CapabilityProbe): CapabilityRow[] {
  return MEDIA_FORMATS.map((format) => ({ format, mime: format.mime, ...probeAnswer(probe, format) }));
}

/** Rows for one extension, in catalog order. */
export function rowsForExtension(probe: CapabilityProbe, ext: string): CapabilityRow[] {
  return capabilityTable(probe).filter((row) => row.format.ext === (ext.startsWith('.') ? ext : `.${ext}`));
}

/** True when at least one row of this extension is playable (probably or maybe). */
export function extensionPlayable(probe: CapabilityProbe, ext: string): boolean {
  return rowsForExtension(probe, ext).some((row) => row.answer !== 'no');
}

/**
 * Why a file cannot be opened, or `null` when at least one candidate row plays.
 * The caller renders `ext` into the bilingual refusal message; this function only
 * decides, so the decision is testable without a browser.
 */
export function refusalFor(probe: CapabilityProbe, path: string): { ext: string; rows: CapabilityRow[] } | null {
  const ext = extensionOf(path);
  if (!ext) return null;
  const rows = rowsForExtension(probe, ext);
  if (rows.length === 0) return null; // unknown extension: let the player try
  if (rows.some((row) => row.answer !== 'no')) return null;
  return { ext, rows };
}

/**
 * The container the export should try first for a source extension.
 * WebM in, WebM out (VP8/VP9 + Opus); anything else prefers MP4 (AVC + AAC).
 */
export function preferredExportMime(sourceExt: string): 'video/webm' | 'video/mp4' {
  return sourceExt === '.webm' || sourceExt === '.ogv' ? 'video/webm' : 'video/mp4';
}

/** Candidate `MediaRecorder` MIME types for a wanted container, best first. */
export function recorderMimeCandidates(want: 'video/webm' | 'video/mp4', kind: 'video' | 'audio'): string[] {
  if (kind === 'audio') {
    return [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
      'audio/mpeg',
    ];
  }
  return want === 'video/webm'
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4', 'video/x-matroska;codecs=avc1']
    : ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
}

/** A human-readable codec name for a WebCodecs config string. */
export function codecFamily(codec: string): string {
  if (codec.startsWith('vp09')) return 'VP9';
  if (codec.startsWith('vp8')) return 'VP8';
  if (codec.startsWith('avc1')) return 'H.264';
  if (codec.startsWith('av01')) return 'AV1';
  if (codec.startsWith('opus')) return 'Opus';
  if (codec.startsWith('mp4a')) return 'AAC';
  return codec;
}
