/**
 * The inspector: the properties of whatever is selected, in four tabs that match
 * the phone's bottom bar — Edit, Audio, Text, Effects (with transitions).
 *
 * Sliders change the project live (`preview`) and become ONE undo step when the
 * drag ends (`end`); buttons are one step each (`apply`).
 */
import { rotateBy, toggleFlip, clampCrop, resetTransform, type CropRect } from './clips';
import {
  clipSpan,
  findClip,
  layoutTrack,
  MAX_TRANSITION,
  NEUTRAL_COLOR,
  updateClip,
  updateTrack,
  type AspectKey,
  type Clip,
  type FontKey,
  type MediaClip,
  type Project,
  type TextAnim,
  type TextClip,
  type TransitionKind,
} from './project';
import { COLOR_PRESETS } from './render-math';
import type { MediaItem } from './media';
import { formatMediaTime } from './time';
import { button, el, s, section, segmented, selectBox, slider, toggle } from './ui';
import { icon } from './icons';

export type InspectorTab = 'edit' | 'audio' | 'text' | 'effects';

export interface TextPreset {
  key: 'title' | 'subtitle' | 'lower' | 'caption';
  overrides: Partial<TextClip>;
}

export const TEXT_PRESETS: TextPreset[] = [
  { key: 'title', overrides: { size: 0.12, bold: true, y: 0.45, animIn: 'pop', animOut: 'fade', font: 'kufi' } },
  { key: 'subtitle', overrides: { size: 0.065, bold: false, y: 0.6, animIn: 'fade', animOut: 'fade' } },
  { key: 'lower', overrides: { size: 0.055, bold: true, x: 0.3, y: 0.82, background: '#16264F', align: 'start', animIn: 'slide', animOut: 'fade' } },
  { key: 'caption', overrides: { size: 0.05, bold: false, y: 0.88, background: '#000000', animIn: 'fade', animOut: 'fade' } },
];

const SWATCHES = ['#FFFFFF', '#000000', '#E0A96D', '#C8894B', '#5B8DEF', '#3DD68C', '#E5484D', '#F5D90A'];

export interface InspectorHost {
  project(): Project;
  media(id: string): MediaItem | undefined;
  time(): number;
  selected(): string | null;
  begin(): void;
  preview(next: Project): void;
  end(): void;
  apply(next: Project): void;
  split(): void;
  remove(): void;
  duplicate(): void;
  detach(): void;
  capture(): void;
  addText(preset: TextPreset): void;
  addMusic(): void;
  setAspect(aspect: AspectKey): void;
  applyTransitionToAll(kind: TransitionKind, duration: number): void;
}

export class Inspector {
  readonly root: HTMLElement;
  private readonly tabs: HTMLElement;
  private readonly body: HTMLElement;
  private tab: InspectorTab = 'edit';
  private tabButtons = new Map<InspectorTab, HTMLButtonElement>();
  /** True while one of our own controls is changing the project (no rebuild). */
  private own = false;

  constructor(private readonly host: InspectorHost) {
    this.root = el('div', 'fvs-inspector');
    this.tabs = el('div', 'fvs-tabs');
    this.tabs.setAttribute('role', 'tablist');
    this.body = el('div', 'fvs-inspector-body');
    this.body.setAttribute('role', 'tabpanel');
    const defs: Array<[InspectorTab, string]> = [['edit', s('tabEdit')], ['audio', s('tabAudio')], ['text', s('tabText')], ['effects', s('tabEffects')]];
    for (const [key, label] of defs) {
      const b = el('button', 'fvs-tab', label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.addEventListener('click', () => this.show(key));
      this.tabButtons.set(key, b);
      this.tabs.append(b);
    }
    this.root.append(this.tabs, this.body);
    this.show('edit');
  }

  get current(): InspectorTab {
    return this.tab;
  }

  show(tab: InspectorTab): void {
    this.tab = tab;
    for (const [key, b] of this.tabButtons) {
      b.setAttribute('aria-selected', String(key === tab));
      b.tabIndex = key === tab ? 0 : -1;
    }
    this.rebuild();
  }

  /** Called by the app after any change; our own live edits do not rebuild the controls. */
  refresh(): void {
    if (this.own) return;
    this.rebuild();
  }

  private selection(): { clip: Clip; track: { kind: string; id: string }; index: number } | null {
    const id = this.host.selected();
    if (!id) return null;
    const where = findClip(this.host.project(), id);
    return where ? { clip: where.clip, track: where.track, index: where.clipIndex } : null;
  }

  private rebuild(): void {
    const scroll = this.body.scrollTop;
    this.body.replaceChildren();
    const sel = this.selection();
    if (this.tab === 'edit') this.buildEdit(sel);
    else if (this.tab === 'audio') this.buildAudio(sel);
    else if (this.tab === 'text') this.buildText(sel);
    else this.buildEffects(sel);
    this.body.scrollTop = scroll;
  }

  /* ───────────── editing helpers ───────────── */

  private live<T extends Clip>(clip: T, change: (c: T) => T): void {
    const current = findClip(this.host.project(), clip.id)?.clip as T | undefined;
    if (!current) return;
    this.own = true;
    this.host.begin();
    this.host.preview(updateClip(this.host.project(), change(current)));
    this.own = false;
  }

  private commit(): void {
    this.own = true;
    this.host.end();
    this.own = false;
  }

  private once<T extends Clip>(clip: T, change: (c: T) => T, rebuild = true): void {
    const current = findClip(this.host.project(), clip.id)?.clip as T | undefined;
    if (!current) return;
    this.own = !rebuild;
    this.host.apply(updateClip(this.host.project(), change(current)));
    this.own = false;
  }

  private numberSlider<T extends Clip>(clip: T, label: string, value: number, min: number, max: number, step: number, format: (v: number) => string, set: (c: T, v: number) => T) {
    return slider({
      label, min, max, step, value, format,
      onInput: (v) => this.live(clip, (c) => set(c, v)),
      onCommit: () => this.commit(),
    }).root;
  }

  private emptyState(title: string, hint: string, iconName: 'film' | 'music' | 'text' | 'effects'): HTMLElement {
    const box = el('div', 'fvs-empty-state');
    const art = el('div', 'fvs-empty-art');
    art.append(icon(iconName));
    box.append(art, el('p', 'fvs-empty-title', title), el('p', 'fvs-empty-hint', hint));
    return box;
  }

  private header(clip: Clip): HTMLElement {
    const project = this.host.project();
    const span = clipSpan(project, clip.id);
    const head = el('div', 'fvs-insp-head');
    const name = clip.type === 'text' ? (clip.text.trim() || s('untitledText')) : (this.host.media(clip.mediaId)?.name ?? '');
    const title = el('p', 'fvs-insp-name', name);
    title.dir = 'auto';
    const meta = el('p', 'fvs-insp-meta', `${s(`type_${clip.type}`)} · ${span ? `${formatMediaTime(span.start)} → ${formatMediaTime(span.end)}` : ''}`);
    head.append(title, meta);
    return head;
  }

  private actionRow(clip: Clip): HTMLElement {
    const row = el('div', 'fvs-action-row');
    const split = button(s('split'), 'fvs-btn', 'scissors');
    split.addEventListener('click', () => this.host.split());
    const dup = button(s('duplicate'), 'fvs-btn', 'duplicate');
    dup.addEventListener('click', () => this.host.duplicate());
    const del = button(s('delete'), 'fvs-btn is-danger', 'trash');
    del.addEventListener('click', () => this.host.remove());
    row.append(split, dup);
    if (clip.type === 'video') {
      const detach = button(s('detachAudio'), 'fvs-btn', 'detach');
      detach.addEventListener('click', () => this.host.detach());
      row.append(detach);
    }
    if (clip.type !== 'audio') {
      const cap = button(s('captureFrame'), 'fvs-btn', 'camera');
      cap.addEventListener('click', () => this.host.capture());
      row.append(cap);
    }
    row.append(del);
    return row;
  }

  /* ───────────── Edit ───────────── */

  private buildEdit(sel: ReturnType<Inspector['selection']>): void {
    if (!sel) {
      this.buildProject();
      return;
    }
    const clip = sel.clip;
    if (clip.type === 'text') {
      this.body.append(this.header(clip), this.actionRow(clip));
      this.textFields(clip);
      return;
    }
    this.body.append(this.header(clip), this.actionRow(clip));
    if (clip.type !== 'image') {
      const speedFmt = (v: number) => `${v.toFixed(2)}×`;
      const chips = el('div', 'fvs-chips');
      for (const v of [0.5, 1, 1.5, 2]) {
        const chip = button(`${v}×`, 'fvs-chip');
        chip.setAttribute('aria-pressed', String(Math.abs(clip.speed - v) < 1e-3));
        chip.addEventListener('click', () => this.once(clip, (c) => ({ ...c, speed: v })));
        chips.append(chip);
      }
      this.body.append(section(s('speed'), [
        this.numberSlider(clip, s('speed'), clip.speed, 0.25, 4, 0.05, speedFmt, (c, v) => ({ ...c, speed: v })),
        chips,
        el('p', 'fvs-note', s('speedNote')),
      ]));
    }
    if (clip.type === 'audio') return;
    const media = clip as MediaClip;
    // Transform: rotate, flip, fit, crop.
    const rotate = el('div', 'fvs-action-row');
    const rl = button(s('rotateLeft'), 'fvs-btn', 'rotateLeft');
    rl.addEventListener('click', () => this.once(media, (c) => ({ ...c, transform: { ...c.transform, rotation: rotateBy(c.transform.rotation, 270) } })));
    const rr = button(s('rotateRight'), 'fvs-btn', 'rotateRight');
    rr.addEventListener('click', () => this.once(media, (c) => ({ ...c, transform: { ...c.transform, rotation: rotateBy(c.transform.rotation, 90) } })));
    const fh = button(s('flipH'), 'fvs-btn', 'flipH');
    fh.setAttribute('aria-pressed', String(media.transform.flip.horizontal));
    fh.addEventListener('click', () => this.once(media, (c) => ({ ...c, transform: { ...c.transform, flip: toggleFlip(c.transform.flip, 'horizontal') } })));
    const fv = button(s('flipV'), 'fvs-btn', 'flipV');
    fv.setAttribute('aria-pressed', String(media.transform.flip.vertical));
    fv.addEventListener('click', () => this.once(media, (c) => ({ ...c, transform: { ...c.transform, flip: toggleFlip(c.transform.flip, 'vertical') } })));
    rotate.append(rl, rr, fh, fv);
    const fit = segmented(s('fit'), [{ value: 'contain', label: s('fitContain') }, { value: 'cover', label: s('fitCover') }], media.fit,
      (v) => this.once(media, (c) => ({ ...c, fit: v }), false));
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const cropField = (key: keyof CropRect, label: string) => this.numberSlider(media, label, media.transform.crop[key], 0, 1, 0.01, pct,
      (c, v) => ({ ...c, transform: { ...c.transform, crop: clampCrop({ ...c.transform.crop, [key]: v }) } }));
    const reset = button(s('resetTransform'), 'fvs-btn');
    reset.addEventListener('click', () => this.once(media, (c) => ({ ...c, transform: resetTransform() })));
    this.body.append(section(s('transform'), [rotate, fit]));
    this.body.append(section(s('crop'), [
      cropField('x', s('cropX')), cropField('y', s('cropY')), cropField('width', s('cropW')), cropField('height', s('cropH')), reset,
    ], false));
    // Position, scale, opacity (picture-in-picture).
    this.body.append(section(s('layout'), [
      this.numberSlider(media, s('scale'), media.scale, 0.1, 2, 0.01, pct, (c, v) => ({ ...c, scale: v })),
      this.numberSlider(media, s('posX'), media.x, 0, 1, 0.005, pct, (c, v) => ({ ...c, x: v })),
      this.numberSlider(media, s('posY'), media.y, 0, 1, 0.005, pct, (c, v) => ({ ...c, y: v })),
      this.numberSlider(media, s('opacity'), media.opacity, 0, 1, 0.01, pct, (c, v) => ({ ...c, opacity: v })),
      el('p', 'fvs-note', s('layoutNote')),
    ], sel.track.kind === 'overlay'));
    if (clip.type === 'image') {
      this.body.append(section(s('duration'), [
        this.numberSlider(media, s('duration'), media.out, 0.5, 30, 0.1, (v) => `${v.toFixed(1)} s`, (c, v) => ({ ...c, out: v })),
      ]));
    }
  }

  private buildProject(): void {
    const project = this.host.project();
    const box = el('div', 'fvs-insp-project');
    box.append(this.emptyState(s('nothingSelected'), s('nothingSelectedHint'), 'film'));
    const aspects: Array<{ value: AspectKey; label: string }> = [
      { value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' }, { value: '1:1', label: '1:1' }, { value: '4:5', label: '4:5' }, { value: 'auto', label: s('aspectAuto') },
    ];
    box.append(section(s('projectSettings'), [
      segmented(s('aspect'), aspects, project.aspect, (v) => this.host.setAspect(v)),
      this.colorRow(s('background'), project.background, false, (c) => this.host.apply({ ...this.host.project(), background: c || '#000000' })),
    ]));
    this.body.append(box);
  }

  /* ───────────── Audio ───────────── */

  private buildAudio(sel: ReturnType<Inspector['selection']>): void {
    const clip = sel?.clip;
    if (clip && (clip.type === 'audio' || clip.type === 'video')) {
      const media = this.host.media(clip.mediaId);
      this.body.append(this.header(clip));
      if (media && !media.hasAudio && media.status === 'ready') this.body.append(el('p', 'fvs-note is-warn', s('noAudioTrack')));
      const secs = (v: number) => `${v.toFixed(1)} s`;
      const vol = (v: number) => `${Math.round(v * 100)}%`;
      this.body.append(section(s('volume'), [
        this.numberSlider(clip, s('volume'), clip.volume, 0, 2, 0.01, vol, (c, v) => ({ ...c, volume: v })),
        toggle(s('muteClip'), clip.muted, (v) => this.once(clip, (c) => ({ ...c, muted: v }), false)),
      ]));
      this.body.append(section(s('fades'), [
        this.numberSlider(clip, s('fadeIn'), clip.fadeIn, 0, 5, 0.1, secs, (c, v) => ({ ...c, fadeIn: v })),
        this.numberSlider(clip, s('fadeOut'), clip.fadeOut, 0, 5, 0.1, secs, (c, v) => ({ ...c, fadeOut: v })),
      ]));
      if (clip.type === 'video') {
        const detach = button(s('detachAudio'), 'fvs-btn', 'detach');
        detach.addEventListener('click', () => this.host.detach());
        this.body.append(detach);
      }
    } else {
      this.body.append(this.emptyState(s('audioEmpty'), s('audioEmptyHint'), 'music'));
    }
    const add = button(s('addMusic'), 'fvs-btn is-primary', 'music');
    add.addEventListener('click', () => this.host.addMusic());
    const tracks = el('div', 'fvs-track-list');
    const project = this.host.project();
    for (const track of project.tracks.filter((t) => t.kind !== 'text')) {
      const name = track.kind === 'main' ? s('trackMain') : track.kind === 'overlay' ? s('trackOverlay') : `${s('trackAudio')} ${project.tracks.filter((t) => t.kind === 'audio').indexOf(track) + 1}`;
      tracks.append(toggle(`${s('muteTrack')}: ${name}`, track.muted, (v) => {
        this.own = true;
        this.host.apply(updateTrack(this.host.project(), track.id, { muted: v }));
        this.own = false;
      }));
    }
    this.body.append(section(s('tracks'), [add, tracks]));
  }

  /* ───────────── Text ───────────── */

  private buildText(sel: ReturnType<Inspector['selection']>): void {
    const grid = el('div', 'fvs-preset-grid');
    for (const preset of TEXT_PRESETS) {
      const card = el('button', `fvs-preset is-${preset.key}`);
      card.type = 'button';
      const sample = el('span', 'fvs-preset-sample', s(`preset_${preset.key}_sample`));
      sample.dir = 'auto';
      card.append(sample, el('span', 'fvs-preset-name', s(`preset_${preset.key}`)));
      card.addEventListener('click', () => this.host.addText(preset));
      grid.append(card);
    }
    this.body.append(section(s('addText'), [grid]));
    const clip = sel?.clip;
    if (clip && clip.type === 'text') {
      this.body.append(this.header(clip));
      this.textFields(clip);
    } else {
      this.body.append(el('p', 'fvs-note', s('textHint')));
    }
  }

  private textFields(clip: TextClip): void {
    const area = el('textarea', 'fvs-textarea');
    area.value = clip.text;
    area.dir = 'auto';
    area.rows = 3;
    area.setAttribute('aria-label', s('textContent'));
    area.addEventListener('input', () => this.live(clip, (c) => ({ ...c, text: area.value })));
    area.addEventListener('change', () => this.commit());
    area.addEventListener('blur', () => this.commit());
    const fonts: Array<{ value: FontKey; label: string }> = (['sans', 'naskh', 'kufi', 'display', 'mono'] as FontKey[]).map((f) => ({ value: f, label: s(`font_${f}`) }));
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const anims: Array<{ value: TextAnim; label: string }> = (['none', 'fade', 'slide', 'pop'] as TextAnim[]).map((a) => ({ value: a, label: s(`anim_${a}`) }));
    const positions = el('div', 'fvs-chips');
    for (const [key, y] of [['posTop', 0.15], ['posMiddle', 0.5], ['posBottom', 0.85]] as const) {
      const chip = button(s(key), 'fvs-chip');
      chip.addEventListener('click', () => this.once(clip, (c) => ({ ...c, y, x: 0.5 })));
      positions.append(chip);
    }
    this.body.append(
      section(s('textContent'), [
        area,
        selectBox(s('font'), fonts, clip.font, (v) => this.once(clip, (c) => ({ ...c, font: v }), false)),
        this.numberSlider(clip, s('fontSize'), clip.size, 0.03, 0.25, 0.005, (v) => `${Math.round(v * 1000) / 10}%`, (c, v) => ({ ...c, size: v })),
        toggle(s('bold'), clip.bold, (v) => this.once(clip, (c) => ({ ...c, bold: v }), false)),
        segmented(s('align'), [
          { value: 'start', label: s('alignStart') }, { value: 'center', label: s('alignCenter') }, { value: 'end', label: s('alignEnd') },
        ], clip.align, (v) => this.once(clip, (c) => ({ ...c, align: v }), false)),
      ]),
      section(s('colors'), [
        this.colorRow(s('textColor'), clip.color, false, (v) => this.once(clip, (c) => ({ ...c, color: v || '#FFFFFF' }))),
        this.colorRow(s('boxColor'), clip.background, true, (v) => this.once(clip, (c) => ({ ...c, background: v }))),
      ]),
      section(s('position'), [
        positions,
        this.numberSlider(clip, s('posX'), clip.x, 0, 1, 0.005, pct, (c, v) => ({ ...c, x: v })),
        this.numberSlider(clip, s('posY'), clip.y, 0, 1, 0.005, pct, (c, v) => ({ ...c, y: v })),
        el('p', 'fvs-note', s('dragOnPreview')),
      ]),
      section(s('animation'), [
        selectBox(s('animIn'), anims, clip.animIn, (v) => this.once(clip, (c) => ({ ...c, animIn: v }), false)),
        selectBox(s('animOut'), anims, clip.animOut, (v) => this.once(clip, (c) => ({ ...c, animOut: v }), false)),
        this.numberSlider(clip, s('animDuration'), clip.animDuration, 0.1, 2, 0.05, (v) => `${v.toFixed(2)} s`, (c, v) => ({ ...c, animDuration: v })),
        this.numberSlider(clip, s('duration'), clip.duration, 0.5, 30, 0.1, (v) => `${v.toFixed(1)} s`, (c, v) => ({ ...c, duration: v })),
      ]),
    );
  }

  private colorRow(label: string, value: string, allowNone: boolean, pick: (color: string) => void): HTMLElement {
    const row = el('div', 'fvs-color-row');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', label);
    row.append(el('span', 'fvs-field-label', label));
    const swatches = el('div', 'fvs-swatches');
    if (allowNone) {
      const none = el('button', 'fvs-swatch is-none');
      none.type = 'button';
      none.title = s('noBox');
      none.setAttribute('aria-label', s('noBox'));
      none.setAttribute('aria-pressed', String(value === ''));
      none.addEventListener('click', () => pick(''));
      swatches.append(none);
    }
    for (const color of SWATCHES) {
      const sw = el('button', 'fvs-swatch');
      sw.type = 'button';
      sw.style.setProperty('--swatch', color);
      sw.title = color;
      sw.setAttribute('aria-label', color);
      sw.setAttribute('aria-pressed', String(value.toUpperCase() === color));
      sw.addEventListener('click', () => pick(color));
      swatches.append(sw);
    }
    const custom = el('input', 'fvs-color-input');
    custom.type = 'color';
    custom.value = /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#ffffff';
    custom.setAttribute('aria-label', `${label} — ${s('customColor')}`);
    custom.addEventListener('change', () => pick(custom.value.toUpperCase()));
    swatches.append(custom);
    row.append(swatches);
    return row;
  }

  /* ───────────── Effects ───────────── */

  private buildEffects(sel: ReturnType<Inspector['selection']>): void {
    const clip = sel?.clip;
    if (!clip || clip.type === 'text' || clip.type === 'audio') {
      this.body.append(this.emptyState(s('effectsEmpty'), s('effectsEmptyHint'), 'effects'));
      return;
    }
    this.body.append(this.header(clip));
    const presets = el('div', 'fvs-chips');
    for (const [key, value] of Object.entries(COLOR_PRESETS)) {
      const chip = button(s(`look_${key}`), 'fvs-chip');
      const on = Math.abs(clip.color.brightness - value.brightness) < 1e-3 && Math.abs(clip.color.contrast - value.contrast) < 1e-3 && Math.abs(clip.color.saturation - value.saturation) < 1e-3;
      chip.setAttribute('aria-pressed', String(on));
      chip.addEventListener('click', () => this.once(clip, (c) => ({ ...c, color: { ...value } })));
      presets.append(chip);
    }
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const reset = button(s('resetColor'), 'fvs-btn');
    reset.addEventListener('click', () => this.once(clip, (c) => ({ ...c, color: { ...NEUTRAL_COLOR } })));
    this.body.append(section(s('color'), [
      presets,
      this.numberSlider(clip, s('brightness'), clip.color.brightness, 0, 2, 0.01, pct, (c, v) => ({ ...c, color: { ...c.color, brightness: v } })),
      this.numberSlider(clip, s('contrast'), clip.color.contrast, 0, 2, 0.01, pct, (c, v) => ({ ...c, color: { ...c.color, contrast: v } })),
      this.numberSlider(clip, s('saturation'), clip.color.saturation, 0, 2, 0.01, pct, (c, v) => ({ ...c, color: { ...c.color, saturation: v } })),
      reset,
    ]));
    // Transitions: into this clip from the one before it (main track only).
    const body: HTMLElement[] = [];
    if (sel!.track.kind !== 'main') {
      body.push(el('p', 'fvs-note', s('transitionMainOnly')));
    } else if (sel!.index === 0) {
      body.push(el('p', 'fvs-note', s('transitionFirst')));
    } else {
      const kinds: Array<{ value: TransitionKind; label: string }> = (['none', 'crossfade', 'dip', 'slide'] as TransitionKind[]).map((k) => ({ value: k, label: s(`transition_${k}`) }));
      body.push(segmented(s('transition'), kinds, clip.transition.kind, (v) => this.once(clip, (c) => ({ ...c, transition: { ...c.transition, kind: v } }), false)));
      body.push(this.numberSlider(clip, s('transitionDuration'), clip.transition.duration, 0.1, MAX_TRANSITION, 0.05, (v) => `${v.toFixed(2)} s`,
        (c, v) => ({ ...c, transition: { ...c.transition, duration: v } })));
      const all = button(s('transitionAll'), 'fvs-btn');
      all.addEventListener('click', () => {
        const current = findClip(this.host.project(), clip.id)?.clip as MediaClip | undefined;
        if (current) this.host.applyTransitionToAll(current.transition.kind, current.transition.duration);
      });
      body.push(all);
      const placed = layoutTrack(this.host.project().tracks.find((t) => t.kind === 'main')!);
      if (placed.length > 1) body.push(el('p', 'fvs-note', s('transitionNote')));
    }
    this.body.append(section(s('transitions'), body));
  }
}
