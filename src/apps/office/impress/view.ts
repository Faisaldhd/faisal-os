/**
 * Impress — the slides view (العروض التقديمية), basic for now: a thumbnail rail,
 * every slide drawn as a 16:9 card whose first paragraph is the title and the
 * rest the body, text edited in place, and a full-screen slideshow (F5) with
 * arrow keys, taps and Esc. Slide text is saved through the surgical patch.
 */
import { t } from '../../../kernel/i18n';
import type { Editor, EditorContext, StatusInfo } from '../editor';
import { slideTextEdit, type DeckModel } from '../model';
import { button, el } from '../ui/dom';
import type { RibbonTab } from '../ui/ribbon';

export function createDeck(ctx: EditorContext): Editor {
  const deck = (): DeckModel | null => {
    const m = ctx.model();
    return m && m.kind === 'pptx' ? m : null;
  };
  let current = 0;
  const root = el('div', 'fo-impress');
  const rail = el('nav', 'fo-rail');
  rail.setAttribute('aria-label', t('office.slidesPanel'));
  const stage = el('div', 'fo-slidestage');
  root.append(rail, stage);

  function grow(area: HTMLTextAreaElement): void {
    area.style.height = 'auto';
    area.style.height = `${Math.min(area.scrollHeight || 0, 600)}px`;
  }

  function render(): void {
    const m = deck();
    rail.replaceChildren();
    stage.replaceChildren();
    if (!m) return;
    m.slides.forEach((paragraphs, s) => {
      const thumb = el('button', 'fo-thumb');
      thumb.type = 'button';
      thumb.setAttribute('aria-label', t('office.slide', { n: s + 1 }));
      thumb.setAttribute('aria-current', String(s === current));
      thumb.append(el('span', 'fo-thumb-n', String(s + 1)));
      const mini = el('span', 'fo-thumb-slide');
      mini.append(el('span', 'fo-thumb-title', paragraphs[0] ?? ''), el('span', 'fo-thumb-body', paragraphs.slice(1).join(' ')));
      thumb.append(mini);
      thumb.addEventListener('click', () => { current = s; stage.querySelector(`[data-slide="${s}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }); markCurrent(); });
      rail.append(thumb);

      const card = el('section', 'fo-slide');
      card.dataset.slide = String(s);
      card.setAttribute('aria-label', t('office.slide', { n: s + 1 }));
      const inner = el('div', 'fo-slide-inner');
      if (!paragraphs.length) inner.append(el('p', 'fo-slide-empty', t('office.emptySlide')));
      paragraphs.forEach((text, index) => {
        const area = el('textarea', `faisal-office-para fo-slidetext ${index === 0 ? 'is-title' : 'is-body'}`);
        area.value = text;
        area.dir = 'auto';
        area.rows = 1;
        area.readOnly = !ctx.editable();
        area.setAttribute('aria-label', index === 0 ? t('office.slideTitle', { n: s + 1 }) : t('office.slideText', { n: s + 1 }));
        area.addEventListener('focus', () => { current = s; markCurrent(); });
        area.addEventListener('input', () => {
          const cur = deck();
          if (!cur) return;
          const before = cur.slides[s]?.[index] ?? '';
          if (before !== area.value) ctx.commit(slideTextEdit(s, index, before, area.value));
          grow(area);
          const mini2 = rail.children[s]?.querySelector(index === 0 ? '.fo-thumb-title' : '.fo-thumb-body');
          if (mini2) mini2.textContent = index === 0 ? area.value : (deck()?.slides[s] ?? []).slice(1).join(' ');
        });
        inner.append(area);
      });
      card.append(inner);
      stage.append(card);
      requestAnimationFrame(() => inner.querySelectorAll('textarea').forEach((a) => grow(a)));
    });
  }

  function markCurrent(): void {
    [...rail.children].forEach((c, i) => c.setAttribute('aria-current', String(i === current)));
    ctx.refresh();
  }

  function present(): void {
    const m = deck();
    if (!m) return;
    let at = current;
    const show = el('div', 'fo-show');
    show.tabIndex = 0;
    show.setAttribute('role', 'dialog');
    show.setAttribute('aria-label', t('office.slideshow'));
    const slide = el('div', 'fo-show-slide');
    const counter = el('div', 'fo-show-count');
    const draw = (): void => {
      const paragraphs = m.slides[at] ?? [];
      slide.replaceChildren();
      const title = el('h2', 'fo-show-title', paragraphs[0] ?? '');
      title.dir = 'auto';
      slide.append(title);
      for (const p of paragraphs.slice(1)) { const line = el('p', 'fo-show-text', p); line.dir = 'auto'; slide.append(line); }
      counter.textContent = `${at + 1} / ${m.slides.length}`;
    };
    const close = (): void => {
      show.remove();
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    };
    show.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { close(); return; }
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(ev.key)) at = Math.min(m.slides.length - 1, at + 1);
      else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(ev.key)) at = Math.max(0, at - 1);
      else return;
      ev.preventDefault();
      draw();
    });
    show.addEventListener('click', (ev) => {
      const rect = show.getBoundingClientRect();
      const forward = document.documentElement.dir === 'rtl' ? ev.clientX < rect.left + rect.width / 2 : ev.clientX > rect.left + rect.width / 2;
      at = forward ? Math.min(m.slides.length - 1, at + 1) : Math.max(0, at - 1);
      draw();
    });
    const exit = button('close', t('office.endShow'), (ev) => { ev.stopPropagation(); close(); }, { cls: 'fo-show-exit' });
    show.append(slide, counter, exit);
    draw();
    ctx.host().append(show);
    show.focus();
    void show.requestFullscreen?.().catch(() => undefined);
  }

  function tabs(): RibbonTab[] {
    return [
      ctx.fileTab(),
      {
        id: 'home', label: t('office.tabSlideshow'), groups: [
          { label: t('office.groupShow'), controls: [
            { type: 'button', id: 'present', icon: 'play', label: t('office.presentFromStart'), showLabel: true, phone: true, run: () => { current = 0; present(); } },
            { type: 'button', id: 'presentHere', icon: 'presenter', label: t('office.presentFromCurrent'), showLabel: true, run: present },
          ] },
        ],
      },
    ];
  }

  return {
    element: root,
    tabs,
    render,
    status(): StatusInfo {
      const m = deck();
      return { parts: m ? [t('office.statusSlide', { n: current + 1, total: m.slides.length })] : [] };
    },
    onKey(ev: KeyboardEvent): boolean {
      if (ev.key === 'F5') { if (ev.shiftKey) present(); else { current = 0; present(); } return true; }
      return false;
    },
    dispose(): void { /* nothing held outside the view */ },
  };
}
