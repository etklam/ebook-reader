// API DTOs (stabilization §9): explicit HTTP contract types. Raw DB rows are
// never spread into responses — the wire format stays camelCase and stable
// even when the DB schema evolves.
export interface ApiError {
  error: string;
  detail?: string;
}

export interface ImportJobSourceFile {
  fileHash: string;
  sizeBytes: number;
  mimeType: string;
  createdAt: string;
}

export interface ImportJobResponse {
  id: string;
  status: string;
  workId: string | null;
  requestedEncoding: string | null;
  detectedFormat: 'txt' | 'epub' | null;
  detectedEncoding: string | null;
  encodingResult: { confidence: string; reason: string; warnings: string[] } | null;
  chapterCount: number | null;
  errorCode: string | null;
  errorDetail: string | null;
  attemptCount: number;
  maxAttempts: number;
  stagedChapters: number;
  stagedNeedsReview: number;
  committedWorkId: string | null;
  committedChapterCount: number | null;
  applyMode: string | null;
  appliedResult: unknown;
  createdAt: string;
  completedAt: string | null;
  sourceFile: ImportJobSourceFile | null;
}

export interface ImportChapterPreview {
  position: number;
  volumeLabel: string | null;
  labelRaw: string;
  parsedLabel: unknown;
  title: string;
  snippet: string;
  warnings: string[];
  needsReview: boolean;
}

export interface ImportChapterPageResponse {
  total: number;
  page: number;
  limit: number;
  chapters: ImportChapterPreview[];
}

export interface ImportDiffItem {
  itemId: string;
  labelRaw: string;
  itemClass: string;
  matchedChapterId: string | null;
  insertAfterChapterId: string | null;
  insertBeforeChapterId: string | null;
  positionConfident: boolean;
  reason: string[];
}

export interface ImportDiffResponse {
  workId: string;
  editVersion: number;
  match: {
    items: ImportDiffItem[];
    missingFromSource: { chapterId: string; labelRaw: string; editorialPosition: number }[];
    needsReview: boolean;
    warnings: string[];
  };
}

export interface ImportApplyResponse {
  workId: string;
  newEditVersion: number;
  summary: { added: number; unchanged: number; modifiedKept: number; skipped: number; missingKept: number };
  alreadyApplied: boolean;
}

export interface ImportCommitResponse {
  workId: string;
  chapterCount: number;
  alreadyCommitted: boolean;
}

export interface ImportUploadResponse {
  importId: string;
  sourceFileId: string;
}
