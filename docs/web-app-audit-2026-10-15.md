# Web app technical audit — 2026-10-15

Scope: catalog, rankings, work detail, reader, member pages and administration.
Evidence: current source at `aaf14bc` and one Impeccable detector pass over
`apps/web/src`. No browser/device inspection, numerical contrast verification,
performance measurement or new test runs were performed. Scores are provisional
implementation assessments, not WCAG certification.

## Implementation integrity

Pass at source level: shared tokens, ruled catalog rows, consistent native
controls, textual state indicators and one bottom-sheet pattern express the
archive's existing design. Detector output contained five advisory typography
findings, not five confirmed defects. Status dots/warning glyphs and the chip's
close glyph are symbols; their small sizes do not establish unreadable text.
The calendar weekday gutter's 10px text deserves visual inspection before a
typography change is recommended.

| Dimension | Provisional score | Evidence or remaining gap |
| --- | --- | --- |
| Accessibility | 3/4 | Sheet keyboard handling and labels; screen-reader and contrast checks pending |
| Performance | 2/4 | All route components eagerly imported; conversion library loads dynamically |
| Responsive design | 3/4 | Mobile/desktop rules present; some controls below the project's 44px target |
| Theming | 3/4 | Semantic tokens used throughout sampled surfaces; actual theme contrast pending |
| Implementation integrity | 3/4 | Coherent existing system; advisory font-ramp deviations need contextual review |
| Total | 14/20 | Good, provisional |

## Findings

### [P2] Filter targets below the project's touch standard

- Location: `apps/web/src/styles/app.css:56` (`.chip`) and `:560`
  (`.applied-chip`); applied chips are buttons in `CatalogPage.tsx:247`.
- Category: responsive/accessibility.
- Evidence: chip minimum height 40px; remove-filter chip minimum height 32px.
- Impact: compact filter controls are harder to operate with one thumb.
- Standard: the project's 44×44 CSS-pixel touch target requirement. This alone
  does not establish a WCAG 2.2 AA target-size failure; that criterion has a
  different minimum and spacing exceptions.
- Recommendation: use `var(--tap)` for clickable chip height and inspect mobile
  wrapping. Suggested command: `$impeccable adapt`.

### [P2] Public visits load route-specific administration code

- Location: `apps/web/src/App.tsx:9–19`.
- Category: performance.
- Evidence: static imports load admin, reader and member-page modules from the
  same application entrypoint.
- Impact: catalog visitors download route code they may never use. Actual cost
  depends on build output, network and device; no latency claim is made here.
- Recommendation: split substantial route modules with React lazy/Suspense,
  keeping readable loading states and checking navigation/focus behavior.
  Suggested command: `$impeccable optimize`.

### [P2] Export failure collapses actionable errors into a generic retry

- Location: `apps/web/src/admin/ExportPanel.tsx:60–62`.
- Category: implementation integrity/error UX.
- Evidence: only `no_chapters` receives a specific message. Missing immutable
  content (`content_unavailable`) displays the generic “try later” failure.
- Impact: an administrator is encouraged to retry a storage problem without
  understanding what needs repair.
- Recommendation: map unavailable-content and session errors to concise
  Traditional Chinese messages with the relevant next action.
  Suggested command: `$impeccable harden`.

Confirmed counts: P0 0, P1 0, P2 3, P3 0. Unverified conditions are not defects.

## Practices to retain

- `reader/BottomSheet.tsx`: initial focus, focus return, Tab wrapping, Escape
  dismissal and scroll locking.
- `reader/ReaderContent.tsx`: lazy image loading, asynchronous decoding and alt
  text.
- `reader/conversion.ts`: conversion data loaded only when needed.
- `reader/FullTextSearch.tsx`: labeled input, live result/error status and stale
  response suppression.
- `styles/app.css`: token-based controls and a static reduced-motion skeleton.

## Next pass

1. `$impeccable adapt`: filter touch targets, then inspect desktop/mobile layouts.
2. `$impeccable harden`: export error guidance.
3. `$impeccable optimize`: route loading, measured before/after.
4. `$impeccable polish`: final bounded visual and keyboard pass.

Remaining verification: phone/desktop overflow, zoomed text, all theme contrast
pairs, screen-reader navigation, and authenticated admin workflows. Fixes should
be followed by another audit; this report does not claim those checks passed.

## Resolution — 2026-10-15

All three reported findings have been addressed:

- Filter and remove-filter chips now use the 44px `--tap` height.
- Non-catalog routes load with React lazy/Suspense, with an accessible loading
  state and an error boundary offering reload if a page fails to load.
- Export errors distinguish missing contents, empty/missing versions and expired
  administrator access, with the relevant recovery guidance.

Web typecheck and production build passed. Build output separates administration
(72.45 kB) and the reader (34.34 kB) from the entry bundle (245.48 kB); figures
are minified, before gzip. The existing dynamically loaded conversion dictionary
still triggers the large-chunk advisory.

Browser inspection at 390×844 and 1280×900 confirmed a 44px remove-filter button
and no document horizontal overflow. Lazy navigation completed to rankings and
administrator login. Local API requests were unavailable, so authenticated
export error scenarios were not exercised live. Other original verification
gaps remain; no revised health score is claimed.
