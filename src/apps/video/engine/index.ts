/**
 * Video Studio rendering & export engine — public API.
 *
 * Model: the lead's `../project.ts` (no second model). Port: `../engine-port.ts`.
 *
 *  • `CanvasStudioEngine` — implements `StudioEngine` (preview, scrub, export,
 *    WAV export, PNG capture, on-canvas boxes).
 *  • `composeFrame` — draws any project frame on any 2D context (same code for
 *    preview and export).
 *  • `exportSettings` / `chooseMime` — the MP4-or-WebM decision from
 *    `MediaRecorder.isTypeSupported`, plus size, fps and bitrates.
 *  • `filmstrip`, `waveformOf`, `minMaxPeaks` — timeline thumbnails and waveforms.
 */
export { CanvasStudioEngine } from './engine';
export { composeFrame, supportsFilter, type ComposeOptions, type ComposeReport, type FrameProvider, type FrameImage } from './compositor';
export { chooseMime, exportSettings, exportRange, filmstrip, filmstripTimes, recordProject, MP4_CANDIDATES, WEBM_CANDIDATES, type ContainerChoice, type MimeChoice } from './exporter';
export { LiveMixer, renderMixOffline, decodeBytes, decodeUrl, waveformOf, minMaxPeaks, mixDown, gainEnvelope } from './audio-mix';
export { layerPlan, textPlan, textFont, safeAreas, quantize, frameCount, viewFor, toCanvas } from './layout';
export { TimelineRenderer } from './player';
export { MediaPool, seekAccurate } from './media-pool';
