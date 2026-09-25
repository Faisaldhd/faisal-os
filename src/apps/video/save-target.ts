/**
 * Video — the small policy behind the shared Save as dialog (src/shell/save-as.ts).
 *
 * The dialog owns the folder browsing, the file name, the overwrite question and the read-back;
 * this module only answers what THIS app hands it: which single format an export is in, and what
 * the project is called once a path exists. Pure, so it is tested without a DOM.
 */
import { PROJECT_EXTENSION } from './project-file';

export interface VideoFormatChoice {
  /** Stable id the dialog hands back to `encode`. */
  value: string;
  /** Extension without the dot. */
  ext: string;
  mime: string;
  /** Shown in the picker; container names are format identifiers, not prose. */
  label: string;
}

/** The one format an export can be, named by its container — never a format we cannot produce. */
export function exportFormatChoice(extension: string, mime: string): VideoFormatChoice {
  const ext = extension.replace(/^\./, '').toLowerCase() || 'webm';
  const label = ext === 'mp4' ? 'MP4 (H.264)' : ext === 'webm' ? 'WebM (VP9/VP8)' : ext === 'wav' ? 'WAV' : ext.toUpperCase();
  return { value: ext, ext, mime: mime || 'application/octet-stream', label };
}

/** The project: one JSON file with the `.fvproj` extension, unchanged. */
export function projectFormatChoice(label: string): VideoFormatChoice {
  const ext = PROJECT_EXTENSION.replace(/^\./, '');
  return { value: ext, ext, mime: 'application/json', label };
}

/** `/home/user/Videos/my clip.fvproj` → `my clip`; the name shown in the app's chrome. */
export function projectNameFromPath(path: string, extension = PROJECT_EXTENSION): string {
  const name = path.split('/').pop() ?? '';
  return name.toLowerCase().endsWith(extension.toLowerCase()) ? name.slice(0, -extension.length) : name;
}
