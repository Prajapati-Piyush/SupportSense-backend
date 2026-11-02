import { query } from "../../../db/client.js";
import { SemanticMatchRow, KeywordMatchRow } from "./retrieval.types.js";

export class RetrievalRepository {
  /**
   * Performs semantic vector search using pgvector cosine distance (<=>).
   * Strictly tenant-isolated.
   *
   * Enforces complete indexing rule:
   * 1. Tenant match (dc.tenant_id = $tenantId)
   * 2. Document status is 'ready' (d.status = 'ready')
   * 3. Chunk has a valid embedding (dc.embedding IS NOT NULL)
   * 4. Document has zero pending un-embedded chunks (no partial indexing leakage)
   */
  static async searchSemantic(
    tenantId: string,
    queryEmbedding: number[],
    threshold: number,
    limit: number
  ): Promise<SemanticMatchRow[]> {
    const vectorStr = `[${queryEmbedding.join(",")}]`;

    const sql = `
      SELECT 
        dc.id,
        dc.document_id,
        dc.tenant_id,
        dc.chunk_index,
        dc.content,
        dc.heading_path,
        dc.token_count,
        dc.embedding_model,
        d.title as document_title,
        d.original_filename,
        d.source_type,
        (1 - (dc.embedding <=> $1::vector)) as similarity
      FROM document_chunks dc
      JOIN documents d ON d.id = dc.document_id AND d.tenant_id = dc.tenant_id
      WHERE dc.tenant_id = $2
        AND d.status = 'ready'
        AND dc.embedding IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM document_chunks dc_pending
          WHERE dc_pending.document_id = d.id
            AND dc_pending.tenant_id = d.tenant_id
            AND dc_pending.embedding IS NULL
        )
        AND (1 - (dc.embedding <=> $1::vector)) >= $3
      ORDER BY dc.embedding <=> $1::vector ASC
      LIMIT $4
    `;

    const res = await query<SemanticMatchRow>(sql, [
      vectorStr,
      tenantId,
      threshold,
      limit,
    ]);

    return res.rows;
  }

  /**
   * Performs full-text search against the GIN-indexed tsvector column (dc.tsv).
   * Strictly tenant-isolated.
   *
   * Enforces complete indexing rule:
   * 1. Tenant match (dc.tenant_id = $tenantId)
   * 2. Document status is 'ready' (d.status = 'ready')
   * 3. Chunk has a valid embedding (dc.embedding IS NOT NULL)
   * 4. Document has zero pending un-embedded chunks (no partial indexing leakage)
   */
  static async searchKeyword(
    tenantId: string,
    queryText: string,
    limit: number
  ): Promise<KeywordMatchRow[]> {
    // Check if query produces valid tsquery tokens
    const testSql = `SELECT websearch_to_tsquery('english', $1)::text as tsquery_str`;
    let tsqueryValid = false;
    try {
      const testRes = await query<{ tsquery_str: string }>(testSql, [queryText]);
      if (testRes.rows[0]?.tsquery_str && testRes.rows[0].tsquery_str.trim().length > 0) {
        tsqueryValid = true;
      }
    } catch {
      tsqueryValid = false;
    }

    if (!tsqueryValid) {
      // Fallback: try plainto_tsquery
      try {
        const plainTest = await query<{ tsquery_str: string }>(
          `SELECT plainto_tsquery('english', $1)::text as tsquery_str`,
          [queryText]
        );
        if (plainTest.rows[0]?.tsquery_str && plainTest.rows[0].tsquery_str.trim().length > 0) {
          const sql = `
            SELECT 
              dc.id,
              dc.document_id,
              dc.tenant_id,
              dc.chunk_index,
              dc.content,
              dc.heading_path,
              dc.token_count,
              dc.embedding_model,
              d.title as document_title,
              d.original_filename,
              d.source_type,
              ts_rank_cd(dc.tsv, plainto_tsquery('english', $1)) as rank_score
            FROM document_chunks dc
            JOIN documents d ON d.id = dc.document_id AND d.tenant_id = dc.tenant_id
            WHERE dc.tenant_id = $2
              AND d.status = 'ready'
              AND dc.embedding IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM document_chunks dc_pending
                WHERE dc_pending.document_id = d.id
                  AND dc_pending.tenant_id = d.tenant_id
                  AND dc_pending.embedding IS NULL
              )
              AND dc.tsv @@ plainto_tsquery('english', $1)
            ORDER BY rank_score DESC
            LIMIT $3
          `;
          const res = await query<KeywordMatchRow>(sql, [queryText, tenantId, limit]);
          return res.rows;
        }
      } catch {
        return [];
      }
      return [];
    }

    const sql = `
      SELECT 
        dc.id,
        dc.document_id,
        dc.tenant_id,
        dc.chunk_index,
        dc.content,
        dc.heading_path,
        dc.token_count,
        dc.embedding_model,
        d.title as document_title,
        d.original_filename,
        d.source_type,
        ts_rank_cd(dc.tsv, websearch_to_tsquery('english', $1)) as rank_score
      FROM document_chunks dc
      JOIN documents d ON d.id = dc.document_id AND d.tenant_id = dc.tenant_id
      WHERE dc.tenant_id = $2
        AND d.status = 'ready'
        AND dc.embedding IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM document_chunks dc_pending
          WHERE dc_pending.document_id = d.id
            AND dc_pending.tenant_id = d.tenant_id
            AND dc_pending.embedding IS NULL
        )
        AND dc.tsv @@ websearch_to_tsquery('english', $1)
      ORDER BY rank_score DESC
      LIMIT $3
    `;

    const res = await query<KeywordMatchRow>(sql, [queryText, tenantId, limit]);
    return res.rows;
  }
}
