/**
 * Writer — find and replace that reads Arabic the way people type it
 * (البحث والاستبدال): case-insensitive, and blind to tashkeel (harakat),
 * tatweel and the alef/hamza and yaa/alef-maqsura spellings, while every match
 * is reported at its real offsets in the original text so the document itself
 * (diacritics included) is never altered by searching.
 */

const MARKS = /[ً-ٰٟۖ-ۭـ]/;

function fold(ch: string): string {
  if (MARKS.test(ch)) return '';
  switch (ch) {
    case 'أ': case 'إ': case 'آ': case 'ٱ': return 'ا';
    case 'ى': return 'ي';
    case 'ة': return 'ه';
    case 'ؤ': return 'و';
    case 'ئ': return 'ي';
    default: return ch.toLocaleLowerCase();
  }
}

/** The folded text and, for each folded character, the offset it came from. */
export function foldText(text: string): { folded: string; map: number[] } {
  let folded = '';
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const out = fold(text[i]);
    for (const ch of out) { folded += ch; map.push(i); }
  }
  map.push(text.length);
  return { folded, map };
}

export interface Match { block: number; start: number; end: number }

/** Every match of `query` in the paragraphs, in reading order. */
export function findAll(texts: readonly string[], query: string): Match[] {
  const q = foldText(query).folded;
  if (!q) return [];
  const out: Match[] = [];
  texts.forEach((text, block) => {
    const { folded, map } = foldText(text);
    let from = 0;
    for (;;) {
      const at = folded.indexOf(q, from);
      if (at < 0) break;
      const start = map[at];
      const lastFolded = at + q.length - 1;
      let end = map[lastFolded] + 1;
      // Keep the diacritics that follow the last matched letter inside the match.
      while (end < text.length && MARKS.test(text[end])) end++;
      out.push({ block, start, end });
      from = at + q.length;
    }
  });
  return out;
}
