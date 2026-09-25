import { describe, expect, it } from 'vitest';
import { audioBlocks, avcCandidates, avcLevel, frameCount, frameTiming, isKeyFrame, muxerOptions, pickMp4Plan, type Mp4Probe } from './mp4-plan';

const yes: Mp4Probe = { video: async () => true, audio: async () => true };
const req = { width: 1920, height: 1080, fps: 30, videoBitrate: 8e6, audioBitrate: 192e3, wantsAudio: true };

describe('avcLevel', () => {
  it('picks the smallest level that holds the frame size and rate', () => {
    expect(avcLevel(1280, 720, 30)).toBe(0x1f); // 3.1
    expect(avcLevel(1920, 1080, 30)).toBe(0x28); // 4.0
    expect(avcLevel(1920, 1080, 60)).toBe(0x2a); // 4.2
    expect(avcLevel(640, 480, 30)).toBe(0x1e); // 3.0
    expect(avcLevel(854, 480, 30)).toBe(0x1f); // 3.1 (over 3.0's throughput)
    expect(avcLevel(3840, 2160, 30)).toBe(0x33); // 5.1
  });
  it('builds High, Main and Baseline strings at that level', () => {
    expect(avcCandidates(1920, 1080, 30)).toEqual(['avc1.640028', 'avc1.4D0028', 'avc1.42E028']);
  });
});

describe('pickMp4Plan', () => {
  it('takes the first video and audio codec the browser confirms', async () => {
    const plan = await pickMp4Plan(yes, req);
    expect(plan?.video.codec).toBe('avc1.640028');
    expect(plan?.video.avc).toEqual({ format: 'avc' });
    expect(plan?.audio?.codec).toBe('mp4a.40.2');
    expect(plan?.audioMuxer).toBe('aac');
  });
  it('falls back to Main/Baseline and to Opus when AAC is refused', async () => {
    const probe: Mp4Probe = {
      video: async (c) => c.codec.startsWith('avc1.42'),
      audio: async (c) => c.codec === 'opus',
    };
    const plan = await pickMp4Plan(probe, req);
    expect(plan?.video.codec).toBe('avc1.42E028');
    expect(plan?.audioMuxer).toBe('opus');
  });
  it('is null when no H.264 encoder exists (MediaRecorder path)', async () => {
    expect(await pickMp4Plan({ video: async () => false, audio: async () => true }, req)).toBeNull();
  });
  it('is null when the film has sound but no audio encoder exists', async () => {
    expect(await pickMp4Plan({ video: async () => true, audio: async () => false }, req)).toBeNull();
  });
  it('writes no audio track for a silent film, and survives a throwing probe', async () => {
    const plan = await pickMp4Plan({ video: async () => true, audio: () => Promise.reject(new Error('x')) }, { ...req, wantsAudio: false });
    expect(plan?.audio).toBeNull();
    expect(await pickMp4Plan({ video: () => Promise.reject(new Error('x')), audio: async () => true }, req)).toBeNull();
  });
  it('rounds odd sizes to even and clamps the frame rate', async () => {
    const plan = await pickMp4Plan(yes, { ...req, width: 1281, height: 719, fps: 120 });
    expect(plan!.video.width % 2).toBe(0);
    expect(plan!.video.height % 2).toBe(0);
    expect(plan?.fps).toBe(60);
  });
});

describe('muxerOptions', () => {
  it('maps the plan to an in-memory fast-start MP4 with both tracks', async () => {
    const plan = (await pickMp4Plan(yes, req))!;
    expect(muxerOptions(plan)).toEqual({
      video: { codec: 'avc', width: 1920, height: 1080, frameRate: 30 },
      audio: { codec: 'aac', numberOfChannels: 2, sampleRate: 48000 },
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    });
  });
  it('has no audio entry for a silent plan', async () => {
    const plan = (await pickMp4Plan(yes, { ...req, wantsAudio: false }))!;
    expect('audio' in muxerOptions(plan)).toBe(false);
  });
});

describe('timing', () => {
  it('counts frames and spaces them without drift', () => {
    expect(frameCount(10, 30)).toBe(300);
    expect(frameCount(0, 30)).toBe(1);
    let sum = 0;
    for (let i = 0; i < 30; i++) sum += frameTiming(i, 30).duration;
    expect(sum).toBe(1_000_000);
    expect(frameTiming(30, 30).timestamp).toBe(1_000_000);
  });
  it('puts a key frame every two seconds', () => {
    expect([0, 59, 60, 120].map((i) => isKeyFrame(i, 30))).toEqual([true, false, true, true]);
  });
  it('slices audio into blocks that cover every sample once', () => {
    const blocks = audioBlocks(10_000, 4096);
    expect(blocks).toEqual([{ start: 0, frames: 4096 }, { start: 4096, frames: 4096 }, { start: 8192, frames: 1808 }]);
    expect(audioBlocks(0)).toEqual([]);
  });
});
