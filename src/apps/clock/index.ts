import { manifest } from './manifest';
import type { AppContext, AppModule } from '../../kernel/types';
import { defineStrings, t, getLocale } from '../../kernel/i18n';
import { CITY_CATALOG, DEFAULT_CITY_IDS, findCity, type CityDef } from './cities';
import './clock.css';

defineStrings('clock', {
  ar: {
    title: 'الساعة',
    tabWorld: 'العالم',
    tabCalendar: 'التقويم',
    tabStopwatch: 'ساعة الإيقاف',
    tabTimer: 'المؤقت',
    addCity: 'إضافة مدينة',
    noCities: 'لا توجد مدن مضافة',
    addCityTitle: 'اختر مدينة',
    close: 'إغلاق',
    today: 'اليوم',
    tomorrow: 'غداً',
    yesterday: 'أمس',
    start: 'ابدأ',
    pause: 'إيقاف مؤقت',
    resume: 'استئناف',
    lap: 'لفة',
    reset: 'تصفير',
    lapLabel: 'لفة {n}',
    custom: 'مخصص',
    minutes: 'دقيقة',
    timerDone: 'انتهى الوقت',
    timerDoneBody: 'انتهت مدة المؤقت',
    startTimer: 'ابدأ المؤقت',
  },
  en: {
    title: 'Clock',
    tabWorld: 'World',
    tabCalendar: 'Calendar',
    tabStopwatch: 'Stopwatch',
    tabTimer: 'Timer',
    addCity: 'Add City',
    noCities: 'No cities added',
    addCityTitle: 'Choose a city',
    close: 'Close',
    today: 'Today',
    tomorrow: 'Tomorrow',
    yesterday: 'Yesterday',
    start: 'Start',
    pause: 'Pause',
    resume: 'Resume',
    lap: 'Lap',
    reset: 'Reset',
    lapLabel: 'Lap {n}',
    custom: 'Custom',
    minutes: 'min',
    timerDone: 'Time is up',
    timerDoneBody: 'Your timer has finished',
    startTimer: 'Start Timer',
  },
});

const CITIES_KEY = 'faisal.clock.cities';

function loadCityIds(): string[] {
  try {
    const raw = localStorage.getItem(CITIES_KEY);
    if (!raw) return [...DEFAULT_CITY_IDS];
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
      const valid = parsed.filter((id) => findCity(id));
      return valid.length ? valid : [...DEFAULT_CITY_IDS];
    }
  } catch { /* ignore corrupt/unavailable storage */ }
  return [...DEFAULT_CITY_IDS];
}

function saveCityIds(ids: string[]): void {
  try { localStorage.setItem(CITIES_KEY, JSON.stringify(ids)); } catch { /* ignore */ }
}

type Tab = 'world' | 'calendar' | 'stopwatch' | 'timer';

function pad2(n: number): string {
  return String(Math.trunc(n)).padStart(2, '0');
}

function hijriDayParts(date: Date): { day: number; month: string; year: number } {
  const fmt = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', { day: 'numeric', month: 'short', year: 'numeric' });
  const parts = fmt.formatToParts(date);
  const day = Number(parts.find((p) => p.type === 'day')?.value ?? 0);
  const month = parts.find((p) => p.type === 'month')?.value ?? '';
  const year = Number(parts.find((p) => p.type === 'year')?.value ?? 0);
  return { day, month, year };
}

function hijriTitle(date: Date, locale: string): string {
  const loc = locale === 'ar' ? 'ar-SA-u-ca-islamic-umalqura' : 'en-u-ca-islamic-umalqura';
  const fmt = new Intl.DateTimeFormat(loc, { month: 'long', year: 'numeric' });
  return fmt.format(date);
}

function launch(ctx: AppContext): void {
  const { window: win, sys } = ctx;

  let activeTab: Tab = 'world';
  let cityIds = loadCityIds();

  // Calendar state
  const now0 = new Date();
  let viewYear = now0.getFullYear();
  let viewMonth = now0.getMonth();

  // Stopwatch state
  let swRunning = false;
  let swStartedAt = 0; // performance.now() when (re)started
  let swAccumulated = 0; // ms accumulated before the current run
  let swLaps: number[] = [];

  // Timer state
  let timerDurationMs = 5 * 60 * 1000;
  let timerEndAt: number | null = null;
  let timerRemainingMs = timerDurationMs;
  let timerRunning = false;
  let timerDone = false;

  // Audio (created lazily after a user gesture)
  let audioCtx: AudioContext | null = null;

  const intervals: ReturnType<typeof setInterval>[] = [];

  const root = document.createElement('div');
  root.className = 'faisal-clock';

  // ── tabs ──
  const tabsBar = document.createElement('div');
  tabsBar.className = 'faisal-clock-tabs';
  // Four tabs over four panels.
  tabsBar.setAttribute('role', 'tablist');
  tabsBar.setAttribute('aria-label', t('clock.title'));
  const tabDefs: { id: Tab; label: string }[] = [
    { id: 'world', label: t('clock.tabWorld') },
    { id: 'calendar', label: t('clock.tabCalendar') },
    { id: 'stopwatch', label: t('clock.tabStopwatch') },
    { id: 'timer', label: t('clock.tabTimer') },
  ];
  const tabButtons = new Map<Tab, HTMLButtonElement>();
  for (const def of tabDefs) {
    const b = document.createElement('button');
    b.className = 'faisal-clock-tab';
    b.type = 'button';
    b.id = `faisal-clock-tab-${def.id}`;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-controls', `faisal-clock-panel-${def.id}`);
    b.setAttribute('aria-selected', 'false');
    b.textContent = def.label;
    b.addEventListener('click', () => setTab(def.id));
    tabsBar.append(b);
    tabButtons.set(def.id, b);
  }

  const panels = document.createElement('div');
  panels.className = 'faisal-clock-panels';

  // World panel
  const worldPanel = document.createElement('div');
  worldPanel.className = 'faisal-clock-panel';
  const localBlock = document.createElement('div');
  localBlock.className = 'faisal-clock-local';
  const localTime = document.createElement('div');
  localTime.className = 'faisal-clock-local-time';
  const localDate = document.createElement('div');
  localDate.className = 'faisal-clock-local-date';
  localBlock.append(localTime, localDate);

  const citiesHead = document.createElement('div');
  citiesHead.className = 'faisal-clock-cities-head';
  const citiesTitle = document.createElement('h3');
  citiesTitle.textContent = t('clock.tabWorld');
  const addCityBtn = document.createElement('button');
  addCityBtn.className = 'faisal-clock-add-btn';
  addCityBtn.textContent = t('clock.addCity');
  citiesHead.append(citiesTitle, addCityBtn);

  const cityList = document.createElement('div');
  cityList.className = 'faisal-clock-city-list';

  worldPanel.append(localBlock, citiesHead, cityList);

  // Calendar panel
  const calPanel = document.createElement('div');
  calPanel.className = 'faisal-clock-panel';
  const calHead = document.createElement('div');
  calHead.className = 'faisal-clock-cal-head';
  const calPrev = document.createElement('button');
  calPrev.className = 'faisal-clock-cal-nav';
  calPrev.textContent = '‹';
  const calTitles = document.createElement('div');
  calTitles.className = 'faisal-clock-cal-titles';
  const calTitleG = document.createElement('div');
  calTitleG.className = 'faisal-clock-cal-title-g';
  const calTitleH = document.createElement('div');
  calTitleH.className = 'faisal-clock-cal-title-h';
  calTitles.append(calTitleG, calTitleH);
  // Changing month is a user action whose only feedback was the painted title, so the
  // Gregorian title is the status region for it (the Hijri line is a second label).
  calTitleG.setAttribute('role', 'status');
  calTitleG.setAttribute('aria-live', 'polite');
  const calNext = document.createElement('button');
  calNext.className = 'faisal-clock-cal-nav';
  calNext.textContent = '›';
  calHead.append(calPrev, calTitles, calNext);
  const calGrid = document.createElement('div');
  calGrid.className = 'faisal-clock-cal-grid';
  calGrid.setAttribute('role', 'grid');
  calGrid.setAttribute('aria-label', t('clock.tabCalendar'));
  calPanel.append(calHead, calGrid);

  // Stopwatch panel
  const swPanel = document.createElement('div');
  swPanel.className = 'faisal-clock-panel';
  const swWrap = document.createElement('div');
  swWrap.className = 'faisal-clock-sw';
  const swTime = document.createElement('div');
  swTime.className = 'faisal-clock-sw-time';
  swTime.textContent = '00:00.00';
  const swBtnRow = document.createElement('div');
  swBtnRow.className = 'faisal-clock-btn-row';
  const swStartBtn = document.createElement('button');
  swStartBtn.className = 'faisal-clock-btn is-primary';
  swStartBtn.textContent = t('clock.start');
  const swLapBtn = document.createElement('button');
  swLapBtn.className = 'faisal-clock-btn';
  swLapBtn.textContent = t('clock.lap');
  swLapBtn.disabled = true;
  const swResetBtn = document.createElement('button');
  swResetBtn.className = 'faisal-clock-btn';
  swResetBtn.textContent = t('clock.reset');
  swBtnRow.append(swStartBtn, swLapBtn, swResetBtn);
  const swLapsEl = document.createElement('div');
  swLapsEl.className = 'faisal-clock-laps';
  swWrap.append(swTime, swBtnRow, swLapsEl);
  swPanel.append(swWrap);

  // Timer panel
  const timerPanel = document.createElement('div');
  timerPanel.className = 'faisal-clock-panel';
  const timerWrap = document.createElement('div');
  timerWrap.className = 'faisal-clock-timer';
  const timerTimeEl = document.createElement('div');
  timerTimeEl.className = 'faisal-clock-timer-time';
  // The countdown is repainted four times a second; it must not be a live region.
  // Timer completion is announced by the notification in onTimerFinished().
  timerTimeEl.setAttribute('aria-live', 'off');
  const presetsRow = document.createElement('div');
  presetsRow.className = 'faisal-clock-presets';
  const PRESETS = [1, 5, 10, 25];
  const presetButtons: HTMLButtonElement[] = [];
  for (const m of PRESETS) {
    const b = document.createElement('button');
    b.className = 'faisal-clock-preset';
    b.textContent = `${m} ${t('clock.minutes')}`;
    b.addEventListener('click', () => { if (!timerRunning) setTimerMinutes(m); });
    presetsRow.append(b);
    presetButtons.push(b);
  }
  const customRow = document.createElement('div');
  customRow.className = 'faisal-clock-custom';
  const customInput = document.createElement('input');
  customInput.type = 'number';
  customInput.min = '1';
  customInput.max = '180';
  customInput.placeholder = '15';
  const customBtn = document.createElement('button');
  customBtn.className = 'faisal-clock-preset';
  customBtn.textContent = t('clock.custom');
  customBtn.addEventListener('click', () => {
    const v = Number(customInput.value);
    if (Number.isFinite(v) && v > 0 && !timerRunning) setTimerMinutes(v);
  });
  customRow.append(customInput, customBtn);
  const timerBtnRow = document.createElement('div');
  timerBtnRow.className = 'faisal-clock-btn-row';
  const timerStartBtn = document.createElement('button');
  timerStartBtn.className = 'faisal-clock-btn is-primary';
  timerStartBtn.textContent = t('clock.startTimer');
  const timerResetBtn = document.createElement('button');
  timerResetBtn.className = 'faisal-clock-btn';
  timerResetBtn.textContent = t('clock.reset');
  timerBtnRow.append(timerStartBtn, timerResetBtn);
  timerWrap.append(timerTimeEl, presetsRow, customRow, timerBtnRow);
  timerPanel.append(timerWrap);

  panels.append(worldPanel, calPanel, swPanel, timerPanel);
  root.append(tabsBar, panels);
  win.content.append(root);

  // One panel per tab, wired to its tab button (see setTab for the state mirror).
  for (const def of tabDefs) {
    const panel = { world: worldPanel, calendar: calPanel, stopwatch: swPanel, timer: timerPanel }[def.id];
    panel.id = `faisal-clock-panel-${def.id}`;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', `faisal-clock-tab-${def.id}`);
    panel.tabIndex = 0;
  }

  const panelMap: Record<Tab, HTMLElement> = {
    world: worldPanel, calendar: calPanel, stopwatch: swPanel, timer: timerPanel,
  };

  function setTab(tab: Tab) {
    activeTab = tab;
    // The `is-active` class is invisible to assistive tech: mirror it into
    // aria-selected / the roving tabindex, and hide the panels that are not shown.
    for (const [id, btn] of tabButtons) {
      const active = id === tab;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', String(active));
      btn.tabIndex = active ? 0 : -1;
    }
    for (const [id, panel] of Object.entries(panelMap) as [Tab, HTMLElement][]) {
      panel.classList.toggle('is-active', id === tab);
      // `display: none` alone hides a panel visually; `aria-hidden` says the same to a
      // screen reader, so the four value displays are never read as one blob.
      panel.setAttribute('aria-hidden', String(id !== tab));
    }
    if (tab === 'calendar') renderCalendar();
  }

  // ── world tab rendering ──
  function relativeDayLabel(cityDate: Date, localDate: Date): string {
    const a = new Date(cityDate.getFullYear(), cityDate.getMonth(), cityDate.getDate()).getTime();
    const b = new Date(localDate.getFullYear(), localDate.getMonth(), localDate.getDate()).getTime();
    const diffDays = Math.round((a - b) / 86400000);
    if (diffDays === 0) return t('clock.today');
    if (diffDays === 1) return t('clock.tomorrow');
    if (diffDays === -1) return t('clock.yesterday');
    return '';
  }

  function renderWorld() {
    const nowD = new Date();
    const locale = getLocale() === 'ar' ? 'ar-SA-u-ca-gregory' : 'en-US';
    localTime.textContent = nowD.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    localTime.dir = 'ltr';
    localDate.textContent = nowD.toLocaleDateString(locale, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    cityList.replaceChildren();
    if (cityIds.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'faisal-clock-empty';
      empty.textContent = t('clock.noCities');
      cityList.append(empty);
      return;
    }
    for (const id of cityIds) {
      const city = findCity(id);
      if (!city) continue;
      const row = document.createElement('div');
      row.className = 'faisal-clock-city-row';

      const info = document.createElement('div');
      const nameEl = document.createElement('div');
      nameEl.className = 'faisal-clock-city-name';
      nameEl.textContent = getLocale() === 'ar' ? city.name.ar : city.name.en;
      const sub = document.createElement('div');
      sub.className = 'faisal-clock-city-sub';
      let cityNow: Date;
      let timeStr: string;
      try {
        timeStr = nowD.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', timeZone: city.tz });
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone: city.tz, year: 'numeric', month: 'numeric', day: 'numeric',
        }).formatToParts(nowD);
        const y = Number(parts.find((p) => p.type === 'year')?.value);
        const m = Number(parts.find((p) => p.type === 'month')?.value) - 1;
        const d = Number(parts.find((p) => p.type === 'day')?.value);
        cityNow = new Date(y, m, d);
      } catch {
        timeStr = '—';
        cityNow = nowD;
      }
      sub.textContent = relativeDayLabel(cityNow, nowD);
      info.append(nameEl, sub);

      const timeEl = document.createElement('div');
      timeEl.className = 'faisal-clock-city-time';
      timeEl.textContent = timeStr;

      const removeBtn = document.createElement('button');
      removeBtn.className = 'faisal-clock-city-remove';
      removeBtn.textContent = '×';
      removeBtn.setAttribute('aria-label', t('clock.close'));
      removeBtn.addEventListener('click', () => {
        cityIds = cityIds.filter((x) => x !== id);
        saveCityIds(cityIds);
        renderWorld();
      });

      row.append(info, timeEl, removeBtn);
      cityList.append(row);
    }
  }

  let addDialogEl: HTMLElement | null = null;
  function openAddCityDialog() {
    if (addDialogEl) return;
    const overlay = document.createElement('div');
    overlay.className = 'faisal-clock-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'faisal-clock-dialog';
    const head = document.createElement('div');
    head.className = 'faisal-clock-dialog-head';
    const title = document.createElement('span');
    title.textContent = t('clock.addCityTitle');
    const closeBtn = document.createElement('button');
    closeBtn.className = 'faisal-clock-dialog-close';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', closeDialog);
    head.append(title, closeBtn);
    const list = document.createElement('div');
    list.className = 'faisal-clock-dialog-list';
    for (const city of CITY_CATALOG) {
      const already = cityIds.includes(city.id);
      const item = document.createElement('button');
      item.className = 'faisal-clock-dialog-item';
      item.textContent = getLocale() === 'ar' ? city.name.ar : city.name.en;
      item.disabled = already;
      item.addEventListener('click', () => {
        if (!cityIds.includes(city.id)) {
          cityIds = [...cityIds, city.id];
          saveCityIds(cityIds);
          renderWorld();
        }
        closeDialog();
      });
      list.append(item);
    }
    dialog.append(head, list);
    overlay.append(dialog);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDialog(); });
    root.append(overlay);
    addDialogEl = overlay;
  }
  function closeDialog() {
    addDialogEl?.remove();
    addDialogEl = null;
  }
  addCityBtn.addEventListener('click', openAddCityDialog);

  // ── calendar tab ──
  function renderCalendar() {
    const locale = getLocale() === 'ar' ? 'ar-SA-u-ca-gregory' : 'en-US';
    const first = new Date(viewYear, viewMonth, 1);
    calTitleG.textContent = first.toLocaleDateString(locale, { month: 'long', year: 'numeric' });
    calTitleH.textContent = hijriTitle(new Date(viewYear, viewMonth, 15), getLocale());

    calGrid.replaceChildren();
    const dowFmt = new Intl.DateTimeFormat(locale, { weekday: 'narrow', timeZone: 'UTC' });
    const dowLong = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' });
    const dayFmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' });
    // The calendar really is a 7-column grid of dated cells, so it is exposed as one:
    // a column-header row, then one row per week with a labelled gridcell per day.
    const headerRow = document.createElement('div');
    headerRow.className = 'faisal-clock-cal-row';
    headerRow.setAttribute('role', 'row');
    // Week starts Sunday (day 0). Use a fixed UTC Sunday reference to avoid TZ drift.
    for (let i = 0; i < 7; i++) {
      const label = document.createElement('div');
      label.className = 'faisal-clock-cal-dow';
      const ref = new Date(Date.UTC(2023, 0, 1 + i)); // 2023-01-01 was a Sunday
      label.textContent = dowFmt.format(ref);
      label.setAttribute('role', 'columnheader');
      label.setAttribute('aria-label', dowLong.format(ref));
      headerRow.append(label);
    }
    calGrid.append(headerRow);

    const startWeekday = first.getDay(); // 0 = Sunday
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const today = new Date();
    const totalCells = Math.ceil((startWeekday + daysInMonth) / 7) * 7;

    let weekRow: HTMLElement | null = null;
    for (let cellIdx = 0; cellIdx < totalCells; cellIdx++) {
      if (cellIdx % 7 === 0) {
        weekRow = document.createElement('div');
        weekRow.className = 'faisal-clock-cal-row';
        weekRow.setAttribute('role', 'row');
        calGrid.append(weekRow);
      }
      const dayNum = cellIdx - startWeekday + 1;
      const cellDate = new Date(viewYear, viewMonth, dayNum);
      const outside = dayNum < 1 || dayNum > daysInMonth;
      const isToday = !outside
        && cellDate.getFullYear() === today.getFullYear()
        && cellDate.getMonth() === today.getMonth()
        && cellDate.getDate() === today.getDate();

      const cell = document.createElement('div');
      cell.className = 'faisal-clock-cal-cell' + (outside ? ' is-outside' : '') + (isToday ? ' is-today' : '');
      cell.setAttribute('role', 'gridcell');
      // Each cell shows a Gregorian day and a Hijri day with no visible month, so the
      // accessible name spells both out in full.
      const hijri = hijriDayParts(cellDate);
      const parts = [dayFmt.format(cellDate), hijri.month];
      if (isToday) parts.push(t('clock.today'));
      cell.setAttribute('aria-label', parts.join(' · '));
      const g = document.createElement('div');
      g.className = 'faisal-clock-cal-g';
      g.textContent = String(cellDate.getDate());
      const h = document.createElement('div');
      h.className = 'faisal-clock-cal-h';
      h.textContent = String(hijri.day);
      cell.append(g, h);
      weekRow?.append(cell);
    }
  }

  calPrev.addEventListener('click', () => {
    viewMonth -= 1;
    if (viewMonth < 0) { viewMonth = 11; viewYear -= 1; }
    renderCalendar();
  });
  calNext.addEventListener('click', () => {
    viewMonth += 1;
    if (viewMonth > 11) { viewMonth = 0; viewYear += 1; }
    renderCalendar();
  });

  // ── stopwatch ──
  function swElapsedMs(): number {
    return swAccumulated + (swRunning ? performance.now() - swStartedAt : 0);
  }

  function formatStopwatch(ms: number): string {
    const totalCs = Math.floor(ms / 10);
    const cs = totalCs % 100;
    const totalSec = Math.floor(totalCs / 100);
    const sec = totalSec % 60;
    const min = Math.floor(totalSec / 60);
    return `${pad2(min)}:${pad2(sec)}.${pad2(cs)}`;
  }

  function renderStopwatch() {
    swTime.textContent = formatStopwatch(swElapsedMs());
  }

  function renderLaps() {
    swLapsEl.replaceChildren();
    for (let i = 0; i < swLaps.length; i++) {
      const row = document.createElement('div');
      row.className = 'faisal-clock-lap-row';
      const label = document.createElement('span');
      label.textContent = t('clock.lapLabel', { n: swLaps.length - i });
      const time = document.createElement('span');
      time.textContent = formatStopwatch(swLaps[swLaps.length - 1 - i]);
      row.append(label, time);
      swLapsEl.append(row);
    }
  }

  swStartBtn.addEventListener('click', () => {
    if (!swRunning) {
      swRunning = true;
      swStartedAt = performance.now();
      swStartBtn.textContent = t('clock.pause');
      swStartBtn.classList.remove('is-primary');
      swLapBtn.disabled = false;
    } else {
      swAccumulated += performance.now() - swStartedAt;
      swRunning = false;
      swStartBtn.textContent = t('clock.resume');
      swStartBtn.classList.add('is-primary');
    }
  });
  swLapBtn.addEventListener('click', () => {
    if (!swRunning) return;
    swLaps.push(swElapsedMs());
    renderLaps();
  });
  swResetBtn.addEventListener('click', () => {
    swRunning = false;
    swAccumulated = 0;
    swLaps = [];
    swStartBtn.textContent = t('clock.start');
    swStartBtn.classList.add('is-primary');
    swLapBtn.disabled = true;
    renderLaps();
    renderStopwatch();
  });

  // ── timer ──
  function formatCountdown(ms: number): string {
    const totalSec = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return h > 0 ? `${pad2(h)}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
  }

  function setTimerMinutes(min: number) {
    timerDurationMs = min * 60 * 1000;
    timerRemainingMs = timerDurationMs;
    timerDone = false;
    timerTimeEl.classList.remove('is-done');
    for (const b of presetButtons) b.classList.toggle('is-active', Number(b.textContent?.split(' ')[0]) === min);
    renderTimer();
  }

  function renderTimer() {
    timerTimeEl.textContent = formatCountdown(timerRemainingMs);
    timerTimeEl.classList.toggle('is-done', timerDone);
  }

  function ensureAudio(): AudioContext | null {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      if (audioCtx.state === 'suspended') void audioCtx.resume();
      return audioCtx;
    } catch { return null; }
  }

  function beep() {
    const ctxA = audioCtx;
    if (!ctxA) return;
    const now = ctxA.currentTime;
    for (let i = 0; i < 3; i++) {
      const osc = ctxA.createOscillator();
      const gain = ctxA.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      const start = now + i * 0.28;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
      osc.connect(gain).connect(ctxA.destination);
      osc.start(start);
      osc.stop(start + 0.24);
    }
  }

  function onTimerFinished() {
    timerRunning = false;
    timerDone = true;
    timerEndAt = null;
    timerRemainingMs = 0;
    renderTimer();
    timerStartBtn.textContent = t('clock.startTimer');
    try { sys.notify(t('clock.timerDone'), t('clock.timerDoneBody')); } catch { /* ignore */ }
    beep();
  }

  timerStartBtn.addEventListener('click', () => {
    ensureAudio();
    if (!timerRunning) {
      if (timerRemainingMs <= 0) timerRemainingMs = timerDurationMs;
      timerEndAt = performance.now() + timerRemainingMs;
      timerRunning = true;
      timerDone = false;
      timerTimeEl.classList.remove('is-done');
      timerStartBtn.textContent = t('clock.pause');
    } else {
      timerRunning = false;
      if (timerEndAt !== null) timerRemainingMs = Math.max(0, timerEndAt - performance.now());
      timerEndAt = null;
      timerStartBtn.textContent = t('clock.resume');
    }
  });
  timerResetBtn.addEventListener('click', () => {
    timerRunning = false;
    timerEndAt = null;
    timerDone = false;
    timerRemainingMs = timerDurationMs;
    timerStartBtn.textContent = t('clock.startTimer');
    timerTimeEl.classList.remove('is-done');
    renderTimer();
  });

  // ── ticking ──
  const worldInterval = setInterval(() => { if (activeTab === 'world') renderWorld(); }, 1000);
  const swInterval = setInterval(() => { if (swRunning && activeTab === 'stopwatch') renderStopwatch(); }, 30);
  const timerInterval = setInterval(() => {
    if (timerRunning && timerEndAt !== null) {
      timerRemainingMs = Math.max(0, timerEndAt - performance.now());
      if (activeTab === 'timer') renderTimer();
      if (timerRemainingMs <= 0) onTimerFinished();
    }
  }, 250);
  intervals.push(worldInterval, swInterval, timerInterval);

  win.onClose(() => {
    for (const id of intervals) clearInterval(id);
    if (audioCtx) { try { void audioCtx.close(); } catch { /* ignore */ } }
  });

  // ── init ──
  setTab('world');
  renderWorld();
  renderCalendar();
  renderStopwatch();
  renderLaps();
  setTimerMinutes(5);
}

const app: AppModule = {
  manifest,
  launch,
};

export default app;
