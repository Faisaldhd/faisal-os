import type { Locale } from '../../kernel/types';

export function formatBytes(bytes: number, locale: Locale): string {
  if (bytes === 0) return locale === 'ar' ? '0 بايت' : '0 B';
  const units = locale === 'ar'
    ? ['بايت', 'ك.ب', 'م.ب', 'ج.ب', 'ت.ب']
    : ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  const value = bytes / Math.pow(k, i);
  const formatted = i === 0 ? String(value) : value.toFixed(value < 10 ? 1 : 0);
  return `${formatted} ${units[i]}`;
}

export function formatDate(ms: number, locale: Locale): string {
  try {
    return new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString();
  }
}
