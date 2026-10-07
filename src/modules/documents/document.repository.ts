import { query } from "../../db/client.js";
import { DocumentLifecycleStatus, DocumentPublic, DocumentRow, DocumentSourceType } from "./document.types.js";

function extractHeadings(content: string | null): string[] {
  if (!content) return [];
  const matches = [...content.matchAll(/^##\s+(.+)$/gm)];
  return matches.map((m) => m[1].trim());
}

function computeWordCount(content: string | null): number {
  if (!content) return 0;
  return content.trim().split(/\s+/).filter(Boolean).length;
}

function mapDocumentRow(row: DocumentRow): DocumentPublic {
  const content = row.content || "";
  const headings = extractHeadings(content);
  const wordCount = computeWordCount(content);
  const tokenCount = Math.round(wordCount * 1.32);

  let ingestProgress = 1;
  if (row.status === "uploaded") ingestProgress = 0.2;
  else if (row.status === "processing") ingestProgress = 0.6;
  else if (row.status === "failed") ingestProgress = 0;

  return {
    id: row.id,
    tenantId: row.tenant_id,
    title: row.title,
    originalFilename: row.original_filename,
    storageKey: row.storage_key,
    mimeType: row.mime_type,
    fileSize: Number(row.file_size),
    status: row.status,
    errorMessage: row.error_message,
    sourceType: row.source_type,
    sourceRefId: row.source_ref_id,
    content,
    uploadedBy: row.uploaded_by,
    uploadedByName: row.uploaded_by_name || "Support Staff",
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),

    // UI compatibility fields
    chunkCount: headings.length > 0 ? headings.length : 1,
    tokenCount,
    wordCount,
    headings,
    ingestProgress,
    citationCount: 0,
    lastCitedAt: null,
  };
}

export class DocumentRepository {
  static async create(data: {
    tenantId: string;
    title: string;
    originalFilename: string;
    storageKey: string;
    mimeType: string;
    fileSize: number;
    status?: DocumentLifecycleStatus;
    content?: string | null;
    uploadedBy?: string | null;
  }): Promise<DocumentPublic> {
    const res = await query<DocumentRow>(
      `INSERT INTO documents (
        tenant_id, title, original_filename, storage_key, mime_type, file_size, status, content, uploaded_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [
        data.tenantId,
        data.title.trim(),
        data.originalFilename.trim(),
        data.storageKey,
        data.mimeType,
        data.fileSize,
        data.status || "uploaded",
        data.content || null,
        data.uploadedBy || null,
      ]
    );

    return mapDocumentRow(res.rows[0]);
  }

  static async findByTenant(tenantId: string): Promise<DocumentPublic[]> {
    const res = await query<DocumentRow>(
      `SELECT d.*, u.name as uploaded_by_name
       FROM documents d
       LEFT JOIN users u ON d.uploaded_by = u.id
       WHERE d.tenant_id = $1
       ORDER BY d.created_at DESC`,
      [tenantId]
    );

    return res.rows.map(mapDocumentRow);
  }

  static async findById(id: string, tenantId: string): Promise<DocumentPublic | null> {
    const res = await query<DocumentRow>(
      `SELECT d.*, u.name as uploaded_by_name
       FROM documents d
       LEFT JOIN users u ON d.uploaded_by = u.id
       WHERE d.id = $1 AND d.tenant_id = $2
       LIMIT 1`,
      [id, tenantId]
    );

    return res.rows[0] ? mapDocumentRow(res.rows[0]) : null;
  }

  static async updateStatus(
    id: string,
    tenantId: string,
    status: DocumentLifecycleStatus,
    errorMessage?: string | null
  ): Promise<DocumentPublic | null> {
    const res = await query<DocumentRow>(
      `UPDATE documents
       SET status = $1, error_message = $2, updated_at = NOW()
       WHERE id = $3 AND tenant_id = $4
       RETURNING *`,
      [status, errorMessage || null, id, tenantId]
    );

    return res.rows[0] ? mapDocumentRow(res.rows[0]) : null;
  }

  static async delete(id: string, tenantId: string): Promise<DocumentPublic | null> {
    const res = await query<DocumentRow>(
      `DELETE FROM documents
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [id, tenantId]
    );

    return res.rows[0] ? mapDocumentRow(res.rows[0]) : null;
  }
}

