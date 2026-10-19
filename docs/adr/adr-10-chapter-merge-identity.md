# ADR-10: Preserve chapter identity when merging

Accepted 2026-10-12.

Chapter revisions and their resource links retain their original chapter ID.
Merging creates a new revision on the surviving chapter and sets
`chapters.merged_into_chapter_id` on the absorbed chapter. Its row, head,
revision history and editorial position remain available. Historical revision
URLs use the original chapter and revision IDs.

An active editorial chapter has `merged_into_chapter_id IS NULL AND deleted_at IS NULL`. Apply this
predicate to head lists/counts, draft navigation, preview, publish validation
and snapshots, search/export, head resource digests, incremental matching and
reader state writes. Frozen release items and historical reading statistics
remain independent of current editorial activity.

Merge is available only before any release exists and when the absorbed
chapter has no reader references. The next chapter means the next active row
in editorial order. Absorbing a tombstone or a survivor referenced by existing
tombstones is rejected, preventing chains. The composite self foreign key
requires the survivor to belong to the same work; a check forbids self merges.

Merge leaves position gaps. Split shifts every later row, including tombstones,
to preserve the existing unique constraint. Incremental apply and revert
reserve tombstone positions while ordering active chapters. Work locks serialize
these operations; later edits continue to block protected import reverts.

Deletion sets `deleted_at` while retaining chapter IDs, positions, revisions and
reader references. It locks the work and checks the expected head revision.
Deleted positions are reserved like merged positions. At least one active
chapter must remain; removing the whole work uses `visibility = 'removed'`.
Chapter deletion changes only the draft until republished. Publication diffs
include removed IDs, derived from immutable snapshots on idempotent replay.
