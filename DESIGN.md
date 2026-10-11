---
name: 典藏
description: An admin-curated Traditional-Chinese novel archive, set like a well-made reference edition.
colors:
  bg: "oklch(1 0 0)"
  surface: "oklch(0.981 0.004 77)"
  surface-2: "oklch(0.962 0.006 77)"
  chrome: "oklch(0.981 0.004 77)"
  ink: "oklch(0.225 0.014 77)"
  ink-2: "oklch(0.43 0.014 77)"
  ink-3: "oklch(0.535 0.014 77)"
  ink-faint: "oklch(0.665 0.012 77)"
  rule: "oklch(0.905 0.006 77)"
  rule-strong: "oklch(0.835 0.008 77)"
  brand: "oklch(0.505 0.104 77)"
  brand-hover: "oklch(0.44 0.088 77)"
  brand-tint: "oklch(0.965 0.025 77)"
  on-brand: "oklch(0.995 0.004 77)"
  danger: "oklch(0.505 0.165 25)"
  danger-tint: "oklch(0.958 0.02 25)"
  ok: "oklch(0.49 0.105 150)"
  dark-bg: "oklch(0.145 0 0)"
  dark-surface: "oklch(0.195 0 0)"
  dark-ink: "oklch(0.925 0.008 77)"
  dark-brand: "oklch(0.785 0.115 77)"
  sepia-bg: "oklch(0.945 0.027 86)"
  sepia-ink: "oklch(0.285 0.022 62)"
  sepia-brand: "oklch(0.47 0.098 64)"
  reader-dark-bg: "oklch(0.155 0 0)"
  reader-dark-ink: "oklch(0.878 0.009 77)"
typography:
  display:
    fontFamily: '"Noto Serif TC", "Source Han Serif TC", "Songti TC", serif'
    fontSize: "1.625rem"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "0.02em"
  headline:
    fontFamily: '"Noto Serif TC", "Source Han Serif TC", "Songti TC", serif'
    fontSize: "1.375rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "0.02em"
  title:
    fontFamily: '"Noto Serif TC", "Source Han Serif TC", "Songti TC", serif'
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "0.02em"
  prose:
    fontFamily: '"Noto Serif TC", "Source Han Serif TC", "Songti TC", serif'
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: 1.9
    letterSpacing: "normal"
  body:
    fontFamily: '-apple-system, "PingFang TC", "Noto Sans TC", sans-serif'
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "normal"
  form:
    fontFamily: '-apple-system, "PingFang TC", "Noto Sans TC", sans-serif'
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
  label:
    fontFamily: '-apple-system, "PingFang TC", "Noto Sans TC", sans-serif'
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0.04em"
    fontFeature: "tabular-nums"
  mono:
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace'
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
rounded:
  xs: "2px"
  sm: "4px"
  md: "6px"
  lg: "10px"
  pill: "999px"
spacing:
  sp-1: "4px"
  sp-2: "6px"
  sp-3: "8px"
  sp-4: "12px"
  sp-5: "16px"
  sp-6: "20px"
  sp-7: "24px"
  sp-8: "32px"
  sp-9: "40px"
  sp-10: "48px"
  tap: "44px"
components:
  button-primary:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.on-brand}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "6px 12px"
    height: "44px"
  button-primary-hover:
    backgroundColor: "{colors.brand-hover}"
    textColor: "{colors.on-brand}"
  button-default:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "6px 12px"
    height: "44px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    height: "44px"
  chip:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink-2}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    padding: "6px 12px"
    height: "40px"
  chip-selected:
    backgroundColor: "{colors.brand-tint}"
    textColor: "{colors.brand}"
    rounded: "{rounded.pill}"
  input:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink}"
    typography: "{typography.form}"
    rounded: "{rounded.sm}"
    padding: "10px 12px"
    height: "44px"
  row:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.title}"
    rounded: "0"
    padding: "12px 0"
  nav-item:
    backgroundColor: "{colors.chrome}"
    textColor: "{colors.ink-3}"
    typography: "{typography.label}"
    rounded: "0"
    height: "56px"
  nav-badge:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.bg}"
    rounded: "{rounded.pill}"
    padding: "0 4px"
    height: "16px"
  sheet:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "0 16px 16px"
  toast:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    padding: "4px 4px 4px 16px"
---

# Design System: 典藏

Canonical implementation: `apps/web/src/styles/tokens.css` (tokens, reset, base),
`apps/web/src/styles/app.css` (shell, catalog, member, auth, admin),
`apps/web/src/styles/reader.css` (reader surface + three reading themes).
The frontmatter above is normative; this prose says where each token goes and why.

## 1. Overview

**Creative North Star: "The Reference Edition"**

This is the visual system of a well-made reference edition — the kind of book
whose typography you never notice and whose index you trust on sight. Ruled
lists, running heads, metadata on a tabular baseline, one bronze ink accent
against a true-white page. Crisp, not soft. The register is *archival, exact,
quiet*: the interface states facts and counts things, and has nothing to sell,
because there is one curator and a finite shelf.

Two surfaces, one vocabulary. The **catalog** is an index to be scanned in
daylight on a commute — dense ruled rows, aligned counts, comparisons down a
column. The **reader** is a book at 1am — chrome that appears on demand and
leaves no residue, and a page whose only job is to be legible and to stay
exactly where it was left. Every shared primitive (`.btn`, `.chip`, `.sheet`,
`.setting-row`) is written once against the token vocabulary and re-pointed by
theme, so the reader's 護眼 page and the admin's import table are the same
system under different light.

What this system rejects is as load-bearing as what it is. No cards. No shadows
as decoration. No rounded-corner grid of equal tiles. No gradient, no glass, no
hero metric. Density is a feature here, and familiarity is the point: a reader
should be able to use this on the first night without learning anything.

**Key Characteristics:**

- **Phone-first.** 360–430px is the priority viewport, 390×844 is the acceptance
  viewport. Desktop widens the measure (`--measure` 720px → 820px at ≥768px); it
  never dictates the phone layout and never introduces columns.
- **Ruled rows, not cards.** Catalog, library, bookmarks, TOC and the work page's
  latest-chapters list are one primitive: a full-bleed row with a 1px bottom
  rule, a hanging indent for the apparatus, a right rail of tabular counts.
- **One accent, under 10%.** Bronze marks primary action, current selection and
  focus. Nothing else is coloured.
- **Spacing with rhythm, not uniformity.** The 4→48px scale is used tight inside
  a row and generous between sections; equal gaps everywhere is the tell of a
  system nobody tuned.
- **Motion is state.** 120/180/260ms, ease-out only, `transform` and `opacity`
  only. No page-load choreography, no scroll reveal. Reader *content* is never
  animated — position anchoring has to stay measurable.
- **WCAG 2.2 AA is a floor, verified numerically** in all five colour contexts,
  with 44×44px targets and a complete keyboard path.

**The Chrome Is a Guest Rule.** Every reader surface earns its pixels or hides.
Open chrome pushes text instead of covering it; dismissed chrome leaves nothing
behind — no bar, no inset, no residue.

**The Spoken State Rule.** Selection, status and updates carry a glyph or a word
as well as a colour: `✓` on a selected chip, `▌` before 有更新, 閱讀中 on the
current TOC row. Colour alone is prohibited — it fails for colour-blind readers
and it fails again in the reader's three themes.

## 2. Colors: The Bronze-On-White Palette

**Strategy: Restrained.** Tinted neutrals plus a single accent. The brand hue is
77° (ochre/bronze); surfaces are pure white or pure neutral black. The warmth
lives in the accent and in one opt-in reading theme, never in the body
background. Values are canonical in OKLCH (frontmatter); the hex beside each
name below is its sRGB rendering, and every ratio was computed OKLCH → sRGB →
WCAG rather than eyeballed.

### Primary

- **Bronze Ink** (`brand`, `#855b05`, 6.0:1 on white): primary action, current
  selection, focus ring, the chapter-position hairline, `aria-current` in the
  bottom nav. Never a fill for anything decorative.
- **Deep Bronze** (`brand-hover`, `#6d4b09`, 7.9:1): hover and active for every
  brand-filled control. The only "darker on hover" relationship in the system.
- **Bronze Wash** (`brand-tint`, `#fdf2e1`): the background of a selected chip
  and of `::selection`. A tint, not a fill — it never carries body text alone.
- **Ink On Bronze** (`on-brand`, `#fffdfa`, 5.9:1 on brand): the only text colour
  permitted on a brand fill.

### Secondary

- **Red Correction** (`danger`, `#af2f30`, 6.4:1): errors, invalid fields, and
  the 有更新 marker — the one place a non-error uses red, because an update is
  the single thing in this product that is genuinely urgent to a follower.
- **Red Wash** (`danger-tint`, `#ffecea`): error backgrounds only.
- **Field Green** (`ok`, `#2c713f`, 6.0:1): success confirmations in admin.

### Neutral

- **Page** (`bg`, `#ffffff`): the page. Pure white, no warm tint.
- **Chrome** (`surface` / `chrome`, `#faf8f6`): bars, sheets, panels, toasts.
  Opaque on purpose — a translucent bar over body text breaks the verified
  ratios, and blur-as-decoration is not this system.
- **Inset** (`surface-2`, `#f5f2ee`): skeletons, table heads, the page-turn pill,
  pressed states.
- **Text Black** (`ink`, `#1f1b14`, 17.1:1): body, titles, values.
- **Secondary Prose** (`ink-2`, `#544f47`, 8.1:1): descriptions, author lines,
  the quiet button.
- **Metadata** (`ink-3`, `#726c64`, 5.2:1): counts, dates, keys, placeholders.
  This is the floor for text — nothing lighter carries a word.
- **Disabled** (`ink-faint`, `#98938c`, 3.1:1): icon-only and disabled states
  exclusively. Never a text colour.
- **Hairline** (`rule`, `#e2dfdb`) and **Rule** (`rule-strong`, `#ccc8c3`): row
  separators, and input/section borders respectively. These two carry all the
  structure the system has.

### The three reader themes

The shell follows `prefers-color-scheme`. The reader keeps three **explicit**
themes, because reading light is a preference the reader sets, not a system
setting — and because someone who leaves a dark reader must not be flashbanged
by a white catalog. Each theme re-points the *same* token names, so no component
has a per-theme rule.

- **亮色** — identical to the shell's light values.
- **護眼** (`sepia-*`): background `oklch(0.945 0.027 86)`, ink 12.3:1, muted
  5.1:1, accent 6.0:1. The one place a warm paper surface is correct: the reader
  asked for it by name.
- **深色** (`reader-dark-*`): background `oklch(0.155 0 0)`, ink 13.5:1, muted
  5.9:1, accent 10.0:1.

Dark shell: `dark-bg` / `dark-surface` / `dark-ink` (15.9:1), secondary 9.9:1,
metadata 6.2:1, accent 9.9:1.

**The One Accent Rule.** Bronze appears on under 10% of any screen and only
where it means *action, selection, or focus*. If a surface needs a second
colour to be legible, the hierarchy is wrong, not the palette.

**The Zero-Chroma Dark Rule.** Dark surfaces carry chroma exactly 0. The hue
lives in the accent; a tinted dark grey is how a product starts looking like a
theme instead of a page.

**The No-Warning-Hue Rule.** 77° is the brand, so there is no amber warning.
Warnings are a brand-tinted surface plus a `⚠` glyph plus a word. Red is
reserved for errors and the update marker.

**The Verified Pair Rule.** Every foreground/background pair in use is checked
numerically in all five contexts (light shell, dark shell, reader light, 護眼,
reader dark). A pair that has not been checked is not in the system.

## 3. Typography

**Display font:** Noto Serif TC → Source Han Serif TC → Songti TC → SimSun →
LiSong Pro → serif.
**Body/UI font:** -apple-system → BlinkMacSystemFont → Segoe UI → PingFang TC →
Noto Sans TC → Microsoft JhengHei → Hiragino Sans TC → sans-serif.
**Mono:** ui-monospace → SFMono-Regular → Menlo, for error codes and IDs only.

**Character:** two families on a contrast axis, both from the system — opening a
book never waits on a webfont download. The serif is the *work's* voice: reader
prose and every work or chapter title, because a title belongs to the text it
names. The sans is the *system's* voice: labels, metadata, counts, buttons,
admin. Nothing else is permitted to speak.

### Hierarchy

Fixed rem scale at roughly a 1.2 ratio — `12 / 13 / 15 / 16 / 18 / 22 / 26px`.
No fluid clamp headings: this is product UI viewed at a consistent DPI.

- **Display** (serif, 600, 26px, 1.35, +0.02em): the work title on the detail
  page. One per page, never anywhere else.
- **Headline** (serif, 600, 22px, +0.02em, `text-wrap: balance`): page titles —
  書庫, 我的書庫, 我的書籤.
- **Title** (serif, 600, 18px, 1.4, +0.02em): the row title in every ruled list,
  empty-state and panel headings. 16px in a sheet header.
- **Prose** (serif, 400, 18px default, line-height 1.9): reader body text. The
  reader may set 14–28px, line-height 1.6/1.9/2.2 and paragraph spacing
  0.4/0.9/1.4em; every combination is a layout change that re-anchors the
  paragraph.
- **Body** (sans, 400, 15px, 1.6): descriptions, secondary prose, button labels.
- **Form** (sans, 400, 16px): every input, pinned — iOS Safari zooms on focus
  below 16px and the zoom never comes back cleanly.
- **Label** (sans, 12–13px, +0.04em on table heads, tabular figures): metadata,
  counts, dates, status, nav labels. 12px is the floor; CJK below that is not
  legible.

**The Positive Tracking Rule.** CJK display headings take **positive** tracking
(+0.02em). Han glyphs at size want air. The Latin display convention of tight
tracking — and the −0.04em floor that guards it — is irrelevant here and is
never applied to Chinese text.

**The Two-Character Indent Rule.** Reader paragraphs are set `text-indent: 2em`
with `text-align: justify` and `text-justify: inter-ideograph`. The
two-full-width-character first-line indent is the Chinese prose convention and
is the single strongest signal that this is a book and not a web page. Measure
is capped at 34em (≈68 CJK characters).

**The Tabular Column Rule.** Every count, date, page indicator, chapter number
and admin figure sets `font-variant-numeric: tabular-nums`, so a reader scanning
forty works compares chapter counts straight down a column. `text-wrap: balance`
on page titles, `text-wrap: pretty` on descriptions.

## 4. Elevation

**This system is flat and has no shadow vocabulary.** There is not a single
drop shadow in the codebase, and adding one is a regression. Depth is carried
by three devices instead: a tonal step (`bg` → `surface` → `surface-2`), a
hairline (`rule` for separation, `rule-strong` for containment), and — for the
one true modal — a scrim.

- **Flat (default).** Rows, panels, tables, the catalog, the reader page. A
  surface at rest is a surface: no border box, no radius, no lift.
- **Tonal (chrome).** Bars, sheets, panels and toasts sit on `surface`, one
  step off the page, with a hairline on the edge that faces content.
- **Scrim (modal).** The bottom sheet is the only element that leaves the plane:
  a `backdrop` wash (42% ink in light, 62% black in dark) above all chrome, with
  the sheet above that.

The only `box-shadow` in the system is `inset 0 0 0 1px` on a focused input —
a ring, not a shadow; it thickens the border without moving layout.

### Depth order

Named z-index scale, no arbitrary values anywhere:
`dropdown 10 → sticky 20 → backdrop 30 → sheet 40 → toast 50 → tooltip 60`.

**The Flat-By-Default Rule.** If an element needs a shadow to read as separate,
it needs a rule, a tonal step, or more space — in that order. A shadow is never
the answer. Audit test: if it looks like a card could be dragged, it is wrong.

**The No-Ghost-Card Rule.** A 1px border and a soft wide drop shadow on the same
element is forbidden outright. Pick the border. Round corners stay at 2/4/6/10px
and pill; nothing in this product is rounded past 10px.

## 5. Components

### Buttons

- **Shape:** gently squared (4px radius), minimum 44px tall, 6px/12px padding,
  15px sans label, never uppercase.
- **Primary:** bronze fill, `on-brand` label, 600 weight. One per surface; on
  phones it lives in the bottom third where the thumb is.
- **Default:** page background, `rule-strong` border, ink label.
- **Quiet:** no border, no background, `ink-2` label — the third choice in a
  group, present without competing.
- **States:** all seven are implemented on every variant — default, hover
  (`surface-2` wash or `brand-hover` fill), focus-visible (2px bronze outline,
  2px offset), active (5% ink press), disabled (`ink-faint`, `not-allowed`),
  busy (`aria-busy`, `cursor: progress`), error. A variant shipping a subset is
  a bug.

### Chips

- **Style:** pill (999px), 40px tall (44px inside a row's action cluster),
  `rule-strong` border, `ink-2` label on page background.
- **Selected:** bronze border + bronze wash + bronze label at 600 **and a
  leading `✓` in the text**. Hover on a selected chip keeps all four — the
  common CSS slip is letting `:hover` out-specify the selected state.
- **Variants:** filter chip (catalog sheet, reader settings), action chip
  (`primary` fill, for 繼續閱讀), and the applied-condition chip — a 32px
  removable summary token with a `×` that turns red on hover.

### Rows and lists

The signature primitive. `.row` is a CSS grid: `minmax(0,1fr) auto`, 12px
column gap, 12px vertical padding (16px on desktop), 1px bottom `rule`.

- **Main column:** serif title on the left edge; beneath it a hanging indent
  (1.1em) holding author, 2-line clamped description, categories, tags.
- **Right rail:** status word, chapter count, relative date — right-aligned,
  tabular, `ink-3`, 12px.
- **Interactive rows** (`button.row`) take a `surface-2` hover, a press wash,
  and an inset focus ring. No border box, no radius, no shadow, ever.
- **Status:** 連載中 is bronze at 600; everything else is plain `ink-3`. 有更新
  is `danger` at 600 with a leading `▌` and the new-chapter count in words.

### Inputs and fields

- **Style:** label above control, 16px text, `rule-strong` 1px border, 4px
  radius, full width, 44px minimum height.
- **Focus:** border goes bronze plus the inset 1px ring; the default outline is
  suppressed only because something stronger replaces it.
- **Error:** `aria-invalid`, `danger` border, and a message tied by
  `aria-describedby`. **Disabled:** `surface-2` fill, `ink-3` text.
- **Native controls stay native.** `select` keeps its own arrow so it follows
  `color-scheme` for free; reinventing a form control for flavour is banned.

### Navigation

- **Bottom nav:** fixed, labelled, two or three items, 56px tall, `chrome`
  background with a top hairline, safe-area padded. The current item is bronze
  at 600 with `aria-current="page"` and a 20×2px bronze tick above the icon.
  The update badge is a `danger` pill carrying the count, with an `aria-label`
  that reads as a sentence ("追更中有 3 本更新") rather than a bare number.
- **Segmented control:** text tabs on a hairline, 2px bronze underline on the
  selected tab, `role="tablist"`. Used for catalog type and admin sections.
- **Subnav:** a row of underlined text links at 13px; the one action that leaves
  (登出) is pushed to the opposite end.

### Bottom sheet

The only modal pattern in the product. Max-height 78vh, 10px top corners,
`surface` background, grip, title, close button; the body scrolls with
`overscroll-behavior: contain`; it slides up on `--ease-out-expo` over a faded
backdrop. Focus moves in on open and returns to the opener on close, Tab cycles
inside it (`aria-modal` must be true in behaviour, not just in the attribute),
and Escape closes **exactly one layer** — the sheet stops the event so the
reader's chrome stays up behind it. On ≥768px it becomes a centred 560px panel.

### Toast

A pill above the bottom nav confirming an action that already happened, with its
undo: `surface` fill, `rule-strong` border, 44px targets, `role="status"`,
self-dismissing at 6s, manually closable. This is the system's answer to "are
you sure?" — removing a work from the shelf is one tap and then 復原, never a
confirmation dialog.

### Skeletons and empty states

- **Skeleton:** placeholders shaped like the content they stand in for, so
  arrival shifts nothing. Four shapes only — ruled rows, single lines (TOC and
  admin lists), the colophon, and the chapter (prose-measure lines in the
  reader's own theme). A centred spinner is never correct here.
- **Empty state:** states what the surface is *for* and offers the next action.
  "沒有資料" is banned copy. A failed fetch and an empty collection get different
  titles, different bodies, and different buttons — telling a member with twelve
  saved books that they have none is a lie, not a loading state.

### Metadata grid

Two-column `max-content / 1fr` definition list with hairlines and **zero column
gap** — a gap would break the rule into dashes. Keys in `ink-3` sans, values in
`ink` with tabular figures. Used for the work colophon and admin summaries.

### The reader surface (signature)

A fixed, full-viewport plane with three bands:

- **Running head** (56px): chapter label in serif over work title in 12px,
  translated off-screen until summoned, with a 2px bronze hairline along its
  bottom edge whose width *is* the position in the chapter.
- **The page:** scroll mode scrolls a container (never the window); paginated
  mode is a horizontal multi-column strip translated by exactly one column
  pitch per page. Content padding grows by the chrome height when chrome is
  open, so text is pushed, never covered.
- **Toolbar** (112px, 152px paginated): three stacked bands that never collapse
  into each other — page turns, chapter turns + position, then the five tools
  (返回｜目錄｜書籤｜繁簡｜設定) as 52px labelled icon buttons.

**The Page Step Rule.** The paginated strip carries **no horizontal padding** —
the side inset belongs to the paragraphs. A padded multi-column box is narrower
than the viewport it is paged across, and the step would no longer equal the
column pitch: every turn drifts by the difference and clips text at the seam.
`column width + gap === viewport width + gap === one page step`, covered by an
acceptance test.

**The Unambiguous Input Rule.** The reader takes the same movement from every
device and a gesture is never ambiguous with a selection. Tap: outer quarters
turn the page, middle toggles chrome, suppressed over a selection or a control.
Swipe: horizontal flick, **touch pointers only** (a mouse drag is a selection
gesture and can never turn a page), 44px of travel inside 700ms. Keyboard:
`←`/`→` turn page or chapter, `Space`/`PageUp`/`PageDown` move a screenful,
`Home`/`End` reach the ends, `Esc` dismisses chrome — bindings are listed in the
settings sheet wherever `any-pointer: fine` implies a keyboard.

**The Sacred Position Rule.** Any visual change that affects layout must
preserve the anchored paragraph: typography is a correctness concern here, not
taste. The anchor is captured *before* a layout-changing setting applies and
re-applied two frames later. And nothing undoes the reader's own movement — if
they scrolled or turned a page while a restore was still pending, the queued
anchor is dropped rather than applied on top of them.

## 6. Do's and Don'ts

### Do:

- **Do** reach for the ruled row first. Catalog, library, bookmarks, TOC and
  latest-chapters are all `.row` or `.toc-item`; a new list is one of them.
- **Do** put the primary action in the bottom third on phones, and let desktop
  release it into the flow (`.detail-cta` goes static at ≥768px).
- **Do** state the number. 共 128 部, 180 章, 第 48 段, 版本 v1 — this product
  counts things, and a count is better copy than an adjective.
- **Do** pair every colour signal with a glyph or a word: `✓` selected, `▌`
  有更新, `⚠` warning, 閱讀中 current.
- **Do** keep all seven interaction states on every control, and keep the
  focus-visible ring (2px bronze, 2px offset) exactly as it is everywhere.
- **Do** give failure its own copy and its own retry, separate from emptiness.
- **Do** honour `env(safe-area-inset-*)` on every fixed element, and keep touch
  targets at 44×44px (40px is permitted only for an inline filter chip).
- **Do** verify a new colour pair numerically in all five contexts before using
  it, and add it to the frontmatter rather than inlining a value.
- **Do** keep motion at 120/180/260ms on ease-out curves, and give
  `prefers-reduced-motion: reduce` a real alternative — feedback stays, movement
  goes — never a removal of the feedback itself.

### Don't:

- **Don't** regress to **default-framework styling**: Tailwind's stock palette
  (`#2563eb`, `#6b7280`, `#e5e7eb`, `#d1d5db`), uniform 8–10px rounded card
  grids, system sans at one weight for everything, no tokens, no interaction
  states. That is the pre-redesign state the user called *"too AI"*; it is the
  thing being fixed.
- **Don't** borrow from **commercial web-novel portals** (起點/番茄-style):
  red-orange saturation, ranking badges, VIP chrome, carousels, "hot" counters,
  density as noise.
- **Don't** introduce a **cream/sand/parchment "digital paper"** body
  background. The warm near-white is the saturated generated-design default.
  Warm paper belongs to exactly one place here — the reader's 護眼 theme, where
  the reader asked for it by name.
- **Don't** build **decorated card grids**: equal-sized cards with icon + title
  + two lines of text, soft wide drop shadows paired with 1px borders, gradient
  accents. There are no cards in the member surfaces at all.
- **Don't** add a drop shadow. There are none; depth is tonal steps, hairlines
  and one scrim.
- **Don't** use a colour-only state, a bare number as an accessible name, or
  `opacity: 0` to hide something from assistive technology.
- **Don't** put text on `ink-faint` (3.1:1) or any lighter neutral, and don't
  let a muted grey carry body copy on a tinted surface.
- **Don't** animate reader content, ever — position anchoring must stay
  measurable — and don't animate layout properties anywhere else.
- **Don't** reach for a modal. The bottom sheet is the only one, and a
  confirmation dialog is never the answer where an undo toast will do.
- **Don't** reinvent a native form control, add a custom scrollbar, or round a
  card past 10px.
- **Don't** write an arbitrary z-index. The six-step named scale is the whole
  vocabulary.
- **Don't** hard-code a spacing, radius or colour value in a component. If it
  isn't in the frontmatter, it isn't in the system yet.
