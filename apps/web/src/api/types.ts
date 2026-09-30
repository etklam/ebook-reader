// Reader/Admin DTO mirrors of the server's explicit responses (§27). No `any`
// chains: the server owns these shapes, the client only narrows.
export type WorkType = 'short_story' | 'serial';
export type SerialStatus = 'ongoing' | 'completed' | 'paused' | null;
export type Visibility = 'draft' | 'public' | 'unlisted' | 'removed';

export interface Me {
  id: string;
  role: 'admin' | 'member';
}

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

export type ApiError = { error: string; detail?: string };
