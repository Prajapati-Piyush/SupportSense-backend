import { pool, query } from "../../db/client.js";
import { DocumentChunk } from "./chunker.service.js";

export interface DocumentChunkRow {
  id: string;
  document_id: string;
  tenant_id: string;
  chunk_index: number;
  content: string;
  heading_path: string | null;
  token_count: number;
  embedding?: string | null;
  embedding_model?: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface DocumentChunkPublic {
  id: string;
  documentId: string;
  tenantId: string;
  chunkIndex: number;
  content: string;
  headingPath: string | null;
  tokenCount: number;
  hasEmbedding: boolean;
  embeddingModel: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapChunkRow(row: DocumentChunkRow): DocumentChunkPublic {
  return {
    id: row.id,
    documentId: row.document_id,
    tenantId: row.tenant_id,
    chunkIndex: row.chunk_index,
    content: row.content,
    headingPath: row.heading_path,
    tokenCount: row.token_count,
    hasEmbedding: Boolean(row.embedding),
    embeddingModel: row.embedding_model || null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString(),
  };
}

export class ChunkRepository {
  /**
   * Replaces all chunks for a document in a single atomic transaction.
   * Ensures safe reprocessing without duplicate chunks or unique constraint collisions.
   * Returns newly inserted chunk rows with generated IDs.
   */
  static async replaceChunks(
    documentId: string,
    tenantId: string,
    chunks: DocumentChunk[]
  ): Promise<DocumentChunkRow[]> {
    const client = await pool.connect();
    let insertedRows: DocumentChunkRow[] = [];

    try {
      await client.query("BEGIN");

      // 1. Delete any existing chunks for this document (strictly tenant-scoped)
      await client.query(
        `DELETE FROM document_chunks WHERE document_id = $1 AND tenant_id = $2`,
        [documentId, tenantId]
      );

      // 2. Insert new chunks in batch
      if (chunks.length > 0) {
        const values: any[] = [];
        const placeholders: string[] = [];

        chunks.forEach((chunk, idx) => {
          const offset = idx * 7;
          placeholders.push(
            `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`
          );
          values.push(
            documentId,
            tenantId,
            chunk.chunkIndex,
            chunk.content,
            chunk.headingPath || null,
            chunk.tokenCount,
            null // embedding_model explicitly NULL until embeddings are generated
          );
        });

        const sql = `
          INSERT INTO document_chunks (
            document_id, tenant_id, chunk_index, content, heading_path, token_count, embedding_model
          ) VALUES ${placeholders.join(", ")}
          RETURNING id, document_id, tenant_id, chunk_index, content, heading_path, token_count, created_at, updated_at
        `;

        const res = await client.query<DocumentChunkRow>(sql, values);
        insertedRows = res.rows;
      }

      await client.query("COMMIT");
      return insertedRows;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Saves generated embeddings to document_chunks table in an atomic transaction.
   */
  static async saveChunkEmbeddings(
    updates: Array<{ id: string; tenantId: string; embedding: number[]; model: string }>
  ): Promise<void> {
    if (updates.length === 0) return;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      for (const item of updates) {
        const vectorStr = `[${item.embedding.join(",")}]`;
        await client.query(
          `UPDATE document_chunks
           SET embedding = $1::vector,
               embedding_model = $2,
               updated_at = NOW()
           WHERE id = $3 AND tenant_id = $4`,
          [vectorStr, item.model, item.id, item.tenantId]
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Retrieves all chunks for a document, strictly scoped to the tenant.
   */
  static async findByDocument(
    documentId: string,
    tenantId: string
  ): Promise<DocumentChunkPublic[]> {
    const res = await query<DocumentChunkRow>(
      `SELECT id, document_id, tenant_id, chunk_index, content, heading_path, token_count,
              (embedding IS NOT NULL)::text as embedding, embedding_model, created_at, updated_at
       FROM document_chunks
       WHERE document_id = $1 AND tenant_id = $2
       ORDER BY chunk_index ASC`,
      [documentId, tenantId]
    );

    return res.rows.map(mapChunkRow);
  }

  /**
   * Finds chunks that have NULL embeddings for a given tenant.
   * Useful for indexing/backfilling chunks created in earlier steps.
   */
  static async findPendingChunks(
    tenantId: string,
    limit = 50
  ): Promise<DocumentChunkRow[]> {
    const res = await query<DocumentChunkRow>(
      `SELECT id, document_id, tenant_id, chunk_index, content, heading_path, token_count, created_at, updated_at
       FROM document_chunks
       WHERE tenant_id = $1 AND embedding IS NULL
       ORDER BY created_at ASC
       LIMIT $2`,
      [tenantId, limit]
    );

    return res.rows;
  }

  /**
   * Counts how many chunks still have NULL embeddings for a tenant.
   */
  static async countPendingChunks(tenantId: string): Promise<number> {
    const res = await query<{ count: string }>(
      `SELECT COUNT(*) as count
       FROM document_chunks
       WHERE tenant_id = $1 AND embedding IS NULL`,
      [tenantId]
    );

    return parseInt(res.rows[0]?.count || "0", 10);
  }

  /**
   * Counts how many chunks still have NULL embeddings for a specific document.
   */
  static async countPendingByDocument(documentId: string, tenantId: string): Promise<number> {
    const res = await query<{ count: string }>(
      `SELECT COUNT(*) as count
       FROM document_chunks
       WHERE document_id = $1 AND tenant_id = $2 AND embedding IS NULL`,
      [documentId, tenantId]
    );

    return parseInt(res.rows[0]?.count || "0", 10);
  }

  /**
   * Counts total chunks for a document, strictly scoped to the tenant.
   */
  static async countByDocument(
    documentId: string,
    tenantId: string
  ): Promise<number> {
    const res = await query<{ count: string }>(
      `SELECT COUNT(*) as count
       FROM document_chunks
       WHERE document_id = $1 AND tenant_id = $2`,
      [documentId, tenantId]
    );

    return parseInt(res.rows[0]?.count || "0", 10);
  }

  /**
   * Deletes all chunks for a document, strictly scoped to the tenant.
   */
  static async deleteByDocument(
    documentId: string,
    tenantId: string
  ): Promise<number> {
    const res = await query(
      `DELETE FROM document_chunks
       WHERE document_id = $1 AND tenant_id = $2`,
      [documentId, tenantId]
    );

    return res.rowCount || 0;
  }
}
