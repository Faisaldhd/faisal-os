import type { AppManifest } from '../../kernel/types';
import { ICON_EDITOR } from '../../brand/icons';

/** Static app metadata: kept apart from the app code so the desktop can list the app without loading it. */
export const manifest: AppManifest = {
  id: 'org.faisal.TextEditor',
  name: { ar: 'محرر النصوص', en: 'Text Editor' },
  description: { ar: 'محرر نصوص بسيط', en: 'A simple text editor' },
  icon: ICON_EDITOR,
  permissions: ['fs:home'],
  category: 'accessories',
  opens: ['.txt', '.md', '.json', '.js', '.ts', '.css', '.html', '.sh', '.conf', '.log'],
};
