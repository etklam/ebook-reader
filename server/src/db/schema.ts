// Core schema (M1 subset + M6 publishing/member tables). Canonical column
// names per §16A-C — chapters use label_raw / editorial_position /
// head_revision_id; do not invent duplicates.
import { pgSchema, uuid, text, integer, timestamp, boolean, jsonb, real, index, unique, primaryKey, foreignKey, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const app = pgSchema('app');

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

// --- identity (§17) -----------------------------------------------------------
export const users = app.table('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: text('username').notNull(),
  // emails lowercased by callers; no citext extension needed
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['admin', 'member'] }).notNull().default('member'),
  createdAt: createdAt(),
}, (t) => [
  // DB-level domain checks (§16A-C): TS enums alone do not constrain the DB
  check('users_role_ck', sql`${t.role} in ('admin','member')`),
]);

export const sessions = app.table('sessions', {
  // id = sha256 of the session token; the raw token only exists in the cookie
  id: text('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  index('sessions_user_idx').on(t.userId),
]);

// --- works & taxonomy (§17, §03A-F; aliases/merge deferred per v1.3) ---------
export const works = app.table('works', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  author: text('author').notNull().default(''),
  workType: text('work_type', { enum: ['short_story', 'serial'] }).notNull(),
  serialStatus: text('serial_status', { enum: ['ongoing', 'completed', 'paused'] }),
  description: text('description').notNull().default(''),
  editVersion: integer('edit_version').notNull().default(1),
  // composite FK works_active_release_fk (active_release_id, id) →
  // work_releases(id, work_id) added by hand in 0004_m6 — a work can never
  // point at another work's release
  activeReleaseId: uuid('active_release_id'),
  visibility: text('visibility', { enum: ['draft', 'public', 'unlisted', 'removed'] }).notNull().default('draft'),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('works_work_type_ck', sql`${t.workType} in ('short_story','serial')`),
  check('works_serial_status_ck', sql`${t.serialStatus} is null or ${t.serialStatus} in ('ongoing','completed','paused')`),
  // short_story carries no serial state; serial may leave it NULL while unknown
  check('works_type_status_ck', sql`(${t.workType} = 'serial') or (${t.workType} = 'short_story' and ${t.serialStatus} is null)`),
  check('works_visibility_ck', sql`${t.visibility} in ('draft','public','unlisted','removed')`),
]);

export const volumes = app.table('volumes', {
  id: uuid('id').primaryKey().defaultRandom(),
  workId: uuid('work_id').notNull().references(() => works.id),
  title: text('title').notNull(),
  position: integer('position').notNull(),
}, (t) => [
  unique('volumes_work_position_uq').on(t.workId, t.position),
  // candidate key so chapters can reference (volume_id, work_id) as a
  // composite FK — a chapter can never point at another work's volume (§16A-C)
  unique('volumes_id_work_uq').on(t.id, t.workId),
]);

const taxonomyColumns = {
  id: uuid('id').primaryKey().defaultRandom(),
  displayName: text('display_name').notNull(),
  description: text('description').notNull().default(''),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  version: integer('version').notNull().default(1),
  createdAt: createdAt(),
};

// note: separate named uniques — constraint index names are schema-unique,
// so sharing one name across the two tables breaks the generated SQL
export const categories = app.table('categories', {
  ...taxonomyColumns,
}, (t) => [unique('categories_display_name_unique').on(t.displayName)]);

export const tags = app.table('tags', {
  ...taxonomyColumns,
}, (t) => [unique('tags_display_name_unique').on(t.displayName)]);

export const workCategories = app.table('work_categories', {
  workId: uuid('work_id').notNull().references(() => works.id),
  categoryId: uuid('category_id').notNull().references(() => categories.id),
  assignedAt: createdAt(),
}, (t) => [
  primaryKey({ columns: [t.workId, t.categoryId] }),
  index('work_categories_reverse_idx').on(t.categoryId, t.workId),
]);

export const workTags = app.table('work_tags', {
  workId: uuid('work_id').notNull().references(() => works.id),
  tagId: uuid('tag_id').notNull().references(() => tags.id),
  assignedAt: createdAt(),
}, (t) => [
  primaryKey({ columns: [t.workId, t.tagId] }),
  index('work_tags_reverse_idx').on(t.tagId, t.workId),
]);

// --- chapters & immutable revisions (§09, §12) --------------------------------
// label_raw is TEXT and never unique: 12.10, 12.5.1, 第12章（上）, 無數字標題
// all coexist, and the same label may legally appear in different volumes.
// head_revision_id FK is added by hand in the migration (circular reference
// with chapter_revisions).
export const chapters = app.table('chapters', {
  id: uuid('id').primaryKey().defaultRandom(),
  workId: uuid('work_id').notNull().references(() => works.id),
  volumeId: uuid('volume_id').references(() => volumes.id),
  labelRaw: text('label_raw').notNull(),
  editorialPosition: integer('editorial_position').notNull(),
  // FK chapters_head_revision_fk added by hand in the migration — composite
  // (head_revision_id, id) → chapter_revisions(id, chapter_id) so a revision
  // can never be pointed at from another chapter (§16A-C)
  headRevisionId: uuid('head_revision_id'),
  createdAt: createdAt(),
}, (t) => [
  // chapters_work_position_uq is DEFERRABLE INITIALLY DEFERRED in the
  // migration SQL (§16A-C) — mid-sequence insertions shift a range in one tx
  unique('chapters_work_position_uq').on(t.workId, t.editorialPosition),
  index('chapters_work_position_idx').on(t.workId, t.editorialPosition),
  // composite FK: (volume_id, work_id) → volumes(id, work_id). NULL volume_id
  // passes (MATCH SIMPLE); a non-null volume must belong to the same work.
  foreignKey({ columns: [t.volumeId, t.workId], foreignColumns: [volumes.id, volumes.workId] }),
]);

export const chapterRevisions = app.table('chapter_revisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  chapterId: uuid('chapter_id').notNull().references(() => chapters.id),
  title: text('title').notNull(),
  // content_key points into private storage; resolved server-side only (§16A-D)
  contentKey: text('content_key').notNull(),
  bodyCompareHash: text('body_compare_hash').notNull(),
  revisionHash: text('revision_hash').notNull(),
  processorVersion: text('processor_version').notNull(),
  sourceImportId: uuid('source_import_id'),
  createdAt: createdAt(),
}, (t) => [
  index('chapter_revisions_chapter_idx').on(t.chapterId, t.createdAt),
]);

// Apply idempotency (dev-plan §12): retries with the same Idempotency-Key and
// the same payload return the persisted response and create nothing; the same
// key with a different payload is rejected. Written in the same transaction
// as the content change it guards.
export const applyIdempotency = app.table('apply_idempotency', {
  key: text('key').primaryKey(),
  importJobId: uuid('import_job_id').notNull().references(() => importJobs.id),
  requestHash: text('request_hash').notNull(),
  response: jsonb('response').notNull(),
  createdAt: createdAt(),
}, (t) => [
  index('apply_idempotency_job_idx').on(t.importJobId),
]);

// --- source files (§17) --------------------------------------------------------
export const sourceFiles = app.table('source_files', {
  id: uuid('id').primaryKey().defaultRandom(),
  workId: uuid('work_id').references(() => works.id),
  storageKey: text('storage_key').notNull().unique(),
  fileHash: text('file_hash').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  mimeType: text('mime_type').notNull(),
  createdAt: createdAt(),
}, (t) => [
  index('source_files_hash_idx').on(t.fileHash),
]);

// --- import domain (M2, §17 import_jobs/import_items) --------------------------
// Transitions are explicit: queued → processing → (review_required | ready |
// failed | cancelled); ready|review_required → committed only via the commit
// transaction. Staging rows are disposable import state — canonical truth stays
// works/chapters/chapter_revisions; staged items never reuse chapter ids.
export const importJobs = app.table('import_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  // target work: NULL when importing a new work (commit creates or takes it)
  workId: uuid('work_id').references(() => works.id),
  sourceFileId: uuid('source_file_id').notNull().references(() => sourceFiles.id),
  requestedByUserId: uuid('requested_by_user_id').notNull().references(() => users.id),
  status: text('status').notNull().default('queued'),
  detectedFormat: text('detected_format', { enum: ['txt', 'epub'] }),
  requestedEncoding: text('requested_encoding'),
  detectedEncoding: text('detected_encoding'),
  // { confidence, reason, warnings, candidates } — why we picked the encoding
  encodingResult: jsonb('encoding_result'),
  chapterCount: integer('chapter_count'),
  processorVersion: text('processor_version').notNull(),
  errorCode: text('error_code'),
  // sanitized operator-facing detail; never contains file content or paths
  errorDetail: text('error_detail'),
  // queue bookkeeping (lease/reclaim, §16 queue column)
  attemptCount: integer('attempt_count').notNull().default(0),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  // idempotent commit result: first successful commit persists these; a retry
  // returns the same result without creating chapters/revisions again
  committedWorkId: uuid('committed_work_id'),
  committedChapterCount: integer('committed_chapter_count'),
  // M3 incremental apply: mode + persisted summary for idempotent replay
  applyMode: text('apply_mode', { enum: ['incremental', 'overwrite'] }),
  appliedResult: jsonb('applied_result'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  check('import_jobs_status_ck', sql`${t.status} in ('queued','processing','review_required','ready','failed','cancelled','committed','applied','reverted')`),
  index('import_jobs_status_created_idx').on(t.status, t.createdAt),
]);

export const importItems = app.table('import_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  importJobId: uuid('import_job_id').notNull().references(() => importJobs.id),
  // position within this source document (0-based source sequence)
  position: integer('position').notNull(),
  // volume label / staging volume identity if the source had one
  volumeLabel: text('volume_label'),
  // raw chapter label preserved exactly ('' when the source had none)
  labelRaw: text('label_raw').notNull(),
  // parsed-label metadata from the shared parser (kind/parts/subPart/key)
  parsedLabel: jsonb('parsed_label'),
  title: text('title').notNull().default(''),
  // immutable staged body already in private storage (worker writes before tx)
  contentKey: text('content_key').notNull(),
  bodyHash: text('body_hash').notNull(),
  // short headless preview snippet for admin listing (not full body)
  snippet: text('snippet').notNull().default(''),
  warnings: jsonb('warnings').notNull().default(sql`'[]'::jsonb`),
  needsReview: boolean('needs_review').notNull().default(false),
}, (t) => [
  unique('import_items_job_position_uq').on(t.importJobId, t.position),
  index('import_items_job_idx').on(t.importJobId, t.position),
]);

// --- publishing (M6): editorial head != public release --------------------------
// Editorial chapters/head_revision_id are Admin truth. Public readers consume
// the immutable active_release snapshot (release_items → exact revisions);
// imports never change public content until an explicit publish.
export const workReleases = app.table('work_releases', {
  id: uuid('id').primaryKey().defaultRandom(),
  workId: uuid('work_id').notNull().references(() => works.id),
  version: integer('version').notNull(),
  // publish retry identity (M4 Idempotency-Key pattern); a retried publish
  // with the same key returns the same release instead of creating a new one
  idempotencyKey: text('idempotency_key'),
  note: text('note').notNull().default(''),
  chapterCount: integer('chapter_count').notNull(),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAt(),
}, (t) => [
  unique('work_releases_work_version_uq').on(t.workId, t.version),
  unique('work_releases_idempotency_uq').on(t.idempotencyKey),
  // candidate key so works.active_release_id can composite-FK here — a work
  // can never point at another work's release (§16A-C pattern)
  unique('work_releases_id_work_uq').on(t.id, t.workId),
  check('work_releases_version_ck', sql`${t.version} >= 1`),
]);

export const releaseItems = app.table('release_items', {
  releaseId: uuid('release_id').notNull().references(() => workReleases.id),
  chapterId: uuid('chapter_id').notNull().references(() => chapters.id),
  // exact immutable revision snapshot — the body stays in private storage
  revisionId: uuid('revision_id').notNull().references(() => chapterRevisions.id),
  editorialPosition: integer('editorial_position').notNull(),
  volumeId: uuid('volume_id').references(() => volumes.id),
  // snapshot of display fields so a release is readable even if editorial
  // metadata moves on; body content always comes from the revision
  labelRaw: text('label_raw').notNull(),
  title: text('title').notNull().default(''),
}, (t) => [
  // a chapter appears exactly once per release; positions are deterministic
  // (the position unique doubles as the ordering index)
  primaryKey({ columns: [t.releaseId, t.chapterId] }),
  unique('release_items_position_uq').on(t.releaseId, t.editorialPosition),
  index('release_items_revision_idx').on(t.revisionId),
]);

// One event per release, created transactionally with publication. NEW =
// chapter absent from the previous active release; UPDATED = same chapter,
// different revision. Only NEW counts as a follow "new chapter" update.
export const publicationEvents = app.table('publication_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  workId: uuid('work_id').notNull().references(() => works.id),
  releaseId: uuid('release_id').notNull().references(() => workReleases.id),
  releaseVersion: integer('release_version').notNull(),
  eventType: text('event_type', { enum: ['published'] }).notNull().default('published'),
  newChapterIds: jsonb('new_chapter_ids').notNull().default(sql`'[]'::jsonb`),
  updatedChapterIds: jsonb('updated_chapter_ids').notNull().default(sql`'[]'::jsonb`),
  createdAt: createdAt(),
}, (t) => [
  unique('publication_events_release_uq').on(t.releaseId),
  index('publication_events_work_idx').on(t.workId, t.releaseVersion),
]);

// --- member state (M6) ----------------------------------------------------------
export const registrationInvites = app.table('registration_invites', {
  // sha256 of the invite token — the raw token exists only in the API response
  tokenHash: text('token_hash').primaryKey(),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  usedByUserId: uuid('used_by_user_id').references(() => users.id),
  createdAt: createdAt(),
});

export const userLibrary = app.table('user_library', {
  userId: uuid('user_id').notNull().references(() => users.id),
  workId: uuid('work_id').notNull().references(() => works.id),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.userId, t.workId] }),
  index('user_library_user_idx').on(t.userId, t.updatedAt),
]);

export const userFollows = app.table('user_follows', {
  userId: uuid('user_id').notNull().references(() => users.id),
  workId: uuid('work_id').notNull().references(() => works.id),
  // highest release version the follower has been shown as seen
  lastSeenReleaseVersion: integer('last_seen_release_version').notNull().default(0),
  followedAt: createdAt(),
}, (t) => [
  primaryKey({ columns: [t.userId, t.workId] }),
  index('user_follows_user_idx').on(t.userId),
]);

export const readingProgress = app.table('reading_progress', {
  userId: uuid('user_id').notNull().references(() => users.id),
  workId: uuid('work_id').notNull().references(() => works.id),
  chapterId: uuid('chapter_id').notNull().references(() => chapters.id),
  revisionId: uuid('revision_id').notNull().references(() => chapterRevisions.id),
  paragraphIndex: integer('paragraph_index').notNull().default(0),
  fraction: real('fraction'),
  // optimistic concurrency: update only when client baseVersion matches
  syncVersion: integer('sync_version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAt(),
}, (t) => [
  primaryKey({ columns: [t.userId, t.workId] }),
  check('reading_progress_paragraph_ck', sql`${t.paragraphIndex} >= 0`),
  check('reading_progress_sync_ck', sql`${t.syncVersion} >= 1`),
]);

// read history keyed by stable chapter id — a late-published 87.5 must stay
// unread even though its editorial position precedes read chapters (PUB-02)
export const userChapterReads = app.table('user_chapter_reads', {
  userId: uuid('user_id').notNull().references(() => users.id),
  chapterId: uuid('chapter_id').notNull().references(() => chapters.id),
  releaseVersion: integer('release_version'),
  firstReadAt: timestamp('first_read_at', { withTimezone: true }).notNull().defaultNow(),
  lastReadAt: timestamp('last_read_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.userId, t.chapterId] }),
  index('user_chapter_reads_user_idx').on(t.userId, t.lastReadAt),
]);

export const bookmarks = app.table('bookmarks', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  workId: uuid('work_id').notNull().references(() => works.id),
  chapterId: uuid('chapter_id').notNull().references(() => chapters.id),
  // frozen at creation: never rewritten because a head/release moved (§35)
  revisionId: uuid('revision_id').notNull().references(() => chapterRevisions.id),
  paragraphIndex: integer('paragraph_index').notNull().default(0),
  note: text('note').notNull().default(''),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('bookmarks_user_work_idx').on(t.userId, t.workId),
  index('bookmarks_user_chapter_idx').on(t.userId, t.chapterId),
  check('bookmarks_paragraph_ck', sql`${t.paragraphIndex} >= 0`),
]);

export const readerPreferences = app.table('reader_preferences', {
  userId: uuid('user_id').primaryKey().references(() => users.id),
  theme: text('theme', { enum: ['light', 'sepia', 'dark'] }).notNull(),
  fontSize: integer('font_size').notNull(),
  lineHeight: real('line_height').notNull(),
  paragraphSpacing: real('paragraph_spacing').notNull(),
  conversionMode: text('conversion_mode', { enum: ['original', 't', 'cn'] }).notNull(),
  readingMode: text('reading_mode', { enum: ['scroll', 'paginated'] }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('reader_preferences_font_ck', sql`${t.fontSize} between 14 and 28`),
  check('reader_preferences_line_height_ck', sql`${t.lineHeight} between 1.4 and 2.6`),
  check('reader_preferences_spacing_ck', sql`${t.paragraphSpacing} between 0 and 3`),
]);
