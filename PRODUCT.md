# Product

## Register

product

## Users

Traditional-Chinese novel readers on phones (360–430px is the priority viewport,
390×844 is the acceptance viewport). Two real contexts, both of which the design
has to serve:

- **Deep reading.** In bed near midnight, screen brightness low, one thumb,
  resuming chapter 847 of a serial they have followed for eight months. They want
  the interface to vanish. The only things that matter are the text, where they
  left off, and getting to the next chapter without thinking.
- **Browsing.** On a commute in daylight, scanning the catalog for something new
  or checking which followed serials gained chapters. They are comparing works by
  type, status, chapter count, category and tag — this is a scanning task, not a
  browsing-for-pleasure task, and dense legible rows beat decorated cards.

A second, much smaller user: the single administrator who imports TXT/EPUB files,
reviews chapter segmentation, applies incremental updates, and publishes
immutable release snapshots. Same person, completely different mode — reviewing
machine output and deciding whether to trust it.

## Product Purpose

An admin-curated Traditional-Chinese novel reading site. Content is imported,
segmented and versioned by one editor; readers consume published release
snapshots. Membership is invite-only during beta.

Success is a reader finishing a chapter without noticing the interface, coming
back the next night, and landing exactly where they stopped — including on a
different device. Everything else (catalog, filters, library, bookmarks) exists
to get them into the text and back out again.

The engineering substrate is unusually rigorous about this: chapters have
immutable revisions, publication is an explicit snapshot separate from editing,
reading positions are anchored to `chapter_id + revision_id + paragraph_index`
rather than page numbers, and chapter labels are preserved verbatim however
irregular. The product is a **curated archive**, not a content feed — and the
interface should say so.

## Brand Personality

**Archival, exact, quiet.**

Voice: a well-made reference edition. States facts, counts things, never sells.
Chapter counts, release versions, publication dates and serial status are the
copy — there is nothing to hype because there is one curator and a finite shelf.

Emotional goal: trust and calm. The reader should believe the text is correct and
their place is safe. No urgency, no gamification, no engagement bait.

## Anti-references

- **Default-framework styling.** The pre-redesign state: Tailwind's stock palette
  (`#2563eb`, `#6b7280`, `#e5e7eb`, `#d1d5db`), uniform 8–10px rounded card
  grids, system sans at one weight for everything, no tokens, no interaction
  states. The user's words for the result: "too AI". This is the thing being
  fixed; do not regress to it.
- **Commercial web-novel portals** (起點/番茄-style): red-orange saturation,
  ranking badges, VIP chrome, carousels, "hot" counters, density as noise.
- **Cream/sand/parchment "digital paper".** The warm near-white body background
  is the saturated generated-design default. Warm paper tone belongs to exactly
  one place here: the reader's user-selected 護眼 theme, where the user asked
  for it.
- **Decorated card grids.** Equal-sized cards with icon + title + two lines of
  text, soft wide drop shadows paired with 1px borders, gradient accents.

## Design Principles

1. **The text is the product; chrome is a guest.** Every reader surface earns its
   pixels or hides. Chrome appears on demand, never overlaps text, and leaves no
   residue when dismissed.
2. **Catalog as index, not storefront.** Ruled rows, hanging indent, aligned
   metadata, tabular figures. A reader scanning 40 works should be able to
   compare chapter counts down a column.
3. **Say the state, don't just colour it.** Selection, update and status carry a
   glyph or word as well as a colour — required by spec §21, and it also makes
   the interface readable in every reader theme and for colour-blind users.
4. **Mobile reach is structural.** Primary actions live in the bottom third
   (dev-plan §04). Desktop widens the measure; it never dictates the phone
   layout.
5. **Position is sacred.** Any visual change that affects layout must preserve
   the anchored paragraph. Typography is a correctness concern here, not taste.

## Accessibility & Inclusion

- WCAG 2.2 AA as the floor: body text ≥4.5:1, large text and non-text indicators
  ≥3:1, verified numerically per token pair rather than by eye — in all five
  colour contexts (light shell, dark shell, reader light, reader 護眼, reader
  dark).
- Touch targets ≥44×44 CSS px (dev-plan §09.4). Safe-area insets honoured on
  all fixed chrome.
- State never by colour alone (dev-plan §21): ✓ / ★ / word labels accompany
  every selected, followed and updated state.
- `prefers-reduced-motion: reduce` has a real alternative for every transition,
  not a removal of feedback.
- Full keyboard path: visible `:focus-visible` rings, Escape closes sheets, focus
  returns to the opener.
- The shell follows `prefers-color-scheme`; the reader keeps its three explicit
  themes because theme choice there is a reading preference, not a system one.
