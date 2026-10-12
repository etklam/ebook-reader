// Mirrors the import HTTP DTOs; parser hints stay editable rather than trusted metadata.
export interface ImportMetadata {
  title?: string; author?: string; description?: string; serialStatus?: 'ongoing' | 'completed';
}
export interface ImportJob {
  id: string; status: string; workId: string | null;
  detectedEncoding: string | null; chapterCount: number | null;
  encodingResult: { confidence: string; reason: string; warnings: string[]; metadata?: ImportMetadata } | null;
  errorCode: string | null; errorDetail: string | null;
  stagedChapters: number; stagedNeedsReview: number; committedWorkId: string | null;
  sourceFile: { mimeType: string; sizeBytes: number; fileHash: string; createdAt: string } | null;
}
export interface ImportQuality {
  total: number; issueCount: number;
  counts: { empty: number; duplicates: number; gaps: number };
  issues: Array<{ type: 'empty' | 'duplicate' | 'gap'; positions: number[]; labels: string[]; message: string }>;
}
export interface ImportChapterPage {
  total: number; page: number; limit: number;
  chapters: Array<{ position: number; labelRaw: string; title: string; snippet: string; warnings: string[]; needsReview: boolean }>;
}
