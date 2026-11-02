import dotenv from "dotenv";
dotenv.config();

import { pool } from "../src/db/client.js";
import { GeminiEmbeddingProvider } from "../src/modules/rag/embeddings/gemini-embedding.provider.js";
import { ChunkRepository } from "../src/modules/documents/chunk.repository.js";
import { EmbeddingService } from "../src/modules/rag/embeddings/embedding.service.js";

async function reindexAllChunks() {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured in environment.");
  }

  const modelName = process.env.EMBEDDING_MODEL || "gemini-embedding-001";
  console.log(`Starting safe real-embedding re-indexing using Gemini model: ${modelName}`);

  const provider = new GeminiEmbeddingProvider(apiKey, modelName);

  // 1. Fetch all tenants
  const tenantsRes = await pool.query("SELECT id, name FROM tenants ORDER BY name;");
  const tenants = tenantsRes.rows;

  let totalReindexed = 0;
  let totalErrors = 0;

  for (const tenant of tenants) {
    console.log(`\n--- Processing Tenant: ${tenant.name} (${tenant.id}) ---`);

    // Fetch chunks for this tenant that need real embedding indexing
    const chunksRes = await pool.query(
      `SELECT id, document_id, tenant_id, chunk_index, content, heading_path, token_count, embedding_model
       FROM document_chunks
       WHERE tenant_id = $1 AND (embedding_model IS NULL OR embedding_model != $2)
       ORDER BY document_id, chunk_index;`,
      [tenant.id, modelName]
    );

    const chunks = chunksRes.rows;
    console.log(`Found ${chunks.length} chunks for tenant ${tenant.name}.`);

    if (chunks.length === 0) continue;

    // Process in batches of 25
    const BATCH_SIZE = 25;
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      const preparedTexts = batch.map((c) =>
        EmbeddingService.prepareChunkText(c.content, c.heading_path)
      );

      console.log(
        `  Embedding batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(chunks.length / BATCH_SIZE)} (${batch.length} chunks)...`
      );

      let batchSuccess = false;
      let retries = 0;
      while (!batchSuccess && retries < 3) {
        try {
          const vectors = await provider.embedBatch(preparedTexts, {
            taskType: "RETRIEVAL_DOCUMENT",
          });

          const updates = batch.map((chunk, idx) => ({
            id: chunk.id,
            tenantId: chunk.tenant_id,
            embedding: vectors[idx],
            model: modelName,
          }));

          await ChunkRepository.saveChunkEmbeddings(updates);
          totalReindexed += batch.length;
          console.log(`    ✓ Saved ${batch.length} real Gemini embeddings.`);
          batchSuccess = true;
          // gentle delay between batches
          await new Promise((r) => setTimeout(r, 2000));
        } catch (err: any) {
          retries++;
          if (err.message?.includes("quota") || err.message?.includes("Quota") || err.message?.includes("rate-limits")) {
            console.log(`    ⏳ Rate limit reached, waiting 35 seconds before retry...`);
            await new Promise((r) => setTimeout(r, 35000));
          } else {
            console.error(`    ❌ Batch error (attempt ${retries}): ${err.message}`);
            await new Promise((r) => setTimeout(r, 5000));
          }
        }
      }
      if (!batchSuccess) {
        totalErrors += batch.length;
      }
    }

    // Verify document readiness for this tenant:
    // Mark documents ready if all their chunks have real embeddings
    const docsRes = await pool.query(
      `SELECT d.id, d.title
       FROM documents d
       WHERE d.tenant_id = $1 AND d.status != 'archived';`,
      [tenant.id]
    );

    for (const doc of docsRes.rows) {
      const pendingRes = await pool.query(
        `SELECT COUNT(*) as count
         FROM document_chunks
         WHERE document_id = $1 AND tenant_id = $2 AND (embedding IS NULL OR embedding_model != $3);`,
        [doc.id, tenant.id, modelName]
      );
      const pending = parseInt(pendingRes.rows[0].count, 10);
      if (pending === 0) {
        await pool.query(
          `UPDATE documents SET status = 'ready', error_message = NULL, updated_at = NOW() WHERE id = $1 AND tenant_id = $2;`,
          [doc.id, tenant.id]
        );
      }
    }
  }

  console.log("\n========================================================");
  console.log(`Re-indexing Complete!`);
  console.log(`Total chunks re-indexed with real embeddings: ${totalReindexed}`);
  console.log(`Total errors: ${totalErrors}`);
  console.log("========================================================\n");

  // Final check of embedding models in database
  const finalSummary = await pool.query(`
    SELECT embedding_model, count(*) as count
    FROM document_chunks
    GROUP BY embedding_model;
  `);
  console.log("FINAL CHUNKS BY MODEL:");
  console.table(finalSummary.rows);

  await pool.end();
}

reindexAllChunks().catch((err) => {
  console.error("Fatal reindex error:", err);
  process.exit(1);
});

