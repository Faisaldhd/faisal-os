import { manifest } from './manifest';
import type { AppContext, AppModule, Stat } from '../../kernel/types';
import { HOME } from '../../kernel/types';
import { dirname, join } from '../../kernel/path';
import { defineStrings, t } from '../../kernel/i18n';
import { galleryOrder, clampZoom, formatDimensions, formatBytesShort } from './helpers';
import { mimeForPath } from './mime';
import { sampleImages } from './samples';
import { icon, ICONS } from './toolbar-icons';
import './images.css';

defineStrings('images', {
  ar: {
    title: 'عارض الصور',
    gallery: 'المعرض',
    prev: 'السابق',
    next: 'التالي',
    zoomIn: 'تكبير',
    zoomOut: 'تصغير',
    fit: 'ملاءمة',
    actual: 'الحجم الفعلي',
    rotate: 'تدوير',
    fullscreen: 'ملء الإطار',
    exitFullscreen: 'إنهاء ملء الإطار',
    empty: 'لا توجد صور في مجلد الصور',
    loading: 'جارٍ التحميل…',
    loadError: 'تعذّر تحميل الصورة',
  },
  en: {
    title: 'Image Viewer',
    gallery: 'Gallery',
    prev: 'Previous',
    next: 'Next',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    fit: 'Fit',
    actual: 'Actual size',
    rotate: 'Rotate',
    fullscreen: 'Fullscreen',
    exitFullscreen: 'Exit fullscreen',
    empty: 'No images in your Pictures folder',
    loading: 'Loading…',
    loadError: 'Could not load image',
  },
});

type Zoom = 'fit' | number;

async function ensureSampleImages(sys: AppContext['sys']): Promise<void> {
  const dir = join(HOME, 'Pictures');
  try {
    if (!(await sys.vfs.exists(dir))) await sys.vfs.mkdir(dir, { recursive: true });
    const entries = await sys.vfs.readdir(dir);
    if (entries.length > 0) return;
    for (const sample of sampleImages()) {
      await sys.vfs.writeFile(join(dir, sample.name), sample.svg);
    }
  } catch {
    // best-effort — an inaccessible Pictures folder just means an empty gallery
  }
}

function launch(ctx: AppContext): void {
  const { sys, window: win, args } = ctx;
  const vfs = sys.vfs;

  win.setTitle(t('images.title'));

  const root = document.createElement('div');
  root.className = 'faisal-img';

  // ---- toolbar ----
  const toolbar = document.createElement('div');
  toolbar.className = 'faisal-img-toolbar';

  function makeBtn(svgIcon: string, label: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'faisal-img-btn';
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.appendChild(icon(svgIcon));
    b.addEventListener('click', onClick);
    return b;
  }

  const galleryBtn = makeBtn(ICONS.image, t('images.gallery'), () => showGallery());
  const prevBtn = makeBtn(ICONS.prev, t('images.prev'), () => step(-1));
  const nextBtn = makeBtn(ICONS.next, t('images.next'), () => step(1));
  const metaEl = document.createElement('div');
  metaEl.className = 'faisal-img-meta';
  const spacer = document.createElement('div');
  spacer.className = 'faisal-img-spacer';
  const zoomOutBtn = makeBtn(ICONS.zoomOut, t('images.zoomOut'), () => setZoom(typeof zoom === 'number' ? zoom / 1.25 : 1 / 1.25));
  const zoomLabel = document.createElement('div');
  zoomLabel.className = 'faisal-img-zoomlabel';
  const zoomInBtn = makeBtn(ICONS.zoomIn, t('images.zoomIn'), () => setZoom(typeof zoom === 'number' ? zoom * 1.25 : 1.25));
  const fitBtn = makeBtn(ICONS.fit, t('images.fit'), () => setZoom('fit'));
  const actualBtn = makeBtn(ICONS.actual, t('images.actual'), () => setZoom(1));
  const rotateBtn = makeBtn(ICONS.rotate, t('images.rotate'), () => rotate());
  const fullscreenBtn = makeBtn(ICONS.fullscreen, t('images.fullscreen'), () => toggleFullscreen());

  toolbar.append(
    galleryBtn, prevBtn, nextBtn, metaEl, spacer,
    zoomOutBtn, zoomLabel, zoomInBtn, fitBtn, actualBtn, rotateBtn, fullscreenBtn,
  );

  // ---- viewer stage ----
  const stage = document.createElement('div');
  stage.className = 'faisal-img-stage';
  stage.tabIndex = 0;

  const frame = document.createElement('div');
  frame.className = 'faisal-img-frame';
  const imgEl = document.createElement('img');
  imgEl.alt = '';
  imgEl.draggable = false;
  frame.appendChild(imgEl);

  const prevNav = document.createElement('button');
  prevNav.className = 'faisal-img-navbtn faisal-img-prev';
  prevNav.type = 'button';
  prevNav.setAttribute('aria-label', t('images.prev'));
  prevNav.appendChild(icon(ICONS.prev));
  prevNav.addEventListener('click', () => step(-1));

  const nextNav = document.createElement('button');
  nextNav.className = 'faisal-img-navbtn faisal-img-next';
  nextNav.type = 'button';
  nextNav.setAttribute('aria-label', t('images.next'));
  nextNav.appendChild(icon(ICONS.next));
  nextNav.addEventListener('click', () => step(1));

  stage.append(frame, prevNav, nextNav);

  // ---- gallery ----
  const galleryEl = document.createElement('div');
  galleryEl.className = 'faisal-img-gallery';

  root.append(toolbar, stage, galleryEl);
  win.content.appendChild(root);

  // ---- state ----
  let mode: 'gallery' | 'viewer' = 'gallery';
  let dirPaths: string[] = [];
  let currentIndex = -1;
  let zoom: Zoom = 'fit';
  let rotation = 0;
  let fullscreen = false;
  let objectUrl: string | null = null;
  let naturalW = 0;
  let naturalH = 0;
  let loadToken = 0;
  const galleryUrls = new Map<string, string>();

  function revokeCurrent() {
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  }

  function revokeGalleryUrls() {
    for (const url of galleryUrls.values()) URL.revokeObjectURL(url);
    galleryUrls.clear();
  }

  function currentPath(): string | null {
    return currentIndex >= 0 && currentIndex < dirPaths.length ? dirPaths[currentIndex] : null;
  }

  function updateChrome() {
    root.classList.toggle('is-fullscreen', fullscreen);
    stage.style.display = mode === 'viewer' ? 'flex' : 'none';
    galleryEl.style.display = mode === 'gallery' ? 'block' : 'none';
    prevBtn.disabled = mode !== 'viewer' || currentIndex <= 0;
    nextBtn.disabled = mode !== 'viewer' || currentIndex >= dirPaths.length - 1;
    zoomOutBtn.disabled = mode !== 'viewer';
    zoomInBtn.disabled = mode !== 'viewer';
    fitBtn.disabled = mode !== 'viewer';
    actualBtn.disabled = mode !== 'viewer';
    rotateBtn.disabled = mode !== 'viewer';
    fullscreenBtn.disabled = mode !== 'viewer';
    fullscreenBtn.replaceChildren(icon(fullscreen ? ICONS.exitFullscreen : ICONS.fullscreen));
    fullscreenBtn.title = fullscreen ? t('images.exitFullscreen') : t('images.fullscreen');
  }

  function computeFitScale(): number {
    const rotated = rotation === 90 || rotation === 270;
    const effW = rotated ? naturalH : naturalW;
    const effH = rotated ? naturalW : naturalH;
    if (!effW || !effH) return 1;
    const availW = Math.max(1, stage.clientWidth - 24);
    const availH = Math.max(1, stage.clientHeight - 24);
    return Math.min(4, availW / effW, availH / effH);
  }

  function applyTransform() {
    if (!naturalW || !naturalH) return;
    const scale = clampZoom(zoom === 'fit' ? computeFitScale() : zoom);
    const rotated = rotation === 90 || rotation === 270;
    const boxW = (rotated ? naturalH : naturalW) * scale;
    const boxH = (rotated ? naturalW : naturalH) * scale;
    frame.style.width = `${boxW}px`;
    frame.style.height = `${boxH}px`;
    imgEl.style.width = `${naturalW * scale}px`;
    imgEl.style.height = `${naturalH * scale}px`;
    imgEl.style.transform = `rotate(${rotation}deg)`;
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
  }

  function setZoom(z: Zoom) {
    zoom = typeof z === 'number' ? clampZoom(z) : z;
    applyTransform();
  }

  function rotate() {
    rotation = (rotation + 90) % 360;
    applyTransform();
  }

  function toggleFullscreen() {
    fullscreen = !fullscreen;
    updateChrome();
    applyTransform();
  }

  function setMeta(name: string, size: number) {
    metaEl.textContent = `${name} — ${formatBytesShort(size)} — ${formatDimensions(naturalW, naturalH)}`;
    metaEl.title = name;
  }

  async function loadIndex(index: number) {
    const path = dirPaths[index];
    if (!path) return;
    currentIndex = index;
    const token = ++loadToken;
    rotation = 0;
    frame.classList.remove('is-loaded');
    metaEl.textContent = t('images.loading');
    win.setTitle(path.split('/').pop() ?? t('images.title'));
    try {
      const [data, stat] = await Promise.all([vfs.readFile(path), vfs.stat(path)]);
      if (token !== loadToken) return;
      revokeCurrent();
      const blob = new Blob([data.slice()], { type: mimeForPath(path) });
      objectUrl = URL.createObjectURL(blob);
      await new Promise<void>((resolve, reject) => {
        imgEl.onload = () => resolve();
        imgEl.onerror = () => reject(new Error('load-error'));
        imgEl.src = objectUrl!;
      });
      if (token !== loadToken) return;
      naturalW = imgEl.naturalWidth || 1;
      naturalH = imgEl.naturalHeight || 1;
      setMeta(stat.name, stat.size);
      applyTransform();
    } catch {
      if (token !== loadToken) return;
      metaEl.textContent = t('images.loadError');
    }
    updateChrome();
  }

  function step(delta: number) {
    if (mode !== 'viewer') return;
    const next = currentIndex + delta;
    if (next < 0 || next >= dirPaths.length) return;
    void loadIndex(next);
    updateChrome();
  }

  async function openViewer(path: string) {
    const dir = dirname(path);
    let entries: Stat[] = [];
    try {
      entries = await vfs.readdir(dir);
    } catch {
      entries = [];
    }
    let ordered = galleryOrder(entries.map((e) => ({ path: e.path, name: e.name, type: e.type })));
    if (!ordered.some((e) => e.path === path)) {
      ordered = [...ordered, { path, name: path.split('/').pop() ?? path, type: 'file' as const }]
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    }
    dirPaths = ordered.map((e) => e.path);
    mode = 'viewer';
    zoom = 'fit';
    fullscreen = false;
    const idx = dirPaths.indexOf(path);
    updateChrome();
    await loadIndex(idx < 0 ? 0 : idx);
    stage.focus();
  }

  function showGallery() {
    mode = 'gallery';
    revokeCurrent();
    loadToken++;
    updateChrome();
    void renderGallery();
  }

  let galleryObserver: IntersectionObserver | null = null;

  async function renderGallery() {
    galleryEl.replaceChildren();
    revokeGalleryUrls();
    galleryObserver?.disconnect();
    win.setTitle(t('images.title'));

    const dir = join(HOME, 'Pictures');
    let entries: Stat[] = [];
    try {
      entries = await vfs.readdir(dir);
    } catch {
      entries = [];
    }
    const images = galleryOrder(entries.map((e) => ({ path: e.path, name: e.name, type: e.type })));

    if (images.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'faisal-img-gallery-empty';
      empty.textContent = t('images.empty');
      galleryEl.appendChild(empty);
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'faisal-img-grid';

    galleryObserver = new IntersectionObserver((observed) => {
      for (const entry of observed) {
        if (!entry.isIntersecting) continue;
        const el = entry.target as HTMLElement;
        const path = el.dataset.path!;
        galleryObserver?.unobserve(el);
        void loadThumb(path, el);
      }
    }, { root: galleryEl, rootMargin: '200px' });

    for (const img of images) {
      const btn = document.createElement('button');
      btn.className = 'faisal-img-thumb';
      btn.type = 'button';
      btn.dataset.path = img.path;
      const pic = document.createElement('div');
      pic.className = 'faisal-img-thumb-pic';
      const nameEl = document.createElement('div');
      nameEl.className = 'faisal-img-thumb-name';
      nameEl.textContent = img.name;
      btn.append(pic, nameEl);
      btn.addEventListener('click', () => void openViewer(img.path));
      grid.appendChild(btn);
      galleryObserver.observe(pic);
      pic.dataset.path = img.path;
    }
    galleryEl.appendChild(grid);
  }

  async function loadThumb(path: string, container: HTMLElement) {
    try {
      const data = await vfs.readFile(path);
      const blob = new Blob([data.slice()], { type: mimeForPath(path) });
      const url = URL.createObjectURL(blob);
      galleryUrls.set(path, url);
      const im = document.createElement('img');
      im.src = url;
      im.alt = '';
      im.loading = 'lazy';
      container.replaceChildren(im);
    } catch {
      // leave the placeholder empty on failure
    }
  }

  // ---- interaction ----
  // Listened on the whole window root (not just the stage) so shortcuts still work
  // after a toolbar button has taken focus.
  root.addEventListener('keydown', (e) => {
    if (mode !== 'viewer') return;
    switch (e.key) {
      case 'ArrowRight': e.preventDefault(); step(1); break;
      case 'ArrowLeft': e.preventDefault(); step(-1); break;
      case '+': case '=': e.preventDefault(); setZoom(typeof zoom === 'number' ? zoom * 1.25 : 1.25); break;
      case '-': e.preventDefault(); setZoom(typeof zoom === 'number' ? zoom / 1.25 : 1 / 1.25); break;
      case '0': e.preventDefault(); setZoom(1); break;
      case 'Escape': if (fullscreen) { e.preventDefault(); toggleFullscreen(); } break;
      default: return;
    }
  });

  stage.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const current = typeof zoom === 'number' ? zoom : computeFitScale();
    setZoom(current * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });

  const resizeObserver = new ResizeObserver(() => { if (zoom === 'fit') applyTransform(); });
  resizeObserver.observe(stage);

  // New files in Pictures (e.g. a screenshot) show up without reopening the app.
  const unsubFs = sys.bus.on('fs:change', (ev) => {
    const pics = join(HOME, 'Pictures');
    if (mode === 'gallery' && (dirname(ev.path) === pics || (ev.oldPath && dirname(ev.oldPath) === pics))) void renderGallery();
  });

  win.onClose(() => {
    unsubFs();
    resizeObserver.disconnect();
    galleryObserver?.disconnect();
    revokeCurrent();
    revokeGalleryUrls();
  });

  // ---- boot ----
  void (async () => {
    await ensureSampleImages(sys);
    if (args[0]) {
      mode = 'viewer';
      updateChrome();
      await openViewer(args[0]);
    } else {
      updateChrome();
      await renderGallery();
    }
  })();
}

const app: AppModule = {
  manifest,
  launch,
};

export default app;
