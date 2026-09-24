import { describe, expect, it } from 'vitest';
import {
  absoluteFallback,
  parseProjectFile,
  ProjectFileError,
  relativePath,
  resolveRelative,
  serializeProject,
  type MediaRef,
} from './project-file';
import { appendClip, emptyProject, insertClip, makeMediaClip, makeTextClip, updateClip, updateTrack, type MediaClip } from './project';

const MEDIA: MediaRef[] = [
  { id: 'm1', path: '/home/user/Videos/trip.webm', name: 'trip.webm', type: 'video', duration: 12, width: 1280, height: 720, hasAudio: true },
  { id: 'm2', path: '/home/user/Music/song.mp3', name: 'song.mp3', type: 'audio', duration: 60, width: 0, height: 0, hasAudio: true },
  { id: 'm3', path: '/home/user/Pictures/logo.png', name: 'logo.png', type: 'image', duration: 0, width: 512, height: 512, hasAudio: false },
  { id: 'unused', path: '/home/user/x.mp4', name: 'x.mp4', type: 'video', duration: 1, width: 1, height: 1, hasAudio: false },
];

function richProject() {
  let p = emptyProject('9:16', 'رحلة الصيف');
  p = appendClip(p, 'main', makeMediaClip('video', 'm1', 12));
  p = appendClip(p, 'main', makeMediaClip('video', 'm1', 12));
  const second = p.tracks[2].clips[1] as MediaClip;
  p = updateClip(p, { ...second, in: 2, out: 8, speed: 1.5, transition: { kind: 'slide', duration: 0.8 }, color: { brightness: 1.2, contrast: 1, saturation: 0.5 } });
  p = insertClip(p, 'overlay-1', makeMediaClip('image', 'm3', 0, { overlay: true }), 1);
  p = insertClip(p, 'audio-2', makeMediaClip('audio', 'm2', 60), 0);
  p = insertClip(p, 'text-1', makeTextClip(0, 'مرحباً بكم', { animIn: 'slide', color: '#ffcc00', background: '#000000' }), 0.5);
  p = updateTrack(p, 'audio-1', { muted: true });
  return p;
}

describe('paths', () => {
  it('makes paths relative to the project folder', () => {
    expect(relativePath('/home/user/Videos', '/home/user/Videos/a.webm')).toBe('a.webm');
    expect(relativePath('/home/user/Videos', '/home/user/Music/a.mp3')).toBe('../Music/a.mp3');
    expect(relativePath('/home/user/Videos/p', '/tmp/x.mp4')).toBe('../../../../tmp/x.mp4');
  });

  it('resolves them back', () => {
    expect(resolveRelative('/home/user/Videos', '../Music/a.mp3')).toBe('/home/user/Music/a.mp3');
    expect(resolveRelative('/home/user/Videos', '/abs/b.mp4')).toBe('/abs/b.mp4');
  });
});

describe('project round-trip', () => {
  it('reopens every track, clip, text, transition and setting identically', () => {
    const project = richProject();
    const text = serializeProject(project, MEDIA, '/home/user/Videos');
    const back = parseProjectFile(text, '/home/user/Videos');
    expect(back.project).toEqual(project);
    expect(back.media.map((m) => m.path)).toEqual(['/home/user/Videos/trip.webm', '/home/user/Music/song.mp3', '/home/user/Pictures/logo.png']);
    expect(back.media.find((m) => m.id === 'unused')).toBeUndefined();
  });

  it('follows the project when its folder moves together with the media', () => {
    const text = serializeProject(richProject(), MEDIA, '/home/user');
    const moved = parseProjectFile(text, '/home/user/Backup');
    expect(moved.media[0].path).toBe('/home/user/Backup/Videos/trip.webm');
    expect(absoluteFallback(text, 'm1')).toBe('/home/user/Videos/trip.webm');
  });

  it('names what is wrong with a bad file', () => {
    const reason = (text: string) => {
      try { parseProjectFile(text, '/'); return null; } catch (err) { return err instanceof ProjectFileError ? err.reason : 'other'; }
    };
    expect(reason('{not json')).toBe('json');
    expect(reason('{"format":"something-else"}')).toBe('format');
    expect(reason('{"format":"faisal-video-project","version":99}')).toBe('version');
    expect(reason('{"format":"faisal-video-project","version":1,"project":{}}')).toBe('shape');
  });

  it('repairs hostile values instead of trusting them', () => {
    const text = JSON.stringify({
      format: 'faisal-video-project',
      version: 1,
      project: {
        aspect: 'weird',
        background: 'red; }',
        tracks: [
          { id: 'a', kind: 'audio', clips: [{ id: 'x', type: 'text', text: 'wrong track' }, { id: 'y', type: 'audio', mediaId: 'm', in: 0, out: 5, speed: 99, volume: -3 }] },
          { id: 'b', kind: 'bogus', clips: [] },
        ],
      },
      media: [{ id: 'm', path: 'song.mp3', type: 'audio' }],
    });
    const back = parseProjectFile(text, '/home/user');
    expect(back.project.aspect).toBe('auto');
    expect(back.project.background).toBe('#000000');
    expect(back.project.tracks.map((t) => t.kind)).toEqual(['audio', 'main']);
    const clip = back.project.tracks[0].clips[0] as MediaClip;
    expect(back.project.tracks[0].clips).toHaveLength(1);
    expect(clip.speed).toBe(4);
    expect(clip.volume).toBe(0);
    expect(back.media[0].path).toBe('/home/user/song.mp3');
  });
});
