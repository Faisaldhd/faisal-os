/**
 * Video Studio (استوديو الفيديو) — a CapCut/Clipchamp-style editor and a
 * cinematic player, in the browser, with nothing uploaded anywhere.
 *
 * THREE SCREENS
 *  • Start: new project by aspect (16:9, 9:16, 1:1, 4:5) or template, open a
 *    project, play a video, recent projects and recent media.
 *  • Player: big picture, glass controls (play, volume, speed 0.5×–2×,
 *    fullscreen), a playlist drawer (add, drag to reorder, switch) and trim
 *    handles that save only the chosen part.
 *  • Editor: media pool · preview · inspector, over a multi-track timeline
 *    (titles, overlay, main, two audio tracks) with split, trim, move, snap,
 *    transitions, colour, text, undo/redo and export.
 *
 * WHAT IT REFUSES TO DO
 *  • Pretend a format plays: the browser is asked (`canPlayType`), and a refusal
 *    names the extension (capabilities.ts).
 *  • Invent a file: a cancelled or failed export or save writes nothing; a
 *    written file is read back before "Saved" is shown; overwriting keeps one
 *    `.bak`.
 *
 * Model: project.ts (pure, tested). Drawing, playback and export: the engine
 * behind engine-port.ts. Every visible string: strings.ts (ar + en). All text
 * goes through textContent.
 */
import { manifest } from './manifest';
import type { AppContext, AppModule, Stat } from '../../kernel/types';
import { basename, dirname, normalize } from '../../kernel/path';
import { formatBytes } from '../files/format';
import { extensionOf } from '../viewer/formats';
import { PATHS_MIME } from '../files/dnd';
import { shellConfirm } from '../../shell/dialog';
import { pushEscapeLayer } from '../../shell/esc';
import { NARROW_BREAKPOINT } from '../../shell/device';
import './strings';
import './video.css';

import { VIDEO_EXTENSIONS, type CapabilityProbe } from './capabilities';
import { outputSize } from './clips';
import { baseNameWithoutExtension } from './export';
import { History } from './history';
import { icon } from './icons';
import { Inspector, TEXT_PRESETS, type InspectorTab, type TextPreset } from './inspector';
import { IMAGE_EXTENSIONS, MediaLibrary, measureDuration, mediaTypeFor, type MediaItem } from './media';
import { PlayerView } from './player-view';
import { PoolView, type PoolFilter } from './pool-view';
import {
  appendClip,
  clipSpan,
  detachAudio,
  duplicateClip,
  emptyProject,
  estimateExportBytes,
  findClip,
  frameSize,
  insertClip,
  isEmptyProject,
  isMedia,
  makeMediaClip,
  makeTextClip,
  mainTrack,
  projectDuration,
  removeClip,
  splitAtPlayhead,
  timecode,
  trackAccepts,
  trackFor,
  trimToPlayhead,
  updateClip,
  updateTrack,
  usedMediaIds,
  type AspectKey,
  type MediaClip,
  type Project,
  type QualityKey,
  type ResolutionKey,
  type TransitionKind,
} from './project';
import { absoluteFallback, parseProjectFile, PROJECT_EXTENSION, ProjectFileError, serializeProject } from './project-file';
import { isTypingTarget, matchShortcut, shuttle, type ShortcutAction } from './shortcuts';
import { TimelineView } from './timeline-view';
import { button, el, formatClock, iconButton, openModal, promptName, s, segmented, setIcon } from './ui';
import { dialogsFor } from './app-dialogs';
import type { StudioEngine, EngineMedia } from './engine-port';
import { ExportCancelled } from './engine-port';
import { CanvasStudioEngine, exportSettings, hasWebCodecs, planMp4, type Mp4Plan } from './engine';

type Mode = 'start' | 'player' | 'editor';

const HOME = '/home/user';
const VIDEOS_DIR = '/home/user/Videos';
const PICTURES_DIR = '/home/user/Pictures';
const AUTOSAVE_KEY = 'faisal.video.autosave.v1';
const RECENT_KEY = 'faisal.video.recent.v1';
const AUTOSAVE_MS = 30_000;
const MEDIA_EXTS = [...new Set([...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS])];
const VIDEO_ONLY_EXTS = VIDEO_EXTENSIONS.filter((e) => mediaTypeFor(`x${e}`) === 'video');
const AUDIO_EXTS = VIDEO_EXTENSIONS.filter((e) => mediaTypeFor(`x${e}`) === 'audio');

interface RecentProject {
  path: string;
  name: string;
  savedAt: number;
}

/* ─────────────────────────────── storage helpers (never throw) ─────────────────────────────── */

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: autosave and recents are conveniences */
  }
}

function clockToken(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 100) || 'video';
}

/* ─────────────────────────────── the app ─────────────────────────────── */

function launch(ctx: AppContext): void {
  const { sys, window: win, args } = ctx;
  win.setTitle(s('title'));
  win.content.textContent = '';

  /* ── state ── */
  let mode: Mode = 'start';
  let project: Project = emptyProject('16:9');
  let projectPath: string | null = null;
  let dirty = false;
  let selected: string | null = null;
  let snapping = true;
  let looping = false;
  let shuttleRate = 0;
  let reverseTimer = 0;
  let closed = false;
  let exportRunning: AbortController | null = null;
  let narrow = false;
  let medium = false;
  const history = new History<Project>(200);

  const probe = (): CapabilityProbe => ({
    canPlayType: (mime: string) => {
      try {
        return document.createElement(mime.startsWith('audio/') ? 'audio' : 'video').canPlayType(mime);
      } catch {
        return '';
      }
    },
    isTypeSupported: (mime: string) => {
      try {
        return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mime);
      } catch {
        return false;
      }
    },
  });

  const library = new MediaLibrary(sys.vfs, probe, {
    refused: (ext) => s('refused', { ext }),
    unreadable: (reason) => (reason ? s('unreadableWhy', { reason }) : s('unreadable')),
    empty: () => s('emptyFile'),
    codec: (ext, size) => s('codecUnsupported', { ext, size: formatBytes(size, sys.locale()) }),
    tooBig: () => s('tooBig'),
  });

  const engine: StudioEngine = new CanvasStudioEngine({ offline: s('offline') });
  const engineMedia = (id: string): EngineMedia | undefined => {
    const m = library.get(id);
    if (!m) return undefined;
    return {
      id: m.id,
      type: m.type,
      url: m.status === 'ready' ? m.url : '',
      width: m.width,
      height: m.height,
      duration: m.duration,
      hasAudio: m.hasAudio,
      image: m.image,
      peaks: m.peaks,
      bytes: m.bytes,
    };
  };
  engine.setMedia(engineMedia);

  /* ── root and app bar ── */
  const root = el('div', 'fvs');
  root.tabIndex = -1;
  const bar = el('header', 'fvs-appbar');
  const homeBtn = iconButton(s('home'), 'back');
  const brand = el('span', 'fvs-brand');
  brand.append(icon('film'));
  const titleWrap = el('div', 'fvs-titlewrap');
  const titleEl = el('span', 'fvs-title', s('title'));
  titleEl.dir = 'auto';
  const dirtyDot = el('span', 'fvs-dirty');
  dirtyDot.setAttribute('role', 'img');
  dirtyDot.setAttribute('aria-label', s('unsaved'));
  dirtyDot.title = s('unsaved');
  dirtyDot.hidden = true;
  titleWrap.append(titleEl, dirtyDot);
  const modeSeg = el('div', 'fvs-seg fvs-modeseg');
  modeSeg.setAttribute('role', 'group');
  modeSeg.setAttribute('aria-label', s('mode'));
  const playerModeBtn = button(s('modePlayer'), 'fvs-seg-btn', 'play');
  const editorModeBtn = button(s('modeEditor'), 'fvs-seg-btn', 'layers');
  modeSeg.append(playerModeBtn, editorModeBtn);
  const spacer = el('span', 'fvs-spacer');
  const undoBtn = iconButton(s('undo'), 'undo');
  const redoBtn = iconButton(s('redo'), 'redo');
  const helpBtn = iconButton(s('help'), 'help');
  helpBtn.setAttribute('aria-haspopup', 'menu');
  const moreBtn = iconButton(s('more'), 'more', 'fvs-iconbtn fvs-more');
  moreBtn.setAttribute('aria-haspopup', 'menu');
  const saveBtn = button(s('save'), 'fvs-btn fvs-save', 'save');
  const exportBtn = button(s('export'), 'fvs-btn is-primary fvs-export', 'exportIcon');
  bar.append(homeBtn, brand, titleWrap, modeSeg, spacer, undoBtn, redoBtn, helpBtn, saveBtn, exportBtn, moreBtn);

  const work = el('div', 'fvs-work');
  const statusBar = el('footer', 'fvs-status');
  const statusCtx = el('span', 'fvs-status-ctx');
  statusCtx.dir = 'ltr';
  const statusMsg = el('span', 'fvs-status-msg');
  statusMsg.setAttribute('role', 'status');
  statusMsg.setAttribute('aria-live', 'polite');
  const statusRight = el('span', 'fvs-status-right');
  statusBar.append(statusCtx, statusMsg, statusRight);
  const bottomNav = el('nav', 'fvs-bottomnav');
  bottomNav.setAttribute('aria-label', s('tools'));
  const sheetHost = el('div', 'fvs-sheet-host');
  sheetHost.hidden = true;
  root.append(bar, work, statusBar, bottomNav, sheetHost);
  win.content.append(root);

  let statusTimer = 0;
  function status(text: string, sticky = false): void {
    statusMsg.textContent = text;
    window.clearTimeout(statusTimer);
    if (!sticky && text) statusTimer = window.setTimeout(() => { statusMsg.textContent = ''; }, 6000);
  }

  /* ── sheets (phone) ── */
  let sheet: { panel: HTMLElement; parent: Node; next: Node | null; release: () => void; opener: HTMLElement | null } | null = null;
  function openSheet(panel: HTMLElement, title: string): void {
    closeSheet();
    const opener = document.activeElement as HTMLElement | null;
    const parent = panel.parentNode ?? work;
    const next = panel.nextSibling;
    sheetHost.replaceChildren();
    const backdrop = el('div', 'fvs-sheet-backdrop');
    const card = el('div', 'fvs-sheet');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', title);
    const grab = el('button', 'fvs-sheet-grab');
    grab.type = 'button';
    grab.setAttribute('aria-label', s('closeSheet'));
    grab.append(el('span', 'fvs-sheet-grip'));
    const head = el('div', 'fvs-sheet-head');
    const close = iconButton(s('close'), 'close');
    head.append(el('h2', 'fvs-sheet-title', title), close);
    const body = el('div', 'fvs-sheet-body');
    body.append(panel);
    card.append(grab, head, body);
    sheetHost.append(backdrop, card);
    sheetHost.hidden = false;
    backdrop.addEventListener('click', closeSheet);
    close.addEventListener('click', closeSheet);
    grab.addEventListener('click', closeSheet);
    // Swipe down on the grab bar closes the sheet.
    let startY = -1;
    grab.addEventListener('pointerdown', (e) => { startY = e.clientY; grab.setPointerCapture(e.pointerId); });
    grab.addEventListener('pointerup', (e) => { if (startY >= 0 && e.clientY - startY > 40) closeSheet(); startY = -1; });
    const release = pushEscapeLayer(closeSheet);
    sheet = { panel, parent, next, release, opener };
    queueMicrotask(() => close.focus());
  }
  function closeSheet(): void {
    if (!sheet) return;
    const { panel, parent, next, release, opener } = sheet;
    sheet = null;
    release();
    parent.insertBefore(panel, next && next.parentNode === parent ? next : null);
    sheetHost.replaceChildren();
    sheetHost.hidden = true;
    if (opener?.isConnected) opener.focus();
  }

  /* ── dialogs ── */
  const dialogs = dialogsFor({
    host: root,
    sys,
    status,
    probe,
  });

  /* ─────────────── editor ─────────────── */

  const editor = el('div', 'fvs-editor');
  const poolPanel = el('section', 'fvs-panel fvs-pool-panel');
  poolPanel.setAttribute('aria-label', s('mediaPool'));
  const center = el('section', 'fvs-center');
  const stage = el('div', 'fvs-stage');
  const stageFrame = el('div', 'fvs-stage-frame');
  const outline = el('div', 'fvs-outline');
  outline.hidden = true;
  const outlineHandle = el('div', 'fvs-outline-handle');
  outlineHandle.setAttribute('aria-hidden', 'true');
  outline.append(outlineHandle);
  stageFrame.append(outline);
  const stageEmpty = el('div', 'fvs-stage-empty');
  stage.append(stageFrame, stageEmpty);
  const transport = el('div', 'fvs-transport');
  const sidePanel = el('section', 'fvs-panel fvs-side');
  sidePanel.setAttribute('aria-label', s('inspector'));
  const tlPanel = el('section', 'fvs-panel fvs-tl-panel');
  tlPanel.setAttribute('aria-label', s('timeline'));
  editor.append(poolPanel, center, sidePanel, tlPanel);
  center.append(stage, transport);

  /* inspector */
  const inspector = new Inspector({
    project: () => project,
    media: (id) => library.get(id),
    time: () => engine.time,
    selected: () => selected,
    begin: () => history.begin(project),
    preview: (next) => { project = next; refresh({ inspector: false }); },
    end: () => { history.commit(project); refresh(); },
    apply: (next) => apply(next),
    split: () => doSplit(),
    remove: () => doDelete(),
    duplicate: () => doDuplicate(),
    detach: () => doDetach(),
    capture: () => void captureFrame(),
    addText: (preset) => addText(preset),
    addMusic: () => void addMusic(),
    setAspect: (aspect) => apply({ ...project, aspect }),
    applyTransitionToAll: (kind, duration) => applyTransitionToAll(kind, duration),
  });
  sidePanel.append(inspector.root);

  /* timeline */
  const timeline = new TimelineView({
    project: () => project,
    media: (id) => library.get(id),
    time: () => engine.time,
    playing: () => engine.playing,
    selected: () => selected,
    select: (id) => select(id),
    seek: (t) => seek(t),
    begin: () => history.begin(project),
    preview: (next) => { project = next; refresh(); },
    end: () => { history.commit(project); refresh(); },
    apply: (next) => apply(next),
    snapping: () => snapping,
    dropMedia: (id, trackId, time) => {
      const item = library.get(id);
      if (item) addToTimeline(item, trackId, time);
    },
    toggleTrack: (trackId, what) => {
      const track = project.tracks.find((t) => t.id === trackId);
      if (track) apply(updateTrack(project, trackId, { [what]: !track[what] }));
    },
  });

  /* timeline toolbar */
  const tlBar = el('div', 'fvs-tl-bar');
  const tcLabel = el('span', 'fvs-timecode', '00:00:00');
  tcLabel.dir = 'ltr';
  const poolToggle = button(s('mediaPool'), 'fvs-btn is-ghost fvs-pool-toggle', 'folder');
  poolToggle.addEventListener('click', () => openSheet(pool.root, s('mediaPool')));
  const splitBtn = iconButton(`${s('split')} (S)`, 'scissors');
  splitBtn.addEventListener('click', () => doSplit());
  const deleteBtn = iconButton(`${s('delete')} (Del)`, 'trash');
  deleteBtn.addEventListener('click', () => doDelete());
  const dupBtn = iconButton(`${s('duplicate')} (Ctrl+D)`, 'duplicate');
  dupBtn.addEventListener('click', () => doDuplicate());
  const detachBtn = iconButton(s('detachAudio'), 'detach');
  detachBtn.addEventListener('click', () => doDetach());
  const textBtn = iconButton(`${s('addTitle')} (T)`, 'text');
  textBtn.addEventListener('click', () => addText(TEXT_PRESETS[0]));
  const transitionBtn = iconButton(s('transitions'), 'transition');
  transitionBtn.addEventListener('click', () => showInspector('effects'));
  const tlSpacer = el('span', 'fvs-spacer');
  const snapBtn = iconButton(`${s('snap')} (N)`, 'magnet');
  snapBtn.setAttribute('aria-pressed', 'true');
  snapBtn.addEventListener('click', () => setSnap(!snapping));
  const zoomOut = iconButton(`${s('zoomOut')} (−)`, 'zoomOut');
  zoomOut.addEventListener('click', () => timeline.zoomBy(1 / 1.5));
  const zoomSlider = el('input', 'fvs-range fvs-zoom');
  zoomSlider.type = 'range';
  zoomSlider.min = '0';
  zoomSlider.max = '1000';
  zoomSlider.setAttribute('aria-label', s('zoom'));
  zoomSlider.addEventListener('input', () => {
    const f = Number(zoomSlider.value) / 1000;
    timeline.setZoom(2 * Math.pow(300, f));
  });
  const zoomIn = iconButton(`${s('zoomIn')} (+)`, 'zoomIn');
  zoomIn.addEventListener('click', () => timeline.zoomBy(1.5));
  const fitBtn = iconButton(`${s('zoomFit')} (Ctrl+0)`, 'fit');
  fitBtn.addEventListener('click', () => timeline.fit());
  const zoomGroup = el('div', 'fvs-zoomgroup');
  zoomGroup.append(zoomOut, zoomSlider, zoomIn, fitBtn);
  tlBar.append(tcLabel, poolToggle, splitBtn, deleteBtn, dupBtn, detachBtn, textBtn, transitionBtn, tlSpacer, snapBtn, zoomGroup);
  tlPanel.append(tlBar, timeline.root);
  timeline.onZoom((pps) => {
    zoomSlider.value = String(Math.round((Math.log(pps / 2) / Math.log(300)) * 1000));
    zoomSlider.style.setProperty('--fill', `${Number(zoomSlider.value) / 10}%`);
  });

  /* pool */
  const pool = new PoolView(library, {
    importFromFiles: (filter) => void importFromFiles(filter),
    importFromDevice: () => pickDevice('pool'),
    add: (item) => {
      addToTimeline(item);
      if (sheet) closeSheet();
    },
    relink: (item) => void relink(item),
    remove: (item) => library.remove(item.id),
    inUse: (id) => usedMediaIds(project).has(id),
  });
  poolPanel.append(pool.root);

  /* transport */
  const scrub = el('input', 'fvs-range fvs-scrub');
  scrub.type = 'range';
  scrub.min = '0';
  scrub.max = '1000';
  scrub.step = '1';
  scrub.value = '0';
  scrub.dir = 'ltr';
  scrub.setAttribute('aria-label', s('seekBar'));
  scrub.addEventListener('input', () => seek((Number(scrub.value) / 1000) * engine.duration));
  const tRow = el('div', 'fvs-transport-row');
  tRow.dir = 'ltr';
  const timeNow = el('span', 'fvs-tc-now', '00:00:00');
  const timeTotal = el('span', 'fvs-tc-total', '/ 00:00:00');
  const times = el('span', 'fvs-tc');
  times.append(timeNow, timeTotal);
  const goStart = iconButton(`${s('goStart')} (Home)`, 'prev');
  goStart.addEventListener('click', () => seek(0));
  const frameBack = iconButton(`${s('frameBack')} (←)`, 'frameBack');
  frameBack.addEventListener('click', () => stepFrames(-1));
  const playBtn = iconButton(`${s('play')} (Space)`, 'play', 'fvs-iconbtn is-play');
  playBtn.addEventListener('click', () => void togglePlay());
  const frameFwd = iconButton(`${s('frameForward')} (→)`, 'frameForward');
  frameFwd.addEventListener('click', () => stepFrames(1));
  const goEnd = iconButton(`${s('goEnd')} (End)`, 'next');
  goEnd.addEventListener('click', () => seek(engine.duration));
  const tSpacerA = el('span', 'fvs-spacer');
  const tSpacerB = el('span', 'fvs-spacer');
  const loopBtn = iconButton(`${s('loop')} (R)`, 'loop');
  loopBtn.setAttribute('aria-pressed', 'false');
  loopBtn.addEventListener('click', () => setLoop(!looping));
  let edMuted = false;
  const edMute = iconButton(s('mute'), 'volume');
  edMute.addEventListener('click', () => {
    edMuted = !edMuted;
    engine.setMuted(edMuted);
    setIcon(edMute, edMuted ? 'mute' : 'volume', edMuted ? s('unmute') : s('mute'));
  });
  const edVol = el('input', 'fvs-range is-volume');
  edVol.type = 'range';
  edVol.min = '0';
  edVol.max = '1';
  edVol.step = '0.01';
  edVol.value = '1';
  edVol.style.setProperty('--fill', '100%');
  edVol.setAttribute('aria-label', s('volume'));
  edVol.addEventListener('input', () => {
    engine.setVolume(Number(edVol.value));
    edVol.style.setProperty('--fill', `${Number(edVol.value) * 100}%`);
  });
  const edVolWrap = el('div', 'fvs-volume');
  edVolWrap.append(edMute, edVol);
  const fullBtn = iconButton(`${s('fullscreen')} (F)`, 'expand');
  fullBtn.addEventListener('click', () => toggleFullscreen(stage));
  tRow.append(times, tSpacerA, goStart, frameBack, playBtn, frameFwd, goEnd, tSpacerB, loopBtn, edVolWrap, fullBtn);
  transport.append(scrub, tRow);

  /* ─────────────── player ─────────────── */

  const player = new PlayerView({
    engine,
    library,
    showProject: (p) => showPlayerProject(p),
    addClips: () => void addToPlaylist(),
    openInEditor: (ids) => void openEditorWith(ids),
    saveSelection: (item, range) => void saveSelection(item, range),
    toggleFullscreen: (target) => toggleFullscreen(target),
    status,
    narrow: () => narrow,
    openSheet,
    closeSheet,
  });

  /* ─────────────── start screen ─────────────── */

  const start = el('div', 'fvs-start');

  /* ─────────────── bottom nav (phone editor) ─────────────── */

  const navItems: Array<{ key: 'media' | InspectorTab; label: string; iconName: Parameters<typeof icon>[0] }> = [
    { key: 'media', label: s('navMedia'), iconName: 'folder' },
    { key: 'edit', label: s('tabEdit'), iconName: 'sliders' },
    { key: 'audio', label: s('tabAudio'), iconName: 'music' },
    { key: 'text', label: s('tabText'), iconName: 'text' },
    { key: 'effects', label: s('tabEffects'), iconName: 'effects' },
  ];
  for (const item of navItems) {
    const b = button(item.label, 'fvs-nav-btn', item.iconName);
    b.addEventListener('click', () => {
      if (item.key === 'media') openSheet(pool.root, s('mediaPool'));
      else showInspector(item.key);
    });
    bottomNav.append(b);
  }

  function showInspector(tab: InspectorTab): void {
    inspector.show(tab);
    if (narrow) openSheet(inspector.root, s(`tab${tab[0].toUpperCase()}${tab.slice(1)}`));
  }

  /* ─────────────── layout by window size ─────────────── */

  const sizeObserver = new ResizeObserver(() => {
    const width = root.clientWidth;
    const wasNarrow = narrow;
    narrow = width > 0 && width < NARROW_BREAKPOINT;
    medium = width > 0 && width < 1000;
    root.classList.toggle('is-narrow', narrow);
    root.classList.toggle('is-medium', medium && !narrow);
    if (wasNarrow !== narrow && sheet) closeSheet();
    // Panels that live in sheets on small windows go back into the grid on large ones.
    if (!medium && pool.root.parentNode !== poolPanel && !sheet) poolPanel.append(pool.root);
    if (!narrow && inspector.root.parentNode !== sidePanel && !sheet) sidePanel.append(inspector.root);
    if (!narrow && player.drawer.parentNode !== player.root && !sheet) player.root.append(player.drawer);
  });
  sizeObserver.observe(root);

  const stageObserver = new ResizeObserver(() => sizePreview());
  function sizePreview(): void {
    const host = mode === 'player' ? player.stage : stage;
    const r = host.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const frame = frameFor(mode === 'player' ? null : project);
    const scale = Math.min(r.width / frame.width, r.height / frame.height);
    const w = Math.max(2, Math.floor(frame.width * scale));
    const h = Math.max(2, Math.floor(frame.height * scale));
    engine.setPreviewSize(Math.min(3840, w * dpr), Math.min(3840, h * dpr));
    engine.canvas.style.width = `${w}px`;
    engine.canvas.style.height = `${h}px`;
    positionOutline();
  }
  stageObserver.observe(stage);
  stageObserver.observe(player.stage);

  /* ─────────────── frame size ─────────────── */

  let playerFrame = { width: 1280, height: 720 };
  function frameFor(p: Project | null): { width: number; height: number } {
    const target = p ?? null;
    if (!target) return playerFrame;
    const first = mainTrack(target).clips.find(isMedia) as MediaClip | undefined;
    const media = first ? library.get(first.mediaId) : undefined;
    const size = media && media.width > 0 ? outputSize({ width: media.width, height: media.height }, first!.transform) : null;
    const frame = frameSize(target.aspect, size);
    if (target !== project) playerFrame = frame;
    return frame;
  }
  function showPlayerProject(p: Project): void {
    playerFrame = frameFor(p);
    engine.setProject(p, playerFrame);
    sizePreview();
    syncChrome();
  }

  /* ─────────────── model changes ─────────────── */

  function apply(next: Project): void {
    if (next === project) return;
    history.record(project);
    project = next;
    refresh();
  }

  function refresh(opts: { inspector?: boolean } = {}): void {
    if (selected && !findClip(project, selected)) selected = null;
    dirty = true;
    if (mode === 'editor') {
      engine.setProject(project, frameFor(project));
      sizePreview();
    }
    timeline.render();
    if (opts.inspector !== false) inspector.refresh();
    syncChrome();
    positionOutline();
  }

  function select(id: string | null): void {
    if (selected === id) return;
    selected = id;
    timeline.render();
    inspector.refresh();
    syncChrome();
    positionOutline();
  }

  function undo(): void {
    const prev = history.undo(project);
    if (!prev) return;
    project = prev;
    refresh();
    status(s('undone'));
  }

  function redo(): void {
    const next = history.redo(project);
    if (!next) return;
    project = next;
    refresh();
    status(s('redone'));
  }

  /* ─────────────── chrome sync ─────────────── */

  function syncChrome(): void {
    const name = mode === 'player' ? (player.currentMedia()?.name ?? s('modePlayer')) : project.name || s('untitledProject');
    titleEl.textContent = mode === 'start' ? s('title') : name;
    win.setTitle(mode === 'start' ? s('title') : `${name} — ${s('title')}`);
    dirtyDot.hidden = !(mode === 'editor' && dirty && !isEmptyProject(project));
    undoBtn.disabled = !history.canUndo || mode !== 'editor';
    redoBtn.disabled = !history.canRedo || mode !== 'editor';
    const hasSel = Boolean(selected);
    deleteBtn.disabled = !hasSel;
    dupBtn.disabled = !hasSel;
    const selClip = selected ? findClip(project, selected)?.clip : null;
    detachBtn.disabled = selClip?.type !== 'video';
    exportBtn.disabled = mode === 'editor' ? isEmptyProject(project) : mode === 'player' ? !player.currentMedia() : true;
    saveBtn.disabled = mode !== 'editor';
    root.dataset.mode = mode;
    playerModeBtn.setAttribute('aria-pressed', String(mode === 'player'));
    editorModeBtn.setAttribute('aria-pressed', String(mode === 'editor'));
    const frame = mode === 'player' ? playerFrame : frameFor(project);
    const d = engine.duration;
    statusCtx.textContent = mode === 'start' ? '' : `${frame.width}×${frame.height} · 30 fps · ${timecode(d)}`;
    stageEmpty.hidden = !isEmptyProject(project);
    if (!stageEmpty.hidden && stageEmpty.childElementCount === 0) {
      const art = el('div', 'fvs-empty-art is-large');
      art.append(icon('film'));
      const add = button(s('importFiles'), 'fvs-btn is-primary', 'folder');
      add.addEventListener('click', () => void importFromFiles('all'));
      const dev = button(s('importDevice'), 'fvs-btn', 'upload');
      dev.addEventListener('click', () => pickDevice('pool'));
      const row = el('div', 'fvs-action-row is-center');
      row.append(add, dev);
      stageEmpty.append(art, el('p', 'fvs-empty-title', s('editorEmpty')), el('p', 'fvs-empty-hint', s('editorEmptyHint')), row);
    }
    paintTime();
  }

  function paintTime(): void {
    const t = engine.time;
    const d = engine.duration;
    timeNow.textContent = timecode(t);
    timeTotal.textContent = `/ ${timecode(d)}`;
    tcLabel.textContent = timecode(t);
    if (document.activeElement !== scrub) scrub.value = String(d > 0 ? Math.round((t / d) * 1000) : 0);
    scrub.style.setProperty('--fill', `${d > 0 ? (t / d) * 100 : 0}%`);
    const playing = engine.playing;
    setIcon(playBtn, playing ? 'pause' : 'play', `${playing ? s('pause') : s('play')} (Space)`);
  }

  engine.onTick(() => {
    if (mode === 'editor') {
      paintTime();
      timeline.positionPlayhead();
      positionOutline();
    }
  });
  engine.onState(() => {
    if (mode === 'player') syncChrome();
    if (mode === 'editor') paintTime();
    if (!engine.playing && shuttleRate > 0) shuttleRate = 0;
  });

  /* ─────────────── transport actions ─────────────── */

  function seek(t: number): void {
    stopReverse();
    engine.seek(t);
    if (mode === 'editor') {
      paintTime();
      timeline.positionPlayhead();
    }
  }

  async function togglePlay(): Promise<void> {
    if (mode === 'player') {
      await player.togglePlay();
      return;
    }
    stopReverse();
    shuttleRate = 0;
    engine.setRate(1);
    if (engine.playing) engine.pause();
    else await engine.play();
    paintTime();
  }

  function stepFrames(n: number): void {
    engine.pause();
    seek(Math.max(0, Math.min(engine.duration, Math.round(engine.time * 30 + n) / 30)));
    timeline.reveal(engine.time);
  }

  function stopReverse(): void {
    if (reverseTimer) window.clearInterval(reverseTimer);
    reverseTimer = 0;
  }

  /** J/K/L: forward speeds through the engine; backward by stepping the playhead. */
  function doShuttle(key: 'J' | 'K' | 'L'): void {
    shuttleRate = shuttle(shuttleRate, key);
    stopReverse();
    if (shuttleRate === 0) {
      engine.pause();
      engine.setRate(mode === 'player' ? 1 : 1);
    } else if (shuttleRate > 0) {
      engine.setRate(shuttleRate);
      if (!engine.playing) void engine.play();
    } else {
      engine.pause();
      const rate = -shuttleRate;
      reverseTimer = window.setInterval(() => {
        const next = engine.time - 0.1 * rate;
        engine.seek(Math.max(0, next));
        if (next <= 0) { stopReverse(); shuttleRate = 0; }
      }, 100);
    }
    status(shuttleRate === 0 ? s('stopped') : s('shuttleIs', { x: shuttleRate }));
  }

  function setLoop(on: boolean): void {
    looping = on;
    loopBtn.setAttribute('aria-pressed', String(on));
    const span = selected ? clipSpan(project, selected) : null;
    engine.setLoop(on && span ? span : null, on);
    status(on ? (span ? s('loopClip') : s('loopAll')) : s('loopOff'));
  }

  function setSnap(on: boolean): void {
    snapping = on;
    snapBtn.setAttribute('aria-pressed', String(on));
    status(on ? s('snapOn') : s('snapOff'));
  }

  function toggleFullscreen(target: HTMLElement): void {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    if (typeof target.requestFullscreen !== 'function') {
      status(s('fullscreenUnsupported'));
      return;
    }
    void target.requestFullscreen().catch(() => status(s('fullscreenFailed')));
  }

  /* ─────────────── editing actions ─────────────── */

  function doSplit(): void {
    const r = splitAtPlayhead(project, engine.time, selected);
    if (!r.left) {
      status(s('splitMissed'));
      return;
    }
    history.record(project);
    project = r.project;
    selected = r.right;
    refresh();
    status(s('splitDone'));
  }

  function doDelete(): void {
    if (!selected) return;
    const next = removeClip(project, selected);
    selected = null;
    apply(next);
    status(s('deleted'));
  }

  function doDuplicate(): void {
    if (!selected) return;
    const r = duplicateClip(project, selected);
    if (!r.id) return;
    history.record(project);
    project = r.project;
    selected = r.id;
    refresh();
  }

  function doDetach(): void {
    if (!selected) return;
    const r = detachAudio(project, selected);
    if (!r.id) {
      status(s('detachNeedsVideo'));
      return;
    }
    history.record(project);
    project = r.project;
    selected = r.id;
    refresh();
    status(s('detached'));
  }

  function markEdge(edge: 'start' | 'end'): void {
    if (mode === 'player') {
      player.markHere(edge === 'start' ? 'in' : 'out');
      return;
    }
    const t = engine.time;
    let id = selected;
    if (!id || !clipSpan(project, id) || !(t > clipSpan(project, id)!.start && t < clipSpan(project, id)!.end)) {
      const main = mainTrack(project);
      const hit = main.clips.find((c) => {
        const span = clipSpan(project, c.id);
        return span && t > span.start && t < span.end;
      });
      id = hit?.id ?? null;
    }
    if (!id) {
      status(s('markMissed'));
      return;
    }
    const next = trimToPlayhead(project, id, edge, t);
    if (next !== project) {
      apply(next);
      status(edge === 'start' ? s('markedIn') : s('markedOut'));
    }
  }

  function addText(preset: TextPreset): void {
    const t = engine.time;
    const clip = makeTextClip(t, s(`preset_${preset.key}_sample`), preset.overrides);
    const track = trackFor(project, 'text', t, clip.duration);
    if (!track) return;
    history.record(project);
    project = insertClip(project, track.id, clip, t);
    selected = clip.id;
    refresh();
    inspector.show('text');
    if (narrow) openSheet(inspector.root, s('tabText'));
    status(s('textAdded'));
  }

  function applyTransitionToAll(kind: TransitionKind, duration: number): void {
    const main = mainTrack(project);
    const clips = main.clips.map((c, i) => (i === 0 || !isMedia(c) ? c : { ...c, transition: { kind, duration } }));
    apply({ ...project, tracks: project.tracks.map((t) => (t.id === main.id ? { ...t, clips } : t)) });
    status(s('transitionApplied'));
  }

  /** Puts a pool item on the timeline: a named lane when dropped, else the natural one. */
  function addToTimeline(item: MediaItem, trackId?: string, time?: number): void {
    if (item.status !== 'ready') {
      status(item.error || s('notReady'));
      return;
    }
    const target = project.tracks.find((t) => t.id === trackId);
    const at = time ?? (item.type === 'audio' ? engine.time : projectDuration(project));
    let next: Project;
    let clip: MediaClip;
    if (target && trackAccepts(target.kind, item.type)) {
      clip = makeMediaClip(item.type, item.id, item.duration, { start: at, overlay: target.kind === 'overlay' });
      next = insertClip(project, target.id, clip, at);
    } else if (item.type === 'audio') {
      clip = makeMediaClip('audio', item.id, item.duration, { start: at });
      const track = trackFor(project, 'audio', at, item.duration);
      next = track ? insertClip(project, track.id, clip, at) : project;
    } else {
      clip = makeMediaClip(item.type, item.id, item.duration);
      next = time === undefined ? appendClip(project, 'main', clip) : insertClip(project, 'main', clip, at);
    }
    if (next === project) return;
    const wasEmpty = isEmptyProject(project);
    history.record(project);
    project = next;
    if (!project.name) project = { ...project, name: baseNameWithoutExtension(item.name) };
    selected = clip.id;
    refresh();
    if (wasEmpty) timeline.fit();
    status(s('addedToTimeline', { name: item.name }));
  }

  async function captureFrame(): Promise<void> {
    const frame = mode === 'player' ? playerFrame : frameFor(project);
    try {
      const blob = await engine.captureFrame(frame);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const name = `${safeName(project.name || s('untitledProject'))}-${clockToken()}.png`;
      const path = await writeChecked(PICTURES_DIR, name, bytes);
      status(s('frameSaved', { path }));
    } catch (err) {
      status(s('saveFailed', { reason: err instanceof Error ? err.message : '' }));
    }
  }

  /* ─────────────── importing ─────────────── */

  const categories = () => [
    { key: 'video', label: s('filterVideo'), exts: VIDEO_ONLY_EXTS, icon: 'film' as const },
    { key: 'audio', label: s('filterAudio'), exts: AUDIO_EXTS, icon: 'music' as const },
    { key: 'image', label: s('filterImage'), exts: IMAGE_EXTENSIONS, icon: 'image' as const },
  ];

  async function importPaths(paths: string[]): Promise<MediaItem[]> {
    const items: MediaItem[] = [];
    for (const path of paths) {
      if (extensionOf(path).toLowerCase() === PROJECT_EXTENSION) continue;
      const item = await library.addPath(path);
      items.push(item);
      if (item.status === 'error') status(`${item.name}: ${item.error}`, true);
    }
    return items;
  }

  async function importFromFiles(filter: PoolFilter): Promise<void> {
    const cats = categories();
    const paths = await dialogs.pick({ title: s('importTitle'), categories: [{ key: 'all', label: s('filterAll'), exts: MEDIA_EXTS, icon: 'folder' }, ...cats], initial: filter, multiple: true, okLabel: s('import') });
    if (paths.length === 0) return;
    const items = await importPaths(paths);
    const ok = items.filter((i) => i.status === 'ready').length;
    if (ok) status(s('imported', { n: ok }));
  }

  async function addMusic(): Promise<void> {
    const paths = await dialogs.pick({ title: s('addMusic'), categories: [categories()[1]], multiple: true, okLabel: s('add') });
    const items = await importPaths(paths);
    for (const item of items) if (item.status === 'ready') addToTimeline(item, undefined, engine.time);
  }

  async function addToPlaylist(): Promise<void> {
    const paths = await dialogs.pick({
      title: s('addClips'),
      categories: [{ key: 'all', label: s('filterAll'), exts: MEDIA_EXTS, icon: 'folder' }, ...categories()],
      multiple: true,
      okLabel: s('add'),
    });
    const items = await importPaths(paths);
    const ready = items.filter((i) => i.status !== 'error').map((i) => i.id);
    if (ready.length) player.add(ready, false);
  }

  async function relink(item: MediaItem): Promise<void> {
    const type = item.type;
    const cat = categories().find((c) => c.key === type) ?? categories()[0];
    const [path] = await dialogs.pick({ title: s('relinkTitle', { name: item.name }), categories: [cat], multiple: false, okLabel: s('relink') });
    if (!path) return;
    const result = await library.relink(item.id, path);
    if (result?.status === 'ready') {
      status(s('relinked', { name: result.name }));
      refresh();
    }
  }

  /** Device files are copied into ~/Videos/Imported so projects can find them again. */
  async function importDeviceFile(file: File): Promise<MediaItem> {
    let saved: string | null = null;
    if (file.size <= sys.vfs.quota.file) {
      try {
        const dir = `${VIDEOS_DIR}/Imported`;
        await sys.vfs.mkdir(dir, { recursive: true });
        let name = safeName(file.name);
        if (await sys.vfs.exists(`${dir}/${name}`)) name = `${baseNameWithoutExtension(name)}-${clockToken()}${extensionOf(name)}`;
        await sys.vfs.writeFile(`${dir}/${name}`, new Uint8Array(await file.arrayBuffer()));
        saved = `${dir}/${name}`;
      } catch {
        saved = null;
      }
    }
    if (!saved) status(s('notCopied', { name: file.name }), true);
    return library.addFile(file, saved);
  }

  const deviceInput = el('input', 'fvs-fileinput');
  deviceInput.type = 'file';
  deviceInput.multiple = true;
  deviceInput.accept = [...MEDIA_EXTS, 'video/*', 'audio/*', 'image/*'].join(',');
  deviceInput.tabIndex = -1;
  deviceInput.setAttribute('aria-hidden', 'true');
  root.append(deviceInput);
  let devicePurpose: 'pool' | 'player' = 'pool';
  function pickDevice(purpose: 'pool' | 'player'): void {
    devicePurpose = purpose;
    deviceInput.value = '';
    deviceInput.click();
  }
  deviceInput.addEventListener('change', () => {
    const files = [...(deviceInput.files ?? [])];
    void (async () => {
      const items: MediaItem[] = [];
      for (const file of files) items.push(await importDeviceFile(file));
      const ids = items.filter((i) => i.status !== 'error').map((i) => i.id);
      if (devicePurpose === 'player' && ids.length) {
        setMode('player');
        player.add(ids, true);
      } else if (ids.length) status(s('imported', { n: ids.length }));
    })();
  });

  /* ─────────────── drag & drop onto the window ─────────────── */

  root.addEventListener('dragover', (event) => {
    const types = [...(event.dataTransfer?.types ?? [])];
    if (types.includes('Files') || types.includes(PATHS_MIME)) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      root.classList.add('is-dropping');
    }
  });
  root.addEventListener('dragleave', (event) => {
    if (!root.contains(event.relatedTarget as Node | null)) root.classList.remove('is-dropping');
  });
  root.addEventListener('drop', (event) => {
    root.classList.remove('is-dropping');
    const dt = event.dataTransfer;
    if (!dt || event.defaultPrevented) return;
    const types = [...dt.types];
    if (!types.includes('Files') && !types.includes(PATHS_MIME)) return;
    event.preventDefault();
    const files = [...dt.files];
    const paths = types.includes(PATHS_MIME) ? dt.getData(PATHS_MIME).split('\n').map((p) => p.trim()).filter(Boolean) : [];
    void (async () => {
      const projectFile = paths.find((p) => extensionOf(p).toLowerCase() === PROJECT_EXTENSION);
      if (projectFile) {
        await openProject(projectFile);
        return;
      }
      const items = [...(await importPaths(paths))];
      for (const f of files) items.push(await importDeviceFile(f));
      const ids = items.filter((i) => i.status !== 'error').map((i) => i.id);
      if (!ids.length) return;
      if (mode === 'editor') status(s('imported', { n: ids.length }));
      else {
        setMode('player');
        player.add(ids, true);
      }
    })();
  });

  /* ─────────────── modes ─────────────── */

  function setMode(next: Mode): void {
    if (next === mode) return;
    closeSheet();
    engine.pause();
    stopReverse();
    if (mode === 'player') player.deactivate();
    mode = next;
    work.replaceChildren(next === 'start' ? start : next === 'player' ? player.root : editor);
    if (next === 'player') {
      player.activate();
    } else if (next === 'editor') {
      stageFrame.prepend(engine.canvas);
      engine.setRate(1);
      engine.setStopAt(null);
      engine.setLoop(null, looping);
      engine.setProject(project, frameFor(project));
      timeline.render();
      inspector.refresh();
      requestAnimationFrame(() => {
        sizePreview();
        timeline.render();
        if (!isEmptyProject(project)) timeline.autoFit();
      });
    } else {
      renderStart();
    }
    syncChrome();
    requestAnimationFrame(sizePreview);
  }

  async function confirmDiscard(): Promise<boolean> {
    if (!dirty || isEmptyProject(project)) return true;
    return shellConfirm({ title: s('discardTitle'), message: s('discardBody'), okLabel: s('discard'), cancelLabel: s('cancel'), danger: true });
  }

  async function newProject(aspect: AspectKey, template?: 'intro' | 'story'): Promise<void> {
    if (!(await confirmDiscard())) return;
    project = emptyProject(aspect);
    if (template === 'intro') {
      project = insertClip(project, 'text-1', makeTextClip(0, s('templateIntroTitle'), { ...TEXT_PRESETS[0].overrides, duration: 4 }), 0);
      project = insertClip(project, 'text-1', makeTextClip(4, s('templateIntroSub'), { ...TEXT_PRESETS[1].overrides, duration: 3 }), 4);
    } else if (template === 'story') {
      project = insertClip(project, 'text-1', makeTextClip(0, s('templateStory'), { ...TEXT_PRESETS[3].overrides, y: 0.8, duration: 5 }), 0);
    }
    projectPath = null;
    history.clear();
    selected = null;
    dirty = false;
    writeJson(AUTOSAVE_KEY, null);
    setMode('editor');
    status(s('newProjectReady', { aspect: aspect === 'auto' ? s('aspectAuto') : aspect }));
  }

  async function openEditorWith(ids: string[]): Promise<void> {
    if (isEmptyProject(project)) {
      let p = emptyProject('auto', library.get(ids[0])?.name ? baseNameWithoutExtension(library.get(ids[0])!.name) : '');
      for (const id of ids) {
        const item = library.get(id);
        if (!item || item.status !== 'ready') continue;
        const clip = makeMediaClip(item.type, item.id, item.duration);
        p = item.type === 'audio' ? insertClip(p, 'audio-1', clip, projectDuration(p)) : appendClip(p, 'main', clip);
      }
      project = p;
      history.clear();
      dirty = true;
    }
    setMode('editor');
  }

  /* ─────────────── files: write with one .bak, read back ─────────────── */

  /**
   * Writes `bytes` to `dir/name` and proves it: an existing file becomes the one
   * `.bak`, the new file is read back and must be the same size, and a failure
   * puts the previous file back. Returns the path.
   */
  async function writeChecked(dir: string, name: string, bytes: Uint8Array): Promise<string> {
    if (bytes.length > sys.vfs.quota.file) {
      throw new Error(s('quotaFile', { max: formatBytes(sys.vfs.quota.file, sys.locale()) }));
    }
    const folder = normalize(dir);
    if (!folder.startsWith(HOME) && !folder.startsWith('/tmp')) throw new Error(s('outsideHome'));
    await sys.vfs.mkdir(folder, { recursive: true });
    const path = `${folder}/${name}`;
    const bak = `${path}.bak`;
    const existed = await sys.vfs.exists(path).catch(() => false);
    if (existed) {
      if (await sys.vfs.exists(bak).catch(() => false)) await sys.vfs.remove(bak);
      await sys.vfs.rename(path, bak);
    }
    try {
      await sys.vfs.writeFile(path, bytes);
      const back = await sys.vfs.stat(path);
      if (back.size !== bytes.length) throw new Error(s('verifyFailed'));
    } catch (err) {
      await sys.vfs.remove(path).catch(() => undefined);
      if (existed) await sys.vfs.rename(bak, path).catch(() => undefined);
      throw err;
    }
    return path;
  }

  /* ─────────────── project save / open ─────────────── */

  async function saveProject(saveAs = false): Promise<boolean> {
    if (mode !== 'editor') return false;
    let path = projectPath;
    if (!path || saveAs) {
      const name = await promptName(root, s('saveProjectTitle'), s('projectName'), project.name || s('untitledProject'), s('save'));
      if (!name) return false;
      path = `${VIDEOS_DIR}/${safeName(name)}${PROJECT_EXTENSION}`;
      project = { ...project, name };
    }
    const dir = dirname(path);
    try {
      const text = serializeProject(project, library.refs(), dir);
      const written = await writeChecked(dir, basename(path), new TextEncoder().encode(text));
      // Read it back and parse it before claiming success.
      const check = await sys.vfs.readText(written);
      parseProjectFile(check, dir);
      projectPath = written;
      dirty = false;
      writeJson(AUTOSAVE_KEY, null);
      rememberRecent({ path: written, name: project.name || basename(written), savedAt: Date.now() });
      syncChrome();
      status(s('projectSaved', { path: written }));
      return true;
    } catch (err) {
      status(s('saveFailed', { reason: err instanceof Error ? err.message : '' }), true);
      return false;
    }
  }

  function rememberRecent(entry: RecentProject): void {
    const list = readJson<RecentProject[]>(RECENT_KEY, []).filter((r) => r && r.path !== entry.path);
    writeJson(RECENT_KEY, [entry, ...list].slice(0, 10));
  }

  async function loadProjectText(text: string, dir: string, path: string | null): Promise<void> {
    const parsed = parseProjectFile(text, dir);
    for (const ref of parsed.media) {
      if (library.get(ref.id)?.status === 'ready') continue;
      let found = ref.path && (await sys.vfs.exists(ref.path).catch(() => false)) ? ref.path : null;
      if (!found) {
        const fallback = absoluteFallback(text, ref.id);
        if (fallback && (await sys.vfs.exists(fallback).catch(() => false))) found = fallback;
      }
      if (found) void library.addPath(found, ref.id);
      else library.addOffline(ref);
    }
    project = parsed.project;
    projectPath = path;
    history.clear();
    selected = null;
    dirty = false;
    setMode('editor');
    refresh();
    dirty = path === null;
    syncChrome();
    const offline = parsed.media.filter((m) => library.get(m.id)?.status === 'offline').length;
    if (offline) status(s('offlineMedia', { n: offline }), true);
  }

  async function openProject(path?: string): Promise<void> {
    if (!(await confirmDiscard())) return;
    let target = path;
    if (!target) {
      [target] = await dialogs.pick({ title: s('openProject'), categories: [{ key: 'project', label: s('projects'), exts: [PROJECT_EXTENSION], icon: 'layers' }], multiple: false, okLabel: s('open') });
    }
    if (!target) return;
    try {
      const text = await sys.vfs.readText(target);
      await loadProjectText(text, dirname(target), target);
      rememberRecent({ path: target, name: project.name || basename(target), savedAt: Date.now() });
      status(s('projectOpened', { name: basename(target) }));
    } catch (err) {
      const reason = err instanceof ProjectFileError ? s(`projectError_${err.reason}`) : err instanceof Error ? err.message : '';
      status(s('openFailed', { name: basename(target), reason }), true);
      if (mode === 'start') renderStart(s('openFailed', { name: basename(target), reason }));
    }
  }

  /* ─────────────── autosave ─────────────── */

  const autosaveTimer = window.setInterval(() => {
    if (!dirty || isEmptyProject(project) || closed) return;
    writeJson(AUTOSAVE_KEY, { savedAt: Date.now(), path: projectPath, text: serializeProject(project, library.refs(), '/') });
  }, AUTOSAVE_MS);

  /* ─────────────── export ─────────────── */

  function exportTarget(): { project: Project; frame: { width: number; height: number }; name: string; dir: string } {
    if (mode === 'player') {
      const media = player.currentMedia();
      return {
        project: projectFromPlayer(),
        frame: playerFrame,
        name: media ? baseNameWithoutExtension(media.name) : 'video',
        dir: media?.path ? dirname(media.path) : VIDEOS_DIR,
      };
    }
    return { project, frame: frameFor(project), name: safeName(project.name || s('untitledProject')), dir: projectPath ? dirname(projectPath) : VIDEOS_DIR };
  }

  function projectFromPlayer(): Project {
    const media = player.currentMedia();
    let p = emptyProject('auto', media?.name ?? '');
    if (!media) return p;
    if (media.type === 'audio') p = insertClip(p, 'audio-1', makeMediaClip('audio', media.id, media.duration), 0);
    else p = appendClip(p, 'main', makeMediaClip(media.type, media.id, media.duration));
    return p;
  }

  function hasPicture(p: Project): boolean {
    return p.tracks.some((t) => (t.kind === 'main' || t.kind === 'overlay' || t.kind === 'text') && t.clips.length > 0);
  }

  function openExport(range?: { start: number; end: number }, nameSuffix = ''): void {
    if (exportRunning) return;
    engine.pause();
    const target = exportTarget();
    const modal = openModal(root, s('exportTitle'), { wide: true });
    // A container is offered only when this browser can both record it AND play it
    // back: some builds record H.264 they cannot decode, which would hand the owner
    // a file this system cannot open.
    const recorderOk = (mime: string) => {
      try {
        const canRecord = typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime);
        const probeMime = mime.startsWith('video/mp4') ? 'video/mp4; codecs="avc1.42E01E"' : 'video/webm; codecs="vp8"';
        return canRecord && document.createElement('video').canPlayType(probeMime) !== '';
      } catch { return false; }
    };
    let kind: 'video' | 'audio' = hasPicture(target.project) ? 'video' : 'audio';
    const webCodecs = hasWebCodecs();
    let container: 'mp4' | 'webm' = webCodecs || recorderOk('video/mp4') ? 'mp4' : 'webm';
    // The real MP4 path (WebCodecs + mp4-muxer) is confirmed per size/rate with isConfigSupported.
    let mp4Plan: Mp4Plan | null = null;
    let mp4Key = '';
    let mp4Probing = false;
    let resolution: ResolutionKey = Math.min(target.frame.width, target.frame.height) >= 1080 ? '1080' : '720';
    let fps = 30;
    let quality: QualityKey = 'high';
    const len = range ? range.end - range.start : projectDuration(target.project);

    const form = el('div', 'fvs-export-form');
    const nameField = el('label', 'fvs-field');
    nameField.append(el('span', 'fvs-field-label', s('fileName')));
    const nameInput = el('input', 'fvs-input');
    nameInput.type = 'text';
    nameInput.dir = 'auto';
    nameInput.value = `${target.name}${nameSuffix}`;
    nameField.append(nameInput);
    const where = el('p', 'fvs-note', s('savedTo', { dir: target.dir }));
    where.dir = 'auto';
    const kindSeg = segmented(s('exportKind'), [
      { value: 'video', label: s('exportVideo') },
      { value: 'audio', label: s('exportAudioWav') },
    ], kind, (v) => { kind = v; paint(); });
    const containerRow = el('div', 'fvs-export-row');
    const resRow = el('div', 'fvs-export-row');
    const fpsRow = el('div', 'fvs-export-row');
    const qualityRow = el('div', 'fvs-export-row');
    const estimate = el('p', 'fvs-estimate');
    const notes = el('ul', 'fvs-limits is-compact');
    const progressWrap = el('div', 'fvs-progress');
    progressWrap.hidden = true;
    const bar = el('progress', 'fvs-progress-bar');
    bar.max = 1000;
    bar.value = 0;
    const progressText = el('p', 'fvs-progress-text');
    progressText.setAttribute('role', 'status');
    progressText.setAttribute('aria-live', 'polite');
    progressWrap.append(bar, progressText);
    const result = el('div', 'fvs-export-result');
    result.hidden = true;
    form.append(nameField, where, kindSeg, containerRow, resRow, fpsRow, qualityRow, estimate, notes, progressWrap, result);
    modal.body.append(form);
    const cancel = button(s('cancel'), 'fvs-btn');
    const go = button(s('exportStart'), 'fvs-btn is-primary', 'exportIcon');
    modal.actions.append(cancel, go);
    cancel.addEventListener('click', () => {
      if (exportRunning) exportRunning.abort();
      else modal.close();
    });

    const build = () => {
      containerRow.replaceChildren();
      const options: Array<{ value: 'mp4' | 'webm'; label: string }> = [];
      if (webCodecs || recorderOk('video/mp4')) options.push({ value: 'mp4', label: 'MP4 (H.264)' });
      if (recorderOk('video/webm')) options.push({ value: 'webm', label: 'WebM (VP9/VP8)' });
      if (options.length && !options.some((o) => o.value === container)) container = options[0].value;
      if (options.length) containerRow.append(segmented(s('format'), options, container, (v) => { container = v; paint(); }));
      resRow.replaceChildren(segmented(s('resolution'), [
        { value: '1080', label: '1080p' }, { value: '720', label: '720p' }, { value: '480', label: '480p' }, { value: 'source', label: s('resSource') },
      ] as Array<{ value: ResolutionKey; label: string }>, resolution, (v) => { resolution = v; paint(); }));
      fpsRow.replaceChildren(segmented(s('fps'), [{ value: '30', label: '30 fps' }, { value: '60', label: '60 fps' }], String(fps) as '30' | '60', (v) => { fps = Number(v); paint(); }));
      qualityRow.replaceChildren(segmented(s('quality'), [
        { value: 'high', label: s('qualityHigh') }, { value: 'medium', label: s('qualityMedium') }, { value: 'low', label: s('qualityLow') },
      ] as Array<{ value: QualityKey; label: string }>, quality, (v) => { quality = v; paint(); }));
    };

    const settings = () => exportSettings(target.frame, { resolution, fps, quality, container });

    const refreshMp4 = () => {
      const key = `${resolution}|${fps}|${quality}`;
      if (!webCodecs || key === mp4Key) return;
      mp4Key = key;
      mp4Plan = null;
      mp4Probing = true;
      const want = exportSettings(target.frame, { resolution, fps, quality }, () => true);
      if (!want) { mp4Probing = false; return; }
      void planMp4(target.project, { width: want.width, height: want.height, fps: want.fps, videoBitrate: want.videoBitrate, audioBitrate: want.audioBitrate })
        .catch(() => null)
        .then((plan) => {
          if (mp4Key !== key) return;
          mp4Plan = plan;
          mp4Probing = false;
          if (!exportRunning) { build(); paint(); }
        });
    };

    const paint = () => {
      const video = kind === 'video';
      containerRow.hidden = !video;
      resRow.hidden = !video;
      fpsRow.hidden = !video;
      qualityRow.hidden = !video;
      notes.replaceChildren();
      if (video) refreshMp4();
      if (video && container === 'mp4' && (mp4Plan || mp4Probing)) {
        go.disabled = mp4Probing;
        if (!mp4Plan) {
          estimate.textContent = s('mp4Checking');
          return;
        }
        const p = mp4Plan;
        const bytes = estimateExportBytes(len, p.video.bitrate, p.audio?.bitrate ?? 0);
        estimate.textContent = s('estimate', { w: p.video.width, h: p.video.height, fps: p.fps, len: formatClock(len), size: formatBytes(bytes, sys.locale()) });
        if (bytes > sys.vfs.quota.file) notes.append(el('li', 'is-warn', s('quotaWarn', { max: formatBytes(sys.vfs.quota.file, sys.locale()) })));
        notes.append(el('li', undefined, s('noteFast')));
        notes.append(el('li', undefined, s('noteMp4')));
        if (p.audioMuxer === 'opus') notes.append(el('li', undefined, s('noteOpus')));
      } else if (video) {
        const st = settings();
        if (!st) {
          estimate.textContent = s('noRecorder');
          go.disabled = true;
          return;
        }
        go.disabled = false;
        const bytes = estimateExportBytes(len, st.videoBitrate, st.audioBitrate);
        estimate.textContent = s('estimate', { w: st.width, h: st.height, fps: st.fps, len: formatClock(len), size: formatBytes(bytes, sys.locale()) });
        if (bytes > sys.vfs.quota.file) notes.append(el('li', 'is-warn', s('quotaWarn', { max: formatBytes(sys.vfs.quota.file, sys.locale()) })));
        notes.append(el('li', undefined, s('noteRealtime', { len: formatClock(len) })));
        notes.append(el('li', undefined, st.extension === '.mp4' ? s('noteMp4') : s('noteWebm')));
        if (container === 'mp4') notes.append(el('li', 'is-warn', s('noteNoWebCodecs')));
        if (st.fellBack) notes.append(el('li', 'is-warn', s('noteFellBack')));
      } else {
        go.disabled = false;
        const bytes = Math.round(len * 48000 * 4);
        estimate.textContent = s('estimateAudio', { len: formatClock(len), size: formatBytes(bytes, sys.locale()) });
        notes.append(el('li', undefined, s('noteWav')));
        if (bytes > sys.vfs.quota.file) notes.append(el('li', 'is-warn', s('quotaWarn', { max: formatBytes(sys.vfs.quota.file, sys.locale()) })));
      }
    };
    build();
    paint();

    go.addEventListener('click', () => void run());

    const run = async (): Promise<void> => {
      const name = safeName(nameInput.value || target.name);
      const controller = new AbortController();
      exportRunning = controller;
      form.classList.add('is-running');
      for (const node of [nameField, kindSeg, containerRow, resRow, fpsRow, qualityRow]) node.classList.add('is-disabled');
      nameInput.disabled = true;
      go.disabled = true;
      progressWrap.hidden = false;
      result.hidden = true;
      const started = performance.now();
      const onProgress = (fraction: number) => {
        bar.value = Math.round(fraction * 1000);
        const elapsed = (performance.now() - started) / 1000;
        const eta = fraction > 0.02 ? elapsed / fraction - elapsed : NaN;
        progressText.textContent = s('exportProgress', {
          percent: Math.round(fraction * 100),
          elapsed: formatClock(elapsed),
          eta: Number.isFinite(eta) ? formatClock(eta) : '—',
        });
      };
      onProgress(0);
      const showing = mode === 'player' ? null : project;
      try {
        if (mode !== 'player') engine.setProject(target.project, target.frame);
        let blob: Blob;
        let ext: string;
        if (kind === 'video' && container === 'mp4' && mp4Plan) {
          const p = mp4Plan;
          const out = await engine.exportVideo({
            width: p.video.width, height: p.video.height, fps: p.fps, mime: 'video/mp4',
            videoBitrate: p.video.bitrate, audioBitrate: p.audio?.bitrate ?? 0,
            range, signal: controller.signal, onProgress, mp4: p,
          });
          blob = out.blob;
          ext = '.mp4';
        } else if (kind === 'video') {
          const st = settings();
          if (!st) throw new Error(s('noRecorder'));
          const out = await engine.exportVideo({
            width: st.width, height: st.height, fps: st.fps, mime: st.mime,
            videoBitrate: st.videoBitrate, audioBitrate: st.audioBitrate,
            range, signal: controller.signal, onProgress,
          });
          blob = out.blob;
          ext = st.extension;
        } else {
          blob = await engine.exportAudio({ range, signal: controller.signal, onProgress });
          ext = '.wav';
        }
        if (controller.signal.aborted) throw new ExportCancelled();
        progressText.textContent = s('exportSaving');
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const path = await writeChecked(target.dir, `${name}${ext}`, bytes);
        // Read the file back and measure what a player will really see.
        const back = await sys.vfs.readFile(path);
        const measured = await measureDuration(new Blob([back.slice()], { type: blob.type }));
        bar.value = 1000;
        progressText.textContent = s('exportDone');
        showResult(path, back.length, measured);
      } catch (err) {
        if (err instanceof ExportCancelled || controller.signal.aborted) {
          progressText.textContent = s('exportCancelled');
          status(s('exportCancelled'));
        } else {
          progressText.textContent = s('exportFailed', { reason: err instanceof Error ? err.message : '' });
        }
        bar.value = 0;
        go.disabled = false;
        nameInput.disabled = false;
        for (const node of [nameField, kindSeg, containerRow, resRow, fpsRow, qualityRow]) node.classList.remove('is-disabled');
      } finally {
        exportRunning = null;
        form.classList.remove('is-running');
        if (showing) engine.setProject(showing, frameFor(showing));
        const label = cancel.querySelector('.fvs-btn-label');
        if (label) label.textContent = s('close');
      }
    };

    const showResult = (path: string, size: number, measured: number) => {
      result.hidden = false;
      result.replaceChildren();
      const line = el('p', 'fvs-result-line');
      line.append(icon('check'), el('span', undefined, s('exportSaved', { path, size: formatBytes(size, sys.locale()), len: measured > 0 ? formatClock(measured) : '—' })));
      line.dir = 'auto';
      const actions = el('div', 'fvs-action-row');
      const play = button(s('playExport'), 'fvs-btn is-primary', 'play');
      play.addEventListener('click', () => {
        modal.close();
        void (async () => {
          const item = await library.addPath(path);
          setMode('player');
          player.add([item.id], true);
        })();
      });
      const files = button(s('showInFiles'), 'fvs-btn', 'folder');
      files.addEventListener('click', () => void sys.apps.launch('org.faisal.Files', [dirname(path)]));
      actions.append(play, files);
      result.append(line, actions);
      go.hidden = true;
      status(s('exportSavedShort', { path }));
    };
  }

  function saveSelection(item: MediaItem, range: { start: number; end: number }): void {
    void item;
    openExport(range, `-${s('trimSuffix')}`);
  }

  /* ─────────────── menus ─────────────── */

  function menu(anchor: HTMLElement, items: Array<{ label: string; iconName?: Parameters<typeof icon>[0]; run: () => void; disabled?: boolean }>): void {
    const box = el('div', 'fvs-menu is-app');
    box.setAttribute('role', 'menu');
    const close = () => {
      box.remove();
      release();
      document.removeEventListener('pointerdown', outside, true);
      anchor.setAttribute('aria-expanded', 'false');
    };
    const outside = (e: Event) => {
      if (!box.contains(e.target as Node) && e.target !== anchor && !anchor.contains(e.target as Node)) close();
    };
    for (const item of items) {
      const b = button(item.label, 'fvs-menu-item', item.iconName);
      b.setAttribute('role', 'menuitem');
      b.disabled = Boolean(item.disabled);
      b.addEventListener('click', () => {
        close();
        anchor.focus();
        item.run();
      });
      box.append(b);
    }
    const release = pushEscapeLayer(() => { close(); anchor.focus(); });
    root.append(box);
    const a = anchor.getBoundingClientRect();
    const r = root.getBoundingClientRect();
    box.style.top = `${a.bottom - r.top + 4}px`;
    const rtl = getComputedStyle(root).direction === 'rtl';
    if (rtl) box.style.left = `${Math.max(8, a.left - r.left)}px`;
    else box.style.right = `${Math.max(8, r.right - a.right)}px`;
    anchor.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    (box.querySelector('button:not([disabled])') as HTMLElement | null)?.focus();
    box.addEventListener('keydown', (e) => {
      const list = [...box.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
      const i = list.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
      e.stopPropagation();
    });
  }

  function recorderReport(): Array<{ mime: string; ok: boolean }> {
    return ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].map((mime) => {
      let ok = false;
      try { ok = typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime); } catch { ok = false; }
      return { mime, ok };
    });
  }

  helpBtn.addEventListener('click', () => menu(helpBtn, [
    { label: s('shortcutsTitle'), iconName: 'keyboard', run: () => dialogs.shortcuts() },
    { label: s('limitsTitle'), iconName: 'help', run: () => dialogs.limits(recorderReport()) },
  ]));
  moreBtn.addEventListener('click', () => menu(moreBtn, [
    { label: s('modePlayer'), iconName: 'play', run: () => setMode('player') },
    { label: s('modeEditor'), iconName: 'layers', run: () => void openEditorWith(player.items.map((i) => i.mediaId)) },
    { label: s('save'), iconName: 'save', run: () => void saveProject(false), disabled: mode !== 'editor' },
    { label: s('saveAs'), iconName: 'save', run: () => void saveProject(true), disabled: mode !== 'editor' },
    { label: s('openProject'), iconName: 'folder', run: () => void openProject() },
    { label: s('shortcutsTitle'), iconName: 'keyboard', run: () => dialogs.shortcuts() },
    { label: s('limitsTitle'), iconName: 'help', run: () => dialogs.limits(recorderReport()) },
  ]));
  homeBtn.addEventListener('click', () => setMode('start'));
  playerModeBtn.addEventListener('click', () => setMode('player'));
  editorModeBtn.addEventListener('click', () => void openEditorWith(player.items.map((i) => i.mediaId)));
  undoBtn.addEventListener('click', undo);
  redoBtn.addEventListener('click', redo);
  saveBtn.addEventListener('click', () => void saveProject(false));
  exportBtn.addEventListener('click', () => {
    if (mode === 'player' && player.isTrimming) {
      const sel = player.selection();
      openExport(sel, `-${s('trimSuffix')}`);
    } else openExport();
  });

  /* ─────────────── direct manipulation on the preview ─────────────── */

  function canvasScale(): { sx: number; sy: number; rect: DOMRect } {
    const rect = engine.canvas.getBoundingClientRect();
    return { sx: rect.width / Math.max(1, engine.canvas.width), sy: rect.height / Math.max(1, engine.canvas.height), rect };
  }

  function positionOutline(): void {
    if (mode !== 'editor' || !selected) {
      outline.hidden = true;
      return;
    }
    const box = engine.boxes().find((b) => b.id === selected);
    if (!box) {
      outline.hidden = true;
      return;
    }
    const { sx, sy, rect } = canvasScale();
    const frameRect = stageFrame.getBoundingClientRect();
    outline.hidden = false;
    outline.style.left = `${rect.left - frameRect.left + box.rect.x * sx}px`;
    outline.style.top = `${rect.top - frameRect.top + box.rect.y * sy}px`;
    outline.style.width = `${box.rect.width * sx}px`;
    outline.style.height = `${box.rect.height * sy}px`;
    outline.classList.toggle('is-text', box.kind === 'text');
  }

  let manip: { pointerId: number; id: string; x0: number; y0: number; base: Project; resize: boolean; w0: number } | null = null;
  stageFrame.addEventListener('pointerdown', (event) => {
    if (mode !== 'editor' || event.button !== 0) return;
    const { sx, sy, rect } = canvasScale();
    const cx = (event.clientX - rect.left) / sx;
    const cy = (event.clientY - rect.top) / sy;
    const resize = event.target === outlineHandle;
    const boxes = engine.boxes();
    const hit = resize ? boxes.find((b) => b.id === selected) : [...boxes].reverse().find((b) => cx >= b.rect.x && cx <= b.rect.x + b.rect.width && cy >= b.rect.y && cy <= b.rect.y + b.rect.height);
    if (!hit) return;
    event.preventDefault();
    stageFrame.setPointerCapture(event.pointerId);
    if (selected !== hit.id) select(hit.id);
    history.begin(project);
    manip = { pointerId: event.pointerId, id: hit.id, x0: event.clientX, y0: event.clientY, base: project, resize, w0: hit.rect.width * sx };
  });
  stageFrame.addEventListener('pointermove', (event) => {
    if (!manip || manip.pointerId !== event.pointerId) return;
    const { rect } = canvasScale();
    const clip = findClip(manip.base, manip.id)?.clip;
    if (!clip) return;
    const dx = (event.clientX - manip.x0) / Math.max(1, rect.width);
    const dy = (event.clientY - manip.y0) / Math.max(1, rect.height);
    let next: Project;
    if (manip.resize) {
      const factor = Math.max(0.1, (manip.w0 + (event.clientX - manip.x0) * 2) / Math.max(1, manip.w0));
      next = clip.type === 'text'
        ? updateClip(manip.base, { ...clip, size: Math.min(0.4, Math.max(0.02, clip.size * factor)) })
        : updateClip(manip.base, { ...clip, scale: Math.min(3, Math.max(0.05, clip.scale * factor)) });
    } else {
      const clampPos = (v: number) => Math.min(1, Math.max(0, v));
      next = updateClip(manip.base, { ...clip, x: clampPos(clip.x + dx), y: clampPos(clip.y + dy) });
    }
    project = next;
    engine.setProject(project, frameFor(project));
    requestAnimationFrame(positionOutline);
  });
  const endManip = (event: PointerEvent) => {
    if (!manip || manip.pointerId !== event.pointerId) return;
    manip = null;
    history.commit(project);
    refresh();
  };
  stageFrame.addEventListener('pointerup', endManip);
  stageFrame.addEventListener('pointercancel', endManip);

  /* ─────────────── keyboard ─────────────── */

  function runShortcut(action: ShortcutAction, event: KeyboardEvent): boolean {
    const editing = mode === 'editor';
    switch (action) {
      case 'playPause': void togglePlay(); return true;
      case 'shuttleBack': doShuttle('J'); return true;
      case 'shuttleStop': doShuttle('K'); return true;
      case 'shuttleForward': doShuttle('L'); return true;
      case 'frameBack': stepFrames(-1); return true;
      case 'frameForward': stepFrames(1); return true;
      case 'secondBack': seek(engine.time - 1); return true;
      case 'secondForward': seek(engine.time + 1); return true;
      case 'goStart': seek(mode === 'player' ? player.selection().start : 0); return true;
      case 'goEnd': seek(engine.duration); return true;
      case 'markIn': markEdge('start'); return true;
      case 'markOut': markEdge('end'); return true;
      case 'split': if (editing) doSplit(); return editing;
      case 'delete': if (editing) doDelete(); return editing;
      case 'duplicate': if (editing) doDuplicate(); return editing;
      case 'undo': if (editing) undo(); return editing;
      case 'redo': if (editing) redo(); return editing;
      case 'save': void saveProject(false); return true;
      case 'saveAs': void saveProject(true); return true;
      case 'open': void openProject(); return true;
      case 'newProject': void newProject('16:9'); return true;
      case 'export': if (!exportBtn.disabled) exportBtn.click(); return true;
      case 'zoomIn': if (editing) timeline.zoomBy(1.5); return editing;
      case 'zoomOut': if (editing) timeline.zoomBy(1 / 1.5); return editing;
      case 'zoomFit': if (editing) timeline.fit(); return editing;
      case 'addText': if (editing) addText(TEXT_PRESETS[0]); return editing;
      case 'loop': if (editing) setLoop(!looping); return editing;
      case 'snap': if (editing) setSnap(!snapping); return editing;
      case 'fullscreen': toggleFullscreen(mode === 'player' ? player.stage : stage); return true;
      case 'help': dialogs.shortcuts(); return true;
      case 'escape':
        if (sheet) { closeSheet(); return true; }
        if (selected) { select(null); return true; }
        return false;
    }
    void event;
    return false;
  }

  root.addEventListener('keydown', (event) => {
    if (event.isComposing || event.defaultPrevented) return;
    const target = event.target as HTMLElement | null;
    const typing = isTypingTarget(target as HTMLInputElement | null);
    const action = matchShortcut(event);
    if (!action) return;
    if (typing && action !== 'save' && action !== 'help') {
      event.stopPropagation();
      return;
    }
    // Sliders keep their own arrows and Home/End.
    if (target instanceof HTMLInputElement && target.type === 'range' && ['frameBack', 'frameForward', 'secondBack', 'secondForward', 'goStart', 'goEnd'].includes(action)) return;
    if (mode === 'start' && !['open', 'newProject', 'help', 'escape'].includes(action)) return;
    if (runShortcut(action, event)) {
      event.preventDefault();
      event.stopPropagation();
    }
  });
  root.addEventListener('pointerdown', (event) => {
    // Keep keyboard focus inside the window, so shortcuts reach it.
    if (!(event.target as HTMLElement).closest('input, textarea, select, button, [tabindex]')) root.focus({ preventScroll: true });
  });

  /* ─────────────── start screen ─────────────── */

  function card(title: string, hint: string, iconName: Parameters<typeof icon>[0], run: () => void, extra?: HTMLElement): HTMLButtonElement {
    const b = el('button', 'fvs-start-card');
    b.type = 'button';
    const art = el('span', 'fvs-start-art');
    if (extra) art.append(extra);
    else art.append(icon(iconName));
    const text = el('span', 'fvs-start-text');
    text.append(el('span', 'fvs-start-card-title', title), el('span', 'fvs-start-card-hint', hint));
    b.append(art, text);
    b.addEventListener('click', run);
    return b;
  }

  function ratioShape(w: number, h: number): HTMLElement {
    const shape = el('span', 'fvs-ratio');
    const k = 40 / Math.max(w, h);
    shape.style.width = `${Math.round(w * k)}px`;
    shape.style.height = `${Math.round(h * k)}px`;
    return shape;
  }

  function renderStart(error?: string): void {
    start.replaceChildren();
    const hero = el('div', 'fvs-start-hero');
    const logo = el('span', 'fvs-start-logo');
    logo.append(icon('film'));
    const heroText = el('div');
    heroText.append(el('h1', 'fvs-start-title', s('title')), el('p', 'fvs-start-sub', s('startSub')));
    hero.append(logo, heroText);
    start.append(hero);
    if (error) {
      const banner = el('div', 'fvs-banner is-error');
      banner.setAttribute('role', 'alert');
      banner.append(icon('warning'), el('span', undefined, error));
      start.append(banner);
    }
    const auto = readJson<{ savedAt: number; path: string | null; text: string } | null>(AUTOSAVE_KEY, null);
    if (auto && typeof auto.text === 'string' && !(!isEmptyProject(project) && dirty)) {
      const banner = el('div', 'fvs-banner');
      const time = new Date(auto.savedAt).toLocaleString(sys.locale() === 'ar' ? 'ar' : 'en');
      banner.append(icon('save'), el('span', undefined, s('restoreAsk', { time })));
      const restore = button(s('restore'), 'fvs-btn is-primary is-small');
      restore.addEventListener('click', () => {
        void loadProjectText(auto.text, '/', auto.path).then(() => {
          dirty = true;
          syncChrome();
          status(s('restored'));
        }).catch(() => status(s('restoreFailed'), true));
      });
      const drop = button(s('discard'), 'fvs-btn is-small');
      drop.addEventListener('click', () => {
        writeJson(AUTOSAVE_KEY, null);
        banner.remove();
      });
      banner.append(restore, drop);
      start.append(banner);
    }
    if (!isEmptyProject(project)) {
      const cont = el('div', 'fvs-start-row');
      cont.append(card(s('continueEditing'), project.name || s('untitledProject'), 'layers', () => setMode('editor')));
      start.append(cont);
    }
    start.append(el('h2', 'fvs-start-h2', s('newProject')));
    const presets = el('div', 'fvs-start-grid');
    const ratios: Array<[AspectKey, number, number, string]> = [
      ['16:9', 16, 9, s('aspect169')], ['9:16', 9, 16, s('aspect916')], ['1:1', 1, 1, s('aspect11')], ['4:5', 4, 5, s('aspect45')],
    ];
    for (const [aspect, w, h, hint] of ratios) presets.append(card(aspect, hint, 'square', () => void newProject(aspect), ratioShape(w, h)));
    presets.append(card(s('templateIntro'), s('templateIntroHint'), 'text', () => void newProject('16:9', 'intro')));
    presets.append(card(s('templateStoryName'), s('templateStoryHint'), 'spark', () => void newProject('9:16', 'story')));
    start.append(presets);
    start.append(el('h2', 'fvs-start-h2', s('openSection')));
    const opens = el('div', 'fvs-start-grid is-open');
    opens.append(
      card(s('openProject'), s('openProjectHint'), 'layers', () => void openProject()),
      card(s('playVideo'), s('playVideoHint'), 'play', () => {
        void (async () => {
          const paths = await dialogs.pick({ title: s('playVideo'), categories: [{ key: 'all', label: s('filterAll'), exts: MEDIA_EXTS, icon: 'folder' }, ...categories()], multiple: true, okLabel: s('play') });
          const items = await importPaths(paths);
          const ids = items.filter((i) => i.status !== 'error').map((i) => i.id);
          if (ids.length) {
            setMode('player');
            player.add(ids, true);
          }
        })();
      }),
      card(s('importDevice'), s('importDeviceHint'), 'upload', () => pickDevice('player')),
    );
    start.append(opens);
    start.append(el('h2', 'fvs-start-h2', s('recentProjects')));
    const recents = readJson<RecentProject[]>(RECENT_KEY, []).filter((r) => r && typeof r.path === 'string');
    const recentList = el('div', 'fvs-recent-list');
    if (recents.length === 0) {
      const empty = el('div', 'fvs-empty-state is-compact is-row');
      const art = el('div', 'fvs-empty-art');
      art.append(icon('layers'));
      empty.append(art, el('p', 'fvs-empty-hint', s('noRecentProjects')));
      recentList.append(empty);
    }
    for (const r of recents) {
      const row = el('button', 'fvs-recent-row');
      row.type = 'button';
      const name = el('span', 'fvs-recent-name', r.name);
      name.dir = 'auto';
      const meta = el('span', 'fvs-recent-meta', `${r.path} · ${new Date(r.savedAt).toLocaleDateString(sys.locale() === 'ar' ? 'ar' : 'en')}`);
      meta.dir = 'ltr';
      const text = el('span', 'fvs-recent-text');
      text.append(name, meta);
      row.append(icon('layers'), text);
      row.addEventListener('click', () => void openProject(r.path));
      recentList.append(row);
    }
    start.append(recentList);
    start.append(el('h2', 'fvs-start-h2', s('recentMedia')));
    const mediaGrid = el('div', 'fvs-recent-media');
    mediaGrid.append(el('span', 'fvs-spinner'));
    start.append(mediaGrid);
    void dialogs.scan(MEDIA_EXTS).then((files: Stat[]) => {
      mediaGrid.replaceChildren();
      const top = files.slice(0, 8);
      if (top.length === 0) {
        const empty = el('div', 'fvs-empty-state is-compact is-row');
        const art = el('div', 'fvs-empty-art');
        art.append(icon('film'));
        empty.append(art, el('p', 'fvs-empty-hint', s('noRecentMedia')));
        mediaGrid.append(empty);
        return;
      }
      for (const f of top) {
        const type = mediaTypeFor(f.name) ?? 'video';
        const b = el('button', 'fvs-recent-media-item');
        b.type = 'button';
        const n = el('span', 'fvs-recent-name', f.name);
        n.dir = 'auto';
        b.append(icon(type === 'audio' ? 'music' : type === 'image' ? 'image' : 'film'), n);
        b.title = f.path;
        b.addEventListener('click', () => {
          void (async () => {
            const item = await library.addPath(f.path);
            if (item.status === 'error') {
              status(`${item.name}: ${item.error}`, true);
              return;
            }
            setMode('player');
            player.add([item.id], true);
          })();
        });
        mediaGrid.append(b);
      }
    });
  }

  /* ─────────────── close ─────────────── */

  win.setCloseGuard(async () => {
    if (exportRunning) {
      const stop = await shellConfirm({ title: s('closeExportTitle'), message: s('closeExportBody'), okLabel: s('stopAndClose'), cancelLabel: s('cancel'), danger: true });
      if (!stop) return false;
      exportRunning.abort();
    }
    if (dirty && !isEmptyProject(project)) {
      return shellConfirm({ title: s('discardTitle'), message: s('closeUnsavedBody'), okLabel: s('discard'), cancelLabel: s('cancel'), danger: true });
    }
    return true;
  });
  win.onClose(() => {
    closed = true;
    exportRunning?.abort();
    window.clearInterval(autosaveTimer);
    stopReverse();
    sizeObserver.disconnect();
    stageObserver.disconnect();
    engine.dispose();
    library.dispose();
  });

  /* ─────────────── first screen ─────────────── */

  work.append(start);
  // An editor needs room: a desktop window that opened small is maximized once
  // (the owner can restore it; on phones the shell already fills the screen).
  requestAnimationFrame(() => {
    const frameEl = win.content.closest('.faisal-window');
    const small = root.clientWidth < 960 || root.clientHeight < 600;
    if (small && window.innerWidth >= 1000 && frameEl && !frameEl.classList.contains('is-maximized')) {
      try { sys.wm.toggleMaximize(win.id); } catch { /* the shell may refuse; the compact layout still works */ }
    }
  });
  renderStart();
  syncChrome();
  queueMicrotask(() => root.focus({ preventScroll: true }));

  const first = args[0];
  if (first) {
    if (extensionOf(first).toLowerCase() === PROJECT_EXTENSION) void openProject(first);
    else {
      void (async () => {
        const item = await library.addPath(first);
        setMode('player');
        if (item.status === 'error') {
          status(`${item.name}: ${item.error}`, true);
          return;
        }
        player.add([item.id], true);
      })();
    }
  }
}

const app: AppModule = { manifest, launch };
export default app;

