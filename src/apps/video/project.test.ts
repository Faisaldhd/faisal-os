import { describe, expect, it } from 'vitest';
import {
  appendClip,
  audibleAt,
  clipLength,
  clipSpan,
  detachAudio,
  dropIndex,
  duplicateClip,
  effectiveTransition,
  emptyProject,
  estimateExportBytes,
  exportDimensions,
  findClip,
  fitZoom,
  frameSize,
  freeStart,
  insertClip,
  isEmptyProject,
  layoutTrack,
  mainIndexAt,
  mainTrack,
  makeMediaClip,
  makeTextClip,
  MIN_CLIP,
  moveClip,
  projectDuration,
  removeClip,
  rulerTicks,
  snapBlock,
  snapPoints,
  snapTime,
  sourceTimeAt,
  splitAtPlayhead,
  splitClip,
  textAnimAt,
  tickStep,
  timecode,
  timelineTimeAt,
  trackAccepts,
  trimClip,
  trimToPlayhead,
  updateClip,
  updateTrack,
  videoBitrate,
  visualsAt,
  xToTime,
  timeToX,
  type MediaClip,
  type Project,
} from './project';

/** A project whose main track holds clips of the given lengths (source = timeline at 1×). */
function withMain(...lengths: number[]): Project {
  let p = emptyProject('16:9');
  for (const length of lengths) p = appendClip(p, 'main', makeMediaClip('video', 'm1', length));
  return p;
}

const mainClips = (p: Project) => mainTrack(p).clips as MediaClip[];

describe('layout and time mapping', () => {
  it('packs main-track clips end to end (magnetic track)', () => {
    const p = withMain(4, 3, 5);
    expect(layoutTrack(mainTrack(p)).map((x) => [x.start, x.end])).toEqual([[0, 4], [4, 7], [7, 12]]);
    expect(projectDuration(p)).toBe(12);
  });

  it('divides the source range by the speed', () => {
    const clip = { ...makeMediaClip('video', 'm', 10), speed: 2 };
    expect(clipLength(clip)).toBe(5);
    expect(sourceTimeAt(clip, 3, 4)).toBe(2);
    expect(timelineTimeAt(clip, 3, 2)).toBe(4);
  });

  it('never maps outside the clip source range', () => {
    const clip = { ...makeMediaClip('video', 'm', 10), in: 2, out: 6 };
    expect(sourceTimeAt(clip, 0, -5)).toBe(2);
    expect(sourceTimeAt(clip, 0, 99)).toBeLessThan(6);
  });

  it('shows images for a fixed time with no source clock', () => {
    const image = makeMediaClip('image', 'img', 0);
    expect(clipLength(image)).toBe(4);
    expect(sourceTimeAt(image, 0, 2)).toBe(0);
  });

  it('finds the main clip under the playhead, and -1 past the end', () => {
    const p = withMain(4, 3);
    expect(mainIndexAt(p, 0)).toBe(0);
    expect(mainIndexAt(p, 4)).toBe(1);
    expect(mainIndexAt(p, 7)).toBe(-1);
  });

  it('takes the latest end across every track', () => {
    let p = withMain(4);
    p = insertClip(p, 'audio-1', makeMediaClip('audio', 'song', 10), 1);
    p = insertClip(p, 'text-1', makeTextClip(0, 'hi'), 20);
    expect(projectDuration(p)).toBe(23);
    expect(isEmptyProject(p)).toBe(false);
    expect(isEmptyProject(emptyProject())).toBe(true);
  });
});

describe('transitions', () => {
  it('overlaps a crossfade and a slide, but not a dip to black', () => {
    let p = withMain(4, 4);
    const second = mainClips(p)[1];
    p = updateClip(p, { ...second, transition: { kind: 'crossfade', duration: 1 } });
    expect(layoutTrack(mainTrack(p))[1].start).toBe(3);
    expect(projectDuration(p)).toBe(7);
    p = updateClip(p, { ...mainClips(p)[1], transition: { kind: 'dip', duration: 1 } });
    expect(layoutTrack(mainTrack(p))[1].start).toBe(4);
  });

  it('caps a transition at half of the shorter clip', () => {
    const a = makeMediaClip('video', 'm', 1);
    const b = { ...makeMediaClip('video', 'm', 10), transition: { kind: 'crossfade' as const, duration: 3 } };
    expect(effectiveTransition(a, b)).toBe(0.5);
    expect(effectiveTransition(undefined, b)).toBe(0);
  });

  it('blends two layers inside a crossfade', () => {
    let p = withMain(4, 4);
    p = updateClip(p, { ...mainClips(p)[1], transition: { kind: 'crossfade', duration: 2 } });
    const mid = visualsAt(p, 3);
    expect(mid.layers).toHaveLength(2);
    expect(mid.layers[1].alpha).toBeCloseTo(0.5, 5);
  });

  it('slides the incoming clip in and the outgoing clip out', () => {
    let p = withMain(4, 4);
    p = updateClip(p, { ...mainClips(p)[1], transition: { kind: 'slide', duration: 2 } });
    const mid = visualsAt(p, 3);
    expect(mid.layers[0].offsetX).toBeCloseTo(-0.5, 5);
    expect(mid.layers[1].offsetX).toBeCloseTo(0.5, 5);
  });

  it('dips to full black exactly at the join', () => {
    let p = withMain(4, 4);
    p = updateClip(p, { ...mainClips(p)[1], transition: { kind: 'dip', duration: 1 } });
    expect(visualsAt(p, 4).black).toBeCloseTo(1, 5);
    expect(visualsAt(p, 3.75).black).toBeCloseTo(0.5, 5);
    expect(visualsAt(p, 2).black).toBe(0);
  });

  it('ramps the audio of both clips through a crossfade', () => {
    let p = withMain(4, 4);
    p = updateClip(p, { ...mainClips(p)[1], transition: { kind: 'crossfade', duration: 2 } });
    const sounds = audibleAt(p, 3);
    expect(sounds).toHaveLength(2);
    expect(sounds[0].gain).toBeCloseTo(0.5, 5);
    expect(sounds[1].gain).toBeCloseTo(0.5, 5);
  });
});

describe('audio', () => {
  it('silences a muted track but keeps its clip in the list', () => {
    let p = insertClip(emptyProject(), 'audio-1', makeMediaClip('audio', 'song', 10), 0);
    expect(audibleAt(p, 1)[0].gain).toBe(1);
    p = updateTrack(p, 'audio-1', { muted: true });
    expect(audibleAt(p, 1)[0].gain).toBe(0);
  });

  it('applies the clip fades', () => {
    const song = { ...makeMediaClip('audio', 'song', 10), fadeIn: 2 };
    const p = insertClip(emptyProject(), 'audio-1', song, 0);
    expect(audibleAt(p, 1)[0].gain).toBeCloseTo(0.5, 5);
  });

  it('detaches a video clip sound onto an audio track and mutes the video', () => {
    const p = withMain(4, 6);
    const id = mainClips(p)[1].id;
    const result = detachAudio(p, id);
    expect(result.id).not.toBeNull();
    const audio = findClip(result.project, result.id!);
    expect(audio?.track.kind).toBe('audio');
    expect((audio?.clip as MediaClip).start).toBe(4);
    expect((audio?.clip as MediaClip).type).toBe('audio');
    expect((findClip(result.project, id)?.clip as MediaClip).muted).toBe(true);
  });

  it('refuses to detach from something that is not a video', () => {
    const p = insertClip(emptyProject(), 'text-1', makeTextClip(0, 'x'), 0);
    const id = p.tracks[0].clips[0].id;
    expect(detachAudio(p, id).id).toBeNull();
  });
});

describe('split', () => {
  it('splits a main clip at the playhead into two halves covering the same source', () => {
    const p = withMain(10);
    const id = mainClips(p)[0].id;
    const r = splitClip(p, id, 4);
    const clips = mainClips(r.project);
    expect(clips.map((c) => [c.in, c.out])).toEqual([[0, 4], [4, 10]]);
    expect(projectDuration(r.project)).toBe(10);
    expect(r.left).not.toBe(r.right);
  });

  it('splits a sped-up clip at the right source time', () => {
    let p = withMain(10);
    p = updateClip(p, { ...mainClips(p)[0], speed: 2 });
    const r = splitClip(p, mainClips(p)[0].id, 2);
    expect(mainClips(r.project).map((c) => [c.in, c.out])).toEqual([[0, 4], [4, 10]]);
  });

  it('keeps the entry on the left half and the exit on the right half', () => {
    let p = withMain(3, 10);
    p = updateClip(p, { ...mainClips(p)[1], fadeIn: 1, fadeOut: 2, transition: { kind: 'dip', duration: 0.5 } });
    const r = splitClip(p, mainClips(p)[1].id, 6);
    const [, left, right] = mainClips(r.project);
    expect(left.fadeIn).toBe(1);
    expect(left.fadeOut).toBe(0);
    expect(left.transition.kind).toBe('dip');
    expect(right.fadeIn).toBe(0);
    expect(right.fadeOut).toBe(2);
    expect(right.transition.kind).toBe('none');
  });

  it('refuses a cut too close to an edge', () => {
    const p = withMain(10);
    const id = mainClips(p)[0].id;
    expect(splitClip(p, id, MIN_CLIP / 2).left).toBeNull();
    expect(splitClip(p, id, 10 - MIN_CLIP / 2).left).toBeNull();
  });

  it('splits a title and an audio clip by timeline time', () => {
    let p = insertClip(emptyProject(), 'text-1', makeTextClip(0, 'hello', { duration: 4 }), 2);
    const tid = p.tracks[0].clips[0].id;
    p = splitClip(p, tid, 3).project;
    expect(p.tracks[0].clips.map((c) => [c.start, clipLength(c)])).toEqual([[2, 1], [3, 3]]);
    let a = insertClip(emptyProject(), 'audio-1', makeMediaClip('audio', 's', 8), 1);
    const aid = a.tracks[3].clips[0].id;
    a = splitClip(a, aid, 3).project;
    expect((a.tracks[3].clips as MediaClip[]).map((c) => [c.start, c.in, c.out])).toEqual([[1, 0, 2], [3, 2, 8]]);
  });

  it('splits the selected clip first, else whatever is on the main track', () => {
    let p = withMain(5, 5);
    p = insertClip(p, 'text-1', makeTextClip(0, 'x', { duration: 4 }), 6);
    const textId = p.tracks[0].clips[0].id;
    expect(splitAtPlayhead(p, 7, textId).left).not.toBeNull();
    const byMain = splitAtPlayhead(p, 7, null);
    expect(mainClips(byMain.project)).toHaveLength(3);
    expect(splitAtPlayhead(p, 99, null).left).toBeNull();
  });
});

describe('trim', () => {
  it('trims the head of a main clip and the rest of the track follows', () => {
    let p = withMain(10, 5);
    p = trimClip(p, mainClips(p)[0].id, 'start', 3);
    expect(mainClips(p)[0].in).toBe(3);
    expect(layoutTrack(mainTrack(p))[1].start).toBe(7);
  });

  it('never trims past the source file or below the minimum length', () => {
    let p = withMain(10);
    const id = mainClips(p)[0].id;
    p = trimClip(p, id, 'end', 50);
    expect(mainClips(p)[0].out).toBe(10);
    p = trimClip(p, id, 'start', 50);
    expect(clipLength(mainClips(p)[0])).toBeCloseTo(MIN_CLIP, 6);
    p = trimClip(p, id, 'start', -50);
    expect(mainClips(p)[0].in).toBe(0);
  });

  it('lets an image grow without a source limit', () => {
    let p = appendClip(emptyProject(), 'main', makeMediaClip('image', 'img', 0));
    const id = mainClips(p)[0].id;
    p = trimClip(p, id, 'end', 6);
    expect(clipLength(mainClips(p)[0])).toBe(10);
  });

  it('keeps the tail of an audio clip fixed when its head is trimmed', () => {
    let p = insertClip(emptyProject(), 'audio-1', makeMediaClip('audio', 's', 10), 2);
    const id = p.tracks[3].clips[0].id;
    p = trimClip(p, id, 'start', 3);
    const clip = p.tracks[3].clips[0] as MediaClip;
    expect(clip.start).toBe(5);
    expect(clip.in).toBe(3);
    expect(clipSpan(p, id)?.end).toBe(12);
  });

  it('trims to the playhead (I / O)', () => {
    let p = withMain(10);
    const id = mainClips(p)[0].id;
    p = trimToPlayhead(p, id, 'end', 6);
    expect(mainClips(p)[0].out).toBe(6);
    p = trimToPlayhead(p, id, 'start', 2);
    expect(mainClips(p)[0].in).toBe(2);
    expect(trimToPlayhead(p, id, 'start', 30)).toBe(p);
  });
});

describe('move, delete, duplicate', () => {
  it('reorders the main track by drop position', () => {
    const p = withMain(2, 2, 2);
    const [a, b, c] = mainClips(p).map((x) => x.id);
    const moved = moveClip(p, a, 'main', 5.5);
    expect(mainClips(moved).map((x) => x.id)).toEqual([b, c, a]);
    expect(dropIndex(mainTrack(p), 0.5)).toBe(0);
  });

  it('moves a clip from the main track to the overlay track and back', () => {
    const p = withMain(3, 3);
    const id = mainClips(p)[1].id;
    const up = moveClip(p, id, 'overlay-1', 1);
    expect(findClip(up, id)?.track.kind).toBe('overlay');
    expect((findClip(up, id)?.clip as MediaClip).start).toBe(1);
    expect(mainClips(up)).toHaveLength(1);
    const down = moveClip(up, id, 'main', 0);
    expect(mainClips(down)[0].id).toBe(id);
  });

  it('refuses to put a clip on a track that cannot hold it', () => {
    const p = withMain(3);
    const id = mainClips(p)[0].id;
    expect(moveClip(p, id, 'audio-1', 0)).toBe(p);
    expect(trackAccepts('text', 'video')).toBe(false);
    expect(trackAccepts('overlay', 'image')).toBe(true);
  });

  it('never stacks two clips on one non-main track', () => {
    let p = insertClip(emptyProject(), 'audio-1', makeMediaClip('audio', 's', 5), 0);
    p = insertClip(p, 'audio-1', makeMediaClip('audio', 's', 5), 2);
    expect(p.tracks[3].clips.map((c) => c.start)).toEqual([0, 5]);
    expect(freeStart(p.tracks[3], 1, 2)).toBe(10);
  });

  it('ripple-deletes on the main track', () => {
    const p = withMain(2, 3, 4);
    const next = removeClip(p, mainClips(p)[1].id);
    expect(layoutTrack(mainTrack(next)).map((x) => x.start)).toEqual([0, 2]);
    expect(projectDuration(next)).toBe(6);
  });

  it('duplicates right after the original', () => {
    const p = withMain(2, 3);
    const r = duplicateClip(p, mainClips(p)[0].id);
    expect(mainClips(r.project)[1].id).toBe(r.id);
    expect(projectDuration(r.project)).toBe(7);
    let t = insertClip(emptyProject(), 'text-1', makeTextClip(0, 'a', { duration: 2 }), 1);
    const dup = duplicateClip(t, t.tracks[0].clips[0].id);
    t = dup.project;
    expect(t.tracks[0].clips.map((c) => c.start)).toEqual([1, 3]);
  });
});

describe('snapping', () => {
  it('collects every edge and the playhead', () => {
    let p = withMain(2, 3);
    p = insertClip(p, 'text-1', makeTextClip(0, 'x', { duration: 1 }), 7);
    expect(snapPoints(p, 1.5)).toEqual([0, 1.5, 2, 5, 7, 8]);
    const first = mainClips(p)[0].id;
    expect(snapPoints(p, 1.5, [first])).toEqual([0, 1.5, 2, 5, 7, 8]);
  });

  it('snaps to the nearest point inside the threshold only', () => {
    expect(snapTime(2.04, [0, 2, 5], 0.1)).toEqual({ time: 2, snapped: 2 });
    expect(snapTime(2.3, [0, 2, 5], 0.1)).toEqual({ time: 2.3, snapped: null });
  });

  it('snaps a moving block by its head or its tail', () => {
    expect(snapBlock(1.95, 1, [0, 2, 10], 0.1).start).toBe(2);
    expect(snapBlock(8.96, 1, [0, 2, 10], 0.1).start).toBe(9);
    expect(snapBlock(5, 1, [0, 2, 10], 0.1).snapped).toBeNull();
  });
});

describe('zoom, ruler and timecode', () => {
  it('maps time to pixels and back', () => {
    expect(timeToX(2.5, 100)).toBe(250);
    expect(xToTime(250, 100)).toBe(2.5);
    expect(xToTime(-5, 100)).toBe(0);
  });

  it('fits a project into the visible width', () => {
    expect(fitZoom(10, 1000)).toBe(90);
    expect(fitZoom(0, 1000)).toBe(60);
  });

  it('chooses readable tick steps, down to single frames', () => {
    expect(tickStep(600)).toBeCloseTo(5 / 30, 6);
    expect(tickStep(100)).toBe(1);
    expect(tickStep(2)).toBe(60);
    const ticks = rulerTicks(0, 2, 100);
    expect(ticks.filter((t) => t.major).map((t) => t.time)).toEqual([0, 1, 2]);
  });

  it('formats mm:ss:ff at 30 fps', () => {
    expect(timecode(0)).toBe('00:00:00');
    expect(timecode(61.5)).toBe('01:01:15');
    expect(timecode(3600)).toBe('1:00:00:00');
    expect(timecode(Number.NaN)).toBe('00:00:00');
  });
});

describe('titles', () => {
  it('fades and slides a title in and out', () => {
    const clip = makeTextClip(1, 'x', { duration: 4, animIn: 'slide', animOut: 'fade', animDuration: 0.5 });
    expect(textAnimAt(clip, 0.5).alpha).toBe(0);
    expect(textAnimAt(clip, 1).alpha).toBe(0);
    expect(textAnimAt(clip, 1).dy).toBeGreaterThan(0);
    expect(textAnimAt(clip, 3)).toEqual({ alpha: 1, dy: 0, scale: 1 });
    expect(textAnimAt(clip, 4.75).alpha).toBeCloseTo(0.75, 5);
  });

  it('lists titles on screen in draw order', () => {
    const p = insertClip(emptyProject(), 'text-1', makeTextClip(0, 'x', { duration: 2 }), 1);
    expect(visualsAt(p, 1.5).texts).toHaveLength(1);
    expect(visualsAt(p, 3.5).texts).toHaveLength(0);
    expect(visualsAt(updateTrack(p, 'text-1', { hidden: true }), 1.5).texts).toHaveLength(0);
  });
});

describe('frame and export sizes', () => {
  it('follows the first clip in auto mode and a preset ratio otherwise', () => {
    expect(frameSize('auto', { width: 1281, height: 719 })).toEqual({ width: 1282, height: 720 });
    expect(frameSize('auto', null)).toEqual({ width: 1920, height: 1080 });
    expect(frameSize('9:16', null)).toEqual({ width: 1080, height: 1920 });
    expect(frameSize('4:5', null)).toEqual({ width: 1080, height: 1350 });
  });

  it('scales to the short side of the preset and caps the source at 4K', () => {
    expect(exportDimensions({ width: 1920, height: 1080 }, '720')).toEqual({ width: 1280, height: 720 });
    expect(exportDimensions({ width: 1080, height: 1920 }, '720')).toEqual({ width: 720, height: 1280 });
    expect(exportDimensions({ width: 7680, height: 4320 }, 'source')).toEqual({ width: 3840, height: 2160 });
  });

  it('keeps bitrates in a sane range and estimates the size', () => {
    expect(videoBitrate({ width: 1920, height: 1080 }, 30, 'high')).toBeGreaterThan(videoBitrate({ width: 1920, height: 1080 }, 30, 'low'));
    expect(videoBitrate({ width: 2, height: 2 }, 30, 'low')).toBe(400_000);
    expect(estimateExportBytes(10, 8_000_000, 0)).toBe(10_000_000);
  });
});
