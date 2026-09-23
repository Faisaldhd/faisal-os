import type { SystemAPI } from '../kernel/types';
import { t } from '../kernel/i18n';
import { renderIcon } from './icon';

const AUTO_DISMISS_MS = 5000;
const HISTORY_KEY = 'faisal.notifications.v1';
const HISTORY_MAX = 50;
/** Settings key: when true, notifications go straight to the list without a popup. */
export const DND_KEY = 'shell.dnd';

export interface NotificationItem {
  id: number;
  title: string;
  body?: string;
  appId?: string;
  time: number;
}

/** Pure: validates stored history, newest first, capped. */
export function parseHistory(raw: unknown): NotificationItem[] {
  if (!Array.isArray(raw)) return [];
  const out: NotificationItem[] = [];
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue;
    const n = v as Partial<NotificationItem>;
    if (typeof n.id !== 'number' || typeof n.title !== 'string' || typeof n.time !== 'number') continue;
    out.push({
      id: n.id,
      title: n.title,
      time: n.time,
      ...(typeof n.body === 'string' ? { body: n.body } : {}),
      ...(typeof n.appId === 'string' ? { appId: n.appId } : {}),
    });
  }
  return out.sort((a, b) => b.time - a.time).slice(0, HISTORY_MAX);
}

function loadHistory(): NotificationItem[] {
  try { return parseHistory(JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]')); } catch { return []; }
}

/** "3 minutes ago" in the UI language. */
function relativeTime(time: number, locale: string): string {
  const s = Math.round((time - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (Math.abs(s) < 60) return rtf.format(0, 'second');
  const m = Math.round(s / 60);
  if (Math.abs(m) < 60) return rtf.format(m, 'minute');
  const h = Math.round(m / 60);
  if (Math.abs(h) < 24) return rtf.format(h, 'hour');
  return rtf.format(Math.round(h / 24), 'day');
}

/**
 * Popup toasts plus a notification center opened from the top-bar clock: history
 * (kept across reloads), unread dot, clear all, and Do Not Disturb.
 */
export function mountNotifications(root: HTMLElement, sys: SystemAPI, anchor: HTMLButtonElement | null): void {
  const stack = document.createElement('div');
  stack.className = 'faisal-notif-stack';
  stack.setAttribute('aria-live', 'polite');
  root.append(stack);

  let history = loadHistory();
  let nextId = (history[0]?.id ?? 0) + 1;
  let unread = 0;
  let panel: HTMLElement | null = null;
  const dot = anchor?.querySelector<HTMLElement>('.faisal-notif-dot') ?? null;
  const locale = () => (sys.locale() === 'ar' ? 'ar' : 'en');

  const save = () => {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch { /* private mode */ }
  };
  const syncDot = () => { if (dot) dot.hidden = unread === 0; };

  const appOf = (appId?: string) => (appId ? sys.apps.list().find((a) => a.id === appId) : undefined);

  function iconFor(item: NotificationItem): HTMLElement {
    const icon = document.createElement('div');
    icon.className = 'faisal-notif-icon';
    const app = appOf(item.appId);
    if (app) {
      icon.classList.add('has-app');
      icon.append(renderIcon(app.icon));
    } else {
      icon.textContent = (item.title[0] ?? '!').toUpperCase();
    }
    return icon;
  }

  function textFor(item: NotificationItem, withTime: boolean): HTMLElement {
    const text = document.createElement('div');
    text.className = 'faisal-notif-text';
    const titleEl = document.createElement('div');
    titleEl.className = 'faisal-notif-title';
    titleEl.textContent = item.title;
    text.append(titleEl);
    if (item.body) {
      const bodyEl = document.createElement('div');
      bodyEl.className = 'faisal-notif-body';
      bodyEl.textContent = item.body;
      text.append(bodyEl);
    }
    if (withTime) {
      const time = document.createElement('div');
      time.className = 'faisal-notif-time';
      time.textContent = relativeTime(item.time, locale());
      text.append(time);
    }
    return text;
  }

  /** Brings the notifying app to the front (launching it if it was closed). */
  function openApp(item: NotificationItem) {
    const app = appOf(item.appId);
    if (!app) return;
    const wins = sys.wm.list().filter((w) => w.appId === app.id);
    if (wins.length) wins[wins.length - 1].focus();
    else void sys.apps.launch(app.id).catch(() => {});
  }

  function toast(item: NotificationItem) {
    const card = document.createElement('div');
    card.className = 'faisal-notif';
    card.setAttribute('role', 'status');
    card.append(iconFor(item), textFor(item, false));
    stack.append(card);
    const remove = () => card.remove();
    let timer = window.setTimeout(remove, AUTO_DISMISS_MS);
    // Hovering keeps it up; leaving restarts the countdown.
    card.addEventListener('pointerenter', () => window.clearTimeout(timer));
    card.addEventListener('pointerleave', () => { timer = window.setTimeout(remove, AUTO_DISMISS_MS); });
    card.addEventListener('click', () => { window.clearTimeout(timer); remove(); openApp(item); });
  }

  sys.bus.on('notify', ({ title, body, appId }) => {
    const item: NotificationItem = { id: nextId++, title, body, appId, time: Date.now() };
    history = [item, ...history].slice(0, HISTORY_MAX);
    save();
    if (panel) renderList();
    else { unread++; syncDot(); }
    if (!sys.settings.get<boolean>(DND_KEY, false)) toast(item);
  });

  // ── Notification center panel ──
  let list: HTMLElement;

  function renderList() {
    if (!panel) return;
    list.replaceChildren();
    if (!history.length) {
      const empty = document.createElement('div');
      empty.className = 'faisal-notif-empty';
      empty.textContent = t('shell.notif.empty');
      list.append(empty);
      return;
    }
    for (const item of history) {
      const row = document.createElement('div');
      row.className = 'faisal-notif-item';
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'faisal-notif-open';
      open.append(iconFor(item), textFor(item, true));
      open.addEventListener('click', () => { close(); openApp(item); });
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'faisal-notif-x';
      x.setAttribute('aria-label', t('shell.notif.dismiss'));
      x.title = t('shell.notif.dismiss');
      x.textContent = '×';
      x.addEventListener('click', () => {
        history = history.filter((h) => h.id !== item.id);
        save();
        renderList();
      });
      row.append(open, x);
      list.append(row);
    }
  }

  function openPanel() {
    if (panel || !anchor) return;
    panel = document.createElement('div');
    panel.className = 'faisal-notif-center';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', t('shell.notif.title'));

    const head = document.createElement('div');
    head.className = 'faisal-notif-head';
    const h = document.createElement('h3');
    h.textContent = t('shell.notif.title');
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'faisal-notif-clear';
    clear.textContent = t('shell.notif.clear');
    clear.addEventListener('click', () => { history = []; save(); renderList(); });
    head.append(h, clear);

    list = document.createElement('div');
    list.className = 'faisal-notif-list';

    const foot = document.createElement('label');
    foot.className = 'faisal-notif-dnd';
    const dnd = document.createElement('input');
    dnd.type = 'checkbox';
    dnd.role = 'switch';
    dnd.checked = sys.settings.get<boolean>(DND_KEY, false);
    dnd.addEventListener('change', () => sys.settings.set(DND_KEY, dnd.checked));
    const dndText = document.createElement('span');
    dndText.textContent = t('shell.notif.dnd');
    foot.append(dndText, dnd);

    panel.append(head, list, foot);
    document.body.append(panel);
    renderList();
    unread = 0;
    syncDot();
    anchor.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
  }

  function close() {
    if (!panel) return;
    panel.remove();
    panel = null;
    anchor?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
  }

  function onOutside(ev: PointerEvent) {
    const target = ev.target as Node;
    if (panel?.contains(target) || anchor?.contains(target)) return;
    close();
  }
  function onKey(ev: KeyboardEvent) {
    if (ev.key === 'Escape') { ev.stopPropagation(); close(); anchor?.focus(); }
  }

  anchor?.addEventListener('click', () => (panel ? close() : openPanel()));
}
