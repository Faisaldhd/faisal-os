import { describe, expect, it } from 'vitest';
import {
  ExportBothFailed,
  baseNameWithoutExtension,
  checkQuota,
  exportName,
  extensionForExport,
  planExport,
  planName,
  quotaFraction,
  shouldFallBackFromMp4,
  VFS_FILE_LIMIT,
  VFS_TOTAL_LIMIT,
  webCodecsReady,
  type ExportEnv,
} from './export';
import { ExportCancelled } from './engine-port';

const NO_WEBCODECS = { videoEncoder: false, audioEncoder: false, trackGenerator: false, audioData: false, trackProcessor: false };
const FULL_WEBCODECS = { videoEncoder: true, audioEncoder: true, trackGenerator: true, audioData: true, trackProcessor: true };

/** A browser whose MediaRecorder accepts exactly the listed containers. */
function env(overrides: Partial<ExportEnv> = {}): ExportEnv {
  return {
    webcodecs: NO_WEBCODECS,
    mediaRecorder: true,
    recorderSupports: (mime) => mime.startsWith('video/webm'),
    hasAudio: true,
    ...overrides,
  };
}

const VIDEO_CANDIDATES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
const AUDIO_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];

const encoderProbe = (supported: boolean) => ({ isEncoderSupported: () => supported });

const input = (overrides: Partial<Parameters<typeof planExport>[0]> = {}) => ({
  candidates: VIDEO_CANDIDATES,
  env: env(),
  muted: false,
  videoCodec: 'vp09.00.10.08',
  audioCodec: 'opus',
  width: 1280,
  height: 720,
  sampleRate: 48000,
  channels: 2,
  ...overrides,
});

describe('engine choice', () => {
  it('uses MediaRecorder when WebCodecs is not there at all', () => {    const plan = planExport(input(), encoderProbe(true));
    expect(plan.engine).toBe('mediarecorder');
    expect(plan.reason).toBe('mediarecorder');
    expect(plan.mime).toBe('video/webm;codecs=vp9,opus');
    expect(plan.extension).toBe('.webm');
    expect(plan.audio).toBe(true);
  });

  it('uses WebCodecs only when the encoder accepts the exact configuration', () => {
    const plan = planExport(input({ env: env({ webcodecs: FULL_WEBCODECS }) }), encoderProbe(true));
    expect(plan.engine).toBe('webcodecs');
    expect(plan.reason).toBe('webcodecs');
  });

  it('falls back when the encoder refuses the configuration', () => {
    const plan = planExport(input({ env: env({ webcodecs: FULL_WEBCODECS }) }), encoderProbe(false));
    expect(plan.engine).toBe('mediarecorder');
    expect(plan.reason).toBe('webcodecs-unsupported');
  });

  it('does not pick WebCodecs without the MediaStreamTrackGenerator bridge', () => {
    const partial = { ...FULL_WEBCODECS, trackGenerator: false };
    const plan = planExport(input({ env: env({ webcodecs: partial }) }), encoderProbe(true));
    expect(plan.engine).toBe('mediarecorder');
  });

  it('does not pick WebCodecs for a source with audio when the audio half is missing', () => {
    const noAudioData = { ...FULL_WEBCODECS, audioData: false };
    expect(planExport(input({ env: env({ webcodecs: noAudioData }) }), encoderProbe(true)).engine).toBe('mediarecorder');
    // With the audio muted on purpose, the video half alone is enough.
    const muted = planExport(input({ env: env({ webcodecs: noAudioData }), muted: true }), encoderProbe(true));
    expect(muted.engine).toBe('webcodecs');
    expect(muted.audio).toBe(false);
  });

  it('falls back to MediaRecorder when no audio encoder exists but audio is wanted', () => {
    const noAudioEncoder = { ...FULL_WEBCODECS, audioEncoder: false };
    expect(planExport(input({ env: env({ webcodecs: noAudioEncoder }) }), encoderProbe(true)).engine).toBe('mediarecorder');
  });

  it('refuses with no encoder rather than exporting nothing', () => {
    const plan = planExport(input({ env: env({ mediaRecorder: false }) }), encoderProbe(false));
    expect(plan.engine).toBe('none');
    expect(plan.reason).toBe('no-encoder');
    expect(plan.mime).toBe('');
    expect(plan.extension).toBe('');
  });

  it('refuses when the recorder accepts none of the candidate containers', () => {
    const plan = planExport(input({ env: env({ recorderSupports: () => false }) }), encoderProbe(false));
    expect(plan.engine).toBe('none');
  });

  it('plans an audio-only container when the candidate list is audio-only', () => {
    const audioEnv = env({ recorderSupports: (mime) => mime.startsWith('audio/webm') });
    const plan = planExport(input({ candidates: AUDIO_CANDIDATES, env: audioEnv }), encoderProbe(true));
    expect(plan.engine).toBe('mediarecorder');
    expect(plan.extension).toBe('.webm');
    // An audio container the recorder refuses must be skipped, not assumed.
    const refused = planExport(input({ candidates: ['audio/weird'], env: audioEnv }), encoderProbe(true));
    expect(refused.engine).toBe('none');
  });

  it('knows which containers map to which extension', () => {
    expect(extensionForExport('video/webm;codecs=vp9,opus')).toBe('.webm');
    expect(extensionForExport('video/mp4')).toBe('.mp4');
    expect(extensionForExport('audio/ogg;codecs=opus')).toBe('.ogg');
    expect(extensionForExport('audio/mpeg')).toBe('.mp3');
    expect(extensionForExport('video/x-matroska;codecs=avc1')).toBe('.mkv');
  });

  it('reports whether the whole WebCodecs path is present', () => {
    expect(webCodecsReady(FULL_WEBCODECS)).toBe(true);
    expect(webCodecsReady({ ...FULL_WEBCODECS, trackGenerator: false })).toBe(false);
    expect(webCodecsReady({ ...NO_WEBCODECS, videoEncoder: true, trackGenerator: true })).toBe(true);
  });
});

describe('file naming', () => {
  it('strips only the last extension', () => {
    expect(baseNameWithoutExtension('holiday.clip.mp4')).toBe('holiday.clip');
    expect(baseNameWithoutExtension('plain')).toBe('plain');
    expect(baseNameWithoutExtension('.hidden')).toBe('.hidden');
  });

  it('builds a name that says what it is and when it was made', () => {
    expect(exportName('holiday', '.webm', '120501')).toBe('holiday-edited-120501.webm');
  });

  it('removes characters a file name cannot hold', () => {
    expect(exportName('a/b:c*d?e"f<g>h|i', '.mp4', '000000')).toBe('a-b-c-d-e-f-g-h-i-edited-000000.mp4');
  });

  it('falls back to a usable name when the base is empty', () => {
    expect(exportName('', '.webm', '000000')).toBe('video-edited-000000.webm');
  });

  it('plans a `.bak` only when the target already exists', () => {
    expect(planName('/home/user', 'a-edited-1.webm', false)).toEqual({ path: '/home/user/a-edited-1.webm', backup: null });
    expect(planName('/home/user', 'a-edited-1.webm', true))
      .toEqual({ path: '/home/user/a-edited-1.webm', backup: '/home/user/a-edited-1.webm.bak' });
  });

  it('normalizes a directory with a trailing slash', () => {
    expect(planName('/home/user/', 'x.mp4', false).path).toBe('/home/user/x.mp4');
  });
});

describe('storage limits', () => {
  it('matches the limits the VFS enforces', () => {
    expect(VFS_FILE_LIMIT).toBe(20 * 1024 * 1024);
    expect(VFS_TOTAL_LIMIT).toBe(50 * 1024 * 1024);
  });

  it('accepts a write that fits both limits', () => {
    expect(checkQuota(1_000_000, 0)).toBe('ok');
    expect(checkQuota(10_000_000, 30_000_000)).toBe('ok');
  });

  it('refuses a file past the per-file limit', () => {
    expect(checkQuota(VFS_FILE_LIMIT + 1, 0)).toBe('file-too-big');
  });

  it('refuses a file that would pass the total limit', () => {
    expect(checkQuota(5_000_000, VFS_TOTAL_LIMIT - 1_000_000)).toBe('total-too-big');
  });

  it('reports how full the per-file limit is', () => {
    expect(quotaFraction(VFS_FILE_LIMIT / 2)).toBe(0.5);
    expect(quotaFraction(0)).toBe(0);
    expect(quotaFraction(VFS_FILE_LIMIT * 2)).toBe(1);
    expect(quotaFraction(Number.NaN)).toBe(0);
  });
});

/**
 * The fallback after the fast path gives up. WebCodecs claims support, starts, and then fails on
 * a real machine often enough that the export must not die with it — but a cancellation is the
 * user's decision, and re-running behind their back would be worse than the failure.
 */
describe('falling back from the WebCodecs export', () => {
  it('retries on the recorder for any real failure', () => {
    expect(shouldFallBackFromMp4(new Error('encoder threw'), false)).toBe(true);
    expect(shouldFallBackFromMp4(new DOMException('closed', 'InvalidStateError'), false)).toBe(true);
    expect(shouldFallBackFromMp4('a string somewhere', false)).toBe(true);
  });

  it('never retries after a cancellation, however it arrives', () => {
    expect(shouldFallBackFromMp4(new ExportCancelled(), false)).toBe(false);
    expect(shouldFallBackFromMp4(new Error('anything at all'), true)).toBe(false);
  });

  it('carries both failures, so the UI can say one honest sentence', () => {
    const both = new ExportBothFailed(new Error('mp4 gave up'), new Error('no recorder'));
    expect(both).toBeInstanceOf(Error);
    expect(both.name).toBe('ExportBothFailed');
    expect((both.mp4 as Error).message).toBe('mp4 gave up');
    expect((both.recorder as Error).message).toBe('no recorder');
  });
});
