// Core schema, M1 subset of dev-plan §17 (imports/reading/publishing tables
// arrive with M2/M4/M6). Canonical column names per §16A-C — chapters use
// label_raw / editorial_position / head_revision_id; do not invent duplicates.
import { pgSchema, uuid, text, integer, timestamp, boolean, index, unique, primaryKey, foreignKey } from 'drizzle-orm/pg-core';

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
});

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
  // FK added by migration when work_releases exists (M4)
  activeReleaseId: uuid('active_release_id'),
  visibility: text('visibility', { enum: ['draft', 'public', 'unlisted', 'removed'] }).notNull().default('draft'),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const volumes = app.table('volumes', {
  id: uuid('id').primaryKey().defaultRandom(),
  workId: uuid('work_id').notNull().references(() => works.id),
  title: text('title').notNull(),
  position: integer('position').notNull(),
}, (t) => [
  unique('volumes_work_position_uq').on(t.workId, t.position),
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
