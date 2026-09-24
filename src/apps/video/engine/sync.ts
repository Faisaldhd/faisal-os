/**
 * Playback timing — pure, no DOM.
 *
 * The timeline has one master clock. Every media element that is on screen or
 * audible follows it: small drift is corrected by nudging `playbackRate` (no
 * audible jump), large drift by a hard seek. The decisions live here so they
 * are tested without a browser.
 */
import { audibleAt, visualsAt, type MediaClip, type Project } from '../project';

/** Drift above this (seconds of source time) is fixed with a seek instead of a rate nudge. */
export const HARD_DRIFT = 0.3;
/** Drift below this is ignored: it is under one frame at 30 fps. */
export const SOFT_DRIFT = 0.025;
/** The most the rate is nudged, as a fraction of the clip speed. */
export const MAX_NUDGE = 0.1;
/** How far ahead elements are created and parked on their first frame. */
export const PREROLL = 1.5;

export interface SyncAction {
  /** Source time to jump to, or null to leave the position alone. */
  seek: number | null;
  /** The playbackRate to set. */
  rate: number;
  /** Start the element if it is paused. */
  play: boolean;
}

/**
 * What to do with an element at `current` source time that should be at
 * `target`, playing at `speed`.
 */
export function syncAction(current: number, target: number, speed: number, paused: boolean): SyncAction {
  const s = Number.isFinite(speed) && speed > 0 ? speed : 1;
  const drift = (Number.isFinite(current) ? current : 0) - target;
  if (paused) return { seek: Math.abs(drift) > SOFT_DRIFT ? target : null, rate: s, play: true };
  if (Math.abs(drift) > HARD_DRIFT * s) return { seek: target, rate: s, play: true };
  if (Math.abs(drift) <= SOFT_DRIFT) return { seek: null, rate: s, play: true };
  // Ahead (drift > 0) slows down, behind speeds up; the correction fades out
  // as the element converges, so it never overshoots into oscillation.
  const factor = Math.min(1 + MAX_NUDGE, Math.max(1 - MAX_NUDGE, 1 - drift / s));
  return { seek: null, rate: s * factor, play: true };
}

/** A master clock that can be paused, restarted at any time and read at any moment. */
export class Clock {
  private origin = 0;
  private startedAt = 0;
  private running = false;
  private rate = 1;

  constructor(private readonly now: () => number = () => performance.now() / 1000) {}

  start(at: number): void {
    this.origin = Math.max(0, at);
    this.startedAt = this.now();
    this.running = true;
  }

  pause(): number {
    const t = this.time();
    this.running = false;
    this.origin = t;
    return t;
  }

  set(at: number): void {
    this.origin = Math.max(0, at);
    this.startedAt = this.now();
  }

  /** Changes the speed of the clock without a jump in its reading. */
  setRate(rate: number): void {
    const r = Number.isFinite(rate) && rate > 0 ? rate : 1;
    this.origin = this.time();
    this.startedAt = this.now();
    this.rate = r;
  }

  get speed(): number {
    return this.rate;
  }

  get isRunning(): boolean {
    return this.running;
  }

  time(): number {
    return this.running ? this.origin + (this.now() - this.startedAt) * this.rate : this.origin;
  }
}

export interface ClipNeed {
  clip: MediaClip;
  /** Timeline start of the clip. */
  start: number;
  /** Source time the element should show/play now. */
  sourceTime: number;
  /** Visible at `time` (drawn). */
  visual: boolean;
  /** Audible gain at `time`, or null when the clip is not audible now. */
  gain: number | null;
  /** Not active yet: create the element and park it on its first frame. */
  preroll: boolean;
}

/**
 * Every media clip that needs an element at `time`: the ones drawn or heard
 * now, and the ones starting within `PREROLL` seconds (parked on their first
 * frame, so the cut into them is instant). Images are included (they need a
 * decoded picture) but never get a source position.
 */
export function clipsNeeded(project: Project, time: number, preroll = PREROLL): ClipNeed[] {
  const needs = new Map<string, ClipNeed>();
  const visuals = visualsAt(project, time);
  for (const layer of visuals.layers) {
    needs.set(layer.clip.id, { clip: layer.clip, start: layer.placed.start, sourceTime: layer.sourceTime, visual: true, gain: null, preroll: false });
  }
  for (const a of audibleAt(project, time)) {
    const existing = needs.get(a.clip.id);
    if (existing) existing.gain = a.gain;
    else needs.set(a.clip.id, { clip: a.clip, start: a.start, sourceTime: a.sourceTime, visual: false, gain: a.gain, preroll: false });
  }
  if (preroll > 0) {
    // Sample the look-ahead window so a short clip starting inside it is not missed.
    const steps = Math.max(1, Math.ceil(preroll / 0.25));
    for (let i = 1; i <= steps; i++) {
      const ahead = time + (preroll * i) / steps;
      const later = [
        ...visualsAt(project, ahead).layers.map((l) => ({ clip: l.clip, start: l.placed.start })),
        ...audibleAt(project, ahead).map((a) => ({ clip: a.clip, start: a.start })),
      ];
      for (const item of later) {
        if (needs.has(item.clip.id) || item.start <= time) continue;
        needs.set(item.clip.id, { clip: item.clip, start: item.start, sourceTime: item.clip.type === 'image' ? 0 : item.clip.in, visual: false, gain: null, preroll: true });
      }
    }
  }
  return [...needs.values()];
}

/** Progress and a steady ETA for a job that advances through `total` seconds of timeline. */
export function progressOf(time: number, total: number, elapsedWall: number): { fraction: number; eta: number | null } {
  const fraction = total > 0 ? Math.min(1, Math.max(0, time / total)) : 0;
  if (fraction <= 0.02 || !(elapsedWall > 0.25)) return { fraction, eta: null };
  const eta = (elapsedWall / fraction) * (1 - fraction);
  return { fraction, eta: Math.max(0, eta) };
}
