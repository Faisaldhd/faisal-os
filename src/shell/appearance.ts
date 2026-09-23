import type { EventBus, Settings } from '../kernel/types';

export type ThemeMode = 'light' | 'dark' | 'system';

export interface AccentPreset {
  id: string;
  fg: string;
  hex: string;
  hex2: string;
  /** Swatch paint for the picker when `hex` is not a plain colour. */
  swatch?: string;
}

/** The brand accent is theme-aware: antique gold (white text) in light, saffron gold (ink text) in dark. */
export const BRAND_ACCENT_ID = 'faisal';

export const ACCENTS: AccentPreset[] = [
  {
    id: BRAND_ACCENT_ID,
    fg: 'var(--faisal-brand-accent-fg)',
    hex: 'var(--faisal-brand-accent)',
    hex2: 'var(--faisal-brand-accent-2)',
    swatch: 'linear-gradient(135deg, #E3B650 0 50%, #16264F 50% 100%)',
  },
  { id: 'blue', fg: '#ffffff', hex: '#3c6eb4', hex2: '#51a2da' },
  { id: 'teal', fg: '#ffffff', hex: '#1c7a72', hex2: '#3bb7a9' },
  { id: 'purple', fg: '#ffffff', hex: '#7a4fc0', hex2: '#a389e0' },
  { id: 'green', fg: '#ffffff', hex: '#2f8132', hex2: '#5cb85c' },
  { id: 'orange', fg: '#1e1e1e', hex: '#e0742f', hex2: '#f0a35c' },
];

export function applyTheme(mode: ThemeMode): void {
  const html = document.documentElement;
  if (mode === 'system') html.removeAttribute('data-theme');
  else html.setAttribute('data-theme', mode);
}

export function applyAccent(accentId: string): void {
  const preset = ACCENTS.find((a) => a.id === accentId) ?? ACCENTS[0];
  const root = document.documentElement.style;
  root.setProperty('--faisal-accent', preset.hex);
  root.setProperty('--faisal-accent-2', preset.hex2);
  root.setProperty('--faisal-accent-fg', preset.fg);
}

/** Applies stored appearance settings at boot and reacts live to settings:change. */
export function wireAppearance(bus: EventBus, settings: Settings): void {
  applyTheme(settings.get<ThemeMode>('theme', 'system'));
  applyAccent(settings.get<string>('accent', BRAND_ACCENT_ID));
  bus.on('settings:change', ({ key, value }) => {
    if (key === 'theme') applyTheme(value as ThemeMode);
    if (key === 'accent') applyAccent(value as string);
  });
}
