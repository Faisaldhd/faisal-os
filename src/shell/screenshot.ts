import type { SystemAPI } from '../kernel/types';
import { HOME } from '../kernel/types';
import { join } from '../kernel/path';
import { t } from '../kernel/i18n';

export const SCREENSHOT_DIR = join(HOME, 'Pictures');

/**
 * Snipping tool (Win+Shift+S). The browser can only read the page's pixels through
 * screen capture, so each shot asks to share this tab, grabs one frame, and stops the
 * stream at once. The frozen frame is then shown full screen so the user can drag a
 * region or take the whole screen; the result is saved as a PNG in ~/Pictures.
 */
export function mountScreenshot(sys: SystemAPI): { capture(): void } {
  let busy = false;

  async function capture(): Promise<void> {
    if (busy) return;
    const md = navigator.mediaDevices;
    if (!md?.getDisplayMedia) {
      sys.notify(t('shell.shot.unsupported'));
      return;
    }
    busy = true;
    try {
      const frame = await grabFrame(md);
      if (!frame) return;
      const region = await pickRegion(frame);
      if (!region) return;
      const name = await save(crop(frame, region));
      sys.notify(t('shell.shot.saved'), name);
    } catch {
      sys.notify(t('shell.shot.failed'));
    } finally {
      busy = false;
    }
  }

  async function save(canvas: HTMLCanvasElement): Promise<string> {
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) throw new Error('toBlob failed');
    const name = fileName(new Date());
    if (!(await sys.vfs.exists(SCREENSHOT_DIR))) await sys.vfs.mkdir(SCREENSHOT_DIR, { recursive: true });
    await sys.vfs.writeFile(join(SCREENSHOT_DIR, name), new Uint8Array(await blob.arrayBuffer()));
    return name;
  }

  return { capture: () => { void capture(); } };
}

/** `Screenshot_2026-09-23_10-35-12.png` — sortable, and safe to type in the terminal. */
export function fileName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `Screenshot_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.png`;
}

/** Asks to share this tab and returns one frame, or null if the user declined. */
async function grabFrame(md: MediaDevices): Promise<HTMLCanvasElement | null> {
  let stream: MediaStream;
  try {
    stream = await md.getDisplayMedia({
      video: { displaySurface: 'browser' },
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      surfaceSwitching: 'exclude',
    } as DisplayMediaStreamOptions);
  } catch {
    return null;
  }
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    // Let the share bar settle and a fresh frame arrive before reading pixels.
    await new Promise((r) => setTimeout(r, 300));
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    return canvas;
  } finally {
    stream.getTracks().forEach((tr) => tr.stop());
  }
}

interface Rect { x: number; y: number; w: number; h: number }

export function crop(src: HTMLCanvasElement, r: Rect): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(r.w));
  out.height = Math.max(1, Math.round(r.h));
  out.getContext('2d')!.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, out.width, out.height);
  return out;
}

/** Shows the frozen frame and resolves with the chosen region in frame pixels, or null on cancel. */
function pickRegion(frame: HTMLCanvasElement): Promise<Rect | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'faisal-shot';
    overlay.tabIndex = -1;

    const scale = Math.min(window.innerWidth / frame.width, window.innerHeight / frame.height);
    frame.className = 'faisal-shot-frame';
    frame.style.width = `${frame.width * scale}px`;
    frame.style.height = `${frame.height * scale}px`;

    const stage = document.createElement('div');
    stage.className = 'faisal-shot-stage';
    stage.style.width = frame.style.width;
    stage.style.height = frame.style.height;
    const sel = document.createElement('div');
    sel.className = 'faisal-shot-sel';
    sel.hidden = true;
    stage.append(frame, sel);

    const bar = document.createElement('div');
    bar.className = 'faisal-shot-bar';
    const hint = document.createElement('span');
    hint.textContent = t('shell.shot.hint');
    const fullBtn = document.createElement('button');
    fullBtn.type = 'button';
    fullBtn.textContent = t('shell.shot.full');
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = t('shell.shot.cancel');
    bar.append(hint, fullBtn, cancelBtn);

    overlay.append(stage, bar);
    document.body.append(overlay);
    overlay.focus();

    const done = (r: Rect | null) => {
      overlay.remove();
      resolve(r);
    };
    fullBtn.addEventListener('click', () => done({ x: 0, y: 0, w: frame.width, h: frame.height }));
    cancelBtn.addEventListener('click', () => done(null));
    overlay.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); done(null); }
      else if (ev.key === 'Enter') { ev.preventDefault(); done({ x: 0, y: 0, w: frame.width, h: frame.height }); }
    });

    let start: { x: number; y: number } | null = null;
    let cur: Rect = { x: 0, y: 0, w: 0, h: 0 };
    const local = (ev: PointerEvent) => {
      const b = stage.getBoundingClientRect();
      return {
        x: Math.min(Math.max(ev.clientX - b.left, 0), b.width),
        y: Math.min(Math.max(ev.clientY - b.top, 0), b.height),
      };
    };
    stage.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      start = local(ev);
      stage.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    });
    stage.addEventListener('pointermove', (ev) => {
      if (!start) return;
      const p = local(ev);
      cur = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
      sel.hidden = false;
      Object.assign(sel.style, { left: `${cur.x}px`, top: `${cur.y}px`, width: `${cur.w}px`, height: `${cur.h}px` });
    });
    stage.addEventListener('pointerup', () => {
      if (!start) return;
      start = null;
      if (cur.w < 4 || cur.h < 4) { sel.hidden = true; return; }
      done({ x: cur.x / scale, y: cur.y / scale, w: cur.w / scale, h: cur.h / scale });
    });
  });
}
