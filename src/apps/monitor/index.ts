import { manifest } from './manifest';
import type { AppContext, AppModule, CatalogEntry, Permission, RunningApp } from '../../kernel/types';
import { defineStrings, t } from '../../kernel/i18n';
import { formatUptime, aggregateByTopLevel, formatBytes, clampRatio } from './helpers';
import { walkVFS } from './fs-walk';
import { drawLineChart } from './chart';
import { icon, ICONS } from './tab-icons';
import {
  collectSystemInfoAsync,
  fpsDisplay,
  isYesNoValue,
  type SystemInfoRow,
  type SystemInfoSection,
} from './system-info';
import './monitor.css';

defineStrings('monitor', {
  ar: {
    title: 'مراقب النظام',
    tabProcesses: 'العمليات',
    tabResources: 'الموارد',
    tabFilesystems: 'أنظمة الملفات',
    tabSystem: 'النظام',
    end: 'إنهاء',
    app: 'التطبيق',
    windowId: 'معرّف النافذة',
    uptime: 'مدة التشغيل',
    permissions: 'الصلاحيات',
    noProcesses: 'لا توجد تطبيقات قيد التشغيل',
    heap: 'ذاكرة JS في الصفحة',
    heapUnavailable: 'غير متاحة في هذا المتصفح',
    heapNotePageOnly: 'كومة JavaScript لهذه الصفحة (Chromium فقط) — ليست ذاكرة العتاد، ولا تُعرض على أنها كذلك.',
    fps: 'استجابة الخيط الرئيسي (FPS)',
    fpsPaused: 'متوقّف مؤقتاً لأن هذه النافذة في الخلفية — لا تُعرض قيمة قريبة من الصفر.',
    fpsResumed: 'يُقاس الآن',
    fpsMeasuring: 'جارٍ القياس — تُعرض القيمة بعد أول ثانية كاملة.',
    vfsQuotaLabel: 'حد نظام ملفات Fai$al OS (VFS)',
    storageEstimate: 'تقدير تخزين المتصفح',
    storageUnavailable: 'غير متاح في هذا المتصفح',
    refresh: 'تحديث',
    walking: 'جارٍ الفحص…',
    unavailable: 'غير متاح في هذا المتصفح',
    valueYes: 'نعم',
    valueNo: 'لا',
    systemHonestyTitle: 'ما لا يستطيع المتصفح قياسه',
    systemHonesty:
      'لا يوفّر المتصفح أي حرارة للمعالج أو كرت الرسوميات، ولا سرعة مراوح، ولا قراءات حسّاسات، ولا استهلاكاً حقيقياً لذاكرة العتاد. لذلك لا يعرض Fai$al OS أياً منها: لا عدّاد، ولا نسبة مئوية، ولا مخطط. كل صف أدناه مأخوذ من واجهة متصفح موثّقة، وكل ما لا يوفّره المتصفح يُعرض صراحةً بعبارة «غير متاح في هذا المتصفح».',
    showNoteLang: 'English',
    sectionBrowser: 'المتصفح والمنصة',
    sectionDisplay: 'الشاشة والعرض',
    sectionSystem: 'النظام',
    sectionNetwork: 'الشبكة',
    sectionStorage: 'التخزين',
    sectionRuntime: 'وقت التشغيل',
    sysBrowser: 'المتصفح',
    sysPlatform: 'المنصة',
    sysMobile: 'جهاز محمول',
    sysLanguage: 'لغة الواجهة',
    sysLanguages: 'اللغات المفضّلة',
    sysScreen: 'دقة الشاشة',
    sysDpr: 'نسبة كثافة البكسل',
    sysColorDepth: 'عمق الألوان',
    sysViewport: 'مساحة العرض الحالية',
    sysCpuThreads: 'خيوط المعالجة المتاحة',
    sysDeviceMemory: 'ذاكرة الجهاز التقريبية (بحسب المتصفح)',
    sysOnline: 'متصل بالشبكة',
    sysConnection: 'نوع الاتصال (تقديري)',
    sysRtt: 'زمن الاستجابة التقديري',
    sysSaveData: 'توفير البيانات',
    sysPersisted: 'التخزين دائم',
    sysPageUptime: 'مدة تشغيل الصفحة',
    sysTimezone: 'المنطقة الزمنية',
    sysAppsWindows: 'التطبيقات المفتوحة / النوافذ',
    noteClientHints: 'من navigator.userAgentData (تلميحات وكيل المستخدم) — دون استخراج رقم إصدار من النص.',
    noteRawUserAgent: 'من navigator.userAgent/platform كما هي — لا نستنتج إصداراً غير معلن.',
    noteClientHintsOnly: 'يوفّرها navigator.userAgentData فقط.',
    noteApproximate: 'قيمة تقريبية يبلّغ عنها المتصفح ومقرّبة، وليست قياساً لذاكرة العتاد.',
    noteOnlineEvents: 'من navigator.onLine، وتُحدَّث عند حدثي online/offline.',
    noteNetworkInformation: 'من navigator.connection (Network Information API) وهو تقدير من المتصفح.',
    noteEstimateInFileSystems: 'المساحة المستخدمة والحصة معروضتان في تبويب «أنظمة الملفات».',
    notePersistedUnavailable: 'navigator.storage.persisted غير متاح في هذا المتصفح.',
    noteTimeOrigin: 'من performance.timeOrigin مقارنةً بالوقت الحالي.',
    noteAppsFromRegistry: 'عدد التطبيقات المفتوحة / عدد النوافذ من سجل التطبيقات.',
  },
  en: {
    title: 'System Monitor',
    tabProcesses: 'Processes',
    tabResources: 'Resources',
    tabFilesystems: 'File Systems',
    tabSystem: 'System',
    end: 'End',
    app: 'Application',
    windowId: 'Window ID',
    uptime: 'Uptime',
    permissions: 'Permissions',
    noProcesses: 'No applications are running',
    heap: 'Page JavaScript heap',
    heapUnavailable: 'Not available in this browser',
    heapNotePageOnly: "This page's JavaScript heap (Chromium only) — not hardware memory, and never shown as such.",
    fps: 'Main-thread responsiveness (FPS)',
    fpsPaused: 'Paused while this window is in the background — no misleading near-zero value is shown.',
    fpsResumed: 'Measuring now',
    fpsMeasuring: 'Measuring — a value appears after the first full second.',
    vfsQuotaLabel: 'Fai$al OS VFS limit',
    storageEstimate: 'Browser storage estimate',
    storageUnavailable: 'Not available in this browser',
    refresh: 'Refresh',
    walking: 'Scanning…',
    unavailable: 'Not available in this browser',
    valueYes: 'Yes',
    valueNo: 'No',
    systemHonestyTitle: 'What the browser cannot measure',
    systemHonesty:
      'The browser exposes no CPU or GPU temperature, no fan speed, no sensor readings and no real hardware memory usage. Fai$al OS therefore displays none of them: no gauge, no percentage, no chart. Every row below comes from a documented browser API, and anything the browser does not provide is shown explicitly as "not available in this browser".',
    showNoteLang: 'العربية',
    sectionBrowser: 'Browser and platform',
    sectionDisplay: 'Screen and viewport',
    sectionSystem: 'System',
    sectionNetwork: 'Network',
    sectionStorage: 'Storage',
    sectionRuntime: 'Runtime',
    sysBrowser: 'Browser',
    sysPlatform: 'Platform',
    sysMobile: 'Mobile device',
    sysLanguage: 'Interface language',
    sysLanguages: 'Preferred languages',
    sysScreen: 'Screen resolution',
    sysDpr: 'Device pixel ratio',
    sysColorDepth: 'Colour depth',
    sysViewport: 'Current viewport',
    sysCpuThreads: 'CPU threads available',
    sysDeviceMemory: 'Approximate device memory (browser-reported)',
    sysOnline: 'Online',
    sysConnection: 'Connection type (estimated)',
    sysRtt: 'Estimated round-trip time',
    sysSaveData: 'Data saver',
    sysPersisted: 'Persistent storage',
    sysPageUptime: 'Page uptime',
    sysTimezone: 'Time zone',
    sysAppsWindows: 'Open apps / windows',
    noteClientHints: 'From navigator.userAgentData (User-Agent Client Hints) — no version is parsed out of a string.',
    noteRawUserAgent: 'The raw navigator.userAgent/platform strings — no unstated version is inferred.',
    noteClientHintsOnly: 'Provided only by navigator.userAgentData.',
    noteApproximate: 'An approximate, browser-rounded value reported by the browser — not a measurement of hardware memory.',
    noteOnlineEvents: 'From navigator.onLine, refreshed on the online/offline events.',
    noteNetworkInformation: 'From navigator.connection (Network Information API); the browser estimates these values.',
    noteEstimateInFileSystems: 'Used space and quota are shown in the File Systems tab.',
    notePersistedUnavailable: 'navigator.storage.persisted is not available in this browser.',
    noteTimeOrigin: 'From performance.timeOrigin compared with the current time.',
    noteAppsFromRegistry: 'Open applications / windows, counted from the app registry.',
  },
});

type Tab = 'processes' | 'resources' | 'filesystems' | 'system';

// Quota enforced by the Fai$al OS VFS layer itself (see src/vfs/index.ts),
// NOT by the browser. The browser's own quota comes from
// navigator.storage.estimate() and is displayed separately, labelled as such.
const VFS_QUOTA_BYTES = 50 * 1024 * 1024;
const HISTORY_LEN = 60;

interface PerformanceMemory {
  usedJSHeapSize: number;
  jsHeapSizeLimit: number;
}

/** Reads `window.performance.memory` without letting a throwing getter break the tab. */
function readHeap(): PerformanceMemory | null {
  try {
    const mem = (performance as unknown as { memory?: PerformanceMemory }).memory;
    if (!mem || typeof mem.usedJSHeapSize !== 'number' || !Number.isFinite(mem.usedJSHeapSize)) return null;
    return mem;
  } catch {
    return null;
  }
}

function launch(ctx: AppContext): void {
  const { sys, window: win } = ctx;
  win.setTitle(t('monitor.title'));

  const root = document.createElement('div');
  root.className = 'faisal-mon';

  const tabsEl = document.createElement('div');
  tabsEl.className = 'faisal-mon-tabs';
  // Four real tabs sharing one panel (the scrolling body).
  tabsEl.setAttribute('role', 'tablist');
  tabsEl.setAttribute('aria-label', t('monitor.title'));
  const bodyEl = document.createElement('div');
  bodyEl.className = 'faisal-mon-body';
  bodyEl.id = 'faisal-mon-panel';
  bodyEl.setAttribute('role', 'tabpanel');
  bodyEl.tabIndex = 0;
  root.append(tabsEl, bodyEl);
  win.content.appendChild(root);

  let tab: Tab = 'processes';
  let selectedWindowId: string | null = null;

  function tabBtn(id: Tab, label: string, svgIcon: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'faisal-mon-tab';
    b.type = 'button';
    b.id = `faisal-mon-tab-${id}`;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-controls', 'faisal-mon-panel');
    b.setAttribute('aria-selected', 'false');
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
  const systemTabBtn = tabBtn('system', t('monitor.tabSystem'), ICONS.system);
  tabsEl.append(processesTabBtn, resourcesTabBtn, fsTabBtn, systemTabBtn);

  function updateTabButtons() {
    const buttons: [Tab, HTMLButtonElement][] = [
      ['processes', processesTabBtn],
      ['resources', resourcesTabBtn],
      ['filesystems', fsTabBtn],
      ['system', systemTabBtn],
    ];
    // The `is-active` class is invisible to assistive tech: mirror it into
    // aria-selected / the roving tabindex, and point the panel at the active tab.
    for (const [id, btn] of buttons) {
      const active = id === tab;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', String(active));
      btn.tabIndex = active ? 0 : -1;
    }
    const activeBtn = buttons.find(([id]) => id === tab)?.[1];
    if (activeBtn) bodyEl.setAttribute('aria-labelledby', activeBtn.id);
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
  let fpsStatusEl: HTMLElement | null = null;

  // ── FPS sampling state: rAF only runs while the document is visible ──
  let frameCount = 0;
  let rafId = 0;
  let fpsPaused = document.hidden;
  let fpsWindowComplete = false;
  let lastFps: number | null = null;

  function chartCard(title: string): { card: HTMLElement; valueEl: HTMLElement; statusEl: HTMLElement; body: HTMLElement } {
    const card = document.createElement('div');
    card.className = 'faisal-mon-chart-card';
    const head = document.createElement('div');
    head.className = 'faisal-mon-chart-head';
    const titleEl = document.createElement('span');
    titleEl.className = 'faisal-mon-chart-title';
    titleEl.textContent = title;
    const valueEl = document.createElement('span');
    valueEl.className = 'faisal-mon-chart-value';
    // The value is repainted every sampling second. It stays readable on demand
    // (aria-live="off", not hidden), but nothing in this card may be announced
    // continuously: the canvas is aria-hidden and the status line is not a live region.
    valueEl.setAttribute('aria-live', 'off');
    head.append(titleEl, valueEl);
    const statusEl = document.createElement('div');
    statusEl.className = 'faisal-mon-chart-status';
    const body = document.createElement('div');
    body.setAttribute('aria-live', 'off');
    card.append(head, statusEl, body);
    return { card, valueEl, statusEl, body };
  }

  function buildResources() {
    resourcesRoot.replaceChildren();

    const heap = chartCard(t('monitor.heap'));
    heapValueEl = heap.valueEl;
    const heapMem = readHeap();
    if (heapMem) {
      // Page JavaScript heap only (Chromium). Never presented as hardware memory.
      heapCanvas = document.createElement('canvas');
      // The chart is a picture of numbers that are already in the text; a screen reader
      // gets nothing from the pixels, so the canvas is hidden instead of announced.
      heapCanvas.setAttribute('aria-hidden', 'true');
      heap.body.appendChild(heapCanvas);
      heap.statusEl.textContent = t('monitor.heapNotePageOnly');
    } else {
      heap.statusEl.textContent = '';
      heapValueEl.textContent = t('monitor.heapUnavailable');
      const unavail = document.createElement('div');
      unavail.className = 'faisal-mon-chart-unavailable';
      unavail.textContent = t('monitor.heapUnavailable');
      heap.body.appendChild(unavail);
    }
    resourcesRoot.appendChild(heap.card);

    const fps = chartCard(t('monitor.fps'));
    fpsValueEl = fps.valueEl;
    fpsStatusEl = fps.statusEl;
    fpsCanvas = document.createElement('canvas');
    // The FPS chart must never be announced: it redraws every second. aria-hidden keeps
    // it out of the accessibility tree entirely (see the FPS value/status note above).
    fpsCanvas.setAttribute('aria-hidden', 'true');
    fps.body.appendChild(fpsCanvas);
    resourcesRoot.appendChild(fps.card);
    updateFpsStatus();
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
    if (tab !== 'resources') return;
    const heapMem = readHeap();
    if (heapMem) {
      heapHistory.push(heapMem.usedJSHeapSize);
      if (heapHistory.length > HISTORY_LEN) heapHistory.shift();
      if (heapValueEl) heapValueEl.textContent = formatBytes(heapMem.usedJSHeapSize);
    }
    // While the page is hidden, requestAnimationFrame is throttled to ~0 fps, so a
    // sample taken now would be a misleading near-zero reading. Skip it entirely
    // and hold the last honest value; the paused status line explains why.
    // `fpsWindowComplete` does the same for a partial window after resuming.
    if (!fpsPaused) {
      const fps = Math.min(60, frameCount);
      frameCount = 0;
      if (fpsWindowComplete || lastFps === null) {
        fpsHistory.push(fps);
        if (fpsHistory.length > HISTORY_LEN) fpsHistory.shift();
        lastFps = fps;
      }
      fpsWindowComplete = true;
    }
    updateFpsStatus();
    drawResourceCharts();
  }

  // ── FPS sampling: rAF only runs while the document is visible ──
  function startFpsLoop() {
    if (rafId !== 0 || document.hidden) return;
    frameCount = 0;
    fpsWindowComplete = false;
    rafLoop();
  }

  function stopFpsLoop() {
    if (rafId !== 0) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function rafLoop() {
    frameCount++;
    rafId = requestAnimationFrame(rafLoop);
  }

  function updateFpsStatus() {
    if (!fpsStatusEl) return;
    // The decision itself is pure (see fpsDisplay) — this only paints it.
    const display = fpsDisplay(fpsHistory, document.hidden);
    fpsStatusEl.classList.toggle('is-paused', display.state === 'paused');
    if (display.state === 'paused') {
      fpsStatusEl.textContent = t('monitor.fpsPaused');
      if (fpsValueEl) fpsValueEl.textContent = '—';
    } else if (display.state === 'measuring') {
      fpsStatusEl.textContent = t('monitor.fpsMeasuring');
      if (fpsValueEl) fpsValueEl.textContent = '—';
    } else {
      fpsStatusEl.textContent = t('monitor.fpsResumed');
      if (fpsValueEl) fpsValueEl.textContent = `${display.value}`;
    }
  }

  function onVisibilityChange() {
    const hidden = document.hidden;
    if (hidden === fpsPaused) return;
    fpsPaused = hidden;
    if (hidden) {
      stopFpsLoop();
    } else {
      // A partial window after resuming is not a real reading, so the next sample
      // is held back until a full second has been counted again.
      frameCount = 0;
      fpsWindowComplete = false;
      startFpsLoop();
    }
    updateFpsStatus();
  }

  // ═══════════════════════ System ═══════════════════════

  const systemRoot = document.createElement('div');
  let systemLoaded = false;
  let systemLocale: string | null = null;
  /** value/note cells for the rows that change while the tab is open. */
  const systemLiveCells = new Map<string, { value: HTMLElement; note: HTMLElement }>();

  function yesNoText(value: string): string {
    return isYesNoValue(value) ? t(value === 'yes' ? 'monitor.valueYes' : 'monitor.valueNo') : value;
  }

  /**
   * The honesty note, shown in both languages. `t()` can only return the active
   * locale, so the two sentences live here verbatim as a `{ar, en}` pair — the
   * active locale is shown first and the toggle reveals the other one in place.
   */
  const HONESTY_NOTE: Record<'ar' | 'en', string> = {
    ar: 'المتصفح لا يكشف عن حرارة المعالج أو كرت الرسوميات، ولا سرعة المراوح، ولا قراءات الحساسات، ولا استهلاك ذاكرة العتاد الحقيقي. لذلك لا يعرض Fai$al OS أي قيمة من هذه القيم: لا مقياس ولا نسبة ولا رسم بياني. كل صف في هذه القائمة يأتي من واجهة برمجة متصفح موثّقة، وما لا توفّره يظهر صراحةً باسم «غير متاح في هذا المتصفح».',
    en: 'The browser exposes no CPU or GPU temperature, no fan speed, no sensor readings and no real hardware memory usage. Fai$al OS therefore displays none of them: no gauge, no percentage, no chart. Every row below comes from a documented browser API, and anything the browser does not provide is shown explicitly as "not available in this browser".',
  };

  function honestyNote(): HTMLElement {
    const note = document.createElement('div');
    note.className = 'faisal-mon-honesty';
    const head = document.createElement('div');
    head.className = 'faisal-mon-honesty-head';
    const titleEl = document.createElement('div');
    titleEl.className = 'faisal-mon-honesty-title';
    titleEl.textContent = t('monitor.systemHonestyTitle');

    let lang: 'ar' | 'en' = sys.locale();
    const bodyEl = document.createElement('p');
    bodyEl.className = 'faisal-mon-honesty-body';
    bodyEl.setAttribute('lang', lang);
    bodyEl.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
    bodyEl.textContent = HONESTY_NOTE[lang];

    const toggle = document.createElement('button');
    toggle.className = 'faisal-mon-honesty-lang';
    toggle.type = 'button';
    toggle.textContent = t('monitor.showNoteLang');
    toggle.addEventListener('click', () => {
      lang = lang === 'ar' ? 'en' : 'ar';
      bodyEl.setAttribute('lang', lang);
      bodyEl.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
      bodyEl.textContent = HONESTY_NOTE[lang];
    });

    head.append(titleEl, toggle);
    note.append(head, bodyEl);
    return note;
  }

  function systemSectionOrder(): SystemInfoSection[] {
    return ['browser', 'display', 'system', 'network', 'storage', 'runtime'];
  }

  function buildSystemTable(rows: SystemInfoRow[]): HTMLElement {
    systemLiveCells.clear();
    const wrap = document.createElement('div');
    wrap.appendChild(honestyNote());

    const bySection = new Map<SystemInfoSection, SystemInfoRow[]>();
    for (const section of systemSectionOrder()) bySection.set(section, []);
    for (const r of rows) {
      const bucket = bySection.get(r.section);
      if (bucket) bucket.push(r);
    }

    for (const section of systemSectionOrder()) {
      const bucket = bySection.get(section) ?? [];
      if (bucket.length === 0) continue;

      const group = document.createElement('section');
      group.className = 'faisal-mon-sys-group';
      const heading = document.createElement('h3');
      heading.className = 'faisal-mon-sys-heading';
      heading.textContent = t(`monitor.section${section.charAt(0).toUpperCase()}${section.slice(1)}`);
      group.appendChild(heading);

      const table = document.createElement('table');
      table.className = 'faisal-mon-table faisal-mon-sys-table';
      const tbody = document.createElement('tbody');
      for (const r of bucket) {
        const tr = document.createElement('tr');
        const labelTd = document.createElement('td');
        labelTd.className = 'faisal-mon-sys-label';
        labelTd.textContent = t(r.labelKey);

        const valueTd = document.createElement('td');
        valueTd.className = 'faisal-mon-sys-valuecell';
        const valueEl = document.createElement('div');
        valueEl.className = 'faisal-mon-sys-value' + (r.available ? '' : ' is-unavailable');
        valueEl.textContent = r.available && r.value !== null ? yesNoText(r.value) : t('monitor.unavailable');
        const noteEl = document.createElement('div');
        noteEl.className = 'faisal-mon-sys-note';
        noteEl.textContent = r.noteKey ? t(r.noteKey) : '';
        valueTd.append(valueEl, noteEl);

        tr.append(labelTd, valueTd);
        tbody.appendChild(tr);
        systemLiveCells.set(r.id, { value: valueEl, note: noteEl });
      }
      table.appendChild(tbody);
      group.appendChild(table);
      wrap.appendChild(group);
    }
    return wrap;
  }

  /**
   * Latest value of the rows that change: viewport size, online state and page uptime.
   * Everything else is read once and left alone. Returns null for rows that never change.
   */
  function liveSystemValue(id: string): string | null {
    if (id === 'viewport') {
      const w = typeof window === 'undefined' ? 0 : window.innerWidth;
      const h = typeof window === 'undefined' ? 0 : window.innerHeight;
      return w > 0 && h > 0 ? `${w} × ${h} px` : null;
    }
    if (id === 'online') {
      const onLine = typeof navigator === 'undefined' ? undefined : navigator.onLine;
      return typeof onLine === 'boolean' ? (onLine ? 'yes' : 'no') : null;
    }
    return null;
  }

  function refreshSystemLive() {
    if (tab !== 'system') return;
    for (const [id, cells] of systemLiveCells) {
      const next = liveSystemValue(id);
      if (next === null) continue;
      const shown = yesNoText(next);
      if (cells.value.textContent !== shown) {
        cells.value.textContent = shown;
        cells.value.classList.remove('is-unavailable');
      }
    }
  }

  async function loadSystem() {
    systemRoot.replaceChildren();
    const loading = document.createElement('div');
    loading.className = 'faisal-mon-empty';
    loading.textContent = t('monitor.walking');
    systemRoot.appendChild(loading);

    let running: RunningApp[] = [];
    try { running = sys.apps.running(); } catch { running = []; }
    const windowCount = (() => {
      try { return sys.wm.list().length; } catch { return running.length; }
    })();

    let timeZone: string | undefined;
    try { timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { timeZone = undefined; }

    const rows = await collectSystemInfoAsync({
      source: {
        navigator: typeof navigator === 'undefined' ? undefined : navigator,
        screen: typeof screen === 'undefined' ? undefined : screen,
        devicePixelRatio: typeof window === 'undefined' ? undefined : window.devicePixelRatio,
        innerWidth: typeof window === 'undefined' ? undefined : window.innerWidth,
        innerHeight: typeof window === 'undefined' ? undefined : window.innerHeight,
        onLine: typeof navigator === 'undefined' ? undefined : navigator.onLine,
        timeOrigin: typeof performance === 'undefined' ? undefined : performance.timeOrigin,
        timeZone,
      },
      appsOpen: running.length,
      windowsOpen: windowCount,
      nowMs: Date.now(),
    });

    if (tab !== 'system') return;
    systemRoot.replaceChildren(buildSystemTable(rows));
    systemLoaded = true;
    systemLocale = sys.locale();
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
    quotaLabel.textContent = t('monitor.vfsQuotaLabel');
    const quotaVal = document.createElement('span');
    // Filled in by the asynchronous scan below, so it is the status of that action.
    quotaVal.setAttribute('role', 'status');
    quotaVal.textContent = `${formatBytes(totalUsed)} / ${formatBytes(VFS_QUOTA_BYTES)}`;
    quotaRow.append(quotaLabel, quotaVal);
    const quotaTrack = document.createElement('div');
    quotaTrack.className = 'faisal-mon-fs-bar-track';
    const quotaFill = document.createElement('div');
    const ratio = clampRatio(totalUsed, VFS_QUOTA_BYTES);
    quotaFill.className = 'faisal-mon-fs-bar-fill' + (totalUsed > VFS_QUOTA_BYTES ? ' is-over' : '');
    quotaFill.style.width = `${Math.round(ratio * 100)}%`;
    quotaTrack.appendChild(quotaFill);
    summary.append(quotaRow, quotaTrack);

    // The browser's own reading is authoritative. Start from an explicit
    // "not available" value and only replace it with numbers the browser
    // actually reported — never with a placeholder or a zero.
    const estRow = document.createElement('div');
    estRow.className = 'faisal-mon-fs-bar-row';
    const estLabel = document.createElement('span');
    estLabel.textContent = t('monitor.storageEstimate');
    const estVal = document.createElement('span');
    // Resolved asynchronously from navigator.storage.estimate(): announce the answer.
    estVal.setAttribute('role', 'status');
    estVal.textContent = t('monitor.storageUnavailable');
    estRow.append(estLabel, estVal);
    summary.appendChild(estRow);
    fsRoot.appendChild(summary);

    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      try {
        const est = await navigator.storage.estimate();
        if (typeof est.usage === 'number' && typeof est.quota === 'number') {
          estVal.textContent = `${formatBytes(est.usage)} / ${formatBytes(est.quota)}`;
        }
      } catch {
        // navigator.storage.estimate can reject in restricted contexts —
        // the explicit "not available" text stays on screen.
      }
    }

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
      // Paint the status line before the first sample: an empty status for the first
      // second reads as a broken panel, and the decision does not need a frame.
      updateFpsStatus();
      drawResourceCharts();
      bodyEl.appendChild(resourcesRoot);
    } else if (tab === 'system') {
      bodyEl.appendChild(systemRoot);
      // Re-read the environment when the tab is (re)opened, or when the locale
      // changed since the last visit so the labels follow the active language.
      if (!systemLoaded || systemLocale !== sys.locale()) void loadSystem();
    } else {
      bodyEl.appendChild(fsRoot);
      if (!fsRoot.hasChildNodes()) void refreshFs();
    }
  }

  buildResources();
  updateTabButtons();
  renderTab();

  onVisibilityChange();
  document.addEventListener('visibilitychange', onVisibilityChange);

  const tickTimer = window.setInterval(() => {
    if (tab === 'processes') tickUptimes();
    if (tab === 'system') refreshSystemLive();
    sampleResources();
  }, 1000);

  const resizeObserver = new ResizeObserver(() => { if (tab === 'resources') drawResourceCharts(); });
  resizeObserver.observe(bodyEl);

  const onWindowResize = () => { refreshSystemLive(); };
  const onOnlineChange = () => { refreshSystemLive(); };
  window.addEventListener('resize', onWindowResize);
  window.addEventListener('online', onOnlineChange);
  window.addEventListener('offline', onOnlineChange);

  win.onClose(() => {
    stopFpsLoop();
    clearInterval(tickTimer);
    resizeObserver.disconnect();
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('resize', onWindowResize);
    window.removeEventListener('online', onOnlineChange);
    window.removeEventListener('offline', onOnlineChange);
  });
}

const app: AppModule = {
  manifest,
  launch,
};

export default app;
