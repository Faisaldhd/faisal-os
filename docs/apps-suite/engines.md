# Engines API (ready, tested, not yet wired into the UIs)

All engines are DOM-free where possible, fully covered by vitest, and add nothing to the entry chunk until an app imports them.

## Office: spreadsheet engine
`src/apps/office/formula/index.ts`
- `new Workbook({ now? })`, `addSheet`, `renameSheet` (rewrites references), `removeSheet` (references become `#REF!`).
- `setCell(sheet, row, col, text | "=formula") → { ok } | { ok: false, error }`, `setValue`, `getValue`, `getText`, `getFormula`.
- `recalc()` returns the changed cells (dirty-only). `evaluate(formula, sheet, row, col)` gives a formula-bar preview. `isCircular(...)`: circular references show `#REF!`.
- Model bridge: `computeSheets(model)` (replaces `computeFormulaCells`), `evaluateInModel`, `workbookFromModel(model)`.
- Formula text: `parseFormula`, `formatFormula(ast, { xlfn })` (adds the `_xlfn.` prefix for xlsx), `translateFormula(text, dRows, dCols)` (fill/copy), `shiftFormula(...)` (insert/delete rows or columns).
- `registerFunction(name, impl, { minArgs, maxArgs, volatile?, xlfn?, aliases? })`. 111 functions are registered.
- Performance: 10k rows plus 1k VLOOKUP recalc in about 130 ms; a single edit takes about 12 ms.
- `formula.ts` still exposes the old API. Switching the UI to the new engine means updating two `formula.test.ts` assertions (MIN and `^` are now supported).

`src/apps/office/calc/index.ts`
- `sortRows(rows, [{ col, order }], { header })`, `sortPermutation`.
- AutoFilter: `distinctValues`, `filterRows(rows, { [col]: condition })`, `visibleRows`.
- `evaluateConditionalFormats(values, rules)` returns one style per cell (colour scales, data bars, rules).
- `validateEntry(input, rule)` (list, number range, date range). Copy `VALIDATION_MESSAGES` into `strings.ts`.
- `formatValue(value, pattern, { locale, digits: 'arabic' })`, `makeFormat`, `parseEntry("12%")`, `BUILTIN_FORMATS`.

`src/apps/office/charts/index.ts`
- `buildChart(spec)` returns marks to draw with `createElementNS`. `renderSvg(scene)` gives an escaped SVG string for export. Also `niceTicks`, `pieAngles`, `CHART_THEMES` (bar, line, pie, doughnut, scatter).

## PDF: writing engine
`src/apps/pdf/engine/`
- Coordinates are in PDF user space (bottom-left origin). Colours are `#rrggbb`. Every operation returns `OpResult` from `pdfdoc.ts` and re-opens its own output to verify it.
- `annotations.ts`: `addAnnotation(bytes, { page, kind: highlight|underline|strikeout|ink|square|circle|line|arrow|note|freetext|stamp, color, opacity, width?, fill?, quads?, rect?, paths?, line?, contents?, fontSize?, author? }, opts?)`, `listAnnotations`, `updateAnnotation`, `removeAnnotation`. Annotations are real PDF annotations with `/AP` appearance streams.
- `arabic.ts`: `loadArabicFont()` (lazy; Noto Naskh Arabic, SIL OFL), `addUnicodeText`, `needsUnicodeFont`, plus shaping and bidi helpers.
- `signature.ts`: `drawnSignature` (vector), `typedSignature`, and a saved-signature library (JSON, up to 20).
- `forms.ts`: `listFields`, `fillFields`, `flattenForm`.
- `stamp.ts`: `addStamp`, `addTextWatermark`, `addHeaderFooter`, `addPageNumbers`, `addImageStamp`.
- Dependency: `@pdf-lib/fontkit` (MIT), loaded lazily.

## Photo: pixel engine
`src/apps/photo/engine/index.ts`. Images are ImageData-like `{ width, height, data }`.
- Seam functions: `adjust(buf, params)` (13 sliders plus invert/grayscale), `applyFilter(buf, id, amount, scale)` (22 ids, see `FILTER_IDS`), `histogram(buf, step?, mask?)`.
- `adjustImage` with levels and curves, and `buildPipeline` / `applyPipeline` (a single LUT pass).
- Filters and presets: `blur`, `sharpen`, `vignette`, `noise`, `pixelate`, `posterize`, `emboss`, `edgeDetect`, `FILTER_PRESETS`, `presetThumbnails`.
- Selection: `rectMask`, `ellipseMask`, `polygonMask`, `magicWand`, `featherMask`, `invertMask`, `combineMasks`, `maskOutline`, `applyThroughMask`.
- Paint: `BrushStroke` (paint, erase, clone), `paintBucket`, `drawGradient`, `sampleColor`.
- Blend: `BLEND_MODES` (16 modes), `compositeLayer`, `flattenLayers`.
- Worker: `runInWorker(op, image, params, { signal })` with a synchronous fallback; `disposeWorker()`.
- Performance: the full adjustment stack on a 12 MP image takes about 0.2 s.

## Video: render and export engine
Lands together with the Video Studio UI, because it consumes that UI's `project.ts` model. It provides a `CanvasStudioEngine` (implementing `StudioEngine`): a single compositor for preview and export, the audio mix, and export with progress, cancel and a WebM duration fix.
