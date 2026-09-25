/**
 * Converting a video the browser cannot decode (HEVC, MPEG-4 Part 2 "mp4v",
 * …) — the pure half, no DOM.
 *
 *  • ffmpeg-core.wasm (~31 MB) is over Cloudflare Pages' 25 MiB file limit, so
 *    the build cuts it into parts (`planParts`, used by build/ffmpeg-core.ts)
 *    and the app joins them back (`joinParts`) into a Blob URL for ffmpeg.
 *  • The ffmpeg command lines for H.264 MP4 and the VP9 WebM fallback.
 *  • Reading the encoder list and ffmpeg's progress.
 */

/** Largest part the build writes (Cloudflare Pages refuses files over 25 MiB). */
export const PART_LIMIT = 20 * 1024 * 1024;

/** Byte ranges `[start, end)` that cut `size` bytes into parts of at most `max`. */
export function planParts(size: number, max = PART_LIMIT): Array<{ start: number; end: number }> {
  if (!(max > 0)) throw new Error('part size must be positive');
  const out: Array<{ start: number; end: number }> = [];
  for (let start = 0; start < size; start += max) out.push({ start, end: Math.min(size, start + max) });
  return out;
}

/**
 * Joins the downloaded parts in order. A short or long total means a part is
 * missing or stale (a deploy in between): it throws rather than hand ffmpeg a
 * broken module.
 */
export function joinParts(parts: readonly Uint8Array[], expectedSize: number): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  if (total !== expectedSize) throw new Error(`ffmpeg parts add up to ${total} bytes, expected ${expectedSize}`);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

export type ConvertTarget = 'mp4' | 'webm';

/** True when `ffmpeg -encoders` lists `name` (its log lines look like " V....D libx264  …"). */
export function hasEncoder(encodersLog: string, name: string): boolean {
  return new RegExp(`^\\s*[VAS][A-Z.]{5}\\s+${name.replace(/[^\w-]/g, '')}\\s`, 'm').test(encodersLog);
}

/** H.264 MP4 when libx264 is there (plays everywhere), else VP9 WebM. */
export function chooseTarget(encodersLog: string): ConvertTarget {
  return hasEncoder(encodersLog, 'libx264') ? 'mp4' : 'webm';
}

/** Input name inside ffmpeg's memory file system (keeps the extension: it helps the demuxer). */
export function inputName(fileName: string): string {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(fileName)?.[1]?.toLowerCase() ?? 'bin';
  return `input.${ext}`;
}

/** The converted file's name next to the original: "clip.mov" → "clip-h264.mp4". */
export function outputName(fileName: string, target: ConvertTarget): string {
  const base = fileName.replace(/\.[^./]+$/, '') || 'video';
  return target === 'mp4' ? `${base}-h264.mp4` : `${base}-vp9.webm`;
}

/** The ffmpeg arguments for one conversion. Every stream is re-encoded; sound is kept when there is any. */
export function ffmpegArgs(input: string, target: ConvertTarget): string[] {
  const common = ['-hide_banner', '-nostdin', '-y', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn'];
  if (target === 'mp4') {
    return [...common,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      // Odd sizes are refused by yuv420p H.264: round down to even.
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', 'output.mp4'];
  }
  return [...common,
    '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-b:v', '0', '-crf', '33',
    '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', '128k', 'output.webm'];
}

/** `out_time`/`time=` in ffmpeg logs, as seconds (null when the line has none). */
export function logTime(line: string): number | null {
  const m = /time=\s*(-?)(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(line);
  if (!m || m[1] === '-') return null;
  return Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

/** `Duration: 00:01:02.50` in ffmpeg's input summary, as seconds. */
export function logDuration(line: string): number | null {
  const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(line);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

/** A progress fraction in [0, 1] from the processed and total seconds (0 when unknown). */
export function progressOf(done: number | null, total: number | null): number {
  if (done === null || !total || !(total > 0)) return 0;
  return Math.min(1, Math.max(0, done / total));
}

/** ffmpeg.wasm runs in 32-bit memory: input + output must fit in it. */
export const CONVERT_LIMIT = 1024 * 1024 * 1024;

/**
 * How long the converter may take to answer after its wasm has been downloaded (~31 MB, already
 * reported as its own progress phase) before the app stops waiting and says so.
 *
 * The guard exists because of a silent hang seen in the wild: `@ffmpeg/ffmpeg` creates its
 * worker as a module worker and registers NO `onerror` handler on it (`dist/esm/classes.js`), so
 * a worker that fails to load leaves `load()` pending — forever, with no rejection and no log.
 * A dev server that will not serve the worker file (a Vite fs allow-list, a proxy, a blocked
 * CDN) is exactly such a case: the dialog sat at «downloading the converter… 100%» with nothing
 * to click. The timeout turns that into a plain message and a working retry.
 */
export const CONVERT_START_TIMEOUT_MS = 20_000;

/** The converter never answered: its worker did not boot (see CONVERT_START_TIMEOUT_MS). */
export class ConvertTimeout extends Error {
  constructor() {
    super('converter did not start');
    this.name = 'ConvertTimeout';
  }
}

/**
 * Resolves with `work`, or rejects with `ConvertTimeout` once `ms` has passed.
 *
 * The work itself is left alone (the caller terminates ffmpeg in its own `finally`): this only
 * decides how long the user is kept waiting in silence. A late settlement is ignored, because a
 * rejection nobody listens to is how a hang turns into an unhandled rejection.
 */
export function withTimeout<T>(work: Promise<T>, ms: number = CONVERT_START_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new ConvertTimeout());
    }, ms);
    work.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
