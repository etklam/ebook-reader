// DTO mirrors of the server's explicit responses (§62). Public catalog,
// public reader, member/private and admin shapes stay separate.
export type WorkType = 'short_story' | 'serial';
export type SerialStatus = 'ongoing' | 'completed' | 'paused' | null;
export type Visibility = 'draft' | 'public' | 'unlisted' | 'removed';
export type MeRole = 'admin' | 'member';

export interface Me {
  id: string;
  role: MeRole;
}

// --- public catalog ----------------------------------------------------------
export interface CatalogWork {
  id: string;
  title: string;
  author: string;
  description: string;
  workType: WorkType;
  serialStatus: SerialStatus;
  chapterCount: number;
  latestPublishedAt: string;
  categories: string[];
  tags: string[];
}

export interface CatalogResponse {
  total: null;
  limit: number;
  offset: number;
  works: CatalogWork[];
}

export interface WorkDetail extends Omit<CatalogWork, 'categories' | 'tags' | 'chapterCount' | 'latestPublishedAt'> {
  visibility: Visibility;
  releaseId: string;
  releaseVersion: number;
  publishedAt: string;
  chapterCount: number;
  firstChapterId: string | null;
  categories: string[];
  tags: string[];
}

// --- public reader -----------------------------------------------------------
export interface ReaderWork {
  id: string;
  title: string;
  author: string;
  workType: WorkType;
  serialStatus: SerialStatus;
  description: string;
  visibility: Visibility;
  chapterCount: number;
  firstChapterId: string | null;
  latestChapterId: string | null;
  releaseId: string | null;
  releaseVersion: number | null;
  publishedAt: string | null;
}

export interface TocEntry {
  id: string;
  volumeId: string | null;
  labelRaw: string;
  title: string;
  editorialPosition: number;
  revisionId: string | null;
}

export interface TocResponse {
  total: number;
  limit: number;
  offset: number;
  chapters: TocEntry[];
}

export interface ReaderChapter {
  chapterId: string;
  workId: string;
  revisionId: string;
  labelRaw: string;
  title: string;
  body: string;
  previousChapterId: string | null;
  nextChapterId: string | null;
  paragraphCount: number;
  updatedAt: string;
}

// --- member state --------------------------------------------------------------
export interface LibraryEntry {
  workId: string;
  title: string;
  author: string;
  workType: WorkType;
  serialStatus: SerialStatus;
  hasUpdate: boolean;
  newChapterCount: number;
  continueChapterId: string | null;
  continueParagraphIndex: number | null;
  lastReadAt: string | null;
  addedAt: string;
}

export interface FollowEntry {
  workId: string;
  title: string;
  hasUpdate: boolean;
  newChapterCount: number;
  lastSeenVersion: number;
  latestVersion: number | null;
}

export interface ServerProgress {
  chapterId: string;
  revisionId: string;
  paragraphIndex: number;
  fraction: number | null;
  syncVersion: number;
  updatedAt: string;
}

export interface BookmarkEntry {
  id: string;
  workId: string;
  workTitle: string;
  chapterId: string;
  chapterLabel: string | null;
  revisionId: string;
  paragraphIndex: number;
  note: string;
  createdAt: string;
}

export interface ReaderPreferencesDto {
  theme: 'light' | 'sepia' | 'dark';
  fontSize: number;
  lineHeight: number;
  paragraphSpacing: number;
  conversion: 'original' | 't' | 'cn';
  mode: 'scroll' | 'paginated';
  updatedAt: string;
}

export type ApiError = { error: string; detail?: string };

// --- taxonomy -------------------------------------------------------------------
export interface TaxonomyItem {
  id: string;
  displayName: string;
  description: string;
  sortOrder: number;
  isActive: boolean;
}

export interface TaxonomyListResponse {
  total: number;
  limit: number;
  offset: number;
  items: TaxonomyItem[];
}

// --- admin publishing --------------------------------------------------------------
export interface PublishPreviewResponse {
  ok: true;
  workId: string;
  valid: boolean;
  problems: string[];
  chapterCount: number;
  previousRelease: { id: string; version: number; chapterCount: number } | null;
  diff: { newChapterIds: string[]; updatedChapterIds: string[]; reorderedChapterIds: string[] };
}

export interface PublishResponse {
  workId: string;
  releaseId: string;
  version: number;
  chapterCount: number;
  diff: { newChapterIds: string[]; updatedChapterIds: string[]; reorderedChapterIds: string[] };
  alreadyPublished: boolean;
}
