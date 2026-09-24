import type { AppManifest } from '../../kernel/types';
import { tile, GOLD } from '../../brand/icons';
import { OFFICE_EXTENSIONS } from './model';

/**
 * Office — three stacked gold-edged sheets on navy, in the Fai$al OS icon grammar:
 * Word, Excel and PowerPoint in one app.
 */
const ICON_OFFICE = tile(
  ['#1B2B5A', '#0E1A3A'],
  '#8FA6E0',
  '<rect x="15" y="15" width="24" height="32" rx="3" fill="#24407C" stroke="url(#fiGold)" stroke-width="1.6"/>' +
    '<rect x="21" y="11" width="24" height="32" rx="3" fill="#16264F" stroke="url(#fiGold)" stroke-width="1.6"/>' +
    '<rect x="27" y="18" width="23" height="30" rx="3" fill="url(#fiGold)"/>' +
    '<path d="M31 26h15M31 32h15M31 38h9" stroke="#16264F" stroke-width="2" stroke-linecap="round" stroke-opacity=".85"/>',
  GOLD,
);

/**
 * Static app metadata: kept apart from the app code so the desktop can list the app
 * without loading it.
 *
 * Store-only by design: `defaultInstalled: false` means the kernel treats it as
 * installed *after* the Store adds it (see `src/kernel/apps.ts:131`), and `core: false`
 * means the owner can remove it again.
 */
export const manifest: AppManifest = {
  id: 'org.faisal.Office',
  name: { ar: 'المكتب', en: 'Office' },
  description: {
    ar: 'افتح وحرّر Word وExcel وPowerPoint وCSV والنصوص، واحفظها بصيغها الحقيقية',
    en: 'Open and edit Word, Excel, PowerPoint, CSV and text files, and save them back in their real formats',
  },
  icon: ICON_OFFICE,
  permissions: ['fs:home'],
  opens: [...OFFICE_EXTENSIONS],
  category: 'utilities',
  core: false,
  defaultInstalled: false,
};
