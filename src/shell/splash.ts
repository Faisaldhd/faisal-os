import type { EventBus } from '../kernel/types';
import { MARK_SVG, WORDMARK_ARABIC_SVG, WORDMARK_LATIN_SVG } from '../brand/logo';
import { renderIcon } from './icon';

/** The static screen in index.html already shows the brand, so the fade-in needs no long hold. */
const HOLD_AFTER_READY_MS = 300;
const FADE_MS = 450;
const FAILSAFE_MS = 4000;

/** Mark + both wordmarks, shared by the splash and Settings → About. */
export function brandLockup(): { mark: HTMLElement; wordmarks: HTMLElement } {
  const mark = document.createElement('div');
  mark.append(renderIcon(MARK_SVG));

  const wordmarks = document.createElement('div');
  wordmarks.className = 'faisal-wordmarks';
  wordmarks.dir = 'ltr'; // fixed composition: Latin | Arabic, regardless of UI direction
  const latin = document.createElement('span');
  latin.className = 'faisal-wm-latin';
  latin.append(renderIcon(WORDMARK_LATIN_SVG));
  const rule = document.createElement('span');
  rule.className = 'faisal-wm-rule';
  const arabic = document.createElement('span');
  arabic.className = 'faisal-wm-arabic';
  arabic.lang = 'ar';
  arabic.append(renderIcon(WORDMARK_ARABIC_SVG));
  wordmarks.append(latin, rule, arabic);
  return { mark, wordmarks };
}

function prefersReducedMotion(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Boot splash: shown while the shell comes up, fades ~900 ms after system:ready.
 * Skipped under prefers-reduced-motion. Stops intercepting input the moment it starts fading.
 */
export function mountSplash(bus: EventBus): void {
  if (prefersReducedMotion()) return;

  const splash = document.createElement('div');
  splash.className = 'faisal-splash';
  splash.setAttribute('role', 'presentation');
  splash.setAttribute('aria-hidden', 'true');

  const { mark, wordmarks } = brandLockup();
  mark.className = 'faisal-splash-mark';
  const bar = document.createElement('div');
  bar.className = 'faisal-splash-bar';
  splash.append(mark, wordmarks, bar);
  document.body.append(splash);

  let done = false;
  const leave = () => {
    if (done) return;
    done = true;
    splash.classList.add('is-leaving');
    window.setTimeout(() => splash.remove(), FADE_MS + 50);
  };

  const off = bus.on('system:ready', () => {
    off();
    window.setTimeout(leave, HOLD_AFTER_READY_MS);
  });
  window.setTimeout(leave, FAILSAFE_MS);
}
