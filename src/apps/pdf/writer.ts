/**
 * PDF app — the ONE seam between the window and the document-writing engine (`./engine/`).
 *
 * The engine (annotations with appearance streams, Arabic shaping with an embedded font, drawn
 * signatures, stamps, AcroForm fill/flatten) is built separately. The window only ever calls the
 * functions below, whose shapes are the agreed contract. Until the engine is merged these are
 * honest stubs: every write answers `unknown` with a plain detail, so the window reports "not
 * available yet" instead of pretending, and nothing is written.
 *
 * Coordinates are PDF user space (unrotated page, origin bottom-left); colours are `#rrggbb`.
 * Every write returns the existing `OpResult` and must re-read and verify its own output.
 */
import type { OpResult } from './pdfdoc';
import type { Rect } from './ops';

export type AnnotKind =
  | 'highlight' | 'underline' | 'strikeout' | 'ink' | 'square' | 'circle' | 'line' | 'arrow'
  | 'note' | 'freetext' | 'stamp';

export interface NewAnnotation {
  /** 0-based page index. */
  page: number;
  kind: AnnotKind;
  color: string;
  /** 0..1 */
  opacity: number;
  /** Stroke width in points (ink, shapes, lines). */
  width?: number;
  fill?: string | null;
  /** Text markup: 8 numbers per quad, TL, TR, BL, BR. */
  quads?: number[];
  rect?: Rect;
  paths?: { x: number; y: number }[][];
  line?: [number, number, number, number];
  contents?: string;
  fontSize?: number;
}

export interface AnnotationInfo {
  page: number;
  /** Index inside the page's /Annots array. */
  index: number;
  id: string;
  kind: AnnotKind | null;
  subtype: string;
  rect: Rect;
  contents: string;
  color: string;
  opacity: number;
}

export interface AnnotationPatch {
  color?: string;
  opacity?: number;
  contents?: string;
  dx?: number;
  dy?: number;
}

export interface UnicodeTextInput {
  page: number;
  /** May be several lines, Arabic, Latin or mixed. */
  text: string;
  /** Baseline of the first line. */
  x: number;
  y: number;
  size: number;
  color: string;
}

export interface DrawnSignatureInput {
  page: number;
  rect: Rect;
  /** Strokes in pad pixels (origin top-left of the pad). */
  strokes: { x: number; y: number }[][];
  padWidth: number;
  padHeight: number;
  color: string;
  width: number;
}

export type FieldKind = 'text' | 'checkbox' | 'radio' | 'dropdown' | 'list';

export interface FieldInfo {
  name: string;
  kind: FieldKind;
  page: number;
  rect: Rect;
  value: string | boolean;
  options?: string[];
  readOnly: boolean;
  multiline: boolean;
}

export interface FieldFill { name: string; value: string | boolean }

export interface StampInput { page: number; rect: Rect; text: string; color: string }

const NOT_YET = 'the document engine is not merged into this build yet';
const pending = async (): Promise<OpResult> => ({ ok: false, code: 'unknown', detail: NOT_YET });

/** True once the real engine is wired in; the window uses it to say "coming" instead of failing. */
export const ENGINE_READY = false;

export async function addAnnotation(_bytes: Uint8Array, _a: NewAnnotation, _opts?: { arabicFont?: Uint8Array }): Promise<OpResult> {
  return pending();
}

export async function listAnnotations(_bytes: Uint8Array): Promise<AnnotationInfo[]> {
  return [];
}

export async function updateAnnotation(_bytes: Uint8Array, _page: number, _index: number, _patch: AnnotationPatch): Promise<OpResult> {
  return pending();
}

export async function removeAnnotation(_bytes: Uint8Array, _page: number, _index: number): Promise<OpResult> {
  return pending();
}

export async function loadArabicFont(): Promise<Uint8Array> {
  throw new Error(NOT_YET);
}

/** Anything outside what the standard (WinAnsi) fonts can encode needs the embedded font. */
export function needsUnicodeFont(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\n' || ch === '\t') continue;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) continue;
    if ('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'.includes(ch)) continue;
    return true;
  }
  return false;
}

export async function addUnicodeText(_bytes: Uint8Array, _input: UnicodeTextInput, _font: Uint8Array): Promise<OpResult> {
  return pending();
}

export async function drawnSignature(_bytes: Uint8Array, _input: DrawnSignatureInput): Promise<OpResult> {
  return pending();
}

export async function listFields(_bytes: Uint8Array): Promise<FieldInfo[]> {
  return [];
}

export async function fillFields(_bytes: Uint8Array, _fills: readonly FieldFill[]): Promise<OpResult> {
  return pending();
}

export async function flattenForm(_bytes: Uint8Array): Promise<OpResult> {
  return pending();
}

export async function addStamp(_bytes: Uint8Array, _input: StampInput): Promise<OpResult> {
  return pending();
}
