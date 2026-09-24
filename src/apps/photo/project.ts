/**
 * Photo Editor — the native layered project format (`.fphoto`).
 *
 * One UTF-8 JSON file. Every layer keeps its name, visibility, lock, opacity, blend mode and
 * matrix; text and shape layers are stored as their editable specs (so a reopened project
 * still has live, editable Arabic/English text); raster layers are stored as a PNG in base64,
 * produced by an encoder the caller supplies (the canvas in the app, a stub in tests). Nothing
 * in the file is ever interpreted as markup or code: it is parsed with `JSON.parse` and every
 * field is validated and clamped before it becomes a layer.
 */
import type { PixelBuffer } from './types';
import {
  isBlendMode, newLayerId, type Layer, type PhotoDoc, type ShapeSpec, type TextSpec,
} from './layers';
import type { Matrix } from './transform';
import { fromBuffer, toBuffer } from './tiles';

export const PROJECT_EXT = '.fphoto';
export const PROJECT_FORMAT = 'faisal-photo';
export const PROJECT_VERSION = 1;

export interface RasterCodec {
  /** Buffer → base64 payload (PNG in the app). */
  encode(buf: PixelBuffer): Promise<string>;
  /** Base64 payload → buffer of exactly `width × height`. */
  decode(payload: string, width: number, height: number): Promise<PixelBuffer>;
}

export class ProjectError extends Error {
  constructor(public reason: 'not-json' | 'wrong-format' | 'newer-version' | 'bad-layer' | 'too-large') {
    super(`project:${reason}`);
    this.name = 'ProjectError';
  }
}

interface StoredBase {
  name: string; visible: boolean; locked: boolean; opacity: number; blend: string; matrix: number[];
}
type StoredLayer =
  | (StoredBase & { kind: 'raster'; width: number; height: number; png: string })
  | (StoredBase & { kind: 'text'; text: TextSpec })
  | (StoredBase & { kind: 'shape'; shape: ShapeSpec });

interface StoredProject {
  format: string; version: number; width: number; height: number; active: number; layers: StoredLayer[];
}

export function isProjectPath(path: string): boolean {
  return path.toLowerCase().endsWith(PROJECT_EXT);
}

export async function serializeProject(doc: PhotoDoc, codec: RasterCodec): Promise<string> {
  const layers: StoredLayer[] = [];
  for (const l of doc.layers) {
    const base: StoredBase = {
      name: l.name, visible: l.visible, locked: l.locked, opacity: l.opacity, blend: l.blend, matrix: [...l.matrix],
    };
    if (l.kind === 'raster') {
      layers.push({ ...base, kind: 'raster', width: l.tiled.width, height: l.tiled.height, png: await codec.encode(toBuffer(l.tiled)) });
    } else if (l.kind === 'text') {
      layers.push({ ...base, kind: 'text', text: { ...l.text } });
    } else {
      layers.push({ ...base, kind: 'shape', shape: { ...l.shape, from: { ...l.shape.from }, to: { ...l.shape.to } } });
    }
  }
  const project: StoredProject = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    width: doc.width,
    height: doc.height,
    active: Math.max(0, doc.layers.findIndex((l) => l.id === doc.activeId)),
    layers,
  };
  return JSON.stringify(project);
}

const num = (v: unknown, fallback: number, min = -Infinity, max = Infinity): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
const str = (v: unknown, fallback: string, maxLen = 10000): string =>
  typeof v === 'string' ? v.slice(0, maxLen) : fallback;
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const colour = (v: unknown, fallback: string | null): string | null =>
  typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : v === null ? null : fallback;
const point = (v: unknown) => {
  const o = (v ?? {}) as Record<string, unknown>;
  return { x: num(o.x, 0, -1e6, 1e6), y: num(o.y, 0, -1e6, 1e6) };
};

function matrixOf(v: unknown): Matrix {
  if (!Array.isArray(v) || v.length !== 6 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return [1, 0, 0, 1, 0, 0];
  }
  return [v[0], v[1], v[2], v[3], v[4], v[5]];
}

function textOf(v: unknown): TextSpec {
  const o = (v ?? {}) as Record<string, unknown>;
  const align = o.align === 'center' || o.align === 'end' ? o.align : 'start';
  const direction = o.direction === 'rtl' || o.direction === 'ltr' ? o.direction : 'auto';
  return {
    text: str(o.text, ''),
    font: str(o.font, 'system', 40),
    size: num(o.size, 48, 4, 2000),
    color: colour(o.color, '#ffffff') ?? '#ffffff',
    bold: bool(o.bold, false),
    italic: bool(o.italic, false),
    align,
    direction,
    outline: colour(o.outline, null),
    outlineWidth: num(o.outlineWidth, 0, 0, 200),
  };
}

function shapeOf(v: unknown): ShapeSpec {
  const o = (v ?? {}) as Record<string, unknown>;
  const kinds = ['rect', 'ellipse', 'line', 'arrow'] as const;
  const shape = kinds.includes(o.shape as (typeof kinds)[number]) ? (o.shape as ShapeSpec['shape']) : 'rect';
  return {
    shape,
    from: point(o.from),
    to: point(o.to),
    fill: colour(o.fill, null),
    stroke: colour(o.stroke, null),
    strokeWidth: num(o.strokeWidth, 4, 0, 1000),
    radius: num(o.radius, 0, 0, 10000),
  };
}

/** The pixel budget a project may claim (same order as the editor's open limit). */
export const PROJECT_MAX_PIXELS = 24_000_000;

export async function parseProject(json: string, codec: RasterCodec): Promise<PhotoDoc> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new ProjectError('not-json');
  }
  const p = raw as Partial<StoredProject>;
  if (!p || typeof p !== 'object' || p.format !== PROJECT_FORMAT || !Array.isArray(p.layers)) {
    throw new ProjectError('wrong-format');
  }
  if (num(p.version, 0) > PROJECT_VERSION) throw new ProjectError('newer-version');
  const width = Math.round(num(p.width, 0, 0, 16384));
  const height = Math.round(num(p.height, 0, 0, 16384));
  if (width < 1 || height < 1 || p.layers.length === 0) throw new ProjectError('wrong-format');
  if (width * height > PROJECT_MAX_PIXELS) throw new ProjectError('too-large');

  const layers: Layer[] = [];
  let pixels = 0;
  for (const item of p.layers as unknown[]) {
    const s = (item ?? {}) as Record<string, unknown>;
    const blend = str(s.blend, 'normal', 40);
    const base = {
      id: newLayerId(),
      name: str(s.name, 'Layer', 200),
      visible: bool(s.visible, true),
      locked: bool(s.locked, false),
      opacity: num(s.opacity, 1, 0, 1),
      blend: isBlendMode(blend) ? blend : 'normal',
      matrix: matrixOf(s.matrix),
    } as const;
    if (s.kind === 'raster') {
      const w = Math.round(num(s.width, 0, 0, 16384));
      const h = Math.round(num(s.height, 0, 0, 16384));
      if (w < 1 || h < 1 || typeof s.png !== 'string') throw new ProjectError('bad-layer');
      pixels += w * h;
      if (pixels > PROJECT_MAX_PIXELS * 4) throw new ProjectError('too-large');
      const buf = await codec.decode(s.png, w, h);
      if (buf.width !== w || buf.height !== h) throw new ProjectError('bad-layer');
      layers.push({ ...base, kind: 'raster', tiled: fromBuffer(buf) });
    } else if (s.kind === 'text') {
      layers.push({ ...base, kind: 'text', text: textOf(s.text) });
    } else if (s.kind === 'shape') {
      layers.push({ ...base, kind: 'shape', shape: shapeOf(s.shape) });
    } else {
      throw new ProjectError('bad-layer');
    }
  }
  const active = Math.round(num(p.active, layers.length - 1, 0, layers.length - 1));
  return { width, height, layers, activeId: layers[active].id };
}
