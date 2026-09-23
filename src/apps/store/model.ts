/**
 * Pure, framework-free helpers for the Store app: permission copy, the
 * description fallback map, and catalog filtering/search. Kept separate
 * from index.ts so they are trivially unit-testable (see store.test.ts).
 */
import type { AppCategory, CatalogEntry, Locale, Permission } from '../../kernel/types';

export type StoreTab = 'explore' | 'installed' | 'updates';
export type CategoryFilter = 'all' | AppCategory;

export interface LocalizedText {
  ar: string;
  en: string;
}

export const CATEGORIES: CategoryFilter[] = ['all', 'system', 'utilities', 'accessories', 'media', 'development'];

/** Plain-language explanation of what each permission lets an app do. */
export const PERMISSION_DESCRIPTIONS: Record<Permission, LocalizedText> = {
  'fs:home': { ar: 'قراءة وكتابة ملفاتك الشخصية', en: 'Read and write your personal files' },
  'fs:read-all': { ar: 'قراءة كل ملفات النظام', en: 'Read all system files' },
  'fs:system': { ar: 'قراءة وكتابة كامل نظام الملفات', en: 'Read and write the entire file system' },
  notifications: { ar: 'إظهار الإشعارات', en: 'Show notifications' },
  settings: { ar: 'تغيير إعدادات النظام', en: 'Change system settings' },
  'apps:manage': { ar: 'تثبيت التطبيقات وإزالتها', en: 'Install and remove apps' },
  'system:monitor': { ar: 'رؤية التطبيقات المفتوحة وإغلاقها', en: 'See and close running apps' },
  network: { ar: 'الوصول إلى الشبكة', en: 'Access the network' },
};

/** Permissions powerful enough to warrant a visible warning in the detail page. */
const POWERFUL_PERMISSIONS: ReadonlySet<Permission> = new Set([
  'fs:system',
  'apps:manage',
  'system:monitor',
  'fs:read-all',
]);

export function isPowerfulPermission(permission: Permission): boolean {
  return POWERFUL_PERMISSIONS.has(permission);
}

export function permissionDescription(permission: Permission, locale: Locale): string {
  return PERMISSION_DESCRIPTIONS[permission]?.[locale] ?? permission;
}

/** Manifests don't always carry a description; fall back to a known copy for built-in apps. */
export const FALLBACK_DESCRIPTIONS: Record<string, LocalizedText> = {
  'org.faisal.Files': { ar: 'استعرض وأدر ملفاتك ومجلداتك', en: 'Browse and manage your files and folders' },
  'org.faisal.Terminal': { ar: 'سطر أوامر شبيه بـ bash، ولينكس حقيقي عبر v86', en: 'A bash-like command line, plus real Linux via v86' },
  'org.faisal.TextEditor': { ar: 'محرر نصوص بسيط لملفاتك', en: 'A simple text editor for your files' },
  'org.faisal.Claude': { ar: 'مساعد ذكي سريع عبر GroqCloud يبحث في الإنترنت', en: 'A fast AI assistant on GroqCloud that can search the web' },
  'org.faisal.Calculator': { ar: 'آلة حاسبة سريعة للعمليات اليومية', en: 'A quick calculator for everyday sums' },
  'org.faisal.ImageViewer': { ar: 'تصفح صورك وعرضها', en: 'Browse and view your pictures' },
  'org.faisal.Clock': { ar: 'الوقت والتنبيهات والمؤقتات', en: 'Time, alarms and timers' },
  'org.faisal.SystemMonitor': { ar: 'راقب التطبيقات الجارية وأغلقها', en: 'Watch running apps and close them' },
  'org.faisal.Store': { ar: 'ثبّت التطبيقات وأزلها', en: 'Install and remove apps' },
  'org.faisal.Settings': { ar: 'خصّص مظهر النظام ولغته', en: 'Customize system appearance and language' },
};

export function describeApp(
  app: { id: string; description?: LocalizedText },
  locale: Locale,
): string {
  return app.description?.[locale] ?? FALLBACK_DESCRIPTIONS[app.id]?.[locale] ?? '';
}

export function matchesCategory(entry: CatalogEntry, category: CategoryFilter): boolean {
  return category === 'all' || entry.category === category;
}

export function matchesQuery(entry: CatalogEntry, query: string, locale: Locale): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [entry.name.ar, entry.name.en, entry.id, describeApp(entry, locale)]
    .join(' ')
    .toLowerCase();
  return haystack.includes(q);
}

export function filterCatalog(
  entries: CatalogEntry[],
  opts: { category: CategoryFilter; query: string; locale: Locale },
): CatalogEntry[] {
  return entries.filter((e) => matchesCategory(e, opts.category) && matchesQuery(e, opts.query, opts.locale));
}

/** Deterministic pick for the Explore banner: the first non-installed app, else the first app. */
export function pickFeatured(entries: CatalogEntry[]): CatalogEntry | undefined {
  return entries.find((e) => !e.installed) ?? entries[0];
}

export function sortedCatalog(entries: CatalogEntry[], locale: Locale): CatalogEntry[] {
  return [...entries].sort((a, b) => a.name[locale].localeCompare(b.name[locale], locale));
}
