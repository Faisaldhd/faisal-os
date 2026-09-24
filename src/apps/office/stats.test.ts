/**
 * The numbers in the bottom bar: what a word is (Arabic, Latin, punctuation), what a
 * character is (code points, so an emoji is one), and the edit count that comes out
 * of the existing undo model.
 */
import { describe, expect, it } from 'vitest';
import { HISTORY_LIMIT, History, cellEdit, paragraphEdit, textEdit } from './model';
import { countChars, countValues, countWords, documentValues, editCount, statsForModel } from './stats';

describe('counting words', () => {
  it('counts Arabic words and ignores Arabic and Latin punctuation', () => {
    expect(countWords('مرحباً بالعالم')).toBe(2);
    expect(countWords('مرحبا، بالعالم!')).toBe(2);
    expect(countWords('«مرحبا» … بالعالم؟')).toBe(2);
  });

  it('counts Latin words, hyphens and apostrophes inside them', () => {
    expect(countWords('Hello, world!')).toBe(2);
    expect(countWords("don't stop — well-known")).toBe(3);
  });

  it('counts numbers as words and pure punctuation as none', () => {
    expect(countWords('12 34')).toBe(2);
    expect(countWords('— … !!! ***')).toBe(0);
  });

  it('is zero for an empty or whitespace-only document', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   \n\t  ')).toBe(0);
  });
});

describe('counting characters', () => {
  it('counts Arabic letters, spaces and punctuation as written', () => {
    expect(countChars('مرحبا')).toBe(5);
    expect(countChars('a b')).toBe(3);
    expect(countChars('')).toBe(0);
  });

  it('counts an emoji as one character, not two UTF-16 units', () => {
    expect('a😀b'.length).toBe(4);
    expect(countChars('a😀b')).toBe(3);
    expect(countChars('\uD800')).toBe(1); // a lone surrogate is still one code point
  });

  it('counts a list of strings by summing their counts', () => {
    expect(countValues(['مرحبا بك', ''])).toEqual({ words: 2, chars: 8 });
  });
});

describe('the counts of a document', () => {
  it('reads every paragraph of a Word document', () => {
    const model = { kind: 'docx' as const, paragraphs: ['مرحبا بك', 'second line'] };
    expect(documentValues(model)).toEqual(['مرحبا بك', 'second line']);
    expect(statsForModel(model)).toEqual({ words: 4, chars: 19 });
  });

  it('reads a text buffer, and the slide paragraphs of a deck', () => {
    expect(statsForModel({ kind: 'text', text: 'one two' })).toEqual({ words: 2, chars: 7 });
    const deck = { kind: 'pptx' as const, slides: [['a b'], ['c']] };
    expect(documentValues(deck)).toEqual(['a b', 'c']);
    expect(statsForModel(deck)).toEqual({ words: 3, chars: 4 });
  });

  it('reads the active sheet of a workbook only', () => {
    const model = {
      kind: 'xlsx' as const,
      active: 1,
      delimiter: ',' as const,
      grids: [
        { name: 'First', rows: [['ignored', 'cell']], truncated: false },
        { name: 'Second', rows: [['مرحبا', '2']], truncated: false },
      ],
    };
    expect(documentValues(model)).toEqual(['مرحبا', '2']);
    expect(statsForModel(model)).toEqual({ words: 2, chars: 6 });
  });

  it('is zero for an empty document of every shape', () => {
    expect(statsForModel({ kind: 'docx', paragraphs: [''] })).toEqual({ words: 0, chars: 0 });
    expect(statsForModel({ kind: 'text', text: '' })).toEqual({ words: 0, chars: 0 });
    expect(statsForModel({ kind: 'pptx', slides: [] })).toEqual({ words: 0, chars: 0 });
    expect(statsForModel({ kind: 'csv', active: 0, delimiter: ',', grids: [{ name: 'x', rows: [], truncated: false }] }))
      .toEqual({ words: 0, chars: 0 });
  });
});

describe('counting edits, from the undo model', () => {
  it('starts at zero and grows one step per recorded edit', () => {
    const history = new History();
    expect(editCount(history)).toBe(0);
    history.push(paragraphEdit(0, '', 'a'));
    expect(editCount(history)).toBe(1);
    history.push(paragraphEdit(1, '', 'b'));
    expect(editCount(history)).toBe(2);
  });

  it('counts a burst of typing in one place as the one step it really is', () => {
    let clock = 0;
    const history = new History(HISTORY_LIMIT, () => clock);
    for (const value of ['a', 'ab', 'abc']) {
      clock += 100;
      history.push(textEdit(value.slice(0, -1), value));
    }
    expect(editCount(history)).toBe(1);
    clock += 1000; // a later burst is its own step
    history.push(textEdit('abc', 'abcd'));
    expect(editCount(history)).toBe(2);
  });

  it('does not change when the owner undoes or redoes', () => {
    const history = new History();
    const edit = cellEdit(0, 0, 0, 'a', 'b');
    history.push(edit);
    expect(editCount(history)).toBe(1);
    history.undo({ kind: 'csv', active: 0, delimiter: ',', grids: [{ name: 'x', rows: [['b']], truncated: false }] });
    expect(editCount(history)).toBe(1);
  });

  it('stops at the history limit instead of growing without end', () => {
    const history = new History();
    for (let i = 0; i < HISTORY_LIMIT + 8; i++) history.push(paragraphEdit(i, '', String(i)));
    expect(editCount(history)).toBe(HISTORY_LIMIT);
  });

  it('drops the recorded steps when the file is reloaded', () => {
    const history = new History();
    history.push(paragraphEdit(0, '', 'a'));
    history.reset();
    expect(editCount(history)).toBe(0);
  });
});
