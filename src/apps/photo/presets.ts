/**
 * Photo Editor — custom filter presets (قوالب فلاتر مخصّصة).
 *
 * A preset is a NAME plus the editor's own adjustment parameters (`AdjustParams`), so applying one
 * is the ordinary adjustment session and a thumbnail is `adjust()` on a downscaled copy: the pixel
 * engine stays the single source of truth and this file adds no pixel work at all.
 *
 * Everything that reads a file — storage or an imported JSON — goes through `parsePresets`, which is
 * pure and STRICT:
 *   • unknown keys are dropped (never copied through, never cast),
 *   • numbers are clamped to the engine's own slider range (`adjustRange`) and non-finite or
 *     wrong-typed values fall back to neutral,
 *   • flags are only accepted as real booleans,
 *   • names are trimmed, stripped of control characters and capped,
 *   • ids are always regenerated, so an import can never collide with or replace an existing preset,
 *   • a corrupt file returns an error and leaves the existing list untouched.
 *
 * Storage is local only (`localStorage`, like `recent.ts`): the owner's decision — no cloud sync.
 */
import { ADJUST_GROUPS, NEUTRAL_ADJUST, adjustRange, isNeutralAdjust, type AdjustKey, type AdjustParams } from './ops';

export interface CustomPreset {
  id: string;
  name: string;
  params: AdjustParams;
}

/** The eleven sliders and the two flags, exactly the keys `AdjustParams` declares. */
const SLIDER_KEYS: readonly AdjustKey[] = ADJUST_GROUPS.flatMap((g) => g.keys);
const FLAG_KEYS = ['invert', 'grayscale'] as const;

export const PRESETS_KEY = 'faisal.photo.presets.v1';
/** The exported envelope's own marker, so a stray JSON file is refused early. */
export const PRESETS_KIND = 'photo-filter-presets';
export const PRESETS_VERSION = 1;
/** Caps: the list, one name, and the imported text (a huge file is refused, not parsed). */
export const PRESETS_MAX = 60;
export const PRESET_NAME_MAX = 40;
export const PRESETS_TEXT_MAX = 256 * 1024;

let idSeed = 0;
/** Local, collision-free id: never taken from a file. */
function nextId(): string {
  idSeed += 1;
  return `p${Date.now().toString(36)}${idSeed.toString(36)}`;
}

/** One slider value: a real number clamped to its range, anything else neutral. */
function sanitizeSlider(key: AdjustKey, raw: unknown): number {
  const [min, max] = adjustRange(key);
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return NEUTRAL_ADJUST[key] as number;
  return Math.min(max, Math.max(min, Math.round(raw)));
}

function sanitizeFlag(raw: unknown): boolean {
  return raw === true;
}

/** Strips control characters, collapses whitespace and caps the length. */
export function sanitizeName(raw: unknown, index: number): string {
  const text = typeof raw === 'string' ? raw : '';
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.slice(0, PRESET_NAME_MAX) || `Preset ${index + 1}`;
}

/**
 * The parameters of an UNTRUSTED object: only the known keys survive, each one validated on its
 * own. Returns `null` when there is nothing usable at all (not an object), so the caller can drop
 * the entry instead of storing a neutral preset with a random name.
 */
export function sanitizeParams(raw: unknown): AdjustParams | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const out: AdjustParams = { ...NEUTRAL_ADJUST };
  for (const key of SLIDER_KEYS) out[key] = sanitizeSlider(key, src[key]);
  for (const flag of FLAG_KEYS) out[flag] = sanitizeFlag(src[flag]);
  return out;
}

/** One entry of an imported file. Unknown keys are dropped; the id is always local and fresh. */
export function sanitizePreset(raw: unknown, index: number): CustomPreset | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  // Accept the exported shape (`params`) and the flat shape where the sliders sit at the top level.
  const params = sanitizeParams(src.params ?? src);
  if (!params) return null;
  return { id: nextId(), name: sanitizeName(src.name, index), params };
}

export interface ParseResult {
  presets: CustomPreset[];
  /** Entries that were present but unusable (kept for the report the UI shows). */
  dropped: number;
}

export type ParsePresetsResult = ({ ok: true } & ParseResult) | { ok: false; error: 'text' | 'json' | 'shape' };

/** True when a preset would change nothing — the UI refuses to save one. */
export function isNeutralPreset(preset: CustomPreset): boolean {
  return isNeutralAdjust(preset.params);
}

/**
 * Reads an imported file. PURE and total: it never throws and never touches the stored list, so a
 * corrupt or hostile file can only ever produce `{ ok: false }`.
 */
export function parsePresets(text: string): ParsePresetsResult {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'text' };
  if (text.length > PRESETS_TEXT_MAX) return { ok: false, error: 'shape' };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: 'json' };
  }
  // The exported envelope, or a bare list of presets (both are accepted; the contents are not).
  const list: unknown = Array.isArray(value)
    ? value
    : value && typeof value === 'object' ? (value as { presets?: unknown }).presets : undefined;
  if (!Array.isArray(list)) return { ok: false, error: 'shape' };
  const out: CustomPreset[] = [];
  let dropped = 0;
  for (const [index, entry] of list.entries()) {
    if (out.length >= PRESETS_MAX) { dropped += 1; continue; }
    const preset = sanitizePreset(entry, index);
    if (preset) out.push(preset); else dropped += 1;
  }
  return { ok: true, presets: out, dropped };
}

/** The export envelope: named and versioned so the file explains itself. */
export function exportPresets(list: readonly CustomPreset[]): string {
  return JSON.stringify({
    app: 'faisal-os',
    kind: PRESETS_KIND,
    version: PRESETS_VERSION,
    presets: list.map((p) => ({ name: p.name, params: p.params })),
  }, null, 2);
}

/**
 * Appends imported presets to the existing list: existing entries are never touched, the cap is
 * respected, and the result is a NEW array.
 */
export function mergePresets(existing: readonly CustomPreset[], incoming: readonly CustomPreset[]): CustomPreset[] {
  const room = Math.max(0, PRESETS_MAX - existing.length);
  return [...existing, ...incoming.slice(0, room)];
}

/** Moves one entry by `delta` (−1 up, +1 down), clamped at the ends. */
export function movePreset(list: readonly CustomPreset[], id: string, delta: number): CustomPreset[] {
  const from = list.findIndex((p) => p.id === id);
  if (from < 0) return [...list];
  const to = Math.min(list.length - 1, Math.max(0, from + delta));
  if (to === from) return [...list];
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}

export function renamePreset(list: readonly CustomPreset[], id: string, name: string, index = 0): CustomPreset[] {
  const clean = sanitizeName(name, index);
  return list.map((p) => (p.id === id ? { ...p, name: clean } : p));
}

export function removePreset(list: readonly CustomPreset[], id: string): CustomPreset[] {
  return list.filter((p) => p.id !== id);
}

export function makePreset(name: string, params: AdjustParams): CustomPreset {
  return { id: nextId(), name: sanitizeName(name, 0), params };
}

export function loadPresets(): CustomPreset[] {
  try {
    const raw = window.localStorage.getItem(PRESETS_KEY);
    if (!raw) return [];
    const parsed = parsePresets(raw);
    return parsed.ok ? parsed.presets : [];
  } catch {
    return [];
  }
}

export function savePresets(list: readonly CustomPreset[]): void {
  try {
    window.localStorage.setItem(PRESETS_KEY, JSON.stringify(list.map((p) => ({ id: p.id, name: p.name, params: p.params }))));
  } catch {
    // Storage blocked (private window): presets are a convenience, nothing else depends on them.
  }
}
