import assert from "assert";
import { query, closePool } from "../src/db/client.js";

async function verifyStep1() {
  console.log("\n========================================================");
  console.log("🔍 Verifying STEP 1: PostgreSQL + pgvector Foundation");
  console.log("========================================================\n");

  try {
    // 1. Verify vector extension
    console.log("1. Checking 'vector' extension in Neon PostgreSQL...");
    const extRes = await query(
      "SELECT extname, extversion FROM pg_extension WHERE extname = 'vector'"
    );
    assert.strictEqual(extRes.rowCount, 1, "Extension 'vector' must be installed");
    console.log(`  ✓ 'vector' extension is active (version: ${extRes.rows[0].extversion})`);

    // 2. Verify document_chunks table exists
    console.log("\n2. Checking 'document_chunks' table...");
    const tableRes = await query(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'document_chunks' AND table_schema = 'public'"
    );
    assert.strictEqual(tableRes.rowCount, 1, "'document_chunks' table must exist");
    console.log("  ✓ Table 'document_chunks' exists in public schema");

    // 3. Verify columns and data types
    console.log("\n3. Inspecting column definitions and data types...");
    const colRes = await query(`
      SELECT column_name, data_type, udt_name
      FROM information_schema.columns
      WHERE table_name = 'document_chunks'
      ORDER BY ordinal_position
    `);
    const cols = colRes.rows.map((r: any) => ({
      name: r.column_name,
      type: r.data_type,
      udt: r.udt_name,
    }));

    const colMap = new Map(cols.map((c) => [c.name, c]));

    // Check mandatory columns
    const expected = [
      "id",
      "document_id",
      "tenant_id",
      "chunk_index",
      "content",
      "heading_path",
      "token_count",
      "embedding",
      "embedding_model",
      "tsv",
      "created_at",
      "updated_at",
    ];

    for (const exp of expected) {
      assert.ok(colMap.has(exp), `Column '${exp}' must exist in document_chunks`);
      console.log(`  ✓ Column '${exp}' present (${colMap.get(exp)!.type} / ${colMap.get(exp)!.udt})`);
    }

    // Verify embedding column specifically uses 'vector' udt
    const embCol = colMap.get("embedding")!;
    assert.strictEqual(embCol.udt, "vector", "embedding column must be of type 'vector'");
    console.log("  ✓ Confirmed 'embedding' column uses PostgreSQL 'vector' type");

    // 4. Verify indexes
    console.log("\n4. Checking indexes...");
    const idxRes = await query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'document_chunks'
    `);
    const idxNames = idxRes.rows.map((r: any) => r.indexname);
    console.log(`  Found ${idxNames.length} indexes: ${idxNames.join(", ")}`);

    assert.ok(idxNames.includes("idx_document_chunks_tenant_id"), "Tenant index must exist");
    assert.ok(idxNames.includes("idx_document_chunks_document_id"), "Document ID index must exist");
    assert.ok(idxNames.includes("idx_document_chunks_embedding"), "HNSW embedding index must exist");
    assert.ok(idxNames.includes("idx_document_chunks_tsv"), "GIN full-text search index must exist");
    console.log("  ✓ All required scoping, full-text (GIN), and HNSW vector indexes exist");

    // 5. Test vector insertion and tenant-scoped retrieval
    console.log("\n5. Testing vector insertion and tenant query...");
    // Grab a test tenant and document
    const tenantRes = await query("SELECT id FROM tenants LIMIT 1");
    assert.ok(tenantRes.rowCount && tenantRes.rowCount > 0, "At least one tenant must exist");
    const tenantId = tenantRes.rows[0].id;

    // Grab or create a test document
    let docId: string;
    const docRes = await query("SELECT id FROM documents WHERE tenant_id = $1 LIMIT 1", [tenantId]);
    if (docRes.rowCount && docRes.rowCount > 0) {
      docId = docRes.rows[0].id;
    } else {
      const insDoc = await query(
        `INSERT INTO documents (tenant_id, title, original_filename, storage_key, mime_type, file_size)
         VALUES ($1, 'Test Doc', 'test.txt', 'test-key', 'text/plain', 100)
         RETURNING id`,
        [tenantId]
      );
      docId = insDoc.rows[0].id;
    }

    // Generate a dummy 768-dim normalized vector
    const dummyVector = `[${Array(768).fill(0.01).join(",")}]`;

    const insChunk = await query(
      `INSERT INTO document_chunks (
        document_id, tenant_id, chunk_index, content, heading_path, token_count, embedding
      ) VALUES ($1, $2, 0, 'This is a sample knowledge chunk for testing.', 'Section > Intro', 10, $3)
      RETURNING id, chunk_index, content, (embedding IS NOT NULL) AS has_embedding`,
      [docId, tenantId, dummyVector]
    );

    assert.strictEqual(insChunk.rowCount, 1);
    const chunkId = insChunk.rows[0].id;
    assert.strictEqual(insChunk.rows[0].has_embedding, true);
    console.log(`  ✓ Inserted test chunk with 768-dim vector (ID: ${chunkId})`);

    // Verify tenant-scoped vector query
    const fetchChunk = await query(
      `SELECT id, content, (embedding <=> $1::vector) as distance
       FROM document_chunks
       WHERE id = $2 AND tenant_id = $3`,
      [dummyVector, chunkId, tenantId]
    );
    assert.strictEqual(fetchChunk.rowCount, 1);
    console.log(`  ✓ Tenant-scoped vector distance computed successfully (distance: ${fetchChunk.rows[0].distance})`);

    // Clean up test chunk
    await query("DELETE FROM document_chunks WHERE id = $1", [chunkId]);
    console.log("  ✓ Cleaned up test chunk");

    console.log("\n========================================================");
    console.log("🎉 STEP 1 VERIFICATION PASSED: pgvector & document_chunks READY!");
    console.log("========================================================\n");
  } finally {
    await closePool();
  }
}

verifyStep1().catch((err) => {
  console.error("❌ Verification failed:", err);
  process.exit(1);
});

