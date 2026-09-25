import { describe, expect, it } from 'vitest';
import { PROJECT_EXTENSION } from './project-file';
import { exportFormatChoice, projectFormatChoice, projectNameFromPath } from './save-target';

/**
 * What the video studio hands the shared Save as dialog: the single honest format of an export,
 * the project format, and the project name a chosen path implies. The dialog itself is covered by
 * `src/shell/save-as.test.ts`; this is the app-side half of the contract.
 */

describe('video save-as — the export format', () => {
  it('names each container the recorder can produce, with its real MIME type', () => {
    expect(exportFormatChoice('.mp4', 'video/mp4')).toEqual({ value: 'mp4', ext: 'mp4', mime: 'video/mp4', label: 'MP4 (H.264)' });
    expect(exportFormatChoice('webm', 'video/webm;codecs=vp9')).toMatchObject({ value: 'webm', ext: 'webm', mime: 'video/webm;codecs=vp9', label: 'WebM (VP9/VP8)' });
    expect(exportFormatChoice('.wav', 'audio/wav')).toEqual({ value: 'wav', ext: 'wav', mime: 'audio/wav', label: 'WAV' });
  });

  it('falls back to a playable container instead of inventing an extension', () => {
    expect(exportFormatChoice('', 'video/webm')).toMatchObject({ value: 'webm', ext: 'webm' });
    expect(exportFormatChoice('.', '')).toMatchObject({ ext: 'webm', mime: 'application/octet-stream' });
  });
});

describe('video save-as — the project format', () => {
  it('is one .fvproj JSON file, whatever the label says', () => {
    expect(projectFormatChoice('مشروع فيديو (.fvproj)')).toEqual({
      value: 'fvproj', ext: 'fvproj', mime: 'application/json', label: 'مشروع فيديو (.fvproj)',
    });
    expect(PROJECT_EXTENSION).toBe('.fvproj');
  });

  it('reads the project name back from the path the dialog returned', () => {
    expect(projectNameFromPath('/home/user/Videos/my clip.fvproj')).toBe('my clip');
    expect(projectNameFromPath('/home/user/Videos/report.FVPROJ')).toBe('report');
    expect(projectNameFromPath('/home/user/Videos/no-extension')).toBe('no-extension');
    expect(projectNameFromPath('تقرير-الفيديو.fvproj')).toBe('تقرير-الفيديو');
  });
});
