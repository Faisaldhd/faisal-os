/**
 * Impress — the markup this app writes for new things: a shape, a picture, a line,
 * a whole new slide, a transition and a list of entrance animations. Everything
 * here is generated from the model with `xmlText` for text, never from markup.
 */
import { xmlText } from '../xml';
import type { Anim, DeckPara, DeckShape, Transition } from './deck';

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
  return fill ? `<${tag} ${attrs.join(' ')}>${fill}</${tag}>` : `<${tag} ${attrs.join(' ')}/>`;
}

/** One `<a:p>` from the model; line breaks become `<a:br/>`. */
export function paraXml(p: DeckPara): string {
  const pPr: string[] = [];
  if (p.align) pPr.push(`algn="${p.align}"`);
  if (/[؀-ۿ]/.test(p.text)) pPr.push('rtl="1"');
  const rPr = runProps('a:rPr', p, p.text);
  let runs = '';
  // A tab stays a tab character inside <a:t>: DrawingML has no <a:tab/> run.
  for (const part of p.text.replace(/\r\n?/g, '\n').split(/(\n)/)) {
    if (part === '\n') runs += `<a:br>${rPr}</a:br>`;
    else if (part) runs += `<a:r>${rPr}<a:t>${xmlText(part)}</a:t></a:r>`;
  }
  return `<a:p>${pPr.length ? `<a:pPr ${pPr.join(' ')}/>` : ''}${runs}${runProps('a:endParaRPr', p, p.text)}</a:p>`;
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
 * The markup of a new shape. `id` is its `cNvPr id` on the slide; `embed` the
 * relationship id of a picture's media part.
 */
export function shapeXml(s: DeckShape, id: number, embed: string | null): string {
  const name = xmlText(s.name || `${s.kind === 'pic' ? 'Picture' : s.kind === 'line' ? 'Connector' : s.kind === 'text' ? 'TextBox' : 'Shape'} ${id}`);
  if (s.kind === 'pic') {
    return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${name}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
      `<p:blipFill><a:blip r:embed="${embed ?? ''}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
      `<p:spPr>${xfrm(s)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
  }
  if (s.kind === 'line') {
    return `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>` +
      `<p:spPr>${xfrm(s)}<a:prstGeom prst="line"><a:avLst/></a:prstGeom>${lineXml(s)}</p:spPr></p:cxnSp>`;
  }
  const ph = s.ph ? `<p:ph${s.ph !== 'body' ? ` type="${s.ph}"` : ''}${s.phIdx ? ` idx="${s.phIdx}"` : ''}/>` : '';
  const txBox = s.kind === 'text' && !s.ph ? ' txBox="1"' : '';
  const fill = s.fill ? `<a:solidFill><a:srgbClr val="${hex(s.fill)}"/></a:solidFill>` : s.ph ? '' : '<a:noFill/>';
  const ln = s.kind === 'shape' || s.stroke ? lineXml(s) : '';
  const geom = s.ph ? '' : `<a:prstGeom prst="${xmlText(s.geom)}"><a:avLst/></a:prstGeom>`;
  const paras = s.paras.length ? s.paras.map(paraXml).join('') : '<a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p>';
  const wrap = s.kind === 'text' && !s.ph ? '<a:spAutoFit/>' : '';
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr${txBox}/><p:nvPr>${ph}</p:nvPr></p:nvSpPr>` +
    `<p:spPr>${xfrm(s)}${geom}${fill}${ln}</p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square" rtlCol="0" anchor="${s.anchor}">${wrap}</a:bodyPr><a:lstStyle/>${paras}</p:txBody></p:sp>`;
}

/** `<p:transition>` for the two kinds this app writes; '' for none. */
export function transitionXml(t: Transition): string {
  if (t === 'fade') return '<p:transition spd="med"><p:fade/></p:transition>';
  if (t === 'push') return '<p:transition spd="med"><p:push dir="u"/></p:transition>';
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
    return `<p:par><p:cTn id="${outer}" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:childTnLst>` +
      `<p:par><p:cTn id="${inner}" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>` +
      `<p:par><p:cTn id="${effect}" presetID="${anim === 'fade' ? 10 : 1}" presetClass="entr" presetSubtype="0" fill="hold" nodeType="clickEffect">` +
      `<p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>${visible}${fade}</p:childTnLst></p:cTn></p:par>` +
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
