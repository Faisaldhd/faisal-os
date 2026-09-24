# Acceptance checklist: Office, PDF, Photo, Video (Fai$al OS)

Baseline: `main` @ f58eb3e. Auditor: an app is ACCEPTED only when every **Must** item passes, at least 80% of **Should** items pass, and all of section 0 passes.
Item notation: `[M]` Must (blocks acceptance), `[S]` Should, `[P]` Polish. Each item says how to verify it.
Viewports: **D** = 1440×900 desktop window, **P** = 390×844 phone, **S** = 320×640 small phone (AGENTS.md requires 320 and 390).

---

## 0. Gates that apply to all four apps (all are Must)

| # | Check | How to verify |
|---|---|---|
| G1 | `npm run typecheck`, `npm test`, `npm run build` all pass. No test deleted or skipped (`git diff main --stat -- '*.test.ts'` shows no removals; `grep -rn "\.skip\|\.only" src/apps/<app>` is empty). | CI / local |
| G2 | New logic has vitest tests: each new pure module (parser, writer, geometry, history, timeline model) has its own `*.test.ts`. | diff review |
| G3 | No `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`DOMParser('text/html')` on file or user content. Only static, in-code SVG icon strings may use markup. | `grep -rnE "innerHTML\|outerHTML\|insertAdjacentHTML" src/apps/<app>` then review each hit |
| G4 | Every visible string comes from `strings.ts` with both `ar` and `en`, and the key sets are equal (existing `strings.test.ts` pattern extended). Switch the language in Settings: no English left in Arabic mode and no Arabic left in English mode, except file content. | test + manual |
| G5 | Zero console errors and zero unhandled promise rejections during the full scripted flow of the app (open, edit, undo, save, close) in Chrome, D and P. | DevTools console |
| G6 | Light and dark themes: switching `data-theme` (Settings > Appearance) restyles the whole app live, with no hard-coded dark or light panels. All colours come from `--faisal-*` tokens or app tokens derived from them. Text contrast is at least 4.5:1 in both themes. | `grep -cE "#[0-9a-f]{3,6}" app.css` is small and justified (canvas checkerboard, etc.); axe/Lighthouse contrast |
| G7 | RTL: in Arabic the chrome mirrors (panels, back arrows, ribbon order). Content direction is `dir="auto"` per paragraph/cell/text box. Spreadsheet grids, timelines and rulers stay LTR, as they are today. | manual AR/EN |
| G8 | At P and S: no horizontal page scroll, no control off-screen or overlapping. Every tappable target is ≥44×44 px. Nothing works only on hover. Layout keys off the **window** size (container query or ResizeObserver), not just `@media` on the viewport, so a narrow desktop window also gets the compact layout. | DevTools device mode + script: all `button,[role=button],input,select` have `getBoundingClientRect()` ≥44 and are inside the viewport |
| G9 | Accessibility basics: every icon-only button has `aria-label` (and a tooltip `title` on desktop). The whole app works with the keyboard (Tab order is logical, focus is visible with `--faisal-focus-ring`). Dialogs trap focus, close on Esc and return focus. Status messages use `role="status"`/`aria-live`. | keyboard-only run + axe: 0 critical |
| G10 | Data safety: saving stays inside `/home/user`. Overwriting keeps exactly one `.bak`. A failed or cancelled save writes nothing. After a save the file is re-read before "Saved" is shown. The close guard asks when there are unsaved changes, using `shellConfirm` (not `window.confirm`; Photo uses it today). | test + manual |
| G11 | No new runtime dependency without a one-paragraph reason in the PR (AGENTS.md). Allowed with reason: pdf.js (Photo/PDF rendering) and a font plus shaping for Arabic PDF text. Any library is lazy-loaded (`import()`) so the shell bundle does not grow by more than 20 KB gzip. | `vite build` size report, before and after |
| G12 | No regression: every format that opens on `main` still opens (Office: docx/xlsx/xlsm-ro/pptx/csv/tsv/txt/md; PDF: pdf plus images to PDF; Photo: png/jpeg/webp/gif/bmp/avif/svg; Video: whatever `canPlayType` accepts). Existing honest refusals (legacy .doc/.xls/.ppt, encrypted PDF, .mkv) still show a clear bilingual message. | fixture run |

---

## 1. Office (target: WPS Office)

**Today on `main`:** Word is a list of one `<textarea>` per paragraph ("Paragraph 1…"), with no page view, no inline bold/italic, and formatting only per whole paragraph. Excel is an `<input>` grid (300×40 view) with only SUM/AVERAGE, and no selection ranges, fill, formats or column resize. PowerPoint is text areas per slide, with no slide canvas. There is no "New document", no start screen, no Ctrl+Z/Ctrl+Y (only Ctrl+S), no print or PDF export, and images/tables are not shown. Saving is strong: it patches the original package and keeps a `.bak`, and must be kept.

### Must
1. [M] **Start screen** with no file: New Document / New Spreadsheet / New Presentation, plus Open (VFS path + device file) and a Recent list. New creates a valid, empty .docx/.xlsx/.pptx that Word/LibreOffice opens without a repair prompt (tested by unzip + XML well-formedness plus a checked-in fixture opened in LibreOffice once, with a screenshot in the PR).
2. [M] **Word WYSIWYG page view:** A4/Letter pages with margins on a grey canvas. Runs keep their own bold/italic/underline/colour/size/font (not only per paragraph). Opening `fixtures/mixed-runs.docx` shows "normal **bold** *italic*" in one paragraph exactly as Word does.
3. [M] **Word tables and images render:** a .docx with a 3-column bordered table shows the table with borders and the same column widths (±5%). An inline PNG image appears at its size. Editing text in a table cell saves back and reopens identically.
4. [M] **Word round-trip:** open, change one word, add bold to a word, save, then reopen. Only that word changed, and styles, headers, footers, numbering and images survive (existing patch approach). A byte diff of the untouched ZIP entries is identical.
5. [M] **Arabic in Word:** an RTL paragraph (`w:bidi`) shows right-aligned with correct shaping. New paragraphs typed in Arabic are saved with `w:bidi` + `w:rtl`, and Word shows them RTL.
6. [M] **Sheets grid:** click-drag and Shift+arrows select a range. Arrow/Enter/Tab navigation works, as do a formula bar that shows the formula of the active cell, a name box (A1) and a sheet tab strip. Copy/paste of a range to/from the system clipboard is TSV.
7. [M] **Formulas:** at minimum SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, IF, ROUND, ABS, CONCAT/&, TODAY, plus relative/absolute refs (`$A$1`) and cross-sheet refs (`Sheet2!A1`). Dependents recalculate on edit. Errors show `#DIV/0!`, `#REF!`, `#NAME?`. Each function is unit-tested.
8. [M] **Sheets fidelity:** number formats (0.00, %, date, currency) display as Excel does. Bold/fill colour/borders/column widths/merged cells from the file are shown. Saving keeps them (patch, not rebuild).
9. [M] **Slides view:** a slide thumbnail rail plus a 16:9 slide canvas that shows text boxes at their positions/sizes, with images and background colour. Text edits in place on the canvas. Add, duplicate, delete and reorder slides (drag in the rail), then save and reopen in PowerPoint without repair.
10. [M] **Undo/redo everywhere:** Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z plus toolbar buttons, at least 100 steps, in all three editors. Typing a word is one step, not one step per key.
11. [M] **Performance:** a 1 MB, 50-page .docx shows page 1 in < 1.5 s and stays at < 50 ms keypress-to-paint while typing. A 10,000 × 20 .xlsx opens in < 2 s and scrolls at 60 fps (virtualised rows and columns; no 300-row cap). A 40-slide .pptx shows its rail in < 2 s.
12. [M] **Phone:** at P the ribbon collapses to a tab bar plus one horizontally scrollable tool row, or a bottom sheet. Editing text brings up the keyboard without the caret being hidden behind it. The Sheets grid pans with one finger and its cells are ≥44 px tall in touch mode.

### Should
13. [S] Ribbon tabs Home / Insert / Layout / Review / View (Word); Home / Insert / Formulas / Data / View (Sheets); Home / Insert / Design / Slideshow (Slides).
14. [S] Word: headings (H1–H3 from the file's styles), bulleted/numbered lists, line spacing, find and replace (Ctrl+F / Ctrl+H) with Arabic and diacritic-insensitive matching.
15. [S] Export to PDF (from any of the three), through the PDF app's writer or print-to-PDF. Print (Ctrl+P) prints only the document, never the desktop.
16. [S] Sheets: sort A–Z/Z–A, filter, freeze first row/column, auto-fill by dragging the handle (1,2,3… and Mon, Tue…), resize columns by dragging.
17. [S] Slides: present mode (F5) fullscreen with arrow/tap navigation and Esc to exit.
18. [S] Word/Slides status bar: page X of Y, word count, zoom slider (50–200%), language/direction indicator.
19. [S] Autosave draft to IndexedDB every 30 s. After a crash or reload, reopening offers "Restore unsaved changes".

### Polish
20. [P] Templates on the start screen: at least 3 per type (letter, report, CV / budget, invoice / pitch deck), with Arabic and English variants.
21. [P] Insert chart from a selected range (bar/line/pie) in Sheets, rendered on canvas/SVG.
22. [P] Right-click and long-press context menus (cut/copy/paste/insert row, etc.) using `shell/contextmenu`.

---

## 2. PDF (target: Foxit PhantomPDF)

**Today on `main`:** pages are shown through a browser `<iframe>` with a blob URL. It does not render inside the app, the Android/iOS WebView shows no pages, and there are no thumbnails, no zoom control and no search. Page tools are a text list ("Page 3, 595×842") with ▲/▼. Add text / signature / cover are positioned by typing X,Y numbers. Arabic text is refused. There are no annotations, no highlighting and no text selection. The pdf-lib operations and the save/`.bak` rule are solid and must be kept.

### Must
1. [M] **In-app rendering** (pdf.js, lazy-loaded, worker on): continuous vertical scroll of all pages, rendered to canvas at devicePixelRatio. It works identically on desktop Chrome/Firefox/Safari **and** mobile Chrome/Safari (no iframe dependence).
2. [M] **Performance:** a 1.8 MB 60-page PDF shows page 1 in < 2 s (cold) and page 60 within 500 ms of jumping to it. Pages outside the viewport ±2 are not rendered, and the memory for rendered canvases stays below 300 MB on a 300-page file.
3. [M] **Thumbnail sidebar** with page images (not text rows): click to jump; select multiple (Ctrl/Shift, long-press on touch); drag to reorder; context menu with rotate / delete / extract / duplicate / insert blank. Thumbnails update after each operation.
4. [M] **Navigation and zoom:** page number box ("3 / 60"), prev/next, Fit width, Fit page, 50–400% zoom, Ctrl+wheel and pinch zoom, Home/End/PgUp/PgDn, Ctrl+G to go to a page.
5. [M] **Search:** Ctrl+F finds text across all pages (Arabic and English), highlights every hit, shows "4 of 17" with next/prev, and scrolls to each hit.
6. [M] **Text selection and copy** from the text layer. Arabic copies in logical order (the pasted text reads correctly).
7. [M] **Place on the page by direct manipulation:** add text, signature, image and cover rectangle by clicking/tapping on the page, then dragging and resizing a box. No X/Y number fields needed (they may stay as an "advanced" option).
8. [M] **Annotations:** highlight / underline / strikeout on selected text, freehand ink, rectangle/ellipse/arrow, sticky note, all with colour and opacity. They are saved as real PDF annotations (`/Annots`, visible and editable in Acrobat/Foxit) and reopen as editable objects.
9. [M] **Arabic text in added text, notes and signatures** renders correctly shaped and RTL in the saved PDF (embedded Arabic font subset plus shaping) and reads correctly in Acrobat. It is no longer refused.
10. [M] **Save round-trip:** after rotate + delete + annotate + form fill, saving and reopening shows the same result. The file opens in Chrome's viewer and Acrobat without errors. Save = Ctrl+S (new file by default, overwrite only after confirmation plus `.bak`, as today). Download and Print are kept.
11. [M] **Undo/redo** (Ctrl+Z/Ctrl+Y) for every page operation and annotation, at least 50 steps.
12. [M] **Form filling in place:** AcroForm fields are drawn over the page. Tap a field to type, and checkboxes/radios/dropdowns work on the page itself, then save. Tab moves to the next field.
13. [M] **Phone:** at P the thumbnails become a drawer or bottom sheet. The page fits width by default, pinch-zoom and one-finger scroll work, and the toolbar is one scrollable row plus a "More" sheet. No control is off-screen at S.

### Should
14. [S] Tool tabs like Foxit: Home / Comment / Edit / Organize / Protect / Forms / View.
15. [S] Outline/bookmarks panel from the PDF outline; clicking an entry jumps to its target. Internal links in the page are clickable.
16. [S] Merge (drag files in, reorder, page ranges) and split, reusing the existing ops with the new thumbnail UI.
17. [S] True redaction: mark areas, then "Apply redactions" removes the text under the boxes from the content stream (verify: extracted text no longer contains the word). If it is not possible, the "cover (not redaction)" wording stays explicit.
18. [S] Page labels, document properties dialog (title/author/subject/keywords; edit as today).
19. [S] Open password-protected PDFs for viewing (pdf.js supports passwords) with a password prompt. Editing may still be refused, with a clear message.

### Polish
20. [P] Night reading mode (inverted page colours) in dark theme, as an optional toggle.
21. [P] Two-page / book view and presentation (fullscreen) mode.
22. [P] Stamps (Approved / Draft / Confidential in ar+en) and a saved-signature library (stored locally in the VFS).

---

## 3. Photo (target: Photopea / Pixlr)

**Today on `main`:** single-bitmap editor with adjustments, filters, blur/sharpen, crop/rotate/resize, brush/line/shapes/text and history. It has **no layers** (listed as a limit), no new-canvas screen, no eraser/eyedropper/fill/clone, and no real selection-based editing. Open is done by typing a VFS path. The CSS is hard-coded dark with a blue accent (`--fp-accent: #4da3ff`), so it has no light theme and is off-brand. There is no pinch zoom and no pan by space-drag.

### Must
1. [M] **Start screen:** New (presets 1080×1080, 1920×1080, A4 @300dpi, custom W×H, transparent/white background), Open from the device or VFS (with a VFS picker, not a typed path), Recent, and drag-and-drop a file onto the window.
2. [M] **Layers panel:** add, delete, duplicate, rename, reorder (drag), hide/show, lock, opacity 0–100, and at least these blend modes: normal, multiply, screen, overlay, darken, lighten. Merge down and flatten. Each layer has a thumbnail. All of it is undoable.
3. [M] **Project format:** save/open a native layered project (e.g. `.fphoto` = zip or JSON + PNG per layer) that reopens with every layer, name, opacity, blend mode and text layer still editable. Round-trip test in vitest.
4. [M] **Export:** PNG/JPEG/WebP with quality, size preview (bytes) and scale; transparency is preserved in PNG/WebP. Export of a 4000×3000 image completes in < 3 s. The existing `.bak` rule applies when overwriting.
5. [M] **Selections:** rectangle, ellipse, lasso and magic wand (with tolerance), with add/subtract, select all/deselect/invert (Ctrl+A / Ctrl+D / Ctrl+Shift+I) and marching ants. Adjustments, fill, delete, copy/paste and brush respect the selection (verify: brushing outside the selection changes no pixels).
6. [M] **Core tools:** move (layer), brush, eraser, paint bucket, gradient, eyedropper, clone stamp, text, shapes, crop, zoom and hand. Each has a one-key shortcut (V, B, E, G, I, S, T, U, C, Z, H) and a tool-options bar (size, hardness, opacity, colour).
7. [M] **Non-destructive text layers:** text stays editable after commit (double-click to edit), with font, size, colour, alignment and **Arabic shaping + RTL** correct on the canvas and in the export.
8. [M] **Adjustments** (existing seven plus hue/saturation, levels or curves, invert, grayscale) apply to the active layer or selection, with a live preview under 100 ms on a 12 MP image (preview on a downscaled proxy is fine) and Cancel/OK.
9. [M] **Undo/redo** Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z, at least 50 steps, with a history panel where clicking a state jumps to it. Memory is bounded (keep the existing `history.ts` budget idea).
10. [M] **Performance:** a 12 MP JPEG opens and is displayed in < 1.5 s. Brush strokes track the pointer with no visible lag (≤16 ms per frame at 1080p canvas; verify with a Performance trace). A 24 MP image is allowed or refused with a message, never a crash or tab freeze.
11. [M] **Zoom and pan:** Ctrl+wheel, Ctrl+0 (fit) and Ctrl+1 (100%) zoom, space+drag pans, and on touch two-finger pinch zooms and pans while one finger draws. Pixel grid is crisp (`image-rendering: pixelated`) above 400%.
12. [M] **Theme and brand:** the app uses `--faisal-*` tokens (light and dark). The accent is gold (`--faisal-accent`), not blue. The canvas area stays neutral grey with a checkerboard for transparency in both themes.
13. [M] **Phone:** at P the tools become a bottom toolbar (icons ≥44 px), the panels (layers, adjust, options) become bottom sheets, and the canvas uses the rest of the screen. At S every tool is reachable.

### Should
14. [S] Open PSD (flattened composite plus layers when readable) read-only, or clearly refuse. Open multi-page or animated GIF as its first frame, with a message.
15. [S] Transform: free transform with handles (scale/rotate) and flip for a layer or selection; image resize/canvas size with anchor.
16. [S] Filters: Gaussian blur, sharpen, noise, vignette and the existing presets, each with a before/after toggle.
17. [S] Copy/paste to and from the system clipboard (paste an image from another app as a new layer).
18. [S] Rulers plus guides, and a snap-to-canvas-edges option.

### Polish
19. [P] Layer masks (paint black/white to hide/show).
20. [P] Adjustment layers (non-destructive brightness/contrast, hue).
21. [P] Background removal (simple colour-key or magic-wand-based), with an honest label.

---

## 4. Video (target: CapCut desktop / Clipchamp)

**Today on `main`:** one source file, cut into ordered clips (in/out, split), with rotate/flip/crop, gain, fades and frame capture. Export records in real time via MediaRecorder/WebCodecs. It has no multi-file media bin, no multi-track timeline, no text/titles, no transitions, no music track, no thumbnails or waveform on the timeline, and **no keyboard shortcuts at all** (not even Space).

### Must
1. [M] **Start screen:** New project with aspect presets 16:9, 9:16, 1:1, 4:5, Open project, Recent projects.
2. [M] **Media bin:** import several videos, images and audio files (device and VFS picker, drag-and-drop). Each item shows a thumbnail, its duration and its resolution. Unsupported formats are refused with the existing bilingual `canPlayType` message.
3. [M] **Multi-track timeline:** at least 1 main video track + 1 overlay track + 1 text track + 2 audio tracks. Drag media from the bin, move clips between tracks, snap to playhead and clip edges, trim by dragging edges, split at the playhead (S or Ctrl+B), delete (Del), ripple delete on the main track. Clips show filmstrip thumbnails; audio clips show waveforms.
4. [M] **Preview:** the canvas preview matches the export (same composition, text and transforms). Playback of a 1080p single-track timeline runs at ≥ 30 fps with audio in sync (drift under 1 frame over 60 s). Scrubbing the playhead shows the frame in < 150 ms.
5. [M] **Text/titles:** add text with font, size, colour, background, position (drag on the preview) and in/out animation (fade, slide). **Arabic text is shaped and RTL** in preview and export.
6. [M] **Transitions** between adjacent clips: at least cross-fade, dip to black and slide, with adjustable duration.
7. [M] **Audio:** per-clip volume and fade in/out (existing logic), mute track, background music on its own track, detach audio from a video clip.
8. [M] **Per-clip properties:** speed 0.25×–4× (with pitch kept, or muted with a message), rotate/flip/crop (existing), scale and position for overlay (picture-in-picture), opacity.
9. [M] **Undo/redo** Ctrl+Z / Ctrl+Y for every timeline change, at least 100 steps.
10. [M] **Keyboard:** Space play/pause, J/K/L, ←/→ one frame, Shift+←/→ 1 s, Home/End, I/O set in/out, S split, Del delete, Ctrl+S save project, +/- timeline zoom. Shortcuts do not fire while typing in a text field.
11. [M] **Project save round-trip:** a project file (JSON with relative VFS paths) saves every track, clip, text, transition and setting, and reopens identically. Missing media is shown as "offline" with Relink instead of crashing. Vitest tests the serializer.
12. [M] **Export:** choose resolution (720p/1080p), fps (30/60) and format (MP4 when `MediaRecorder.isTypeSupported` allows it, else WebM, stated honestly), with a progress bar, ETA and Cancel. A 30 s 1080p timeline exports and the result plays in the Files/Viewer app with the correct duration (±0.1 s). A cancelled export writes nothing.
13. [M] **Phone:** at P the layout is preview on top, then transport, then timeline (horizontal scroll, pinch to zoom the time scale), with the bottom tool bar (Edit/Audio/Text/Effects/Export). Clips can be dragged and trimmed with a finger (handles ≥44 px). Nothing is off-screen at S.

### Should
14. [S] Filters/colour per clip (brightness, contrast, saturation, presets) applied in the preview and the export.
15. [S] Stickers/image overlays with keyframe-free position and scale, and a PNG logo watermark.
16. [S] Timeline zoom (Ctrl+wheel / pinch) from whole-project to frame level, plus a ruler with timecode in `mm:ss:ff`.
17. [S] Autosave project every 30 s, with restore after reload.
18. [S] Export audio only (WebM/Opus or WAV) and export the current frame as PNG (existing).

### Polish
19. [P] Auto-captions placeholder is **not** acceptable as fake: either absent, or real via the Web Speech API with an honest "browser-dependent" label.
20. [P] Keyframes for position, scale and opacity.
21. [P] Templates on the start screen (intro title, 9:16 story).

---

## 5. Common UX language (the four apps are one suite)

Built on `src/shell/theme.css` tokens. No app-local colour palette except canvases/checkerboards.

- **Colour:** chrome uses `--faisal-surface` (panels), `--faisal-surface-2` (toolbars, ribbon), `--faisal-surface-3` (pressed/selected), `--faisal-bg` (work area around a page, canvas or timeline), text `--faisal-fg` / `--faisal-fg-muted`, and lines `--faisal-border`. There is one accent: `--faisal-accent` (gold in dark, antique in light) for the primary button, the active tab underline, the selection outline and the playhead. `--faisal-danger` is used only for destructive actions. Focus is a 2 px `--faisal-focus-ring` outline, offset 2 px.
- **Shape and motion:** `--faisal-radius` for panels, cards and dialogs; `--faisal-radius-sm` for buttons and inputs. Transitions use `--faisal-dur-quick` / `--faisal-dur` with `--faisal-ease` and respect `prefers-reduced-motion`. Font: `--faisal-font`, with `--faisal-font-mono` for timecode and cell refs.
- **Layout (desktop), top to bottom:**
  1. **App bar** (48 px): app icon + file name + dirty dot ("•" plus aria text), then Undo/Redo, then the primary action (Save / Export) on the inline-end.
  2. **Ribbon:** tab strip (text labels) plus one tool row of grouped icon buttons (36 px desktop, 44 px coarse pointer) with group captions in `--faisal-fg-muted`.
  3. **Work area:** side panels are inline-start (navigation: pages, slides, layers, media bin) and inline-end (properties/inspector), each collapsible.
  4. **Status bar** (28 px, `--faisal-surface-2`, muted text): left for context (page 3/60, cell B4, 1920×1080, 00:12:05), right for zoom control and a `role="status"` message slot.
- **Layout (phone, window < 700 px = `NARROW_BREAKPOINT`):** the app bar is kept. The ribbon becomes one horizontally scrollable icon row, with an overflow "More" bottom sheet. Side panels become bottom sheets (drag handle, 60% height, Esc/back closes). A primary floating action is allowed only for "Export/Save".
- **Icons:** one set shared by the suite. Line icons 24×24 viewBox, 1.75 px stroke, `currentColor`, round caps and joins (like `photo/toolbar-icons.ts`), rendered with `shell/icon.ts`. Icons that imply direction (undo/redo, indent, arrows, next/prev) flip in RTL, while media play icons do not flip. Every icon button has `aria-label` + `title`.
- **Start screen** (same structure in all four): a large "New" tile row (type or preset cards), then "Open" (device file, VFS picker) and "Recent" (the last 10, with a thumbnail, name, path and date, stored per app in the VFS or localStorage with try/catch). Drag-and-drop onto the window opens the file.
- **Dialogs:** always `shellConfirm` / `shellChoice` or one shared in-app modal with the same look (overlay `--faisal-overlay-bg`, `--faisal-surface` card, title, body, buttons ordered [Cancel][Primary] with the primary on the inline-end). Destructive actions use the danger style. Never `window.alert/confirm/prompt`.
- **Messages:** transient success appears in the status slot. Errors show an inline banner with a bilingual message that names the file and the reason, plus one action (Retry / Choose another file). A long task (export, merge, big open) shows a progress bar with Cancel.
- **Shared shortcuts:** Ctrl+N new, Ctrl+O open, Ctrl+S save, Ctrl+Shift+S save as, Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z, Ctrl+C/X/V, Ctrl+A, Ctrl+F find (where applicable), Ctrl+P print (Office/PDF), Ctrl+0 fit / Ctrl+1 100% / Ctrl +/- zoom, Del delete, Esc cancel or close the sheet, F1 shortcuts sheet (a list generated from the same table the app uses to bind keys, with a test). Shortcuts are scoped to the focused window, never global.
- **Honesty panel:** each app keeps its "limits" list (it exists today) under the "?" menu, not as a permanently visible panel.
