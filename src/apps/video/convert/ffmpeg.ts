/**
 * Converting a video the browser cannot decode, with ffmpeg.wasm (single
 * thread) served from our own origin. Everything here is loaded only when the
 * owner presses "Convert": this module is imported dynamically, and it fetches
 * the ~31 MB core in parts (see build/ffmpeg-core.ts) and joins them.
 *
 * Cancel terminates ffmpeg's worker at once; nothing is returned, so nothing is written.
 */
import core from 'virtual:ffmpeg-core';
import { chooseTarget, ffmpegArgs, inputName, joinParts, logDuration, logTime, outputName, progressOf, type ConvertTarget } from './plan';

export class ConvertCancelled extends Error {
  constructor() {
    super('conversion cancelled');
    this.name = 'ConvertCancelled';
  }
}

export interface ConvertProgress {
  phase: 'download' | 'convert';
  /** 0–1 within the phase. */
  fraction: number;
}

export interface ConvertResult {
  bytes: Uint8Array;
  name: string;
  target: ConvertTarget;
  mime: string;
}

const abs = (path: string) => new URL(path, document.baseURI).href;

/** Downloads the wasm parts (progress by bytes) and joins them into a Blob URL. */
async function wasmUrl(signal: AbortSignal, onProgress: (f: number) => void): Promise<string> {
  let got = 0;
  const parts = await Promise.all(core.parts.map(async (part) => {
    const res = await fetch(abs(part), { signal });
    if (!res.ok || !res.body) throw new Error(`ffmpeg part ${part}: HTTP ${res.status}`);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
      got += value.byteLength;
      onProgress(Math.min(1, got / core.size));
    }
    return joinParts(chunks, size);
  }));
  const wasm = joinParts(parts, core.size);
  return URL.createObjectURL(new Blob([wasm as BlobPart], { type: 'application/wasm' }));
}

export async function convertVideo(file: Blob, fileName: string, signal: AbortSignal, onProgress: (p: ConvertProgress) => void): Promise<ConvertResult> {
  if (signal.aborted) throw new ConvertCancelled();
  const [{ FFmpeg }, { fetchFile }] = await Promise.all([import('@ffmpeg/ffmpeg'), import('@ffmpeg/util')]);
  const ffmpeg = new FFmpeg();
  let wasmURL = '';
  const onAbort = () => ffmpeg.terminate();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    wasmURL = await wasmUrl(signal, (f) => onProgress({ phase: 'download', fraction: f }));
    if (signal.aborted) throw new ConvertCancelled();
    await ffmpeg.load({ coreURL: abs(core.core), wasmURL });
    onProgress({ phase: 'convert', fraction: 0 });

    let log = '';
    let total: number | null = null;
    ffmpeg.on('log', ({ message }) => {
      log += `${message}\n`;
      total ??= logDuration(message);
      const done = logTime(message);
      if (done !== null) onProgress({ phase: 'convert', fraction: progressOf(done, total) });
    });
    await ffmpeg.exec(['-hide_banner', '-encoders']);
    const target = chooseTarget(log);
    log = '';
    const input = inputName(fileName);
    await ffmpeg.writeFile(input, await fetchFile(file));
    const code = await ffmpeg.exec(ffmpegArgs(input, target));
    if (signal.aborted) throw new ConvertCancelled();
    if (code !== 0) {
      const last = log.trim().split('\n').filter((l) => /error|invalid|unsupported|not /i.test(l)).pop();
      throw new Error(last ? last.slice(0, 200) : `ffmpeg exit ${code}`);
    }
    const out = await ffmpeg.readFile(target === 'mp4' ? 'output.mp4' : 'output.webm');
    if (!(out instanceof Uint8Array) || out.byteLength === 0) throw new Error('ffmpeg wrote an empty file');
    onProgress({ phase: 'convert', fraction: 1 });
    return { bytes: out, name: outputName(fileName, target), target, mime: target === 'mp4' ? 'video/mp4' : 'video/webm' };
  } catch (err) {
    if (signal.aborted || err instanceof ConvertCancelled) throw new ConvertCancelled();
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    signal.removeEventListener('abort', onAbort);
    try { ffmpeg.terminate(); } catch { /* already gone */ }
    if (wasmURL) URL.revokeObjectURL(wasmURL);
  }
}
