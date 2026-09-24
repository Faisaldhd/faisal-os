import type { AppManifest } from '../../kernel/types';
import { tile, GOLD } from '../../brand/icons';
import { VIEWER_EXTENSIONS } from './formats';

/** File Viewer — a gold-edged document with folded corner on navy, in the Fai$al OS icon grammar. */
const ICON_VIEWER = tile(
  ['#1B2B5A', '#0E1A3A'],
  '#8FA6E0',
  '<path d="M20 12h17l9 9v29a3 3 0 0 1-3 3H20a3 3 0 0 1-3-3V15a3 3 0 0 1 3-3z" fill="#0E1A3A" stroke="url(#fiGold)" stroke-width="2" stroke-linejoin="round"/>' +
    '<path d="M37 12v9h9" fill="none" stroke="url(#fiGold)" stroke-width="2" stroke-linejoin="round"/>' +
    '<path d="M23 30h17M23 36h17M23 42h11" stroke="#F0CF7A" stroke-width="2" stroke-linecap="round" stroke-opacity=".8"/>',
  GOLD,
);

/** Static app metadata: kept apart from the app code so the desktop can list the app without loading it. */
export const manifest: AppManifest = {
  id: 'org.faisal.FileViewer',
  name: { ar: 'عارض الملفات', en: 'File Viewer' },
  description: { ar: 'افتح PDF وExcel وWord والصوت والفيديو وأي ملف', en: 'Open PDF, Excel, Word, audio, video and any other file' },
  icon: ICON_VIEWER,
  permissions: ['fs:home'],
  // The named formats, plus "*": any file no other app opens comes here instead of doing nothing.
  opens: [...VIEWER_EXTENSIONS, '*'],
  category: 'utilities',
  core: false,
  singleInstance: false,
};
