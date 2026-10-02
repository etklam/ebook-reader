# Design

**典藏 — archive edition.** The visual system of a well-made reference edition:
ruled lists, running heads, metadata on a tabular baseline, one bronze ink accent
against a true-white page. Crisp, not soft. No cards, no shadows as decoration.

Canonical implementation: `apps/web/src/styles/tokens.css` (tokens, reset, base),
`apps/web/src/styles/app.css` (shell, catalog, member, auth, admin),
`apps/web/src/styles/reader.css` (reader surface + three reading themes).

## Theme

Light-first shell with a true dark counterpart driven by `prefers-color-scheme`
— daylight catalog browsing and 1am reading are both real, and a reader who exits
the reader's dark theme into the catalog must not be flashbanged.

The reader keeps three **explicit** themes (`.theme-light`, `.theme-sepia`,
`.theme-dark`) because that is a reading preference the user sets, not a system
one. All three are retuned onto the same token vocabulary.

## Color

**Strategy: Restrained.** Tinted neutrals plus one accent, well under 10% of any
surface. The accent marks primary action, current selection and focus — never
decoration.

Brand hue is 77° (ochre/bronze). Surfaces are pure white / pure neutral black:
the warmth lives in the accent and the reader's 護眼 theme, never in the body
background.

### Light (shell + reader light)

| Role | OKLCH | Hex | Use |
|---|---|---|---|
| `--bg` | `oklch(1 0 0)` | `#ffffff` | page |
| `--surface` | `oklch(0.981 0.004 77)` | `#faf8f6` | chrome, sheets, panels |
| `--surface-2` | `oklch(0.962 0.006 77)` | `#f5f2ee` | inset, skeleton, table head |
| `--ink` | `oklch(0.225 0.014 77)` | `#1f1b14` | body, titles — 17.1:1 |
| `--ink-2` | `oklch(0.43 0.014 77)` | `#544f47` | secondary prose — 8.1:1 |
| `--ink-3` | `oklch(0.535 0.014 77)` | `#726c64` | metadata, placeholders — 5.2:1 |
| `--ink-faint` | `oklch(0.665 0.012 77)` | `#98938c` | icon-only / disabled — 3.1:1 |
| `--rule` | `oklch(0.905 0.006 77)` | `#e2dfdb` | hairline separators |
| `--rule-strong` | `oklch(0.835 0.008 77)` | `#ccc8c3` | input borders, section rules |
| `--brand` | `oklch(0.505 0.104 77)` | `#855b05` | action, selection, focus — 6.0:1 |
| `--brand-hover` | `oklch(0.44 0.088 77)` | `#6d4b09` | hover/active — 7.9:1 |
| `--brand-tint` | `oklch(0.965 0.025 77)` | `#fdf2e1` | selected background |
| `--on-brand` | `oklch(0.995 0.004 77)` | `#fffdfa` | text on brand fill — 5.9:1 |
| `--danger` | `oklch(0.505 0.165 25)` | `#af2f30` | errors, update marker — 6.4:1 |
| `--danger-tint` | `oklch(0.958 0.02 25)` | `#ffecea` | error background |
| `--ok` | `oklch(0.49 0.105 150)` | `#2c713f` | success — 6.0:1 |

### Dark shell

`--bg oklch(0.145 0 0)` · `--surface oklch(0.195 0 0)` ·
`--surface-2 oklch(0.245 0 0)` · `--ink oklch(0.925 0.008 77)` (15.9:1) ·
`--ink-2 oklch(0.78 0.01 77)` (9.9:1) · `--ink-3 oklch(0.655 0.012 77)` (6.2:1) ·
`--rule oklch(0.285 0.005 77)` · `--rule-strong oklch(0.38 0.006 77)` ·
`--brand oklch(0.785 0.115 77)` (9.9:1) · `--on-brand oklch(0.18 0.03 77)` ·
`--danger oklch(0.705 0.145 25)` · `--ok oklch(0.72 0.11 150)`.

Chroma on dark backgrounds is exactly 0 — no hue tint in the surface itself.

### Reader 護眼 (sepia)

`--bg oklch(0.945 0.027 86)` · `--fg oklch(0.285 0.022 62)` (12.3:1) ·
`--muted oklch(0.5 0.022 70)` (5.1:1) · `--accent oklch(0.47 0.098 64)` (6.0:1).
This is the one place a warm surface is correct: the user asked for it by name.

### Reader dark

`--bg oklch(0.155 0 0)` · `--fg oklch(0.878 0.009 77)` (13.5:1) ·
`--muted oklch(0.645 0.011 77)` (5.9:1) · `--accent oklch(0.79 0.115 77)` (10.0:1).

### Rules

- Every pair above is verified numerically (OKLCH → sRGB → WCAG), not by eye.
- Semantic states are standardised: `hover`, `focus-visible`, `active`,
  `disabled`, `selected`, `busy`, `error`. No component ships with a subset.
- No warning hue: 77° is the brand, so warnings read as brand-tinted surface
  plus a `⚠` glyph plus a word. Errors own the red.

## Typography

Two families on a contrast axis, both from the system — no webfont is a
prerequisite for opening a book (dev-plan §04).

- `--font-serif` — `"Noto Serif TC", "Source Han Serif TC", "Songti TC", …`.
  Reader body text **and** work titles. Titles belong to the works, so they are
  set in the same face as the text.
- `--font-ui` — `-apple-system, "PingFang TC", "Noto Sans TC", …`. Everything the
  system says: labels, metadata, buttons, counts, admin.

Fixed rem scale, ~1.2 ratio (product register: no fluid clamp headings):
`12 / 13 / 15 / 16 / 18 / 22 / 26 px`. 12px is the floor — CJK below that is not
legible. Form inputs are pinned to 16px so iOS Safari never zooms on focus.

- CJK display headings take **positive** tracking (`0.02em`): unlike Latin
  display, Han glyphs at size benefit from air. The Latin `-0.04em` floor is
  irrelevant here and is never applied to CJK.
- `font-variant-numeric: tabular-nums` on every count, date, page indicator and
  chapter number so columns align down a list.
- Reader prose: `text-align: justify` + `text-justify: inter-ideograph`, and
  `text-indent: 2em` — the two-full-width-character first-line indent is the
  Chinese prose convention and is the single strongest "this is a book" signal.
- `text-wrap: balance` on page titles; `text-wrap: pretty` on descriptions.
- Prose measure capped at 34em (≈68 CJK characters) in the reader, 72ch for Latin
  prose.

## Layout

- Phone-first single column; `--measure` widens on tablet/desktop rather than
  introducing columns.
- **Ruled rows, not cards.** The catalog, library, bookmarks and TOC are all one
  pattern: a full-bleed row with a 1px bottom `--rule`, the title on the text
  baseline with hanging indent for its metadata, and a right rail holding status
  and tabular counts. No border box, no radius, no shadow.
- Cards appear nowhere in the member surfaces. Admin uses `section` panels with a
  single hairline border — bordered regions, not cards, and never nested.
- Flexbox for rows, Grid only for the metadata key/value tables.
- Spacing scale `4 / 6 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 48`, used with varied
  rhythm — tight inside a row, generous between sections.
- Radii stay crisp: `2 / 4 / 6 / 10px`, pill only for chips and the note toast.
  Nothing on this site is rounded past 10px.
- Z-index is a named scale: `dropdown 10 → sticky 20 → backdrop 30 → sheet 40 →
  toast 50 → tooltip 60`. No arbitrary values.
- Fixed chrome always adds `env(safe-area-inset-*)`; the reader additionally pads
  its scroll surface by the chrome height so open chrome pushes text instead of
  covering it (acceptance READ-01).

## Components

- **Button** — three variants (`primary` filled brand, default outlined,
  `quiet` text-only), one shape, min 44px tall, `chip` modifier for 40px filter
  chips. All seven states implemented.
- **Chip** — filter/selection control. Selected = brand border + brand tint +
  leading `✓`. Never colour alone.
- **Row** (`.row`) — the ruled list primitive described above.
- **Bottom sheet** — the only modal pattern, max-height 78vh, backdrop above all
  chrome, Escape + backdrop dismiss, focus in on open and back to the opener on
  close, slide-up on `--ease-out-expo`.
- **Bottom nav** — fixed, labelled, 48px targets, `aria-current="page"`, update
  count as a numbered badge with an `aria-label` sentence.
- **Skeleton** — ruled-row-shaped placeholders that mirror the real row
  geometry, so content arrival causes no layout shift. Never a centred spinner.
- **Empty state** — states what the surface is for and offers the next action,
  never "nothing here".
- **Field** — label above control, 16px input, `--rule-strong` border, brand
  focus ring, error text tied by `aria-describedby`.
- **Metadata grid** (`.meta-grid`) — two-column key/value for work detail and
  admin summaries; keys in `--ink-3` UI font, values in `--ink` with tabular
  figures.

## Motion

- Durations `--dur-fast 120ms` / `--dur 180ms` / `--dur-slow 260ms`. Product
  register: users are in flow.
- Easing `--ease-out-quart cubic-bezier(0.25, 1, 0.5, 1)` and
  `--ease-out-expo cubic-bezier(0.16, 1, 0.3, 1)`. No bounce, no elastic.
- Motion conveys state only: chrome slide, sheet slide, backdrop fade, chip and
  row press, skeleton pulse, note toast. There is no page-load choreography and
  no scroll-reveal anywhere.
- Only `transform` and `opacity` animate. Reader content is never animated —
  position anchoring must stay measurable.
- `@media (prefers-reduced-motion: reduce)`: transforms become instant, fades
  shorten to 1ms, the skeleton pulse becomes a static tint. Feedback is kept; the
  movement is removed.
