import type { AppManifest } from '../../kernel/types';
import { tile, GOLD } from '../../brand/icons';

/** PDF Documents — a gold-edged page with a folded corner and a wax-seal dot, in the Fai$al OS icon grammar. */
const ICON_PDF = tile(
  ['#1B2B5A', '#0E1A3A'],
  '#8FA6E0',
  '<path d="M20 10h15l11 11v30a3 3 0 0 1-3 3H20a3 3 0 0 1-3-3V13a3 3 0 0 1 3-3z" fill="#0E1A3A" stroke="url(#fiGold)" stroke-width="2" stroke-linejoin="round"/>' +
    '<path d="M35 10v11h11" fill="none" stroke="url(#fiGold)" stroke-width="2" stroke-linejoin="round"/>' +
    '<path d="M23 31h12M23 37h9" stroke="#F0CF7A" stroke-width="2" stroke-linecap="round" stroke-opacity=".85"/>' +
    '<circle cx="40" cy="43" r="7" fill="#B8862B" stroke="url(#fiGold)" stroke-width="1.5"/>' +
    '<path d="M37.5 43h5M40 40.5v5" stroke="#16264F" stroke-width="1.6" stroke-linecap="round"/>',
  GOLD,
);

/**
 * Static app metadata, kept apart from the app code so the Store can list the app without
 * loading pdf-lib. Store-only by the owner's choice: `defaultInstalled: false` and
 * `core: false` mean the kernel shows it in the Store until he installs it
 * (see the install rule in `src/kernel/apps.ts`).
 */
export const manifest: AppManifest = {
  id: 'org.faisal.Pdf',
  name: { ar: 'مستندات PDF', en: 'PDF Documents' },
  description: {
    ar: 'افتح PDF وحرّره: إضافة نص وتعبئة النماذج وتغطية منطقة وإدراج وتكرار الصفحات، مع دمج وتقسيم وترتيب وحذف وتدوير وقص وعلامة مائية وبيانات وصفية وصور إلى PDF',
    en: 'Open and edit a PDF: add text, fill forms, cover a region, insert and duplicate pages, plus merge, split, reorder, delete, rotate, crop, watermark, metadata and images to PDF',
  },
  icon: ICON_PDF,
  permissions: ['fs:home'],
  opens: ['.pdf'],
  category: 'utilities',
  core: false,
  defaultInstalled: false,
  version: '1.0.0',
  releasedAt: '2026-09-24',
  singleInstance: false,
};
