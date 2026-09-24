import { describe, expect, it } from 'vitest';
import {
  capabilityTable,
  choseRefusal,
  codecFamily,
  extensionPlayable,
  formatForPath,
  formatsFor,
  preferredExportMime,
  probeAnswer,
  recorderMimeCandidates,
  refusalFor,
  VIDEO_EXTENSIONS,
  MEDIA_FORMATS,
  type CapabilityProbe,
} from './capabilities';

/** A browser that says "probably" to everything containing a fragment. */
function probeSaying(fragment: string, answer: string, extra: Partial<CapabilityProbe> = {}): CapabilityProbe {
  return {
    canPlayType: (mime: string) => (mime.includes(fragment) ? answer : ''),
    ...extra,
  };
}

const NO_SUPPORT: CapabilityProbe = { canPlayType: () => '' };
const CHROME_LIKE: CapabilityProbe = {
  canPlayType: (mime) => {
    if (mime.startsWith('video/mp4')) return 'probably';
    if (mime.startsWith('video/webm')) return 'probably';
    if (mime.startsWith('audio/mpeg') || mime.startsWith('audio/wav')) return 'probably';
    if (mime.startsWith('audio/ogg')) return 'maybe';
    if (mime.startsWith('audio/mp4')) return 'maybe';
    return '';
  },
  isTypeSupported: (mime) => mime.startsWith('video/mp4') || mime.startsWith('video/webm'),
};

describe('format catalog', () => {
  it('names every extension once in the opens list', () => {
    expect(VIDEO_EXTENSIONS).toEqual([...new Set(VIDEO_EXTENSIONS)]);
    for (const format of MEDIA_FORMATS) expect(VIDEO_EXTENSIONS).toContain(format.ext);
  });

  it('finds a path with any case, and a bare extension', () => {
    expect(formatForPath('/home/user/CLIP.MP4')?.ext).toBe('.mp4');
    expect(formatForPath('/home/user/voice.MP3')?.kind).toBe('audio');
    expect(formatsFor('webm')).toHaveLength(2);
    expect(formatForPath('/home/user/notes.txt')).toBeUndefined();
  });

  it('never calls MKV or AVI common', () => {
    expect(formatsFor('.mkv')[0].likely).toBe('unlikely');
    expect(formatsFor('.avi')[0].likely).toBe('unlikely');
  });

  it('names the codec family from a WebCodecs config string', () => {
    expect(codecFamily('vp09.00.10.08')).toBe('VP9');
    expect(codecFamily('avc1.42E01E')).toBe('H.264');
    expect(codecFamily('opus')).toBe('Opus');
  });
});

describe('probe answers', () => {
  it('believes canPlayType first', () => {
    expect(probeAnswer(probeSaying('video/mp4', 'probably'), MEDIA_FORMATS[0]))
      .toEqual({ answer: 'probably', via: 'element' });
    expect(probeAnswer(probeSaying('audio/mpeg', 'maybe'), formatsFor('.mp3')[0]))
      .toEqual({ answer: 'maybe', via: 'element' });
  });

  it('falls back to MediaSource.isTypeSupported when canPlayType says nothing', () => {
    const probe: CapabilityProbe = { canPlayType: () => '', isTypeSupported: (mime) => mime.includes('vp9') };
    const row = probeAnswer(probe, formatsFor('.webm')[0]);
    expect(row).toEqual({ answer: 'probably', via: 'source' });
  });

  it('reports an explicit refusal with no answer at all', () => {
    expect(probeAnswer(NO_SUPPORT, formatsFor('.avi')[0])).toEqual({ answer: 'no', via: 'none' });
  });

  it('does not upgrade a plain "no" into support', () => {
    const probe: CapabilityProbe = { canPlayType: () => '', isTypeSupported: () => false };
    expect(probeAnswer(probe, formatsFor('.mkv')[0]).answer).toBe('no');
  });
});

describe('refusal mapping', () => {
  it('refuses MKV and AVI on a browser that says nothing about them', () => {
    const mkv = refusalFor(NO_SUPPORT, '/home/user/show.mkv');
    expect(mkv?.ext).toBe('.mkv');
    expect(mkv?.rows.length).toBe(1);
    const avi = refusalFor(NO_SUPPORT, '/home/user/old.avi');
    expect(avi?.ext).toBe('.avi');
  });

  it('accepts the same files when the browser claims support, as "maybe"', () => {
    const probe = probeSaying('video/x-matroska', 'maybe');
    expect(refusalFor(probe, '/home/user/show.mkv')).toBeNull();
    expect(extensionPlayable(probe, '.mkv')).toBe(true);
  });

  it('passes an unknown extension through to the player instead of refusing it', () => {
    expect(refusalFor(NO_SUPPORT, '/home/user/clip.xyz')).toBeNull();
    expect(refusalFor(NO_SUPPORT, '/home/user/noextension')).toBeNull();
  });

  it('accepts a format where only one of two codec rows plays', () => {
    // Chromium answers vp8 but not vp9: the .webm row must still open.
    const probe = probeSaying('vp8', 'probably');
    expect(refusalFor(probe, '/home/user/a.webm')).toBeNull();
  });

  it('maps a full table for a browser with no media support at all', () => {
    const table = capabilityTable(NO_SUPPORT);
    expect(table).toHaveLength(MEDIA_FORMATS.length);
    expect(table.every((row) => row.answer === 'no')).toBe(true);
    expect(choseRefusal(NO_SUPPORT, formatsFor('.mp4')[0])).toBe(true);
  });

  it('gives MP4 and WebM a positive row in a browser that supports them', () => {
    const table = capabilityTable(CHROME_LIKE);
    const mp4 = table.find((row) => row.format.ext === '.mp4');
    const webm = table.find((row) => row.format.ext === '.webm');
    expect(mp4?.answer).toBe('probably');
    expect(webm?.answer).toBe('probably');
    expect(table.find((row) => row.format.ext === '.avi')?.answer).toBe('no');
  });
});

describe('export container choice', () => {
  it('keeps WebM in WebM and everything else in MP4', () => {
    expect(preferredExportMime('.webm')).toBe('video/webm');
    expect(preferredExportMime('.ogv')).toBe('video/webm');
    expect(preferredExportMime('.mp4')).toBe('video/mp4');
    expect(preferredExportMime('.avi')).toBe('video/mp4');
  });

  it('lists video candidates best first, with the preferred container in front', () => {
    const webm = recorderMimeCandidates('video/webm', 'video');
    expect(webm[0]).toContain('video/webm');
    expect(webm).toContain('video/mp4');
    const mp4 = recorderMimeCandidates('video/mp4', 'video');
    expect(mp4[0]).toContain('video/mp4');
    expect(mp4).toContain('video/webm');
  });

  it('lists audio-only candidates when the source has no picture', () => {
    const audio = recorderMimeCandidates('video/mp4', 'audio');
    expect(audio.every((mime) => mime.startsWith('audio/'))).toBe(true);
    expect(audio).toHaveLength(5);
  });
});
