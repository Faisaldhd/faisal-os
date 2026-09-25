/**
 * PDF app — the ONE seam between the window and the document-writing engine (`./engine/`).
 *
 * The engine writes real PDF annotations with appearance streams, Arabic text (shaped, bidi
 * ordered, with an embedded Arabic font that lives in its own lazy chunk), drawn and typed
 * signatures, stamps, watermarks, page numbers and AcroForm fill/flatten. The window only calls
 * what is re-exported here, under the names the window was written against, so the engine can
 * change inside without the window noticing.
 *
 * Coordinates are PDF user space (unrotated page, origin bottom-left); colours are `#rrggbb`.
 * Every write returns the existing `OpResult` and re-reads and verifies its own output.
 */
export {
  addAnnotation, listAnnotations, removeAnnotation, updateAnnotation,
  type AnnotationInfo, type AnnotationInput as NewAnnotation, type AnnotationKind as AnnotKind,
  type AnnotationPatch,
} from './engine/annotations';
export { addUnicodeText, loadArabicFont, needsUnicodeFont, type UnicodeTextInput } from './engine/arabic';
export {
  drawnSignature, typedSignature, type DrawnSignatureInput, type TypedSignatureInput,
} from './engine/signature';
export {
  fillFields, flattenForm, listFields, type FieldFill, type FieldInfo, type FieldKind,
} from './engine/forms';
export {
  addPageNumbers, addStamp, addTextWatermark, type PageNumbersInput, type StampInput, type WatermarkInput,
} from './engine/stamp';
export {
  applyRedactions, glyphsInAreas, type DecodedImage, type RedactionArea, type RedactReport, type RedactResult,
} from './engine/redact';

/** True now that the real engine is wired in (the window used to say "coming" without it). */
export const ENGINE_READY = true;
