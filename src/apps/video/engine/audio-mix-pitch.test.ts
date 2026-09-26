import { afterEach, describe, expect, it } from 'vitest';
import { emptyProject } from '../project';
import { renderMixOffline } from './audio-mix';
import { audio, withTrackClips } from './fixtures';

/**
 * The seam between the mix and the stretch: `renderMixOffline` is what both exports (WAV and MP4)
 * hand to the encoder, so this is where "the exported sound keeps its pitch" is decided.
 *
 * jsdom has no Web Audio at all, so a small stand-in records what the mix builds: which buffer
 * each clip plays, at what rate, and from where. That is exactly the contract that used to be
 * wrong — a clip at 2× was played by resampling (`playbackRate = 2`), which moves the pitch.
 */
const RATE = 48000;

class FakeBuffer {
  readonly channels: Float32Array[];
  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) {
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  get duration(): number { return this.length / this.sampleRate; }
  getChannelData(i: number): Float32Array { return this.channels[i]; }
}

class FakeSource {
  buffer: FakeBuffer | null = null;
  readonly playbackRate = { value: 1 };
  started: { when: number; offset: number } | null = null;
  stopped: number | null = null;
  connect(): void { /* the graph is not under test */ }
  start(when: number, offset = 0): void { this.started = { when, offset }; }
  stop(when: number): void { this.stopped = when; }
}

class FakeGain {
  readonly gain = { setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined };
  connect(): void { /* ditto */ }
}

class FakeOfflineContext {
  static last: FakeOfflineContext | null = null;
  readonly sources: FakeSource[] = [];
  constructor(readonly channels: number, readonly length: number, readonly sampleRate: number) {
    FakeOfflineContext.last = this;
  }
  createBufferSource(): FakeSource { const s = new FakeSource(); this.sources.push(s); return s; }
  createGain(): FakeGain { return new FakeGain(); }
  createBuffer(n: number, length: number, rate: number): FakeBuffer { return new FakeBuffer(n, length, rate); }
  suspend(): Promise<void> { return Promise.resolve(); }
  resume(): Promise<void> { return Promise.resolve(); }
  startRendering(): Promise<FakeBuffer> { return Promise.resolve(new FakeBuffer(this.channels, this.length, this.sampleRate)); }
}

/** A 440Hz tone as a decoded "AudioBuffer" of `seconds`. */
function decodedTone(seconds: number, hz = 440, rate = RATE): FakeBuffer {
  const buffer = new FakeBuffer(1, Math.round(seconds * rate), rate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / rate);
  return buffer;
}

/** Energy at one frequency (Goertzel), for reading the pitch back out of the mix. */
function energyAt(samples: Float32Array, hz: number, rate = RATE): number {
  const w = (2 * Math.PI * hz) / rate;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const s0 = samples[i] + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2)) / Math.max(1, samples.length);
}

/** A project holding exactly one audio clip, so `sources[0]` is the one under test. */
function project(speed: number, duration = 2) {
  const clip = audio('M', 'music', duration, { start: 0, speed });
  const base = emptyProject('16:9', 'test');
  return { project: withTrackClips(base, 'audio-1', [clip]), clip };
}

afterEach(() => { FakeOfflineContext.last = null; });

/**
 * jsdom's `Window` type has no `OfflineAudioContext` — the same reason `audio-mix.ts` reads it
 * through a narrow cast. Install the stand-in exactly the way the module looks for it.
 */
function installFakeOffline(): void {
  (globalThis as unknown as { window: { OfflineAudioContext?: unknown } }).window.OfflineAudioContext =
    FakeOfflineContext;
}

describe('renderMixOffline — a clip at speed 2 is stretched, never resampled', () => {
  it('plays the stretched buffer at rate 1, so the pitch cannot move', async () => {
    installFakeOffline();
    const tone = decodedTone(2);
    const { project: p } = project(2);
    const result = await renderMixOffline(p, 2, async () => tone as unknown as AudioBuffer, { sampleRate: RATE, channels: 1 });
    const ctx = FakeOfflineContext.last!;
    const source = ctx.sources[0];
    expect(source).toBeTruthy();
    // The rate is untouched (the old code set it to the clip's speed) ...
    expect(source.playbackRate.value).toBe(1);
    // ... because the clip's own samples were stretched to half the length instead.
    expect(source.buffer).toBeTruthy();
    expect(Math.abs(source.buffer!.length - tone.length / 2)).toBeLessThanOrEqual(4);
    // ... and it starts reading from the pressed-in point on the stretched axis.
    expect(source.started!.when).toBe(0);
    expect(source.started!.offset).toBeCloseTo(0, 6);
    expect(result.pitchShifted).toBe(false);
  });

  it('keeps 440Hz in the very buffer the encoder will receive', async () => {
    installFakeOffline();
    const tone = decodedTone(2);
    const { project: p } = project(2);
    await renderMixOffline(p, 2, async () => tone as unknown as AudioBuffer, { sampleRate: RATE, channels: 1 });
    const mixed = FakeOfflineContext.last!.sources[0].buffer!.getChannelData(0);
    const at440 = energyAt(mixed, 440);
    const at880 = energyAt(mixed, 880);
    expect(at440).toBeGreaterThan(10 * at880);
  });

  it('leaves a 1× clip exactly as it was: same buffer, same rate, same offset', async () => {
    installFakeOffline();
    const tone = decodedTone(2);
    const { project: p } = project(1);
    await renderMixOffline(p, 2, async () => tone as unknown as AudioBuffer, { sampleRate: RATE, channels: 1 });
    const source = FakeOfflineContext.last!.sources[0];
    expect(source.buffer).toBe(tone);
    expect(source.playbackRate.value).toBe(1);
    expect(source.started!.offset).toBe(0);
  });

  it('reports the one case it cannot keep the pitch for (a clip too short to frame)', async () => {
    installFakeOffline();
    const tiny = decodedTone(0.02);
    const { project: p } = project(2, 0.02);
    const result = await renderMixOffline(p, 0.02, async () => tiny as unknown as AudioBuffer, { sampleRate: RATE, channels: 1 });
    expect(result.pitchShifted).toBe(true);
  });
});
