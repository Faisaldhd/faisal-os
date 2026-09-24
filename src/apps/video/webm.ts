/**
 * WebM duration repair — pure, no DOM.
 *
 * `MediaRecorder` writes WebM as a live stream: the Segment has an "unknown"
 * size and the Info element carries no Duration. Players then report the length
 * as Infinity, cannot show a seek bar, and the Files/Viewer apps show no length.
 * This writes the real Duration into the Info element so the exported file
 * behaves like any other video.
 *
 * It only ever edits a file it fully understands. When a Duration already
 * exists its value is overwritten in place (same byte length). When one must be
 * inserted, the insertion is done only if nothing in the file points at byte
 * offsets after it — no SeekHead and a Segment of unknown size, which is exactly
 * what browsers produce. Anything else is returned unchanged: an unpatched file
 * that plays is better than a patched one that does not.
 */

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_SEEKHEAD = 0x114d9b74;
const ID_CLUSTER = 0x1f43b675;
const ID_DURATION = 0x4489;
const ID_TIMECODE_SCALE = 0x2ad7b1;

interface Vint {
  value: number;
  length: number;
  /** All value bits set: the "unknown size" marker. */
  unknown: boolean;
}

/** Reads an element ID (marker bits kept), or null past the end. */
function readId(bytes: Uint8Array, pos: number): Vint | null {
  const first = bytes[pos];
  if (first === undefined || first === 0) return null;
  let length = 1;
  while (length <= 4 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 4 || pos + length > bytes.length) return null;
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + bytes[pos + i];
  return { value, length, unknown: false };
}

/** Reads a size vint (marker bit removed). */
function readSize(bytes: Uint8Array, pos: number): Vint | null {
  const first = bytes[pos];
  if (first === undefined || first === 0) return null;
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8 || pos + length > bytes.length) return null;
  let value = first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[pos + i];
    if (bytes[pos + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: allOnes };
}

/** Encodes a size into exactly `length` bytes, or null when it does not fit. */
function encodeSize(value: number, length: number): Uint8Array | null {
  if (length < 1 || length > 8) return null;
  // The all-ones pattern is reserved for "unknown", so the maximum is one less.
  const max = 2 ** (7 * length) - 2;
  if (value < 0 || value > max) return null;
  const out = new Uint8Array(length);
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >> (length - 1);
  return out;
}

function readUint(bytes: Uint8Array, pos: number, size: number): number {
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + bytes[pos + i];
  return v;
}

export interface WebmInfo {
  /** Duration in seconds, or null when the file carries none. */
  duration: number | null;
  timecodeScale: number;
}

interface InfoLocation {
  idPos: number;
  sizePos: number;
  size: Vint;
  dataPos: number;
  timecodeScale: number;
  durationPos: number | null;
  durationSize: number;
  segmentSize: Vint;
  seekHead: boolean;
}

function locateInfo(bytes: Uint8Array): InfoLocation | null {
  const ebml = readId(bytes, 0);
  if (!ebml || ebml.value !== ID_EBML) return null;
  const ebmlSize = readSize(bytes, ebml.length);
  if (!ebmlSize || ebmlSize.unknown) return null;
  let pos = ebml.length + ebmlSize.length + ebmlSize.value;
  const segment = readId(bytes, pos);
  if (!segment || segment.value !== ID_SEGMENT) return null;
  const segmentSize = readSize(bytes, pos + segment.length);
  if (!segmentSize) return null;
  pos += segment.length + segmentSize.length;
  let seekHead = false;
  while (pos < bytes.length) {
    const id = readId(bytes, pos);
    if (!id) return null;
    const size = readSize(bytes, pos + id.length);
    if (!size || size.unknown) return null;
    const dataPos = pos + id.length + size.length;
    if (id.value === ID_SEEKHEAD) seekHead = true;
    if (id.value === ID_CLUSTER) return null; // Info always comes before the media
    if (id.value === ID_INFO) {
      let timecodeScale = 1_000_000;
      let durationPos: number | null = null;
      let durationSize = 0;
      let child = dataPos;
      const end = dataPos + size.value;
      while (child < end) {
        const cid = readId(bytes, child);
        if (!cid) return null;
        const csize = readSize(bytes, child + cid.length);
        if (!csize || csize.unknown) return null;
        const cdata = child + cid.length + csize.length;
        if (cid.value === ID_TIMECODE_SCALE && csize.value <= 8) timecodeScale = readUint(bytes, cdata, csize.value) || 1_000_000;
        if (cid.value === ID_DURATION) {
          durationPos = cdata;
          durationSize = csize.value;
        }
        child = cdata + csize.value;
      }
      return { idPos: pos, sizePos: pos + id.length, size, dataPos, timecodeScale, durationPos, durationSize, segmentSize, seekHead };
    }
    pos = dataPos + size.value;
  }
  return null;
}

/** What the file says about its own length. */
export function readWebmInfo(bytes: Uint8Array): WebmInfo | null {
  const info = locateInfo(bytes);
  if (!info) return null;
  let duration: number | null = null;
  if (info.durationPos !== null) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + info.durationPos, info.durationSize);
    const raw = info.durationSize === 4 ? view.getFloat32(0) : info.durationSize === 8 ? view.getFloat64(0) : NaN;
    if (Number.isFinite(raw)) duration = (raw * info.timecodeScale) / 1e9;
  }
  return { duration, timecodeScale: info.timecodeScale };
}

/**
 * Returns a copy of `bytes` whose Info carries `seconds` as its Duration, or the
 * original array unchanged when the file cannot be patched safely.
 */
export function fixWebmDuration(bytes: Uint8Array, seconds: number): Uint8Array {
  if (!(seconds > 0) || !Number.isFinite(seconds)) return bytes;
  const info = locateInfo(bytes);
  if (!info) return bytes;
  const value = (seconds * 1e9) / info.timecodeScale;
  if (info.durationPos !== null) {
    if (info.durationSize !== 4 && info.durationSize !== 8) return bytes;
    const out = bytes.slice();
    const view = new DataView(out.buffer, out.byteOffset + info.durationPos, info.durationSize);
    if (info.durationSize === 8) view.setFloat64(0, value);
    else view.setFloat32(0, value);
    return out;
  }
  // Inserting moves every later byte: only safe when nothing refers to offsets.
  if (info.seekHead || !info.segmentSize.unknown) return bytes;
  const element = new Uint8Array(11);
  element[0] = 0x44;
  element[1] = 0x89;
  element[2] = 0x88; // size 8
  new DataView(element.buffer).setFloat64(3, value);
  const newSize = encodeSize(info.size.value + element.length, info.size.length) ?? encodeSize(info.size.value + element.length, 8);
  if (!newSize) return bytes;
  const infoEnd = info.dataPos + info.size.value;
  const out = new Uint8Array(bytes.length - info.size.length + newSize.length + element.length);
  let o = 0;
  out.set(bytes.subarray(0, info.sizePos), o);
  o += info.sizePos;
  out.set(newSize, o);
  o += newSize.length;
  out.set(bytes.subarray(info.dataPos, infoEnd), o);
  o += infoEnd - info.dataPos;
  out.set(element, o);
  o += element.length;
  out.set(bytes.subarray(infoEnd), o);
  return out;
}

/* Exported for the tests, which build tiny WebM files by hand. */
export const __testing = { encodeSize, readSize, readId };
