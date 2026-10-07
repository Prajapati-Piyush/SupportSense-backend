export type DocumentLifecycleStatus = "uploaded" | "processing" | "ready" | "failed";

export type DocumentSourceType = "KB_DOC" | "RESOLVED_TICKET";

export interface DocumentRow {
  id: string;
  tenant_id: string;
  title: string;
  original_filename: string;
  storage_key: string;
  mime_type: string;
  file_size: string | number;
  status: DocumentLifecycleStatus;
  error_message: string | null;
  source_type: DocumentSourceType;
  source_ref_id: string | null;
  content: string | null;
  uploaded_by: string | null;
  uploaded_by_name?: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface DocumentPublic {
  id: string;
  tenantId: string;
  title: string;
  originalFilename: string;
  storageKey: string;
  mimeType: string;
  fileSize: number;
  status: DocumentLifecycleStatus;
  errorMessage: string | null;
  sourceType: DocumentSourceType;
  sourceRefId: string | null;
  content: string;
  uploadedBy: string | null;
  uploadedByName: string;
  createdAt: string;
  updatedAt: string;

  // Frontend UI compatibility fields
  chunkCount: number;
  tokenCount: number;
  wordCount: number;
  headings: string[];
  ingestProgress: number;
  citationCount: number;
  lastCitedAt: string | null;
}

export const ALLOWED_EXTENSIONS = [".pdf", ".docx", ".txt", ".md", ".markdown"] as const;

export const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "application/octet-stream", // Some browsers/curl report octet-stream for .md or .docx
] as const;

export const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15 MB

