/**
 * The one interface the Video Studio UI uses to play, draw and export a project.
 *
 * The UI never touches media elements, the canvas context or MediaRecorder
 * directly: it goes through `StudioEngine`. Today `preview-adapter.ts` implements
 * it; the dedicated engine (`./engine/`) can replace that implementation behind
 * this same interface without any UI change.
 *
 * Both preview and export draw with the same code from the same model
 * (`project.ts` resolvers), which is what makes the preview match the export.
 */
import type { MediaType, Project } from './project';
import type { Rect } from './render-math';

/** What the engine needs to know about one media file. */
export interface EngineMedia {
  id: string;
  type: MediaType;
  /** Object URL of the file; '' when the media is offline. */
  url: string;
  width: number;
  height: number;
  duration: number;
  hasAudio: boolean;
  image: HTMLImageElement | null;
  peaks: Float32Array | null;
  /** Raw bytes for the offline (WAV) audio render; null when not kept. */
  bytes: Uint8Array | null;
}

export interface EngineLabels {
  /** Drawn on a layer whose media is missing. */
  offline: string;
}

export interface VideoExportOptions {
  width: number;
  height: number;
  fps: number;
  /** A MIME type `MediaRecorder.isTypeSupported` accepted. */
  mime: string;
  videoBitrate: number;
  audioBitrate: number;
  /** Timeline range to export; the whole project when omitted. */
  range?: { start: number; end: number };
  signal: AbortSignal;
  onProgress(fraction: number, elapsedSeconds: number): void;
}

export interface VideoExportResult {
  blob: Blob;
  mime: string;
  /** Seconds of timeline recorded. */
  duration: number;
  frames: number;
}

export interface AudioExportOptions {
  range?: { start: number; end: number };
  signal: AbortSignal;
  onProgress(fraction: number): void;
}

export interface EngineBox {
  id: string;
  kind: 'text' | 'overlay';
  /** In canvas pixels. */
  rect: Rect;
}

export interface StudioEngine {
  /** Replaces the model and redraws. `frame` is the composition size. */
  setProject(project: Project, frame: { width: number; height: number }): void;
  setMedia(lookup: (id: string) => EngineMedia | undefined): void;
  /** Canvas resolution used for the preview (the composition is scaled into it). */
  setPreviewSize(width: number, height: number): void;
  readonly canvas: HTMLCanvasElement;
  readonly time: number;
  readonly playing: boolean;
  readonly duration: number;
  readonly exporting: boolean;
  play(): Promise<void>;
  pause(): void;
  /** Moves the playhead; the frame appears as soon as the element has seeked. */
  seek(time: number): void;
  /** Global playback rate (the player's 0.5×–2×; the editor's J/K/L shuttle). */
  setRate(rate: number): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  /** Plays `[start, end)` over and over, or the whole film with null. */
  setLoop(range: { start: number; end: number } | null, enabled: boolean): void;
  /** Stops at `end` instead of the end of the film (player trim preview), or null. */
  setStopAt(end: number | null): void;
  onTick(cb: (time: number) => void): () => void;
  onState(cb: () => void): () => void;
  /** Rectangles of titles and overlays drawn in the current frame (for direct manipulation). */
  boxes(): EngineBox[];
  exportVideo(options: VideoExportOptions): Promise<VideoExportResult>;
  exportAudio(options: AudioExportOptions): Promise<Blob>;
  /** The current frame at `size`, as PNG. */
  captureFrame(size: { width: number; height: number }): Promise<Blob>;
  dispose(): void;
}

/** Thrown when an export is cancelled; the caller writes nothing and says so. */
export class ExportCancelled extends Error {
  constructor() {
    super('export cancelled');
    this.name = 'ExportCancelled';
  }
}
