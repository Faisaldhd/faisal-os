/**
 * Photo Editor — HEIC decode worker. Decoding a 12 MP HEVC still takes a second or two, so it
 * runs here instead of freezing the window. Requests: { id, bytes, maxPixels }.
 */
import { decodeWithLib, HeicError } from './heic-core';
import { loadLibheif } from './heic-lib';

interface Req { id: number; bytes: Uint8Array; maxPixels: number }

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<Req>) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

scope.onmessage = async (e) => {
  const { id, bytes, maxPixels } = e.data;
  try {
    const lib = await loadLibheif();
    const out = await decodeWithLib(lib, bytes, maxPixels);
    const { width, height, data } = out.buffer;
    scope.postMessage({ id, ok: true, width, height, data, note: out.note, images: out.images }, [data.buffer]);
  } catch (err) {
    const reason = err instanceof HeicError ? err.reason : 'failed';
    scope.postMessage({ id, ok: false, reason, detail: err instanceof Error ? err.message : String(err) });
  }
};
