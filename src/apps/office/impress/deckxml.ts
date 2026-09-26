/**
 * Impress — the markup this app writes for new things: a shape, a picture, a line,
 * a whole new slide, a transition and a list of entrance animations. Everything
 * here is generated from the model with `xmlText` for text, never from markup.
 */
import { xmlText } from '../xml';
import type { Anim, DeckCxn, DeckPara, DeckShape, Transition } from './deck';

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
export const SLIDE_NS = `xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}"`;

const EMPTY_TREE =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

const int = (v: number): number => Math.max(0, Math.round(v));
const hex = (c: string): string => c.replace('#', '').toUpperCase();

function lang(text: string): string {
  return /[؀-ۿ]/.test(text) ? 'ar-SA' : 'en-US';
}

/** `<a:rPr>`/`<a:endParaRPr>` for a paragraph's look. */
function runProps(tag: 'a:rPr' | 'a:endParaRPr', p: DeckPara, text: string): string {
  const attrs = [`lang="${lang(text)}"`];
  if (p.size) attrs.push(`sz="${Math.round(p.size * 100)}"`);
  if (p.bold) attrs.push('b="1"');
  if (p.italic) attrs.push('i="1"');
  if (p.underline) attrs.push('u="sng"');
  attrs.push('dirty="0"');
  const fill = p.color ? `<a:solidFill><a:srgbClr val="${hex(p.color)}"/></a:solidFill>` : '';
  const latin = p.font ? `<a:latin typeface="${xmlText(p.font)}"/>` : '';
  return fill || latin ? `<${tag} ${attrs.join(' ')}>${fill}${latin}</${tag}>` : `<${tag} ${attrs.join(' ')}/>`;
}

/** One `<a:p>` from the model; line breaks become `<a:br/>`. */
export function paraXml(p: DeckPara): string {
  const pPr: string[] = [];
  if (p.align) pPr.push(`algn="${p.align}"`);
  if (/[؀-ۿ]/.test(p.text)) pPr.push('rtl="1"');
  const rPr = runProps('a:rPr', p, p.text);
  let runs = '';
  if (p.field === 'slidenum') {
    // A live slide number: PowerPoint recomputes `<a:t>` itself, and it changes when a slide is
    // inserted before this one — which a literal run never would.
    runs = `<a:fld id="${fieldId()}" type="slidenum">${rPr}<a:t>${xmlText(p.text)}</a:t></a:fld>`;
  } else {
    // A tab stays a tab character inside <a:t>: DrawingML has no <a:tab/> run.
    for (const part of p.text.replace(/\r\n?/g, '\n').split(/(\n)/)) {
      if (part === '\n') runs += `<a:br>${rPr}</a:br>`;
      else if (part) runs += `<a:r>${rPr}<a:t>${xmlText(part)}</a:t></a:r>`;
    }
  }
  return `<a:p>${pPr.length ? `<a:pPr ${pPr.join(' ')}/>` : ''}${runs}${runProps('a:endParaRPr', p, p.text)}</a:p>`;
}

/**
 * The `id` a field run needs: PowerPoint's own shape is `{8-4-4-4-12}` uppercase GUID.
 *
 * It only has to be unique inside the part, and it is only generated when a field paragraph is
 * written for the first time — an edited paragraph keeps the file's own id.
 */
let fieldCounter = 0;
function fieldId(): string {
  const n = (++fieldCounter).toString(16).toUpperCase().padStart(20, '0');
  return `{${n.slice(0, 8)}-0000-4000-8000-${n.slice(8)}}`;
}

function xfrm(s: DeckShape): string {
  const flip = `${s.flipH ? ' flipH="1"' : ''}${s.flipV ? ' flipV="1"' : ''}`;
  const rot = s.rot ? ` rot="${Math.round(s.rot * 60000)}"` : '';
  return `<a:xfrm${rot}${flip}><a:off x="${int(s.x)}" y="${int(s.y)}"/><a:ext cx="${int(s.w)}" cy="${int(s.h)}"/></a:xfrm>`;
}

function lineXml(s: DeckShape): string {
  if (!s.stroke) return '<a:ln><a:noFill/></a:ln>';
  const tail = s.arrow ? '<a:tailEnd type="triangle"/>' : '';
  return `<a:ln w="${int(s.strokeW)}"><a:solidFill><a:srgbClr val="${hex(s.stroke)}"/></a:solidFill>${tail}</a:ln>`;
}

/**
 * `<a:stCxn>`/`<a:endCxn>` for one end of a connector.
 *
 * `ids` maps a target shape's session uid to the `cNvPr id` it is being written with — a shape
 * only gets an id at the moment the slide is written, so the map is what lets a connector drawn
 * in this session point at a shape drawn in this session. A reference the map cannot resolve
 * falls back to the id the file had, which is what keeps an untouched file byte-identical.
 */
function cxnRef(tag: 'a:stCxn' | 'a:endCxn', r: DeckCxn | null, ids?: ReadonlyMap<number, number>): string {
  if (!r) return '';
  const id = (r.uid !== null ? ids?.get(r.uid) : undefined) ?? r.id;
  return id > 0 ? `<${tag} id="${id}" idx="${Math.max(0, Math.round(r.idx))}"/>` : '';
}

/** The inside of a `<p:cNvCxnSpPr>`: both ends of a connector, or '' for a free line. */
export function cxnRefsXml(st: DeckCxn | null, end: DeckCxn | null, ids?: ReadonlyMap<number, number>): string {
  return cxnRef('a:stCxn', st, ids) + cxnRef('a:endCxn', end, ids);
}

/** The whole `<p:cNvCxnSpPr>` element, self-closing when the line holds on to nothing. */
export function cxnHolderXml(st: DeckCxn | null, end: DeckCxn | null, ids?: ReadonlyMap<number, number>): string {
  const inner = cxnRefsXml(st, end, ids);
  return `<p:cNvCxnSpPr${inner ? `>${inner}</p:cNvCxnSpPr>` : '/>'}`;
}

/**
 * `<p:grpSp>`: one group with its own box and its children in the group's own coordinates.
 *
 * `chOff`/`chExt` are the child coordinate space, which is what lets a diagram be built at the
 * origin and then placed anywhere on the slide. Children carry their own `cNvPr id`s, all unique
 * on the slide, and a connector inside the group names its neighbours by those ids — the same
 * `a:stCxn`/`a:endCxn` a top-level connector uses, which is how PowerPoint keeps a diagram wired
 * when the group is dragged.
 */
export function groupXml(s: DeckShape, id: number, name: string, ids?: ReadonlyMap<number, number>): string {
  const box = s.box ?? { x: 0, y: 0, w: s.w, h: s.h };
  const children = s.children.map((c) => shapeXml(c, ids?.get(c.uid) ?? c.spid, null, ids)).join('');
  return `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="${int(s.x)}" y="${int(s.y)}"/><a:ext cx="${int(s.w)}" cy="${int(s.h)}"/>` +
    `<a:chOff x="${int(box.x)}" y="${int(box.y)}"/><a:chExt cx="${int(box.w)}" cy="${int(box.h)}"/></a:xfrm></p:grpSpPr>` +
    `${children}</p:grpSp>`;
}

/** True when a group can be written as it is: this writer has no way to relate a picture's bytes
 *  from inside a group, so the save is refused rather than emitting a picture with no media. */
export function groupWritable(s: DeckShape): boolean {
  return s.children.every((c) => (c.kind === 'group' ? groupWritable(c) : c.kind !== 'pic' && c.kind !== 'frame'));
}

/**
 * The markup of a new shape. `id` is its `cNvPr id` on the slide; `embed` the
 * relationship id of a picture's media part; `ids` the ids of the other new shapes, so a
 * connector can name the shapes it is attached to.
 */
export function shapeXml(s: DeckShape, id: number, embed: string | null, ids?: ReadonlyMap<number, number>, linkRid: string | null = null): string {
  const name = xmlText(s.name || `${s.kind === 'pic' ? 'Picture' : s.kind === 'line' ? 'Connector' : s.kind === 'text' ? 'TextBox' : s.kind === 'group' ? 'Group' : s.kind === 'frame' ? 'Table' : 'Shape'} ${id}`);
  if (s.kind === 'group') return groupXml(s, id, name, ids);
  const nvPr = cNvPrXml(id, name, linkRid);
  if (s.kind === 'frame') return tableXml(s, nvPr);
  if (s.kind === 'pic') {
    return `<p:pic><p:nvPicPr>${nvPr}<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
      `<p:blipFill><a:blip r:embed="${embed ?? ''}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
      `<p:spPr>${xfrm(s)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
  }
  if (s.kind === 'line') {
    // `straightConnector1` and `a:stCxn`/`a:endCxn` are exactly what PowerPoint writes for a
    // connector; the attachments are what make it follow the shapes when they are moved.
    const ends = cxnRefsXml(s.stCxn, s.endCxn, ids);
    return `<p:cxnSp><p:nvCxnSpPr>${nvPr}<p:cNvCxnSpPr${ends ? `>${ends}</p:cNvCxnSpPr>` : '/>'}<p:nvPr/></p:nvCxnSpPr>` +
      `<p:spPr>${xfrm(s)}<a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom>${lineXml(s)}</p:spPr></p:cxnSp>`;
  }
  const ph = s.ph ? `<p:ph${s.ph !== 'body' ? ` type="${s.ph}"` : ''}${s.phIdx ? ` idx="${s.phIdx}"` : ''}/>` : '';
  const txBox = s.kind === 'text' && !s.ph ? ' txBox="1"' : '';
  const fill = s.fill ? `<a:solidFill><a:srgbClr val="${hex(s.fill)}"/></a:solidFill>` : s.ph ? '' : '<a:noFill/>';
  const ln = s.kind === 'shape' || s.stroke ? lineXml(s) : '';
  const geom = s.ph ? '' : `<a:prstGeom prst="${xmlText(s.geom)}"><a:avLst/></a:prstGeom>`;
  const paras = s.paras.length ? s.paras.map(paraXml).join('') : '<a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p>';
  const wrap = s.kind === 'text' && !s.ph ? '<a:spAutoFit/>' : '';
  return `<p:sp><p:nvSpPr>${nvPr}<p:cNvSpPr${txBox}/><p:nvPr>${ph}</p:nvPr></p:nvSpPr>` +
    `<p:spPr>${xfrm(s)}${geom}${fill}${ln}</p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square" rtlCol="0" anchor="${s.anchor}">${wrap}</a:bodyPr><a:lstStyle/>${paras}</p:txBody></p:sp>`;
}

/** `<p:cNvPr>`, with the click hyperlink (`<a:hlinkClick>`) when the shape has one. */
export function cNvPrXml(id: number, name: string, linkRid: string | null): string {
  return linkRid
    ? `<p:cNvPr id="${id}" name="${name}"><a:hlinkClick r:id="${xmlText(linkRid)}"/></p:cNvPr>`
    : `<p:cNvPr id="${id}" name="${name}"/>`;
}

/** The built-in "Medium Style 2 – Accent 1" table style PowerPoint knows by this id. */
export const TABLE_STYLE_ID = '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}';

/** One table cell's `<a:txBody>` (or a notes placeholder's `<p:txBody>`): a paragraph per line. */
export function cellBodyXml(text: string, tag: 'a:txBody' | 'p:txBody' = 'a:txBody'): string {
  const paras = text.split('\n').map((line) => {
    const rtl = /[؀-ۿ]/.test(line) ? '<a:pPr rtl="1"/>' : '';
    const lang = /[؀-ۿ]/.test(line) ? 'ar-SA' : 'en-US';
    return `<a:p>${rtl}${line ? `<a:r><a:rPr lang="${lang}" dirty="0"/><a:t>${xmlText(line)}</a:t></a:r>` : ''}<a:endParaRPr lang="${lang}" dirty="0"/></a:p>`;
  }).join('');
  return `<${tag}><a:bodyPr/><a:lstStyle/>${paras}</${tag}>`;
}

/** A table as a `<p:graphicFrame>`: equal columns and rows, the header row styled by PowerPoint. */
function tableXml(s: DeckShape, nvPr: string): string {
  const rows = s.table ?? [['']];
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const colW = Math.max(1, Math.floor(int(s.w) / cols));
  const rowH = Math.max(1, Math.floor(int(s.h) / Math.max(1, rows.length)));
  const grid = Array.from({ length: cols }, () => `<a:gridCol w="${colW}"/>`).join('');
  const trs = rows.map((r) => `<a:tr h="${rowH}">${Array.from({ length: cols }, (_, c) => `<a:tc>${cellBodyXml(r[c] ?? '')}<a:tcPr/></a:tc>`).join('')}</a:tr>`).join('');
  return `<p:graphicFrame><p:nvGraphicFramePr>${nvPr}<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off x="${int(s.x)}" y="${int(s.y)}"/><a:ext cx="${int(s.w)}" cy="${int(s.h)}"/></p:xfrm>` +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
    `<a:tbl><a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>${TABLE_STYLE_ID}</a:tableStyleId></a:tblPr><a:tblGrid>${grid}</a:tblGrid>${trs}</a:tbl>` +
    '</a:graphicData></a:graphic></p:graphicFrame>';
}

/** `<p:transition>` for the two kinds this app writes; '' for none. */
export function transitionXml(t: Transition): string {
  if (t === 'fade') return '<p:transition spd="med"><p:fade/></p:transition>';
  if (t === 'push') return '<p:transition spd="med"><p:push dir="u"/></p:transition>';
  if (t === 'wipe') return '<p:transition spd="med"><p:wipe dir="r"/></p:transition>';
  if (t === 'cover') return '<p:transition spd="med"><p:cover dir="l"/></p:transition>';
  return '';
}

/**
 * `<p:timing>` with one on-click entrance per shape, in order: Appear (preset 1)
 * sets visibility, Fade (preset 10) also runs a 500 ms fade filter. '' when empty.
 */
export function timingXml(list: ReadonlyArray<{ spid: number; anim: Exclude<Anim, null> }>): string {
  if (!list.length) return '';
  let id = 3;
  const clicks = list.map(({ spid, anim }) => {
    const outer = id++;
    const inner = id++;
    const effect = id++;
    const set = id++;
    const target = `<p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl>`;
    const visible = `<p:set><p:cBhvr><p:cTn id="${set}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>${target}` +
      '<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>';
    const fade = anim === 'fade' ? `<p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="${id++}" dur="500"/>${target}</p:cBhvr></p:animEffect>` : '';
    // Fly In from the bottom: the shape's y runs from below the slide to where it stands.
    const fly = anim === 'fly' ? `<p:anim calcmode="lin" valueType="num"><p:cBhvr additive="base"><p:cTn id="${id++}" dur="500" fill="hold"/>${target}` +
      '<p:attrNameLst><p:attrName>ppt_y</p:attrName></p:attrNameLst></p:cBhvr><p:tavLst>' +
      '<p:tav tm="0"><p:val><p:strVal val="1+#ppt_h/2"/></p:val></p:tav><p:tav tm="100000"><p:val><p:strVal val="#ppt_y"/></p:val></p:tav>' +
      '</p:tavLst></p:anim>' : '';
    return `<p:par><p:cTn id="${outer}" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:childTnLst>` +
      `<p:par><p:cTn id="${inner}" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>` +
      `<p:par><p:cTn id="${effect}" presetID="${anim === 'fade' ? 10 : anim === 'fly' ? 2 : 1}" presetClass="entr" presetSubtype="${anim === 'fly' ? 4 : 0}" fill="hold" nodeType="clickEffect">` +
      `<p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>${visible}${fade}${fly}</p:childTnLst></p:cTn></p:par>` +
      '</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>';
  }).join('');
  return '<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>' +
    `<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${clicks}</p:childTnLst></p:cTn>` +
    '<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>' +
    '<p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq>' +
    '</p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>';
}

/** A complete new slide part. */
export function slideXml(shapes: string, bg: string | null, transition: Transition, timing: string): string {
  const background = bg ? `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${hex(bg)}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>` : '';
  return `${DECL}<p:sld ${SLIDE_NS}><p:cSld>${background}<p:spTree>${EMPTY_TREE}${shapes}</p:spTree></p:cSld>` +
    `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${transitionXml(transition)}${timing}</p:sld>`;
}

/* ───────────────────────────────── speaker notes ───────────────────────────────── */

const NOTES_IMG = '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr>' +
  '<p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr>{XFRM}</p:spPr></p:sp>';
const NOTES_BODY = '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' +
  '<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr>{XFRM}</p:spPr>{BODY}</p:sp>';

/** A notes page for one slide: the slide's picture above, the speaker's words below. */
export function notesSlideXml(text: string): string {
  return `${DECL}<p:notes ${SLIDE_NS}><p:cSld><p:spTree>${EMPTY_TREE}` +
    NOTES_IMG.replace('{XFRM}', '') + NOTES_BODY.replace('{XFRM}', '').replace('{BODY}', cellBodyXml(text, 'p:txBody')) +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>';
}

/** The notes master a presentation needs before it may have notes pages (portrait, 7.5 × 10 in). */
export function notesMasterXml(): string {
  const img = '<a:xfrm><a:off x="1143000" y="685800"/><a:ext cx="4572000" cy="2571750"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
  const body = '<a:xfrm><a:off x="685800" y="3429000"/><a:ext cx="5486400" cy="4114800"/></a:xfrm>';
  return `${DECL}<p:notesMaster ${SLIDE_NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${EMPTY_TREE}` +
    NOTES_IMG.replace('{XFRM}', img) +
    NOTES_BODY.replace('{XFRM}', body).replace('{BODY}', '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody>') +
    '</p:spTree></p:cSld>' +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    '<p:notesStyle><a:lvl1pPr marL="0" algn="l" rtl="0"><a:defRPr sz="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill>' +
    '<a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:notesStyle></p:notesMaster>';
}
