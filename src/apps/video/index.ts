/**
 * Video Studio (استوديو الفيديو) — a real editor, not a preview.
 *
 * WHAT THIS IS
 *  • A player for anything this browser can genuinely decode, with a seekable
 *    timeline, frame stepping, volume, rate and fullscreen.
 *  • An editor: trim (in/out), split, an ordered clip list that *is* the edit,
 *    rotate/flip, crop, audio gain and fades, and frame capture to PNG.
 *  • An exporter: the clips are played in order while the canvas and the audio
 *    graph are recorded, and the result is written into the VFS.
 *
 * WHAT IT REFUSES TO DO
 *  • Pretend a format plays. Every answer comes from the browser
 *    (`canPlayType`, `MediaSource.isTypeSupported`) at open time, the refusal names
 *    the exact extension, and `.mkv`/`.avi` are never advertised as supported.
 *  • Claim frame-accurate cuts it cannot prove: precision is reported as measured —
 *    frame-accurate only when `requestVideoFrameCallback` exists, otherwise it says
 *    plainly that the cut is keyframe-limited.
 *  • Invent a file. An export that fails, is cancelled, or is refused by the storage
 *    limits saves nothing and says so.
 *
 * Every visible string lives in ./strings.ts in both languages. All DOM text goes
 * through textContent; no file or user content is ever parsed as HTML.
 */
import { manifest } from './manifest';
import type { AppContext, AppModule } from '../../kernel/types';
import { basename, dirname } from '../../kernel/path';
import { t } from '../../kernel/i18n';
import { formatBytes } from '../files/format';
import { extensionOf } from '../viewer/formats';
import './strings';
import './video.css';

import { clampTime, formatTime, wholeRange, type TimeRange } from './time';
import {
  capabilityTable,
  formatForPath,
  preferredExportMime,
  recorderMimeCandidates,
  refusalFor,
  type CapabilityProbe,
  type CapabilityRow,
  type MediaFormat,
} from './capabilities';
import {
  clampCrop,
  clipFromRange,
  clipIndexAt,
  describeTransform,
  moveClip,
  outputSize,
  removeClip,
  resetTransform,
  rotateBy,
  setCropField,
  splitClipAt,
  toggleFlip,
  totalDuration,
  type Clip,
  type CropRect,
  type VideoTransform,
} from './clips';
import { clampFades, gainDecibels, type FadeConfig } from './fades';
import {
  baseNameWithoutExtension,
  checkQuota,
  exportName,
  extensionForExport,
  planExport,
  planName,
  VFS_FILE_LIMIT,
  type ExportEngine,
  type ExportEnv,
} from './export';
import { ExportCancelled, VideoPipeline, mediaErrorReason } from './pipeline';

/** PNG captures are written straight to the VFS, which caps one file at this size. */
const CAPTURE_LIMIT = VFS_FILE_LIMIT;
const VIDEO_BITRATE = 4_000_000;
const AUDIO_BITRATE = 128_000;
const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const FULL_CROP: CropRect = { x: 0, y: 0, width: 1, height: 1 };

/* ───────────────────────────── small DOM helpers ───────────────────────────── */

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, cls = 'faisal-video-btn'): HTMLButtonElement {
  const b = el('button', cls, label);
  b.type = 'button';
  return b;
}

/** A label wrapped around its control: no `id` juggling, and the tap target is the row. */
function field(labelText: string, control: HTMLElement): HTMLElement {
  const wrap = el('label', 'faisal-video-field');
  wrap.append(el('span', 'faisal-video-fieldlabel', labelText), control);
  return wrap;
}

function numberInput(id: string, value: number, min: number, max: number, step: number): HTMLInputElement {
  const input = el('input', 'faisal-video-input');
  input.type = 'number';
  input.id = id;
  input.value = String(value);
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.inputMode = 'decimal';
  return input;
}

/** Builds a trusted, literal SVG path from this file — never user or file content. */
function iconSvg(path: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  node.setAttribute('d', path);
  node.setAttribute('fill', 'currentColor');
  svg.append(node);
  return svg;
}

function iconButton(label: string, path: string): HTMLButtonElement {
  const b = el('button', 'faisal-video-iconbtn');
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.append(iconSvg(path));
  return b;
}

const ICON = {
  play: 'M8 5.5v13l11-6.5z',
  pause: 'M8 5.5h3.4v13H8zM12.6 5.5H16v13h-3.4z',
  stop: 'M6.5 6.5h11v11h-11z',
  back: 'M15.5 5.5v13L6 12z',
  forward: 'M8.5 5.5v13L18 12z',
  mute: 'M4 9.5h3l4-3.5v12l-4-3.5H4z',
  sound: 'M4 9.5h3l4-3.5v12l-4-3.5H4zM15 9.5a4 4 0 0 1 0 5',
  expand: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
  shrink: 'M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5',
} as const;

/* ─────────────────────────────── the app ─────────────────────────────── */

interface LoadedSource {
  path: string | null;
  name: string;
  url: string;
  duration: number;
  width: number;
  height: number;
}

function launch(ctx: AppContext): void {
  const { sys, window: win, args } = ctx;
  win.setTitle(t('video.title'));
  win.content.textContent = '';

  /** Every element the sync functions touch, filled in by the builders below. */
  const ui = {
    time: null as HTMLElement | null,
    duration: null as HTMLElement | null,
    precision: null as HTMLElement | null,
    inFill: null as HTMLElement | null,
    inHandle: null as HTMLElement | null,
    outHandle: null as HTMLElement | null,
    progress: null as HTMLElement | null,
    seek: null as HTMLInputElement | null,
    play: null as HTMLButtonElement | null,
    mute: null as HTMLButtonElement | null,
    volume: null as HTMLInputElement | null,
    fullscreen: null as HTMLButtonElement | null,
    caps: null as HTMLElement | null,
    trimInfo: null as HTMLElement | null,
    addSelection: null as HTMLButtonElement | null,
    clips: null as HTMLElement | null,
    clipsTotal: null as HTMLElement | null,
    cropInputs: new Map<keyof CropRect, HTMLInputElement>(),
    transformInfo: null as HTMLElement | null,
    gainLabel: null as HTMLElement | null,
    engine: null as HTMLElement | null,
    captureNote: null as HTMLElement | null,
    format: null as HTMLSelectElement | null,
    exportBtn: null as HTMLButtonElement | null,
    cancelBtn: null as HTMLButtonElement | null,
    progress2: null as HTMLProgressElement | null,
    report: null as HTMLElement | null,
  };

  /* ── state ── */
  const objectUrls: string[] = [];
  let closed = false;
  let source: LoadedSource | null = null;
  let transform: VideoTransform = resetTransform();
  let clips: Clip[] = [];
  let trim: TimeRange = { start: 0, end: 0 };
  let trimActive = false;
  let gain = 1;
  let fades: FadeConfig = { fadeIn: 0, fadeOut: 0 };
  let muted = false;
  let volume = 1;
  let exporting = false;
  let exportAbort: AbortController | null = null;
  /** WebCodecs answers live here, keyed `codec@WxH`; a missing key means "not proven". */
  const encoderSupported = new Map<string, boolean>();

  /* ── layout: built before the pipeline so every element exists first ── */
  const root = el('div', 'faisal-video');
  const bar = el('div', 'faisal-video-bar');
  const badge = el('span', 'faisal-video-badge', t('video.badge'));
  const nameEl = el('span', 'faisal-video-name', t('video.title'));
  const metaEl = el('span', 'faisal-video-meta');
  const statusEl = el('span', 'faisal-video-status');
  statusEl.setAttribute('role', 'status');
  statusEl.setAttribute('aria-live', 'polite');
  const openInput = el('input', 'faisal-video-fileinput');
  openInput.type = 'file';
  openInput.tabIndex = -1;
  openInput.accept = 'video/*,audio/*,.mp4,.webm,.m4v,.mov,.ogv,.mkv,.avi,.mp3,.wav,.ogg,.oga,.m4a,.aac,.flac,.opus';
  openInput.id = 'faisal-video-open';
  const openLabel = el('label', 'faisal-video-btn is-primary', t('video.openFile'));
  openLabel.htmlFor = 'faisal-video-open';
  const barActions = el('div', 'faisal-video-baractions');
  barActions.append(openInput, openLabel);
  bar.append(badge, nameEl, metaEl, statusEl, barActions);

  const body = el('div', 'faisal-video-body');
  const stage = el('div', 'faisal-video-stage');
  const video = el('video', 'faisal-video-media');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  const audioEl = el('video', 'faisal-video-audio');
  audioEl.preload = 'metadata';
  audioEl.tabIndex = -1;
  const canvas = el('canvas', 'faisal-video-canvas');
  const empty = el('div', 'faisal-video-empty');
  stage.append(video, canvas, audioEl, empty);

  const timeline = buildTimeline();
  const transport = buildTransport();
  const panels = el('div', 'faisal-video-panels');
  panels.append(buildCapabilities(), buildEditPanel(), buildClipsPanel(), buildTransformPanel(), buildAudioPanel(), buildExportPanel(), buildLimits());
  body.append(stage, timeline, transport, panels);
  root.append(bar, body);
  win.content.append(root);

  const media = new VideoPipeline({ video, audio: audioEl, canvas });
  const pipe = media;

  function setStatus(text: string): void {
    statusEl.textContent = text;
  }

  /* ───────────────────────────── builders ───────────────────────────── */

  function buildTimeline(): HTMLElement {
    const wrap = el('div', 'faisal-video-timelinebox');
    const head = el('div', 'faisal-video-timelinehead');
    const info = el('span', 'faisal-video-timelineinfo');
    ui.time = el('span', 'faisal-video-mono', '0:00.000');
    ui.duration = el('span', 'faisal-video-mono', '0:00.000');
    info.append(el('span', undefined, `${t('video.currentTime')} `), ui.time,
      el('span', undefined, ` / ${t('video.durationLabel')} `), ui.duration);
    ui.precision = el('span', 'faisal-video-precision');
    head.append(info, ui.precision);

    const track = el('div', 'faisal-video-track');
    // Time always runs left to right, whatever the interface direction is.
    track.dir = 'ltr';
    ui.progress = el('div', 'faisal-video-progress');
    ui.inFill = el('div', 'faisal-video-inout');
    ui.inHandle = el('div', 'faisal-video-handle is-in', 'I');
    ui.inHandle.title = t('video.setIn');
    ui.outHandle = el('div', 'faisal-video-handle is-out', 'O');
    ui.outHandle.title = t('video.setOut');
    ui.inHandle.hidden = true;
    ui.outHandle.hidden = true;
    ui.inFill.hidden = true;
    track.append(ui.progress, ui.inFill, ui.inHandle, ui.outHandle);

    const seek = el('input', 'faisal-video-range');
    seek.type = 'range';
    seek.min = '0';
    seek.max = '0';
    seek.step = '0.001';
    seek.value = '0';
    seek.id = 'faisal-video-seek';
    seek.setAttribute('aria-label', t('video.timeline'));
    seek.addEventListener('input', () => void seekTo(Number(seek.value), true));
    ui.seek = seek;

    wrap.append(head, track, seek);
    // Arrow keys inside the panel must not reach the shell's window shortcuts.
    wrap.addEventListener('keydown', (event) => event.stopPropagation());
    return wrap;
  }

  function buildTransport(): HTMLElement {
    const wrap = el('div', 'faisal-video-transport');
    const play = iconButton(t('video.play'), ICON.play);
    ui.play = play;
    play.addEventListener('click', () => void togglePlay());
    const stop = iconButton(t('video.stop'), ICON.stop);
    stop.addEventListener('click', () => void pipe.stop().then(syncPlayButton));
    const back = iconButton(t('video.stepBack'), ICON.back);
    back.addEventListener('click', () => void pipe.step(-1).then(afterStep));
    const fwd = iconButton(t('video.stepForward'), ICON.forward);
    fwd.addEventListener('click', () => void pipe.step(1).then(afterStep));

    const mute = iconButton(t('video.mute'), ICON.sound);
    ui.mute = mute;
    mute.addEventListener('click', () => {
      muted = !muted;
      pipe.setMuted(muted);
      const label = muted ? t('video.unmute') : t('video.mute');
      mute.title = label;
      mute.setAttribute('aria-label', label);
      mute.replaceChildren(iconSvg(muted ? ICON.mute : ICON.sound));
      if (ui.volume) ui.volume.value = muted ? '0' : String(Math.round(volume * 100));
    });

    const vol = el('input', 'faisal-video-range is-volume');
    vol.type = 'range';
    vol.min = '0';
    vol.max = '100';
    vol.step = '1';
    vol.value = '100';
    vol.id = 'faisal-video-volume';
    vol.setAttribute('aria-label', t('video.volume'));
    vol.addEventListener('input', () => {
      volume = Number(vol.value) / 100;
      muted = volume === 0;
      pipe.setVolume(volume);
      pipe.setMuted(muted);
    });
    ui.volume = vol;

    const rateSelect = el('select', 'faisal-video-select');
    rateSelect.id = 'faisal-video-rate';
    rateSelect.setAttribute('aria-label', t('video.rate'));
    for (const value of RATES) {
      const option = el('option', undefined, `${value}×`);
      option.value = String(value);
      if (value === 1) option.selected = true;
      rateSelect.append(option);
    }
    rateSelect.addEventListener('change', () => pipe.setRate(Number(rateSelect.value)));

    const full = iconButton(t('video.fullscreen'), ICON.expand);
    ui.fullscreen = full;
    full.addEventListener('click', () => void toggleFullscreen());

    wrap.append(play, stop, back, fwd, mute, vol, rateSelect, full);
    return wrap;
  }

  function panel(titleText: string): { box: HTMLElement; inner: HTMLElement } {
    const box = el('section', 'faisal-video-panel');
    const inner = el('div', 'faisal-video-panelbody');
    box.append(el('h2', 'faisal-video-h2', titleText), inner);
    return { box, inner };
  }

  function buildCapabilities(): HTMLElement {
    const { box, inner } = panel(t('video.capsTitle'));
    inner.append(el('p', 'faisal-video-note', t('video.capsIntro')));
    const holder = el('div', 'faisal-video-caphost');
    holder.id = 'faisal-video-captable';
    holder.hidden = true;
    const toggleBtn = button(t('video.capsShow'), 'faisal-video-toggle');
    toggleBtn.setAttribute('aria-expanded', 'false');
    toggleBtn.setAttribute('aria-controls', 'faisal-video-captable');
    toggleBtn.addEventListener('click', () => {
      const wasHidden = holder.hidden;
      holder.hidden = !wasHidden;
      toggleBtn.textContent = wasHidden ? t('video.capsHide') : t('video.capsShow');
      toggleBtn.setAttribute('aria-expanded', String(wasHidden));
    });
    ui.caps = holder;
    inner.append(toggleBtn, holder);
    return box;
  }

  function buildEditPanel(): HTMLElement {
    const { box, inner } = panel(t('video.editTitle'));
    const row = el('div', 'faisal-video-row');
    const inBtn = button(t('video.setIn'));
    inBtn.addEventListener('click', () => {
      trim = { start: clampTime(pipe.currentTime, pipe.duration), end: trim.end };
      if (trim.end < trim.start) trim.end = trim.start;
      trimActive = true;
      syncTrim();
    });
    const outBtn = button(t('video.setOut'));
    outBtn.addEventListener('click', () => {
      trim = { start: trim.start, end: clampTime(pipe.currentTime, pipe.duration) };
      if (trim.end < trim.start) trim.start = trim.end;
      trimActive = true;
      syncTrim();
    });
    const clearBtn = button(t('video.clearTrim'));
    clearBtn.addEventListener('click', () => {
      trim = wholeRange(pipe.duration);
      trimActive = false;
      syncTrim();
    });
    const splitBtn = button(t('video.split'));
    splitBtn.addEventListener('click', () => {
      const at = pipe.currentTime;
      const index = clipIndexAt(clips, at);
      if (index >= 0) {
        clips = splitClipAt(clips, index, at);
      } else if (trimActive) {
        const parts: TimeRange[] = [
          { start: trim.start, end: at },
          { start: at, end: trim.end },
        ].filter((range) => range.end > range.start);
        clips = [...clips, ...parts.map((range) => clipFromRange(sourcePath(), range))];
      }
      syncClips();
    });
    row.append(inBtn, outBtn, clearBtn, splitBtn);

    ui.trimInfo = el('div', 'faisal-video-info');
    const selection = button(t('video.addSelection'), 'faisal-video-btn is-primary');
    ui.addSelection = selection;
    selection.addEventListener('click', () => {
      const range = currentTrimRange();
      if (range.end <= range.start) return;
      clips = [...clips, clipFromRange(sourcePath(), range)];
      trimActive = false;
      syncTrim();
      syncClips();
      setStatus(t('video.addedToClips'));
    });
    const whole = button(t('video.addWhole'));
    whole.addEventListener('click', () => {
      const duration = pipe.duration;
      if (duration <= 0) return;
      clips = [...clips, clipFromRange(sourcePath(), wholeRange(duration))];
      syncClips();
    });
    const actions = el('div', 'faisal-video-row');
    actions.append(selection, whole);
    inner.append(row, ui.trimInfo, actions);
    return box;
  }

  function buildClipsPanel(): HTMLElement {
    const { box, inner } = panel(t('video.clipsTitle'));
    ui.clips = el('div', 'faisal-video-cliplist');
    ui.clipsTotal = el('div', 'faisal-video-info');
    const clearAll = button(t('video.clearClips'));
    clearAll.addEventListener('click', () => {
      clips = [];
      syncClips();
    });
    inner.append(ui.clips, ui.clipsTotal, clearAll);
    return box;
  }

  function buildTransformPanel(): HTMLElement {
    const { box, inner } = panel(t('video.transformTitle'));
    const row = el('div', 'faisal-video-row');
    const rotateLeft = button(t('video.rotateLeft'));
    rotateLeft.addEventListener('click', () => applyTransform({ ...transform, rotation: rotateBy(transform.rotation, 270) }));
    const rotateRight = button(t('video.rotateRight'));
    rotateRight.addEventListener('click', () => applyTransform({ ...transform, rotation: rotateBy(transform.rotation, 90) }));
    const rotateHalf = button(t('video.rotate180'));
    rotateHalf.addEventListener('click', () => applyTransform({ ...transform, rotation: rotateBy(transform.rotation, 180) }));

    const flipH = el('button', 'faisal-video-toggle', t('video.flipH'));
    flipH.type = 'button';
    flipH.setAttribute('aria-pressed', 'false');
    flipH.addEventListener('click', () => {
      const next = { ...transform, flip: toggleFlip(transform.flip, 'horizontal') };
      flipH.setAttribute('aria-pressed', String(next.flip.horizontal));
      applyTransform(next);
    });
    const flipV = el('button', 'faisal-video-toggle', t('video.flipV'));
    flipV.type = 'button';
    flipV.setAttribute('aria-pressed', 'false');
    flipV.addEventListener('click', () => {
      const next = { ...transform, flip: toggleFlip(transform.flip, 'vertical') };
      flipV.setAttribute('aria-pressed', String(next.flip.vertical));
      applyTransform(next);
    });
    const resetBtn = button(t('video.resetTransform'));
    resetBtn.addEventListener('click', () => {
      flipH.setAttribute('aria-pressed', 'false');
      flipV.setAttribute('aria-pressed', 'false');
      for (const [key, input] of ui.cropInputs) input.value = String(FULL_CROP[key] * 100);
      applyTransform(resetTransform());
    });
    row.append(rotateLeft, rotateRight, rotateHalf, flipH, flipV, resetBtn);

    const cropGrid = el('div', 'faisal-video-cropgrid');
    const cropFields: Array<[keyof CropRect, string]> = [
      ['x', t('video.cropX')],
      ['y', t('video.cropY')],
      ['width', t('video.cropW')],
      ['height', t('video.cropH')],
    ];
    for (const [key, label] of cropFields) {
      const input = numberInput(`faisal-video-crop-${key}`, FULL_CROP[key] * 100, 0, 100, 1);
      input.addEventListener('input', () => {
        const percent = Number(input.value);
        if (!Number.isFinite(percent)) return;
        applyTransform({ ...transform, crop: setCropField(transform.crop, key, percent / 100) });
      });
      ui.cropInputs.set(key, input);
      cropGrid.append(field(label, input));
    }
    const cropReset = button(t('video.cropReset'));
    cropReset.addEventListener('click', () => {
      for (const [key, input] of ui.cropInputs) input.value = String(FULL_CROP[key] * 100);
      applyTransform({ ...transform, crop: { ...FULL_CROP } });
    });
    ui.transformInfo = el('div', 'faisal-video-info');
    inner.append(row, el('div', 'faisal-video-subtitle', t('video.cropTitle')), cropGrid, cropReset, ui.transformInfo);
    return box;
  }

  function buildAudioPanel(): HTMLElement {
    const { box, inner } = panel(t('video.audioTitle'));
    const gainInput = numberInput('faisal-video-gain', 1, 0, 4, 0.05);
    ui.gainLabel = el('span', 'faisal-video-mono', t('video.gainValue', { x: '1.00' }));
    gainInput.addEventListener('input', () => {
      const value = Number(gainInput.value);
      gain = Number.isFinite(value) ? Math.min(4, Math.max(0, value)) : 1;
      ui.gainLabel!.textContent = `${t('video.gainValue', { x: gain.toFixed(2) })} (${gainDecibels(gain).toFixed(1)} dB)`;
    });
    const fadeIn = numberInput('faisal-video-fadein', 0, 0, 600, 0.1);
    fadeIn.addEventListener('input', () => {
      const value = Number(fadeIn.value);
      fades = clampFades({ ...fades, fadeIn: Number.isFinite(value) ? value : 0 }, fadeSpan());
    });
    const fadeOut = numberInput('faisal-video-fadeout', 0, 0, 600, 0.1);
    fadeOut.addEventListener('input', () => {
      const value = Number(fadeOut.value);
      fades = clampFades({ ...fades, fadeOut: Number.isFinite(value) ? value : 0 }, fadeSpan());
    });
    const grid = el('div', 'faisal-video-cropgrid');
    grid.append(
      field(t('video.gain'), gainInput),
      field(t('video.fadeIn'), fadeIn),
      field(t('video.fadeOut'), fadeOut),
    );
    inner.append(grid, ui.gainLabel, el('p', 'faisal-video-note', t('video.fadesInfo')));
    return box;
  }

  function buildExportPanel(): HTMLElement {
    const { box, inner } = panel(t('video.exportTitle'));
    ui.engine = el('div', 'faisal-video-info');
    const captureRow = el('div', 'faisal-video-row');
    const captureBtn = button(t('video.captureFrame'));
    captureBtn.addEventListener('click', () => void captureFrame());
    captureRow.append(captureBtn);
    ui.captureNote = el('div', 'faisal-video-info');

    const formatSelect = el('select', 'faisal-video-select');
    formatSelect.id = 'faisal-video-format';
    formatSelect.setAttribute('aria-label', t('video.exportFormat'));
    formatSelect.addEventListener('change', () => {
      // A different container means a different codec: the cached encoder answers
      // were about the previous one and must not be reused.
      encoderSupported.clear();
      applyTransform(transform);
    });
    ui.format = formatSelect;
    const formatRow = el('div', 'faisal-video-row');
    formatRow.append(field(t('video.exportFormat'), formatSelect));

    const exportBtn = button(t('video.exportButton'), 'faisal-video-btn is-primary');
    ui.exportBtn = exportBtn;
    exportBtn.addEventListener('click', () => void startExport());
    const cancelBtn = button(t('video.exportCancel'));
    ui.cancelBtn = cancelBtn;
    cancelBtn.hidden = true;
    cancelBtn.addEventListener('click', () => exportAbort?.abort());
    const actions = el('div', 'faisal-video-row');
    actions.append(exportBtn, cancelBtn);

    const progress = el('progress', 'faisal-video-progress2');
    progress.max = 1000;
    progress.value = 0;
    progress.hidden = true;
    ui.progress2 = progress;
    ui.report = el('div', 'faisal-video-info');

    inner.append(ui.engine, captureRow, ui.captureNote, formatRow, actions, progress, ui.report,
      el('p', 'faisal-video-note', t('video.aboutBody')));
    return box;
  }

  function buildLimits(): HTMLElement {
    const { box, inner } = panel(t('video.limitsTitle'));
    const list = el('ul', 'faisal-video-limits');
    for (const key of ['limitNoEffects', 'limitReencode', 'limitNo4k', 'limitRealtime', 'limitQuota', 'limitAudio', 'limitBrowser']) {
      list.append(el('li', undefined, t(`video.${key}`)));
    }
    inner.append(list);
    return box;
  }

  /* ───────────────────────── capabilities (asked, not assumed) ───────────────────────── */

  function probe(): CapabilityProbe {
    const mediaSource = (window as unknown as { MediaSource?: typeof MediaSource }).MediaSource;
    const encoder = (window as unknown as { VideoEncoder?: typeof VideoEncoder }).VideoEncoder;
    return {
      canPlayType: (mime: string) => {
        try {
          // The method is called on the element it was created from: detaching it
          // first (as a bare function reference) throws "Illegal invocation".
          const element = document.createElement(mime.startsWith('audio/') ? 'audio' : 'video');
          return element.canPlayType(mime);
        } catch {
          return '';
        }
      },
      isTypeSupported: typeof mediaSource?.isTypeSupported === 'function'
        ? (mime: string) => {
          try { return mediaSource.isTypeSupported(mime); } catch { return false; }
        }
        : undefined,
      isEncoderSupported: typeof encoder?.isConfigSupported === 'function'
        ? (config: { codec: string; width: number; height: number }) =>
          encoderSupported.get(`${config.codec}@${config.width}x${config.height}`) === true
        : undefined,    };
  }

  function envFor(hasAudio: boolean): ExportEnv {
    const scope = window as unknown as {
      VideoEncoder?: unknown; AudioEncoder?: unknown; AudioData?: unknown;
      MediaStreamTrackGenerator?: unknown; MediaStreamTrackProcessor?: unknown;
      MediaRecorder?: typeof MediaRecorder;
    };
    const recorder = scope.MediaRecorder;
    return {
      webcodecs: {
        videoEncoder: typeof scope.VideoEncoder === 'function',
        audioEncoder: typeof scope.AudioEncoder === 'function',
        trackGenerator: typeof scope.MediaStreamTrackGenerator === 'function',
        audioData: typeof scope.AudioData === 'function',
        trackProcessor: typeof scope.MediaStreamTrackProcessor === 'function',
      },
      mediaRecorder: typeof recorder === 'function',
      recorderSupports: typeof recorder?.isTypeSupported === 'function'
        ? (mime: string) => recorder.isTypeSupported(mime)
        : undefined,
      hasAudio,
    };
  }

  /**
   * Asks the browser whether it can really encode the output we are about to
   * produce. Several sizes are probed because the answer is per configuration:
   * the export size changes with every crop and rotation, and a size that was
   * never probed must not be reported as supported.
   */
  async function probeEncoders(width: number, height: number, hasAudio: boolean): Promise<void> {
    const scope = window as unknown as { VideoEncoder?: typeof VideoEncoder; AudioEncoder?: typeof AudioEncoder };
    const codec = webCodecsVideoCodec();
    const sizes = [...new Set([`${width}x${height}`, '1280x720', '640x360'])];
    if (typeof scope.VideoEncoder?.isConfigSupported === 'function') {
      // A configuration already asked about is not asked twice: this runs on every
      // crop and rotation, and each call is an async round trip to the encoder.
      for (const size of sizes) {
        const key = `${codec}@${size}`;
        if (encoderSupported.has(key)) continue;
        const [w, h] = size.split('x').map(Number);
        try {
          const answer = await scope.VideoEncoder.isConfigSupported({
            codec, width: w, height: h, bitrate: VIDEO_BITRATE, framerate: 30,
          });
          encoderSupported.set(key, answer.supported === true);
        } catch {
          encoderSupported.set(key, false);
        }
      }
    }
    if (hasAudio && typeof scope.AudioEncoder?.isConfigSupported === 'function') {
      try {
        const answer = await scope.AudioEncoder.isConfigSupported({
          codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: AUDIO_BITRATE,
        });
        encoderSupported.set('opus@audio', answer.supported === true);
      } catch {
        encoderSupported.set('opus@audio', false);
      }
    }
  }

  /** The codec this app will ask WebCodecs for, matching the chosen container. */
  function webCodecsVideoCodec(): string {
    const picked = ui.format?.value ?? preferredExportMime(source ? extensionOf(source.name) : '.mp4');
    return picked.includes('mp4') ? 'avc1.42E01E' : 'vp09.00.10.08';
  }

  function renderCapabilities(): void {
    const holder = ui.caps;
    if (!holder) return;
    const rows = capabilityTable(probe());
    const grouped = new Map<string, CapabilityRow[]>();
    for (const row of rows) {
      const list = grouped.get(row.format.ext) ?? [];
      list.push(row);
      grouped.set(row.format.ext, list);
    }
    const table = el('table', 'faisal-video-table');
    table.dir = 'ltr';
    const head = el('thead');
    const headRow = el('tr');
    for (const label of [t('video.capsElement'), t('video.capsPlayable'), t('video.capsEncode')]) {
      headRow.append(el('th', undefined, label));
    }
    head.append(headRow);
    const tbody = el('tbody');
    for (const [ext, list] of grouped) {
      const best = list.find((row) => row.answer !== 'no');
      const cell = el('td', `faisal-video-cap is-${best ? best.answer : 'no'}`,
        !best ? t('video.capsNo') : best.answer === 'maybe' ? t('video.capsMaybe') : t('video.capsYes'));
      cell.title = best
        ? t('video.viaElement', { mime: best.mime, answer: best.answer })
        : t('video.viaNothing');
      const encodeCell = el('td', 'faisal-video-cap', encodeVerdict(ext, list[0].format));
      encodeCell.title = t('video.capsCheckedVia', { how: 'VideoEncoder.isConfigSupported' });
      const tr = el('tr');
      tr.append(el('td', 'faisal-video-mono', `${ext} — ${list[0].format.label}`), cell, encodeCell);
      tbody.append(tr);
    }
    holder.textContent = '';
    table.append(head, tbody);
    holder.append(table, el('p', 'faisal-video-note', t('video.capsUnsure')));
  }

  function encodeVerdict(ext: string, format: MediaFormat): string {
    const codec = format.kind === 'audio' ? 'opus' : preferredExportMime(ext) === 'video/mp4' ? 'avc1.42E01E' : 'vp09.00.10.08';
    const keys = [...encoderSupported.keys()].filter((key) => key.startsWith(codec));
    if (keys.length === 0) return t('video.capsUnknown');
    return keys.some((key) => encoderSupported.get(key) === true) ? t('video.capsYes') : t('video.capsNo');
  }

  /* ───────────────────────────── opening a file ───────────────────────────── */

  function sourcePath(): string {
    return source?.path ?? source?.name ?? '';
  }

  function mimeForName(name: string): string {
    const format = formatForPath(name);
    return format ? format.mime.split(';')[0].trim() : 'application/octet-stream';
  }

  async function openPath(path: string): Promise<void> {
    try {
      const bytes = await sys.vfs.readFile(path);
      if (closed) return;
      if (bytes.length === 0) {
        showNotice(t('video.emptyFile'));
        return;
      }
      const url = URL.createObjectURL(new Blob([bytes.slice()], { type: mimeForName(path) }));
      objectUrls.push(url);
      await attachSource(path, url);
    } catch {
      if (!closed) showNotice(t('video.readError'));
    }
  }

  async function openPickedFile(file: File): Promise<void> {
    const url = URL.createObjectURL(file);
    objectUrls.push(url);
    await attachSource(null, url, file.name);
  }

  async function attachSource(path: string | null, url: string, pickedName?: string): Promise<void> {
    const name = pickedName ?? (path ? basename(path) : 'file');
    // Capability truth first: say which format is refused, rather than starting a
    // player that cannot work. The user may still insist — the offer is explicit.
    const refusal = refusalFor(probe(), name);
    if (refusal) {
      const proceed = window.confirm(
        `${t('video.refuseTitle', { ext: refusal.ext })}\n\n${t('video.refuseBody')}\n\n${t('video.refuseHint')}\n\n${t('video.openAnyway')}?`,
      );
      if (!proceed) {
        showNotice(t('video.refuseTitle', { ext: refusal.ext }));
        return;
      }
    }
    setStatus(t('video.loadingMedia'));
    try {
      const info = await media.load(url);
      if (closed) return;
      source = { path, name, url, duration: info.duration, width: info.width, height: info.height };
      win.setTitle(`${name} — ${t('video.title')}`);
      nameEl.textContent = name;
      nameEl.title = path ?? name;
      metaEl.textContent = info.width > 0
        ? `${info.width}×${info.height} · ${formatTime(info.duration)}`
        : `${t('video.kindAudio')} · ${formatTime(info.duration)}`;
      trim = wholeRange(info.duration);
      trimActive = false;
      clips = [];
      transform = resetTransform();
      // A new source is a new set of encoder questions.
      encoderSupported.clear();
      empty.hidden = true;
      stage.classList.toggle('is-audio', info.width === 0);
      ui.precision!.textContent = media.frameAccurate ? t('video.precisionFrame') : t('video.precisionKeyframe');
      ui.precision!.title = t('video.keyframeNote');
      setStatus('');
      syncAll();
      renderCapabilities();
    } catch (err) {
      const reason = err instanceof Error ? err.message : mediaErrorReason(video.error);
      // The media element was already pointed at the new URL, so the window no
      // longer has a source it can trust: it says so instead of showing a player
      // whose timeline belongs to the file that failed.
      source = null;
      clips = [];
      win.setTitle(t('video.title'));
      showNotice(`${t('video.readError')} (${reason})`);
      setStatus('');
    }
  }

  /** Shows a message in place of the picture, whatever state the window was in. */
  function showNotice(message: string): void {
    empty.textContent = '';
    empty.append(el('div', 'faisal-video-emptycard', message));
    empty.hidden = false;
    stage.classList.remove('is-audio');
    nameEl.textContent = t('video.title');
    metaEl.textContent = '';
    nameEl.title = '';
    syncTimeline();
  }

  function showPlaceholder(): void {
    showNotice(t('video.noFile'));
  }

  /* ───────────────────────────── playback ───────────────────────────── */

  async function togglePlay(): Promise<void> {
    if (!source) return;
    if (media.paused) await media.play();
    else media.pause();
    syncPlayButton();
  }

  function syncPlayButton(): void {
    const btn = ui.play;
    if (!btn) return;
    const label = media.paused ? t('video.play') : t('video.pause');
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.replaceChildren(iconSvg(media.paused ? ICON.play : ICON.pause));
  }

  async function seekTo(time: number, keepPlaying = false): Promise<void> {
    if (!source) return;
    await media.seek(clampTime(time, media.duration));
    media.draw(transform);
    if (keepPlaying && !media.paused) await media.play();
    syncTimeline();
  }

  function afterStep(): void {
    media.draw(transform);
    syncTimeline();
  }

  /* ───────────────────────────── syncing the UI ───────────────────────────── */

  function currentTrimRange(): TimeRange {
    if (!source) return { start: 0, end: 0 };
    if (!trimActive) return wholeRange(source.duration);
    return { start: Math.min(trim.start, trim.end), end: Math.max(trim.start, trim.end) };
  }

  function fadeSpan(): number {
    return Math.max(totalDuration(clips), media.duration);
  }

  function syncTimeline(): void {
    if (!source || !ui.seek || !ui.time || !ui.duration || !ui.progress) return;
    const duration = Math.max(0.001, media.duration);
    const position = media.currentTime;
    ui.time.textContent = formatTime(position);
    ui.duration.textContent = formatTime(media.duration);
    ui.seek.max = String(duration);
    if (document.activeElement !== ui.seek) ui.seek.value = String(position);
    ui.progress.style.width = `${(position / duration) * 100}%`;
    const range = currentTrimRange();
    if (ui.inFill && ui.inHandle && ui.outHandle) {
      ui.inFill.style.left = `${(range.start / duration) * 100}%`;
      ui.inFill.style.width = `${((range.end - range.start) / duration) * 100}%`;
      ui.inHandle.style.left = `${(range.start / duration) * 100}%`;
      ui.outHandle.style.left = `${(range.end / duration) * 100}%`;
      ui.inHandle.hidden = !trimActive;
      ui.outHandle.hidden = !trimActive;
      ui.inFill.hidden = !trimActive;
    }
  }

  function syncTrim(): void {
    if (!source || !ui.trimInfo) return;
    const range = currentTrimRange();
    ui.trimInfo.textContent = trimActive
      ? t('video.trimInfo', {
        from: formatTime(range.start),
        to: formatTime(range.end),
        len: formatTime(range.end - range.start),
      })
      : t('video.trimWhole');
    syncTimeline();
  }

  function syncClips(): void {
    const host = ui.clips;
    if (!host) return;
    host.textContent = '';
    if (clips.length === 0) host.append(el('p', 'faisal-video-note', t('video.clipsEmpty')));
    clips.forEach((clip, index) => {
      const row = el('div', 'faisal-video-clip');
      const label = el('div', 'faisal-video-cliplabel');
      label.append(
        el('span', 'faisal-video-clipname', `${t('video.clipN', { n: index + 1 })} · ${basename(clip.path || source?.name || '')}`),
        el('span', 'faisal-video-mono', t('video.clipRange', {
          from: formatTime(clip.range.start),
          to: formatTime(clip.range.end),
        })),
      );
      const actions = el('div', 'faisal-video-clipactions');
      const up = button(t('video.moveUp'), 'faisal-video-iconbtn');
      up.disabled = index === 0;
      up.addEventListener('click', () => { clips = moveClip(clips, index, index - 1); syncClips(); });
      const down = button(t('video.moveDown'), 'faisal-video-iconbtn');
      down.disabled = index === clips.length - 1;
      down.addEventListener('click', () => { clips = moveClip(clips, index, index + 1); syncClips(); });
      const remove = button(t('video.removeClip'), 'faisal-video-iconbtn');
      remove.addEventListener('click', () => { clips = removeClip(clips, index); syncClips(); });
      actions.append(up, down, remove);
      row.append(label, actions);
      host.append(row);
    });
    if (ui.clipsTotal) ui.clipsTotal.textContent = t('video.clipTotal', { total: formatTime(totalDuration(clips)) });
    syncExportPlan();
  }

  function applyTransform(next: VideoTransform): void {
    transform = next;
    media.draw(transform);
    if (ui.transformInfo) {
      const info = describeTransform(transform);
      ui.transformInfo.textContent = t('video.transformState', {
        deg: info.deg,
        h: info.h ? t('video.yes') : t('video.no'),
        v: info.v ? t('video.yes') : t('video.no'),
        cw: info.cw,
        ch: info.ch,
      });
    }
    syncExportPlan();
  }

  /** The current candidate list: the format select leads, the rest stay as fallbacks. */
  function candidates(): string[] {
    const picked = ui.format?.value;
    const preferred = picked && picked.startsWith('video/')
      ? (picked.includes('mp4') ? 'video/mp4' : 'video/webm')
      : preferredExportMime(source ? extensionOf(source.name) : '.mp4');
    return recorderMimeCandidates(preferred, 'video');
  }

  function syncExportPlan(): void {
    if (!ui.engine || !ui.exportBtn || !ui.format) return;
    if (!source) {
      ui.engine.textContent = '';
      ui.exportBtn.disabled = true;
      return;
    }
    const size = outputSize({ width: source.width || 2, height: source.height || 2 }, transform);
    const hasAudio = media.hasAudio();
    const list = candidates();
    // Rebuild the select only when its options would change, so the user's choice
    // is not thrown away by a sync triggered from somewhere else.
    const current = [...ui.format.options].map((option) => option.value).join('|');
    if (current !== list.join('|')) {
      const previous = ui.format.value;
      ui.format.textContent = '';
      for (const option of list) {
        const item = el('option', undefined, option);
        item.value = option;
        ui.format.append(item);
      }
      if (list.includes(previous)) ui.format.value = previous;
    }
    const plan = planExport({
      candidates: ui.format.value ? [ui.format.value, ...list] : list,
      env: envFor(hasAudio),
      muted,
      videoCodec: ui.format.value.includes('mp4') ? 'avc1.42E01E' : 'vp09.00.10.08',
      audioCodec: 'opus',
      width: size.width,
      height: size.height,
      sampleRate: 48000,
      channels: 2,
    }, probe());
    const engineName = plan.engine === 'webcodecs'
      ? t('video.engineWebCodecs')
      : plan.engine === 'mediarecorder'
        ? t('video.engineMediaRecorder')
        : t('video.exportNoEncoder');
    // An audio-only file has no canvas to record: the app says so instead of
    // offering an export that cannot produce a video track.
    const audioOnly = source.width === 0;
    ui.engine.textContent = audioOnly
      ? `${t('video.engineLabel')}: —`
      : `${t('video.engineLabel')}: ${engineName}`;
    ui.exportBtn.disabled = exporting || clips.length === 0 || plan.engine === 'none' || audioOnly;
    ui.engine.title = audioOnly ? t('video.exportAudioOnly') : plan.engine === 'none' ? t('video.exportNoEncoder') : plan.mime;
    if (ui.captureNote) {
      ui.captureNote.textContent = audioOnly ? t('video.exportAudioOnly') : hasAudio ? '' : t('video.exportNoAudio');
    }
    // The encoder answers are per size, so a new crop or rotation asks a new
    // question; the answer fills the cache and then re-runs this function once.
    void probeEncoders(size.width, size.height, hasAudio).then(syncExportPlan);
  }

  function syncAll(): void {
    syncTimeline();
    syncTrim();
    syncClips();
    applyTransform(transform);
    syncPlayButton();
  }

  /* ───────────────────────────── capture ───────────────────────────── */

  async function captureFrame(): Promise<void> {
    if (!source) return;
    setStatus(t('video.capturing'));
    try {
      const blob = await media.capturePng(transform);
      if (blob.size > CAPTURE_LIMIT) {
        setStatus(t('video.captureTooBig'));
        return;
      }
      const dir = (source.path ? dirname(source.path) : '/home/user').replace(/\/+$/, '') || '/home/user';
      const name = `${baseNameWithoutExtension(source.name)}-frame-${clockToken()}.png`;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await sys.vfs.writeFile(`${dir}/${name}`, bytes);
      setStatus(t('video.captured', { path: `${dir}/${name}` }));
    } catch {
      setStatus(t('video.captureFailed'));
    }
  }

  function clockToken(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  /* ───────────────────────────── export ───────────────────────────── */

  async function startExport(): Promise<void> {
    if (!source || clips.length === 0 || exporting) return;
    if (source.width === 0) {
      setStatus(t('video.exportAudioOnly'));
      return;
    }
    const size = outputSize({ width: source.width || 2, height: source.height || 2 }, transform);
    const hasAudio = media.hasAudio();
    const list = candidates();
    const plan = planExport({
      candidates: list,
      env: envFor(hasAudio),
      muted,
      videoCodec: ui.format?.value.includes('mp4') ? 'avc1.42E01E' : 'vp09.00.10.08',
      audioCodec: 'opus',
      width: size.width,
      height: size.height,
      sampleRate: 48000,
      channels: 2,
    }, probe());
    if (plan.engine === 'none') {
      setStatus(t('video.exportNoEncoder'));
      return;
    }
    exporting = true;
    exportAbort = new AbortController();
    ui.exportBtn!.disabled = true;
    ui.cancelBtn!.hidden = false;
    ui.progress2!.hidden = false;
    ui.progress2!.value = 0;
    ui.report!.textContent = t('video.exporting', { percent: 0 });
    media.pause();
    syncPlayButton();

    try {
      const result = await media.export({
        clips,
        transform,
        gain,
        fades,
        muted,
        candidates: list,
        engine: plan.engine,
        fps: media.fps > 0 ? Math.min(60, Math.max(24, Math.round(media.fps))) : 30,
        videoBitrate: VIDEO_BITRATE,
        audioBitrate: AUDIO_BITRATE,
        signal: exportAbort.signal,
        onProgress: (report) => {
          ui.progress2!.value = Math.round(report.fraction * 1000);
          ui.report!.textContent = t('video.exporting', { percent: Math.round(report.fraction * 100) });
        },
      });
      ui.report!.textContent = t('video.exportSaving');
      const summary = await saveExport(result.blob, result.mime, result.engine, result.duration, result.effectiveFps, result.frameAccurate);
      ui.report!.textContent = summary;
    } catch (err) {
      if (err instanceof ExportCancelled || exportAbort?.signal.aborted) {
        ui.report!.textContent = t('video.exportCancelled');
      } else {
        const reason = err instanceof Error ? err.message : 'unknown error';
        ui.report!.textContent = t('video.exportFailed', { reason });
      }
    } finally {
      exporting = false;
      exportAbort = null;
      ui.cancelBtn!.hidden = true;
      ui.progress2!.hidden = true;
      syncExportPlan();
    }
  }

  /**
   * Writes the produced blob into the folder the source came from.
   *
   * The name carries the time, so an ordinary export never overwrites anything.
   * When it does collide, ONE `.bak` is kept — and because the VFS caps a single
   * file at 20 MB, a backup that cannot fit is skipped rather than half-written,
   * and the note says so.
   */
  async function saveExport(
    blob: Blob,
    mime: string,
    engine: ExportEngine,
    duration: number,
    fps: number,
    frameAccurate: boolean,
  ): Promise<string | null> {
    if (!source) return null;
    const dir = (source.path ? dirname(source.path) : '/home/user').replace(/\/+$/, '') || '/home/user';
    const name = exportName(baseNameWithoutExtension(source.name), extensionForExport(mime), clockToken());
    const target = `${dir}/${name}`;
    const exists = await sys.vfs.exists(target).catch(() => false);
    const names = planName(dir, name, exists);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const verdict = checkQuota(bytes.length, await usedBytes());
    if (verdict !== 'ok') {
      return t('video.exportFailed', {
        reason: verdict === 'file-too-big'
          ? `${t('video.exportQuotaWarn')} (${formatBytes(VFS_FILE_LIMIT, sys.locale())})`
          : t('video.exportQuotaWarn'),
      });
    }
    let backupNote = '';
    if (names.backup) {
      const previous = await sys.vfs.stat(names.path).catch(() => null);
      if (previous && previous.size <= VFS_FILE_LIMIT) {
        if (await sys.vfs.exists(names.backup).catch(() => false)) {
          await sys.vfs.remove(names.backup).catch(() => undefined);
        }
        try {
          await sys.vfs.rename(names.path, names.backup);
          backupNote = ` · ${t('video.exportOverwriteBak', { bak: basename(names.backup) })}`;
        } catch {
          backupNote = '';
        }
      }
    }
    await sys.vfs.writeFile(names.path, bytes);
    const engineName = engine === 'webcodecs' ? t('video.engineWebCodecs') : t('video.engineMediaRecorder');
    const precision = frameAccurate ? t('video.precisionFrame') : t('video.precisionKeyframe');
    const measured = t('video.engineMeasured', {
      engine: engineName,
      mime,
      size: formatBytes(bytes.length, sys.locale()),
      len: formatTime(duration),
    });
    return `${t('video.exportDone', { path: names.path, size: formatBytes(bytes.length, sys.locale()) })}`
      + `\n${measured} · ${fps.toFixed(1)} fps\n${precision}${backupNote}`;
  }

  async function usedBytes(): Promise<number> {
    const walk = async (path: string): Promise<number> => {
      const entries = await sys.vfs.readdir(path).catch(() => []);
      let total = 0;
      for (const entry of entries) {
        if (entry.type === 'file') total += entry.size;
        else total += await walk(entry.path);
      }
      return total;
    };
    return (await walk('/home/user')) + (await walk('/tmp'));
  }

  /* ───────────────────────────── fullscreen ───────────────────────────── */

  async function toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }
      if (typeof stage.requestFullscreen !== 'function') {
        setStatus(t('video.fullscreenUnsupported'));
        return;
      }
      await stage.requestFullscreen();
    } catch {
      setStatus(t('video.fullscreenFailed'));
    }
  }

  function syncFullscreenButton(): void {
    const btn = ui.fullscreen;
    if (!btn) return;
    const isFull = Boolean(document.fullscreenElement);
    const label = isFull ? t('video.fullscreenExit') : t('video.fullscreen');
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.replaceChildren(iconSvg(isFull ? ICON.shrink : ICON.expand));
  }

  /* ───────────────────────────── wiring ───────────────────────────── */

  openInput.addEventListener('change', () => {
    const file = openInput.files?.[0];
    if (file) void openPickedFile(file);
  });
  video.addEventListener('play', syncPlayButton);
  video.addEventListener('pause', syncPlayButton);
  video.addEventListener('loadedmetadata', syncTimeline);
  video.addEventListener('timeupdate', () => { if (!exporting) syncTimeline(); });
  video.addEventListener('seeking', () => { if (!exporting) syncTimeline(); });
  video.addEventListener('error', () => {
    if (!closed && source) setStatus(t('video.readError'));
  });
  // Typing in a field must not reach the shell's window shortcuts.
  root.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) {
      event.stopPropagation();
    }
  });
  document.addEventListener('fullscreenchange', syncFullscreenButton);

  showPlaceholder();
  renderCapabilities();
  syncExportPlan();

  win.setCloseGuard(() => {
    // An export in flight is cancelled rather than left running against a dead window.
    exportAbort?.abort();
    return true;
  });
  win.onClose(() => {
    closed = true;
    exportAbort?.abort();
    document.removeEventListener('fullscreenchange', syncFullscreenButton);
    media.dispose();
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
    objectUrls.length = 0;
  });

  if (args[0]) void openPath(args[0]);
}

const app: AppModule = { manifest, launch };
export default app;
