/**
 * Office — the live numbers under the document (الأرقام الحية في الشريط السفلي).
 *
 * Pure: strings in, counts out. No DOM and no model mutation, so the window only
 * has to call one function after every change and the tests can prove the rules
 * on their own — including Arabic, punctuation and an empty document.
 *
 * What the three numbers mean, said exactly:
 *  • words — a run of non-whitespace text that holds at least one letter or digit
 *    (Unicode), so "مرحبا، بالعالم!" is two words and a lone "—" is none;
 *  • characters — Unicode code points, so an emoji is one character, not two
 *    UTF-16 units;
 *  • edits — the steps the existing undo model (`History`) has recorded, not the
 *    number of keystrokes: a burst of typing in one place is one step.
 */
import type { History, OfficeModel } from './model';

/** The two text counts; the edit count comes from the undo model. */
export interface TextStats { words: number; chars: number }

/** A token counts as a word only when it carries a letter or a digit. */
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;
const WHITESPACE = /\s+/;

/** Words: whitespace-separated runs that hold at least one letter or digit. */
export function countWords(text: string): number {
  let words = 0;
  for (const token of text.split(WHITESPACE)) {
    if (token && HAS_WORD_CHAR.test(token)) words++;
  }
  return words;
}

/**
 * Characters as Unicode code points: one emoji, one Arabic letter or one Latin
 * letter each count 1. Counting UTF-16 units would report an emoji as two.
 */
export function countChars(text: string): number {
  let chars = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
    if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) i++; // one pair, one character
    chars++;
  }
  return chars;
}

/** The counts of a list of strings, without building one big joined string. */
export function countValues(values: readonly string[]): TextStats {
  let words = 0;
  let chars = 0;
  for (const value of values) {
    words += countWords(value);
    chars += countChars(value);
  }
  return { words, chars };
}

/**
 * The pieces of a document the counts are taken from, per kind:
 *  • Word — its paragraphs;
 *  • PowerPoint — the paragraphs of every slide;
 *  • text — the whole buffer;
 *  • a sheet — the cells of the **active** sheet only, the one on screen. The other
 *    sheets of a workbook are not counted, and the window says so in the bar's title.
 */
export function documentValues(model: OfficeModel): string[] {
  switch (model.kind) {
    case 'docx': return [...model.paragraphs];
    case 'pptx': return model.slides.flatMap((slide) => [...slide]);
    case 'text': return [model.text];
    default: {
      const grid = model.grids[model.active] ?? model.grids[0];
      if (!grid) return [];
      return grid.rows.flatMap((row) => [...row]);
    }
  }
}

/** The words and characters of whatever the window is showing. */
export function statsForModel(model: OfficeModel): TextStats {
  return countValues(documentValues(model));
}

/** The recorded edit steps of the undo model — the "edits" number of the bar. */
export function editCount(history: History): number {
  return history.steps;
}
