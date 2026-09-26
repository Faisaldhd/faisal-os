/**
 * Impress — the start of a new presentation (عرض تقديمي جديد): pick a design first, like WPS.
 *
 * The window asks this before it writes the new file, so the deck is born in its theme (the theme
 * part, the master's background and text colours) instead of being a blank white page painted
 * afterwards. Cancel leaves everything as it was.
 */
import { t } from '../../../kernel/i18n';
import { el } from '../ui/dom';
import { openModal } from '../ui/popover';
import { themeGallery } from './gallery';
import { DEFAULT_THEME, type DeckTheme } from './themes';
import './strings';

/** Resolves with the chosen theme, or null when the dialog is closed without creating. */
export function pickDeckTheme(host: HTMLElement): Promise<DeckTheme | null> {
  return new Promise((resolve) => {
    let chosen: DeckTheme = DEFAULT_THEME;
    let done = false;
    // The galleries are styled as a presentation's (the window is still on its start screen).
    const kind = host.dataset.kind;
    host.dataset.kind = 'pptx';
    const finish = (v: DeckTheme | null): void => {
      if (done) return;
      done = true;
      watch.disconnect();
      if (!v && host.dataset.kind === 'pptx' && kind !== undefined) host.dataset.kind = kind;
      resolve(v);
    };
    const body = el('div', 'fo-imp-pick');
    const mark = (): void => {
      body.querySelectorAll<HTMLElement>('.fo-imp-theme').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.theme === chosen.id)));
    };
    const gallery = themeGallery(chosen.id, (theme) => { chosen = theme; mark(); });
    // A double-click on a design creates the deck at once.
    gallery.addEventListener('dblclick', (ev) => {
      if (!(ev.target as Element).closest('.fo-imp-theme')) return;
      finish(chosen);
      modal.close();
    });
    body.append(el('p', undefined, t('impress.pickHint')), gallery);
    const modal = openModal({
      title: t('impress.pickTitle'), body, okLabel: t('impress.pickCreate'), cancelLabel: t('office.cancel'), host,
      onOk: () => { finish(chosen); },
    });
    // The modal has no cancel callback: its overlay leaving the host without an OK is a cancel.
    const overlay = host.querySelector('.fo-modal-overlay:last-of-type');
    const watch = new MutationObserver(() => { if (!overlay?.isConnected) finish(null); });
    watch.observe(host, { childList: true });
    (body.querySelector<HTMLElement>('.fo-imp-theme[aria-pressed="true"]'))?.focus();
  });
}
