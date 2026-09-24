# Creative Director's bar (non-negotiable; work that misses it is sent back)

## One suite, one visual system (identical values in all four apps, at the app root)
--app-bg: #0d1220 (canvas behind panels) · --app-glass: rgba(22,30,50,.62) · --app-glass-strong: rgba(18,24,40,.82)
--app-hairline: rgba(255,255,255,.08) · --app-hairline-strong: rgba(255,255,255,.14)
--app-copper: #C8894B · --app-copper-2: #E0A96D (hover/active glow) · --app-blue: #5B8DEF (primary buttons, selection) · --app-blue-soft: rgba(91,141,239,.16)
--app-text: #E8ECF4 · --app-text-2: #A7B0C2 · --app-text-3: #6E7890
--app-danger: #E5484D · --app-ok: #3DD68C
Glass = background var(--app-glass) + backdrop-filter: blur(18px) saturate(140%) + 1px var(--app-hairline) border + shadow 0 8px 32px rgba(0,0,0,.35). Opaque fallback under @supports not (backdrop-filter).
Light theme: same structure, surfaces rgba(255,255,255,.72), text #1a1d26; copper and blue unchanged.

## Grid, type, shape
- 4px spacing scale only (4, 8, 12, 16, 24, 32). No random 7px/13px.
- Type: UI 13px/1.4 (desktop), 15px (phone); panel titles 11px uppercase-ish (Latin) / 12px bold (Arabic) in --app-text-2, letter-spacing .04em for Latin; numbers tabular.
- Radius: 6 (controls), 10 (panels, popovers), 14 (dialogs, start-screen cards). Nothing else.
- Icons: one set, 20px on a 24 grid, 1.75px stroke, rounded caps/joins, currentColor. No emoji, no mixed filled/outline styles.

## Components (same look everywhere)
- Buttons: 32px tall desktop / 44px phone; primary = --app-blue fill; secondary = glass + hairline; icon-only buttons always have aria-label + tooltip (title).
- Active tool/tab: copper underline (2px) or copper-tinted pill; hover = --app-blue-soft. Focus ring 2px --app-copper-2, offset 2px, always visible on keyboard focus.
- Panels: header row (title + collapse chevron), 12px padding, sections separated by hairlines, never boxes-in-boxes.
- Sliders: custom track (hairline) + filled part (--app-blue) + 14px thumb with value label.
- Popovers/menus: glass-strong, 10px radius, arrow optional, close on Esc and outside click.
- Status bar: 28px, text-3, right side zoom control.
- Start screen: large app title + 3–6 big cards (icon, title, one-line hint) + "Recent" list; beautiful empty states (illustration drawn in SVG + one sentence + one action). Never a blank grey area.

## Motion
- 140ms for hover/press, 220ms for panels/popovers, easing cubic-bezier(.2,0,0,1). No bounce. Respect prefers-reduced-motion.

## Mobile (≤ 700px window width)
- Top: compact app bar (back/menu, title, 1–2 primary actions). Tools in a bottom bar (≤5 visible + "more"). Panels = bottom sheets with a grab handle, 60–90% height, swipe/tap to close.
- Every touch target ≥ 44px, no horizontal page scroll, no text under 13px.

## Quality gates I will check myself (screenshots at 1280×800, 1440×900, 390×844, 320×640; light + dark)
1. Alignment: every edge lines up on the 4px grid; no text clipped or ellipsised where there is room.
2. Hierarchy: the canvas/document is the hero; chrome is quiet (text-2/text-3), accents used sparingly (copper = active, blue = primary action).
3. Consistency across the four apps: same header height, same panel headers, same buttons, same icon set.
4. RTL: layout mirrors correctly in Arabic (panels, chevrons, sliders), numbers and timelines stay LTR where they must.
5. Polish: loading states (skeletons/spinners), disabled states, errors in plain words with a next step, no "undefined"/NaN/raw keys, no layout jump on load.
Anything that looks like a developer's prototype instead of a product is rejected.
