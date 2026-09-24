/**
 * Small projects for the engine tests (test-only helpers, no DOM).
 */
import { emptyProject, makeMediaClip, makeTextClip, type MediaClip, type Project, type TextClip, type TransitionKind } from '../project';

export function video(id: string, mediaId: string, duration: number, patch: Partial<MediaClip> = {}): MediaClip {
  return { ...makeMediaClip('video', mediaId, duration), id, ...patch };
}

export function audio(id: string, mediaId: string, duration: number, patch: Partial<MediaClip> = {}): MediaClip {
  return { ...makeMediaClip('audio', mediaId, duration), id, ...patch };
}

export function title(id: string, start: number, text: string, patch: Partial<TextClip> = {}): TextClip {
  return { ...makeTextClip(start, text, patch), id };
}

/** Two 4 s main clips joined by `kind` (1 s), an optional title and extra tracks. */
export function twoClips(kind: TransitionKind = 'crossfade', extra: (p: Project) => Project = (p) => p): Project {
  const p = emptyProject('16:9', 'test');
  const a = video('A', 'mA', 4);
  const b = video('B', 'mB', 4, { transition: { kind, duration: 1 } });
  const tracks = p.tracks.map((t) => (t.kind === 'main' ? { ...t, clips: [a, b] } : t));
  return extra({ ...p, tracks });
}

export function withTrackClips(p: Project, trackId: string, clips: Project['tracks'][number]['clips']): Project {
  return { ...p, tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, clips } : t)) };
}
