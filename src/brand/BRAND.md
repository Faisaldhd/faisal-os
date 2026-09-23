# Fai$al · فيصل: brand notes

## The mark
The mark is a monoline "$". Its S is two stacked circles, and a vertical stroke runs through it. A rhombus dot sits on top: the calligrapher's *nuqta*, the same dot that sits on the ف in فيصل. It appears in three forms:

- `MARK_SVG`: navy squircle, gold glyph, hairline gold rim. For app and splash use, 16–512 px.
- `MARK_GLYPH_SVG` / `MARK_GLYPH_GOLD_SVG`: the glyph alone, for the top bar and small UI (16–24 px).
- `FAVICON_SVG`: heavier strokes that hold up at 16 px. It is inlined as a data: URI in `index.html`.

## Wordmarks
- `WORDMARK_LATIN_SVG`: "Fai$al". Geometric monoline, stroke 6.4, x-height 32, baseline 58. The "$" and the i-dot (a rhombus) are gold, and the letters are `currentColor`.
- `WORDMARK_ARABIC_SVG`: "فيصل". Square-Kufi-inspired, with the same stroke and x-height. The dots are gold rhombuses.
- Lockup (`brandLockup()` in `src/shell/splash.ts`): Latin | gold rule | Arabic. The order stays fixed (LTR) in both UI directions.

## Palette
| Token | Hex | Use |
|---|---|---|
| Midnight | `#0B1530` | deepest background, wallpaper base |
| Ink | `#0E1A3A` | text on gold, splash |
| Navy | `#16264F` | mark tile, icon glyphs |
| Royal | `#22386F` | gradients, highlights |
| Gold | `#E3B650` | dark-theme accent (text `#0E1A3A`, 9.0:1) |
| Gold light | `#F0CF7A` | dark-theme accent-2, sheen |
| Gold deep | `#B8862B` | logo gold on light surfaces |
| Antique | `#8F6412` | light-theme accent (text `#FFFFFF`, 5.25:1) |
| Ivory | `#F7F1E3` | light splash, text on navy |

The brand accent (`faisal`, the default and first preset) switches with the theme through
`--faisal-brand-accent{,-2,-fg}`. Both themes meet WCAG AA for button text.

## Usage
- **Clear space:** keep at least ¼ of the mark's width clear on every side. For wordmarks, keep one x-height clear.
- **Minimum size:** 16 px for the mark, 14 px cap height for the wordmarks.
- Gold marks the *details* (the "$" and the dots). Do not fill whole letters or large areas with gold.
- Do not recolor the glyph outside the palette, add effects to it, or set "Fai$al" in a system font inside the logo.
- App icons (`icons.ts`) follow one grammar: a 56 px squircle (rx 14) on a 64 px canvas, a top sheen, a hairline rim and one palette glyph.
