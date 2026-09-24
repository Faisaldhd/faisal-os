# Owner's spec (addendum; it OVERRIDES acceptance.md where they conflict)

## Visual direction (applies to all four apps, one consistent style)
- Modern **glassmorphism**: translucent panels (backdrop-filter: blur + saturate, semi-transparent surfaces, 1px light hairline borders, soft shadows, rounded corners), layered depth.
- **Dark theme first**, with **copper glass accents** (copper ≈ #B87333 / #C8894B range, harmonised with the brand gold `--faisal-brand-gold*`) and a **calm blue** secondary accent (≈ #5B8DEF / #6FA3D8 range, muted). Define these as CSS custom properties at the app root (e.g. `--app-copper`, `--app-blue`, `--app-glass`) built on the `--faisal-*` tokens, so all four apps share the same values. The light theme must still be readable and good-looking, but dark is the showcase.
- This replaces the analyst's "gold tokens only / no blue" rule: copper + calm blue are now the owner's accents.
- Provide a `@supports not (backdrop-filter: blur(1px))` fallback (opaque surfaces) and respect `prefers-reduced-transparency`/`prefers-reduced-motion` where available.

## Per-app must-haves from the owner (make sure every one exists and is easy to find)
1. **Photos (photo app)**: gallery grid of the album (Pictures folder) with pan & zoom viewer; quick editor: crop with fixed ratios (free, 1:1, 16:9, 4:3), rotate, brightness/contrast/saturation sliders, one-click filters (Grayscale, Sepia, Blur, + a few more); save/export and **download** as PNG/JPG in high quality.
2. **Video**: cinematic custom player controls (play/pause, volume, fullscreen, speed 0.5x–2x); **playlist drawer** (add several clips, drag to reorder, switch between them); trim tool with **trim handles** for start/end and save only the selected part.
3. **Office**: Docs editor with full RTL, bold/italic/font size/colours/bulleted lists, live word + character counter in the bottom bar; Spreadsheet with interactive cells and SUM, AVERAGE, COUNT (at least); **import/export CSV and export to PDF** (doc and sheet).
4. **PDF Studio**: view with zoom + page navigation; add text over pages (form filling); **draw a handwritten signature** and place it by dragging; rotate pages; merge files; text watermark; direct print and download.

All of this is client-side only (no network, no uploads).

---
# Office: owner's LibreOffice-grade roadmap (Writer / Calc / Impress / Draw+Math)
The owner wants, over several phases, a LibreOffice-grade suite. It is too large for one pass: build **Phase 1** now, solid and beautiful, and design the code so later phases slot in. List in your report exactly what is done and what is left for Phase 2/3.

## Phase 1 (this round)
- **Writer**: paragraph + character styles (Title, Heading 1–3, Normal, Quote…) with a styles gallery; headers & footers with page numbers; full RTL/LTR with Arabic fonts (tashkeel preserved); auto **Table of Contents** from headings; tables with merge/split cells and table styles; images (inline + wrap square/top-bottom); multi-column sections (2–3 columns); inline comments; export to PDF, HTML, Markdown; open/save .docx (existing patcher), open .odt if feasible.
- **Calc**: virtual-scrolled grid (10k+ rows smooth); a formula engine with a clean function registry and **60+ functions** now incl. VLOOKUP, HLOOKUP, XLOOKUP, INDEX, MATCH, IF, IFS, AND, OR, NOT, IFERROR, SUMIF(S), COUNTIF(S), AVERAGEIF(S), SUM, AVERAGE, COUNT, COUNTA, MIN, MAX, MEDIAN, STDEV, ROUND, PMT, NPV, FV, PV, text & date functions; multi-level sort + AutoFilter; conditional formatting (color scales, data bars); charts (bar, line, pie, doughnut, scatter) drawn on canvas/SVG; data validation dropdown lists; export CSV/PDF/HTML; open/save .xlsx, open .ods if feasible.
- **Impress**: layouts (Title, Title+Content, Two Content, Blank), a simple slide master (theme colours/fonts for the deck), shapes + arrows + connectors, slide transitions and basic entrance animations, **presenter view** (current + next slide, notes, timer); export PDF; open/save .pptx.
- **Math**: an equation editor for a LaTeX subset (fractions, roots, sub/superscripts, sums/integrals, matrices, Greek letters) rendered to SVG/MathML, insertable into Writer and Impress.

## Phase 2+ (design for it, don't build now unless time allows)
Track changes with accept/reject, footnotes/endnotes, cross-references, mail merge, frame styles, text wrap through/tight; pivot tables, icon sets, combination charts, 100+ functions; SmartArt-like diagrams, smart connectors for flowcharts, full slide master editing, exit animations; a Draw app for vector diagrams (org charts, network diagrams); full ODF (.odt/.ods/.odp) export.
