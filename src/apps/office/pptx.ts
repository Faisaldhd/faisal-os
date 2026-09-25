/**
 * Office — writing a PowerPoint (.pptx) package.
 *
 * A .pptx is the widest OOXML package of the three: a presentation references a
 * slide master, the master references a layout and a theme, and every slide
 * references its layout. All of that is written here as fixed boilerplate, plus
 * one text box per slide holding the slide's paragraphs.
 *
 * What this cannot do is said plainly in the app's limits: no images, no charts,
 * no speaker notes, no animations, and no original fonts or colours — the reader
 * never sees them, so writer has nothing to preserve. Blank paragraphs are lost
 * too, because `readPptx` drops paragraphs whose text is only whitespace.
 */
import { contentTypes } from './ooxml';
import { xmlText } from './xml';
import { utf8, writeZip, type ZipInput } from './zip';
import { shapeXml, slideXml } from './impress/deckxml';
import { layoutShapes } from './impress/ops';

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DOC_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R_NS = DOC_REL;

const NS = `xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}"`;

/** The empty shape tree every part starts from (group shape, no children). */
const EMPTY_TREE =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

/**
 * One slide paragraph. A tab becomes `<a:tab/>` and a line break `<a:br/>` as
 * direct children of `<a:p>`, which is what `paragraphText` reads back.
 */
function slideParagraph(text: string): string {
  let runs = '';
  for (const part of text.replace(/\r\n?/g, '\n').split(/([\t\n])/)) {
    if (part === '\t') runs += '<a:tab/>';
    else if (part === '\n') runs += '<a:br/>';
    else if (part) runs += `<a:r><a:rPr lang="en-US" dirty="0"/><a:t>${xmlText(part)}</a:t></a:r>`;
  }
  return runs ? `<a:p>${runs}</a:p>` : '<a:p/>';
}

/** One slide part with a single text box holding every paragraph of the slide. */
export function pptxSlide(paragraphs: readonly string[]): string {
  const body = paragraphs.length ? paragraphs.map(slideParagraph).join('') : '<a:p/>';
  return `${DECL}<p:sld ${NS}><p:cSld><p:spTree>${EMPTY_TREE}` +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Text 1"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="457200" y="457200"/><a:ext cx="8229600" cy="5943600"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>' +
    `<p:txBody><a:bodyPr wrap="square" rtlCol="0"/><a:lstStyle/>${body}</p:txBody></p:sp>` +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
}

const SLIDE_MASTER = `${DECL}<p:sldMaster ${NS}><p:cSld>` +
  '<p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>' +
  `<p:spTree>${EMPTY_TREE}</p:spTree></p:cSld>` +
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3"' +
  ' accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
  '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
  '<p:txStyles><p:titleStyle><a:lvl1pPr algn="ctr" rtl="0"><a:defRPr sz="4400" b="1"/></a:lvl1pPr></p:titleStyle>' +
  '<p:bodyStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:bodyStyle>' +
  '<p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:otherStyle></p:txStyles></p:sldMaster>';

const SLIDE_LAYOUT = `${DECL}<p:sldLayout ${NS} type="blank" preserve="1">` +
  `<p:cSld name="Blank"><p:spTree>${EMPTY_TREE}</p:spTree></p:cSld>` +
  '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';

const PRES_PROPS = `${DECL}<p:presentationPr ${NS}/>`;

const VIEW_PROPS = `${DECL}<p:viewPr ${NS} lastView="sldView">` +
  '<p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr>' +
  '<p:slideViewPr><p:cSldViewPr><p:cViewPr varScale="1"><p:scale><a:sx n="104" d="100"/><a:sy n="104" d="100"/></p:scale>' +
  '<p:origin x="-1452" y="-114"/></p:cViewPr><p:guideLst/></p:cSldViewPr></p:slideViewPr>' +
  '<p:notesTextViewPr><p:cViewPr><p:scale><a:sx n="100" d="100"/><a:sy n="100" d="100"/></p:scale>' +
  '<p:origin x="0" y="0"/></p:cViewPr></p:notesTextViewPr>' +
  '<p:gridSpacing cx="76200" cy="76200"/></p:viewPr>';

const TABLE_STYLES = `${DECL}<a:tblStyleLst xmlns:a="${A_NS}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`;

/**
 * The default Office theme. A slide master must reference one, and a presentation
 * without a theme is the first thing PowerPoint repairs; this is the standard
 * structure with the standard colour and font scheme.
 */
const THEME = `${DECL}<a:theme xmlns:a="${A_NS}" name="Office Theme"><a:themeElements>` +
  '<a:clrScheme name="Office">' +
  '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
  '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
  '<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>' +
  '<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>' +
  '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>' +
  '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>' +
  '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>' +
  '</a:clrScheme>' +
  '<a:fontScheme name="Office">' +
  '<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
  '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>' +
  '</a:fontScheme>' +
  '<a:fmtScheme name="Office">' +
  '<a:fillStyleLst>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:gradFill rotWithShape="1"><a:gsLst>' +
  '<a:gs pos="0"><a:schemeClr val="phClr"><a:lumMod val="110000"/><a:satMod val="105000"/><a:tint val="67000"/></a:schemeClr></a:gs>' +
  '<a:gs pos="50000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:satMod val="103000"/><a:tint val="73000"/></a:schemeClr></a:gs>' +
  '<a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:satMod val="109000"/><a:tint val="81000"/></a:schemeClr></a:gs>' +
  '</a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>' +
  '<a:gradFill rotWithShape="1"><a:gsLst>' +
  '<a:gs pos="0"><a:schemeClr val="phClr"><a:satMod val="103000"/><a:lumMod val="102000"/><a:tint val="94000"/></a:schemeClr></a:gs>' +
  '<a:gs pos="50000"><a:schemeClr val="phClr"><a:satMod val="110000"/><a:lumMod val="100000"/><a:shade val="100000"/></a:schemeClr></a:gs>' +
  '<a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="99000"/><a:satMod val="120000"/><a:shade val="78000"/></a:schemeClr></a:gs>' +
  '</a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>' +
  '</a:fillStyleLst>' +
  '<a:lnStyleLst>' +
  '<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>' +
  '<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>' +
  '<a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>' +
  '</a:lnStyleLst>' +
  '<a:effectStyleLst>' +
  '<a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle>' +
  '<a:effectStyle><a:effectLst><a:outerShdw blurRad="57150" dist="19050" dir="5400000" algn="ctr" rotWithShape="0">' +
  '<a:srgbClr val="000000"><a:alpha val="63000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle>' +
  '</a:effectStyleLst>' +
  '<a:bgFillStyleLst>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/><a:satMod val="170000"/></a:schemeClr></a:solidFill>' +
  '<a:gradFill rotWithShape="1"><a:gsLst>' +
  '<a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="93000"/><a:satMod val="150000"/><a:shade val="98000"/><a:lumMod val="102000"/></a:schemeClr></a:gs>' +
  '<a:gs pos="50000"><a:schemeClr val="phClr"><a:tint val="98000"/><a:satMod val="130000"/><a:shade val="90000"/><a:lumMod val="103000"/></a:schemeClr></a:gs>' +
  '<a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="63000"/><a:satMod val="120000"/></a:schemeClr></a:gs>' +
  '</a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>' +
  '</a:bgFillStyleLst>' +
  '</a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>';

function rel(id: string, type: string, target: string): string {
  return `<Relationship Id="${id}" Type="${DOC_REL}/${type}" Target="${target}"/>`;
}

/** A minimal but complete presentation: master, layout, theme, table styles, slides. */
export function writePptx(slides: readonly string[][]): Uint8Array {
  const deck: string[][] = slides.length ? slides.map((s) => [...s]) : [['']];

  const overrides = [
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
    '<Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>',
    '<Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>',
    '<Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>',
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>',
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>',
    ...deck.map((_, i) =>
      `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`),
  ];

  // rId1 = master, rId2.. = slides, then the four non-slide parts. The order the
  // ids are handed out here is the order they are listed below, nothing implicit.
  const slideIds = deck.map((_, i) => `rId${i + 2}`);
  const presPropsId = `rId${deck.length + 2}`;
  const viewPropsId = `rId${deck.length + 3}`;
  const themeId = `rId${deck.length + 4}`;
  const tableStylesId = `rId${deck.length + 5}`;

  const presentation =
    `${DECL}<p:presentation ${NS} saveSubsetFonts="1">` +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    `<p:sldIdLst>${deck.map((_, i) => `<p:sldId id="${256 + i}" r:id="${slideIds[i]}"/>`).join('')}</p:sldIdLst>` +
    '<p:sldSz cx="9144000" cy="6858000" type="screen4x3"/>' +
    '<p:notesSz cx="6858000" cy="9144000"/>' +
    '</p:presentation>';

  const presentationRels =
    rel('rId1', 'slideMaster', 'slideMasters/slideMaster1.xml') +
    deck.map((_, i) => rel(slideIds[i], 'slide', `slides/slide${i + 1}.xml`)).join('') +
    rel(presPropsId, 'presProps', 'presProps.xml') +
    rel(viewPropsId, 'viewProps', 'viewProps.xml') +
    rel(themeId, 'theme', 'theme/theme1.xml') +
    rel(tableStylesId, 'tableStyles', 'tableStyles.xml');

  const parts: ZipInput[] = [
    { name: '[Content_Types].xml', data: utf8(contentTypes(overrides)) },
    {
      name: '_rels/.rels',
      data: utf8(`${DECL}<Relationships xmlns="${RELS_NS}">` + rel('rId1', 'officeDocument', 'ppt/presentation.xml') + '</Relationships>'),
    },
    { name: 'ppt/presentation.xml', data: utf8(presentation) },
    { name: 'ppt/_rels/presentation.xml.rels', data: utf8(`${DECL}<Relationships xmlns="${RELS_NS}">${presentationRels}</Relationships>`) },
    { name: 'ppt/presProps.xml', data: utf8(PRES_PROPS) },
    { name: 'ppt/viewProps.xml', data: utf8(VIEW_PROPS) },
    { name: 'ppt/tableStyles.xml', data: utf8(TABLE_STYLES) },
    { name: 'ppt/theme/theme1.xml', data: utf8(THEME) },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: utf8(SLIDE_MASTER) },
    {
      name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      data: utf8(`${DECL}<Relationships xmlns="${RELS_NS}">` +
        rel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml') +
        rel('rId2', 'theme', '../theme/theme1.xml') +
        '</Relationships>'),
    },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: utf8(SLIDE_LAYOUT) },
    {
      name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      data: utf8(`${DECL}<Relationships xmlns="${RELS_NS}">` +
        rel('rId1', 'slideMaster', '../slideMasters/slideMaster1.xml') +
        '</Relationships>'),
    },
    ...deck.map((paragraphs, i) => ({ name: `ppt/slides/slide${i + 1}.xml`, data: utf8(pptxSlide(paragraphs)) })),
    ...deck.map((_, i) => ({
      name: `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      data: utf8(`${DECL}<Relationships xmlns="${RELS_NS}">` +
        rel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml') +
        '</Relationships>'),
    })),
  ];
  return writeZip(parts);
}

/* ─────────────────────── a new presentation (Impress) ─────────────────────── */

const NEW_LAYOUTS: ReadonlyArray<{ type: string; name: string }> = [
  { type: 'title', name: 'Title Slide' },
  { type: 'obj', name: 'Title and Content' },
  { type: 'twoObj', name: 'Two Content' },
  { type: 'blank', name: 'Blank' },
];

/**
 * A new 16:9 presentation: one master (title 44 pt, bulleted body), the four layouts
 * the slide rail offers (Title · Title and Content · Two Content · Blank), the theme,
 * and one title slide holding `title` and `subtitle` as placeholders.
 */
export function newDeckPptx(title: string, subtitle: string): Uint8Array {
  const n = NEW_LAYOUTS.length;
  const master = `${DECL}<p:sldMaster ${NS}><p:cSld>` +
    '<p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>' +
    `<p:spTree>${EMPTY_TREE}</p:spTree></p:cSld>` +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3"' +
    ' accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    `<p:sldLayoutIdLst>${NEW_LAYOUTS.map((_, i) => `<p:sldLayoutId id="${2147483649 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldLayoutIdLst>` +
    '<p:txStyles><p:titleStyle><a:lvl1pPr algn="l" rtl="0"><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle>' +
    '<p:bodyStyle><a:lvl1pPr marL="228600" indent="-228600"><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/><a:defRPr sz="2800"/></a:lvl1pPr></p:bodyStyle>' +
    '<p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:otherStyle></p:txStyles></p:sldMaster>';
  const layout = (type: string, name: string): string => `${DECL}<p:sldLayout ${NS} type="${type}" preserve="1">` +
    `<p:cSld name="${name}"><p:spTree>${EMPTY_TREE}</p:spTree></p:cSld>` +
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';
  const relsDoc = (body: string): Uint8Array => utf8(`${DECL}<Relationships xmlns="${RELS_NS}">${body}</Relationships>`);

  const [ctrTitle, sub] = layoutShapes('title', 12192000, 6858000);
  ctrTitle.paras = [{ ...ctrTitle.paras[0], text: title }];
  sub.paras = [{ ...sub.paras[0], text: subtitle }];
  const slide = slideXml(shapeXml(ctrTitle, 2, null) + shapeXml(sub, 3, null), null, 'none', '');

  const overrides = [
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
    '<Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>',
    '<Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>',
    '<Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>',
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>',
    ...NEW_LAYOUTS.map((_, i) => `<Override PartName="/ppt/slideLayouts/slideLayout${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>`),
    '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>',
  ];
  const presentation =
    `${DECL}<p:presentation ${NS} saveSubsetFonts="1">` +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    '<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>' +
    '<p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>';

  return writeZip([
    { name: '[Content_Types].xml', data: utf8(contentTypes(overrides)) },
    { name: '_rels/.rels', data: relsDoc(rel('rId1', 'officeDocument', 'ppt/presentation.xml')) },
    { name: 'ppt/presentation.xml', data: utf8(presentation) },
    {
      name: 'ppt/_rels/presentation.xml.rels',
      data: relsDoc(rel('rId1', 'slideMaster', 'slideMasters/slideMaster1.xml') + rel('rId2', 'slide', 'slides/slide1.xml') +
        rel('rId3', 'presProps', 'presProps.xml') + rel('rId4', 'viewProps', 'viewProps.xml') +
        rel('rId5', 'theme', 'theme/theme1.xml') + rel('rId6', 'tableStyles', 'tableStyles.xml')),
    },
    { name: 'ppt/presProps.xml', data: utf8(PRES_PROPS) },
    { name: 'ppt/viewProps.xml', data: utf8(VIEW_PROPS) },
    { name: 'ppt/tableStyles.xml', data: utf8(TABLE_STYLES) },
    { name: 'ppt/theme/theme1.xml', data: utf8(THEME) },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: utf8(master) },
    {
      name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      data: relsDoc(NEW_LAYOUTS.map((_, i) => rel(`rId${i + 1}`, 'slideLayout', `../slideLayouts/slideLayout${i + 1}.xml`)).join('') +
        rel(`rId${n + 1}`, 'theme', '../theme/theme1.xml')),
    },
    ...NEW_LAYOUTS.flatMap((l, i) => [
      { name: `ppt/slideLayouts/slideLayout${i + 1}.xml`, data: utf8(layout(l.type, l.name)) },
      { name: `ppt/slideLayouts/_rels/slideLayout${i + 1}.xml.rels`, data: relsDoc(rel('rId1', 'slideMaster', '../slideMasters/slideMaster1.xml')) },
    ]),
    { name: 'ppt/slides/slide1.xml', data: utf8(slide) },
    { name: 'ppt/slides/_rels/slide1.xml.rels', data: relsDoc(rel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml')) },
  ]);
}
