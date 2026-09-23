import { manifest } from './manifest';
import type { AppContext, AppModule, CatalogEntry, Permission, RunningApp } from '../../kernel/types';
import { defineStrings, t } from '../../kernel/i18n';
import { formatUptime, aggregateByTopLevel, formatBytes, clampRatio } from './helpers';
import { walkVFS } from './fs-walk';
import { drawLineChart } from './chart';
import { icon, ICONS } from './tab-icons';
import './monitor.css';

defineStrings('monitor', {
  ar: {
    title: 'مراقب النظام',
    tabProcesses: 'العمليات',
    tabResources: 'الموارد',
    tabFilesystems: 'أنظمة الملفات',
    end: 'إنهاء',
    app: 'التطبيق',
    windowId: 'معرّف النافذة',
    uptime: 'مدة التشغيل',
    permissions: 'الصلاحيات',
    noProcesses: 'لا توجد تطبيقات قيد التشغيل',
    heap: 'ذاكرة JS',
    heapUnavailable: 'غير متاحة في هذا المتصفح',
    fps: 'استجابة الخيط الرئيسي (FPS)',
    quotaUsage: 'استخدام التخزين مقابل الحصة',
    storageEstimate: 'تقدير تخزين المتصفح',
    refresh: 'تحديث',
    walking: 'جارٍ الفحص…',
  },
  en: {
    title: 'System Monitor',
    tabProcesses: 'Processes',
    tabResources: 'Resources',
    tabFilesystems: 'File Systems',
    end: 'End',
    app: 'Application',
    windowId: 'Window ID',
    uptime: 'Uptime',
    permissions: 'Permissions',
    noProcesses: 'No applications are running',
    heap: 'JS heap',
    heapUnavailable: 'Not available in this browser',
    fps: 'Main-thread responsiveness (FPS)',
    quotaUsage: 'Storage used vs. quota',
    storageEstimate: 'Browser storage estimate',
    refresh: 'Refresh',
    walking: 'Scanning…',
  },
});

type Tab = 'processes' | 'resources' | 'filesystems';

const QUOTA_BYTES = 50 * 1024 * 1024;
const HISTORY_LEN = 60;

interface PerformanceMemory {
  usedJSHeapSize: number;
  jsHeapSizeLimit: number;
}

function launch(ctx: AppContext): void {
  const { sys, window: win } = ctx;
  win.setTitle(t('monitor.title'));

  const root = document.createElement('div');
  root.className = 'faisal-mon';

  const tabsEl = document.createElement('div');
  tabsEl.className = 'faisal-mon-tabs';
  const bodyEl = document.createElement('div');
  bodyEl.className = 'faisal-mon-body';
  root.append(tabsEl, bodyEl);
  win.content.appendChild(root);

  let tab: Tab = 'processes';
  let selectedWindowId: string | null = null;

  function tabBtn(id: Tab, label: string, svgIcon: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'faisal-mon-tab';
    b.type = 'button';
    b.appendChild(icon(svgIcon));
    const span = document.createElement('span');
    span.textContent = label;
    b.appendChild(span);
    b.addEventListener('click', () => setTab(id));
    return b;
  }

  const processesTabBtn = tabBtn('processes', t('monitor.tabProcesses'), ICONS.processes);
  const resourcesTabBtn = tabBtn('resources', t('monitor.tabResources'), ICONS.resources);
  const fsTabBtn = tabBtn('filesystems', t('monitor.tabFilesystems'), ICONS.filesystems);
  tabsEl.append(processesTabBtn, resourcesTabBtn, fsTabBtn);

  function updateTabButtons() {
    processesTabBtn.classList.toggle('is-active', tab === 'processes');
    resourcesTabBtn.classList.toggle('is-active', tab === 'resources');
    fsTabBtn.classList.toggle('is-active', tab === 'filesystems');
  }

  function setTab(next: Tab) {
    tab = next;
    updateTabButtons();
    renderTab();
  }

  // ═══════════════════════ Processes ═══════════════════════

  const processesRoot = document.createElement('div');

  function permLabel(p: Permission): string {
    return p;
  }

  function renderProcesses() {
    processesRoot.replaceChildren();

    const toolbar = document.createElement('div');
    toolbar.className = 'faisal-mon-toolbar';
    const endBtn = document.createElement('button');
    endBtn.className = 'faisal-mon-end-btn';
    endBtn.type = 'button';
    endBtn.textContent = t('monitor.end');
    endBtn.disabled = !selectedWindowId;
    endBtn.addEventListener('click', () => {
      if (!selectedWindowId) return;
      sys.apps.closeWindow(selectedWindowId);
      selectedWindowId = null;
      renderProcesses();
    });
    toolbar.appendChild(endBtn);
    processesRoot.appendChild(toolbar);

    let running: RunningApp[] = [];
    let catalog: CatalogEntry[] = [];
    try { running = sys.apps.running(); } catch { running = []; }
    try { catalog = sys.apps.catalog(); } catch { catalog = []; }
    const byId = new Map(catalog.map((c) => [c.id, c]));

    if (running.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'faisal-mon-empty';
      empty.textContent = t('monitor.noProcesses');
      processesRoot.appendChild(empty);
      return;
    }

    const table = document.createElement('table');
    table.className = 'faisal-mon-table';
    const thead = document.createElement('thead');
    thead.innerHTML = '';
    const headRow = document.createElement('tr');
    for (const label of [t('monitor.app'), t('monitor.windowId'), t('monitor.uptime'), t('monitor.permissions')]) {
      const th = document.createElement('th');
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const locale = sys.locale();
    for (const r of running) {
      const entry = byId.get(r.appId);
      const tr = document.createElement('tr');
      tr.classList.toggle('is-selected', r.windowId === selectedWindowId);
      tr.addEventListener('click', () => {
        selectedWindowId = r.windowId === selectedWindowId ? null : r.windowId;
        renderProcesses();
      });

      const appTd = document.createElement('td');
      const cell = document.createElement('div');
      cell.className = 'faisal-mon-appcell';
      const iconWrap = document.createElement('div');
      iconWrap.className = 'faisal-mon-appicon';
      try { iconWrap.appendChild(icon(entry?.icon ?? ICONS.app)); } catch { iconWrap.appendChild(icon(ICONS.app)); }
      const nameEl = document.createElement('span');
      nameEl.className = 'faisal-mon-appname';
      nameEl.textContent = entry ? entry.name[locale] ?? entry.name.en : r.appId;
      cell.append(iconWrap, nameEl);
      appTd.appendChild(cell);

      const winTd = document.createElement('td');
      winTd.textContent = r.windowId;

      const uptimeTd = document.createElement('td');
      uptimeTd.className = 'faisal-mon-uptime';
      uptimeTd.dataset.startedAt = String(r.startedAt);
      uptimeTd.textContent = formatUptime(Date.now() - r.startedAt);

      const permTd = document.createElement('td');
      const chips = document.createElement('div');
      chips.className = 'faisal-mon-chips';
      for (const p of entry?.permissions ?? []) {
        const chip = document.createElement('span');
        chip.className = 'faisal-mon-chip';
        chip.textContent = permLabel(p);
        chips.appendChild(chip);
      }
      permTd.appendChild(chips);

      tr.append(appTd, winTd, uptimeTd, permTd);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    processesRoot.appendChild(table);
  }

  function tickUptimes() {
    processesRoot.querySelectorAll<HTMLElement>('.faisal-mon-uptime').forEach((el) => {
      const started = Number(el.dataset.startedAt);
      el.textContent = formatUptime(Date.now() - started);
    });
  }

  // ═══════════════════════ Resources ═══════════════════════

  const resourcesRoot = document.createElement('div');
  resourcesRoot.className = 'faisal-mon-charts';

  const heapHistory: number[] = [];
  const fpsHistory: number[] = [];
  let heapCanvas: HTMLCanvasElement | null = null;
  let fpsCanvas: HTMLCanvasElement | null = null;
  let heapValueEl: HTMLElement | null = null;
  let fpsValueEl: HTMLElement | null = null;
  const hasHeap = typeof performance !== 'undefined' && !!(performance as unknown as { memory?: PerformanceMemory }).memory;

  function chartCard(title: string): { card: HTMLElement; valueEl: HTMLElement; body: HTMLElement } {
    const card = document.createElement('div');
    card.className = 'faisal-mon-chart-card';
    const head = document.createElement('div');
    head.className = 'faisal-mon-chart-head';
    const titleEl = document.createElement('span');
    titleEl.className = 'faisal-mon-chart-title';
    titleEl.textContent = title;
    const valueEl = document.createElement('span');
    valueEl.className = 'faisal-mon-chart-value';
    head.append(titleEl, valueEl);
    const body = document.createElement('div');
    card.append(head, body);
    return { card, valueEl, body };
  }

  function buildResources() {
    resourcesRoot.replaceChildren();

    const heap = chartCard(t('monitor.heap'));
    heapValueEl = heap.valueEl;
    if (hasHeap) {
      heapCanvas = document.createElement('canvas');
      heap.body.appendChild(heapCanvas);
    } else {
      const unavail = document.createElement('div');
      unavail.className = 'faisal-mon-chart-unavailable';
      unavail.textContent = t('monitor.heapUnavailable');
      heap.body.appendChild(unavail);
    }
    resourcesRoot.appendChild(heap.card);

    const fps = chartCard(t('monitor.fps'));
    fpsValueEl = fps.valueEl;
    fpsCanvas = document.createElement('canvas');
    fps.body.appendChild(fpsCanvas);
    resourcesRoot.appendChild(fps.card);
  }

  function themeColor(varName: string, fallback: string): string {
    const v = getComputedStyle(root).getPropertyValue(varName).trim();
    return v || fallback;
  }

  function drawResourceCharts() {
    const accent = themeColor('--faisal-accent', '#E3B650');
    const grid = themeColor('--faisal-border', 'rgba(255,255,255,.11)');
    if (heapCanvas) {
      drawLineChart(heapCanvas, heapHistory, { color: accent, gridColor: grid, fill: 'color-mix(in srgb, ' + accent + ' 18%, transparent)' });
    }
    if (fpsCanvas) {
      drawLineChart(fpsCanvas, fpsHistory, { color: accent, gridColor: grid, max: 60, fill: 'color-mix(in srgb, ' + accent + ' 18%, transparent)' });
    }
  }

  function sampleResources() {
    if (hasHeap) {
      const mem = (performance as unknown as { memory: PerformanceMemory }).memory;
      heapHistory.push(mem.usedJSHeapSize);
      if (heapHistory.length > HISTORY_LEN) heapHistory.shift();
      if (heapValueEl) heapValueEl.textContent = formatBytes(mem.usedJSHeapSize);
    }
    const fps = Math.min(60, frameCount);
    frameCount = 0;
    fpsHistory.push(fps);
    if (fpsHistory.length > HISTORY_LEN) fpsHistory.shift();
    if (fpsValueEl) fpsValueEl.textContent = `${fps}`;
    if (tab === 'resources') drawResourceCharts();
  }

  let frameCount = 0;
  let rafId = 0;
  function rafLoop() {
    frameCount++;
    rafId = requestAnimationFrame(rafLoop);
  }

  // ═══════════════════════ File systems ═══════════════════════

  const fsRoot = document.createElement('div');
  let fsBusy = false;

  async function refreshFs() {
    if (fsBusy) return;
    fsBusy = true;
    fsRoot.replaceChildren();
    const loading = document.createElement('div');
    loading.className = 'faisal-mon-empty';
    loading.textContent = t('monitor.walking');
    fsRoot.appendChild(loading);

    const nodes = await walkVFS(sys.vfs, '/');
    const totals = aggregateByTopLevel(nodes, '/');
    const totalUsed = [...totals.values()].reduce((a, b) => a + b, 0);
    const maxDir = Math.max(1, ...totals.values());

    fsRoot.replaceChildren();

    const toolbar = document.createElement('div');
    toolbar.className = 'faisal-mon-toolbar';
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'faisal-mon-end-btn';
    refreshBtn.type = 'button';
    refreshBtn.textContent = t('monitor.refresh');
    refreshBtn.addEventListener('click', () => void refreshFs());
    toolbar.appendChild(refreshBtn);
    fsRoot.appendChild(toolbar);

    const summary = document.createElement('div');
    summary.className = 'faisal-mon-fs-summary';

    const quotaRow = document.createElement('div');
    quotaRow.className = 'faisal-mon-fs-bar-row';
    const quotaLabel = document.createElement('span');
    quotaLabel.textContent = t('monitor.quotaUsage');
    const quotaVal = document.createElement('span');
    quotaVal.textContent = `${formatBytes(totalUsed)} / ${formatBytes(QUOTA_BYTES)}`;
    quotaRow.append(quotaLabel, quotaVal);
    const quotaTrack = document.createElement('div');
    quotaTrack.className = 'faisal-mon-fs-bar-track';
    const quotaFill = document.createElement('div');
    const ratio = clampRatio(totalUsed, QUOTA_BYTES);
    quotaFill.className = 'faisal-mon-fs-bar-fill' + (totalUsed > QUOTA_BYTES ? ' is-over' : '');
    quotaFill.style.width = `${Math.round(ratio * 100)}%`;
    quotaTrack.appendChild(quotaFill);
    summary.append(quotaRow, quotaTrack);

    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      try {
        const est = await navigator.storage.estimate();
        const estRow = document.createElement('div');
        estRow.className = 'faisal-mon-fs-bar-row';
        estRow.style.marginBlockStart = '6px';
        estRow.textContent = `${t('monitor.storageEstimate')}: ${formatBytes(est.usage ?? 0)} / ${formatBytes(est.quota ?? 0)}`;
        summary.appendChild(estRow);
      } catch {
        // navigator.storage.estimate can reject in restricted contexts — skip silently
      }
    }
    fsRoot.appendChild(summary);

    const list = document.createElement('div');
    list.className = 'faisal-mon-fs-list';
    const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    for (const [name, size] of sorted) {
      const row = document.createElement('div');
      row.className = 'faisal-mon-fs-row';
      const nameEl = document.createElement('div');
      nameEl.className = 'faisal-mon-fs-row-name';
      nameEl.textContent = `/${name}`;
      const track = document.createElement('div');
      track.className = 'faisal-mon-fs-row-track';
      const fill = document.createElement('div');
      fill.className = 'faisal-mon-fs-row-fill';
      fill.style.width = `${Math.round((size / maxDir) * 100)}%`;
      track.appendChild(fill);
      const sizeEl = document.createElement('div');
      sizeEl.className = 'faisal-mon-fs-row-size';
      sizeEl.textContent = formatBytes(size);
      row.append(nameEl, track, sizeEl);
      list.appendChild(row);
    }
    fsRoot.appendChild(list);
    fsBusy = false;
  }

  // ═══════════════════════ tab switching / lifecycle ═══════════════════════

  function renderTab() {
    bodyEl.replaceChildren();
    if (tab === 'processes') {
      renderProcesses();
      bodyEl.appendChild(processesRoot);
    } else if (tab === 'resources') {
      drawResourceCharts();
      bodyEl.appendChild(resourcesRoot);
    } else {
      bodyEl.appendChild(fsRoot);
      if (!fsRoot.hasChildNodes()) void refreshFs();
    }
  }

  buildResources();
  updateTabButtons();
  renderTab();

  rafId = requestAnimationFrame(rafLoop);
  const tickTimer = window.setInterval(() => {
    if (tab === 'processes') tickUptimes();
    sampleResources();
  }, 1000);

  const resizeObserver = new ResizeObserver(() => { if (tab === 'resources') drawResourceCharts(); });
  resizeObserver.observe(bodyEl);

  win.onClose(() => {
    cancelAnimationFrame(rafId);
    clearInterval(tickTimer);
    resizeObserver.disconnect();
  });
}

const app: AppModule = {
  manifest,
  launch,
};

export default app;
