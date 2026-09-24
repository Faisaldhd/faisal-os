/**
 * PDF app — the string keys of annotation kinds and tools, written out literally so the strings
 * test can see every key the window uses (no key is ever built from a variable).
 */
import type { AnnotKind } from './writer';

export const KIND_KEYS: Record<AnnotKind, string> = {
  highlight: 'pdf.kindHighlight',
  underline: 'pdf.kindUnderline',
  strikeout: 'pdf.kindStrikeout',
  ink: 'pdf.kindInk',
  square: 'pdf.kindSquare',
  circle: 'pdf.kindCircle',
  line: 'pdf.kindLine',
  arrow: 'pdf.kindArrow',
  note: 'pdf.kindNote',
  freetext: 'pdf.kindFreetext',
  stamp: 'pdf.kindStamp',
};

export const TOOL_KEYS: Record<string, string> = {
  select: 'pdf.toolSelect',
  hand: 'pdf.toolHand',
  highlight: 'pdf.toolHighlight',
  underline: 'pdf.toolUnderline',
  strikeout: 'pdf.toolStrikeout',
  pen: 'pdf.toolPen',
  rect: 'pdf.toolRect',
  ellipse: 'pdf.toolEllipse',
  line: 'pdf.toolLine',
  arrow: 'pdf.toolArrow',
  note: 'pdf.toolNote',
  textbox: 'pdf.toolTextbox',
  stamp: 'pdf.toolStamp',
  text: 'pdf.toolText',
  cover: 'pdf.toolCover',
  image: 'pdf.toolImage',
  signature: 'pdf.signDraw',
};
