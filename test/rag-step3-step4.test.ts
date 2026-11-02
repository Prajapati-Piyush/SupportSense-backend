import assert from "assert";
import { buildApp } from "../src/app.js";
import { closePool, query } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { runSeed } from "../src/db/seed.js";
import { EmbeddingProviderFactory } from "../src/modules/rag/embeddings/embedding-provider.factory.js";
import { MockEmbeddingProvider } from "../src/modules/rag/embeddings/mock-embedding.provider.js";
import { GeminiEmbeddingProvider } from "../src/modules/rag/embeddings/gemini-embedding.provider.js";
import { EmbeddingService } from "../src/modules/rag/embeddings/embedding.service.js";
import { ChunkRepository } from "../src/modules/documents/chunk.repository.js";
import { DocumentService } from "../src/modules/documents/document.service.js";
import { RetrievalService } from "../src/modules/rag/retrieval/retrieval.service.js";

function extractCookie(cookieHeader: string | string[] | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const rawHeaders = Array.isArray(cookieHeader) ? cookieHeader : [cookieHeader];
  for (const header of rawHeaders) {
    const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    if (match) return match[1];
  }
  return null;
}

async function runStep3And4Tests() {
  console.log("\n========================================================");
  console.log("🧪 SupportSense RAG Step 3 & Step 4: Embeddings & Retrieval Tests");
  console.log("========================================================\n");

  await runMigrations();
  await runSeed();

  const app = buildApp();
  await app.ready();

  // Ensure deterministic test embedding provider is set
  const mockProvider = new MockEmbeddingProvider("mock-text-embedding-768");
  EmbeddingProviderFactory.setProvider(mockProvider);

  try {
    // ------------------------------------------------------------------------
    // PHASE 1: Embedding Provider Unit Tests & Resiliency
    // ------------------------------------------------------------------------
    console.log("--- Phase 1: Embedding Provider Unit Tests & Resiliency ---");

    // 1.1 Vector Dimensions & Normalization
    console.log("  1.1 Verify embedding dimensions (768) and unit normalization");
    const testText = "SupportSense AI knowledge retrieval system";
    const vector = await mockProvider.embedText(testText);
    assert.strictEqual(vector.length, 768, "Embedding dimension must be exactly 768");
    assert.strictEqual(mockProvider.modelName, "mock-text-embedding-768");

    // Verify L2 norm is ~1.0
    const l2Norm = Math.sqrt(vector.reduce((sum: number, v: number) => sum + v * v, 0));
    assert.ok(Math.abs(l2Norm - 1.0) < 0.01, `Embedding L2 norm (${l2Norm}) should be ~1.0`);
    console.log("    ✓ Output dimension is 768 and L2-normalized");

    // 1.2 Semantic Correlation
    console.log("  1.2 Verify semantic correlation (identical vs related vs distinct)");
    const text1 = "How to cancel a monthly subscription and get refund";
    const text2 = "How to cancel a monthly subscription and get refund";
    const text3 = "Refunds and billing cancellation requests";
    const text4 = "Configuring Kubernetes ingress controllers";

    const emb1 = await mockProvider.embedText(text1);
    const emb2 = await mockProvider.embedText(text2);
    const emb3 = await mockProvider.embedText(text3);
    const emb4 = await mockProvider.embedText(text4);

    const dotProduct = (a: number[], b: number[]) => a.reduce((sum: number, v: number, i: number) => sum + v * b[i], 0);
    const simIdentical = dotProduct(emb1, emb2);
    const simRelated = dotProduct(emb1, emb3);
    const simDistinct = dotProduct(emb1, emb4);

    assert.ok(Math.abs(simIdentical - 1.0) < 0.001, "Identical text similarity must be 1.0");
    assert.ok(simRelated > simDistinct, `Related text sim (${simRelated}) must exceed distinct (${simDistinct})`);
    console.log(`    Identical sim: ${simIdentical.toFixed(4)}, Related sim: ${simRelated.toFixed(4)}, Distinct sim: ${simDistinct.toFixed(4)}`);
    console.log("    ✓ Semantic correlation verified");

    // 1.3 Retry Behavior on Simulated 429
    console.log("  1.3 Verify bounded retry behavior on transient 429 rate limit");
    const flakyProvider = new MockEmbeddingProvider("mock-text-embedding-768");
    flakyProvider.simulateRateLimitTimes = 2; // Fails first 2 calls with 429, then succeeds
    EmbeddingProviderFactory.setProvider(flakyProvider);

    const retryResult = await EmbeddingService.embedQuery("Test retry on rate limit");
    assert.strictEqual(retryResult.embedding.length, 768);
    console.log("    ✓ Successfully recovered after transient 429 rate limits");

    // 1.4 Hard Failure when Retries Exhausted
    console.log("  1.4 Verify hard failure when retries exhausted");
    const failingProvider = new MockEmbeddingProvider("mock-text-embedding-768");
    failingProvider.simulateRateLimitTimes = 10; // Exhausts retries
    EmbeddingProviderFactory.setProvider(failingProvider);

    let errorThrown = false;
    try {
      await EmbeddingService.embedQuery("Should fail permanently");
    } catch (err: any) {
      errorThrown = true;
      assert.ok(err.message.includes("429") || err.message.includes("Rate Limit"), "Clear error message");
    }
    assert.ok(errorThrown, "Should throw when max retries exceeded");
    console.log("    ✓ Correctly threw error when retries exhausted");

    // Reset to working provider
    EmbeddingProviderFactory.setProvider(new MockEmbeddingProvider("mock-text-embedding-768"));

    // 1.5 Contextual Chunk Text Prepending
    console.log("  1.5 Verify contextual heading prepending in chunk preparation");
    const preparedWithHeading = EmbeddingService.prepareChunkText(
      "The refund period is 30 days.",
      "Billing > Refunds > Eligibility"
    );
    assert.strictEqual(
      preparedWithHeading,
      "Billing > Refunds > Eligibility\n\nThe refund period is 30 days."
    );

    const preparedWithoutHeading = EmbeddingService.prepareChunkText(
      "Direct content without heading.",
      null
    );
    assert.strictEqual(preparedWithoutHeading, "Direct content without heading.");
    console.log("    ✓ Heading hierarchy prepended appropriately");

    // 1.6 Production Environment Safety
    console.log("  1.6 Verify missing credentials in production never produce mock embeddings");
    assert.throws(
      () =>
        EmbeddingProviderFactory.createProvider({
          NODE_ENV: "production",
          EMBEDDING_PROVIDER: "gemini",
          GEMINI_API_KEY: "",
          GOOGLE_API_KEY: "",
        }),
      (err: any) => err.code === "EMBEDDING_CONFIG_ERROR",
      "Production must fail safely when Gemini credentials are missing"
    );

    assert.throws(
      () =>
        EmbeddingProviderFactory.createProvider({
          NODE_ENV: "production",
          EMBEDDING_PROVIDER: "openai",
          OPENAI_API_KEY: "",
        }),
      (err: any) => err.code === "EMBEDDING_CONFIG_ERROR",
      "Production must fail safely when OpenAI credentials are missing"
    );

    assert.throws(
      () =>
        EmbeddingProviderFactory.createProvider({
          NODE_ENV: "production",
          EMBEDDING_PROVIDER: "mock",
        }),
      (err: any) => err.code === "EMBEDDING_CONFIG_ERROR",
      "Production must forbid explicit mock provider configuration"
    );
    console.log("    ✓ Missing credentials in production safely throw EMBEDDING_CONFIG_ERROR");

    // 1.7 Explicit Mock Provider Identification
    console.log("  1.7 Verify mock provider model is clearly identified in dev/test");
    const devMock = EmbeddingProviderFactory.createProvider({
      NODE_ENV: "development",
      EMBEDDING_PROVIDER: "mock",
      EMBEDDING_MODEL: "text-embedding-004",
    });
    assert.strictEqual(devMock.providerName, "mock");
    assert.ok(
      devMock.modelName.startsWith("mock-"),
      `Mock model name '${devMock.modelName}' must be prefixed with 'mock-'`
    );
    console.log("    ✓ Mock embeddings model clearly distinguished from real provider");

    // 1.8 Gemini Embedding Provider Configuration & Task Types
    console.log("  1.8 Verify Gemini embedding provider parameters & task types");
    const geminiProvider = new GeminiEmbeddingProvider("test-dummy-key", "text-embedding-004");
    assert.strictEqual(geminiProvider.providerName, "gemini");
    assert.strictEqual(geminiProvider.modelName, "text-embedding-004");
    assert.strictEqual(geminiProvider.dimensions, 768);
    console.log("    ✓ Gemini provider configured with 768 dimensions and task type support");

    // ------------------------------------------------------------------------
    // PHASE 2: Database Persistence & Backfilling (indexPendingChunks)
    // ------------------------------------------------------------------------
    console.log("\n--- Phase 2: Database Persistence & Backfilling ---");

    // Lookup Acme tenant ID and Meera (admin)
    const acmeTenantRes = await query<{ id: string }>("SELECT id FROM tenants WHERE slug = 'acme'");
    const acmeTenantId = acmeTenantRes.rows[0].id;
    const meeraUserRes = await query<{ id: string }>("SELECT id FROM users WHERE email = 'meera@acme.test'");
    const meeraUserId = meeraUserRes.rows[0].id;

    // 2.1 Seed a document with NULL embeddings (simulating Step 2)
    console.log("  2.1 Insert document with NULL embedding chunks");
    const uniqueSuffix = Date.now();
    const docInsertRes = await query<{ id: string }>(
      `INSERT INTO documents (tenant_id, original_filename, storage_key, mime_type, file_size, status, uploaded_by, title)
       VALUES ($1, 'legacy_guide.md', 'legacy/key', 'text/markdown', 500, 'ready', $2, $3)
       RETURNING id;`,
      [acmeTenantId, meeraUserId, `Legacy User Guide ${uniqueSuffix}`]
    );
    const legacyDocId = docInsertRes.rows[0].id;

    await query(
      `INSERT INTO document_chunks (document_id, tenant_id, chunk_index, content, heading_path, token_count, embedding, embedding_model)
       VALUES 
       ($1, $2, 0, 'Acme Legacy Chunk 0: Getting started with the dashboard.', 'Overview', 12, NULL, NULL),
       ($1, $2, 1, 'Acme Legacy Chunk 1: Configuring user notifications and alerts.', 'Settings', 14, NULL, NULL);`,
      [legacyDocId, acmeTenantId]
    );

    // Verify pending chunks exist
    const pendingBefore = await ChunkRepository.countPendingChunks(acmeTenantId);
    assert.ok(pendingBefore >= 2, `Pending chunks should be >= 2, got ${pendingBefore}`);
    console.log(`    Found ${pendingBefore} pending chunks without embeddings`);

    // 2.2 Run indexPendingChunks backfill
    console.log("  2.2 Run DocumentService.indexPendingChunks to backfill embeddings");
    const firstBatch = await DocumentService.indexPendingChunks(acmeTenantId, 10);
    assert.strictEqual(firstBatch.indexedCount, Math.min(10, pendingBefore), "Indexed count matches batch bounds");
    assert.strictEqual(firstBatch.remainingCount, Math.max(0, pendingBefore - 10), "Remaining count matches delta");
    console.log(`    Batch indexed ${firstBatch.indexedCount} chunks (${firstBatch.remainingCount} remaining)`);

    if (firstBatch.remainingCount > 0) {
      const finishBatch = await DocumentService.indexPendingChunks(acmeTenantId, 100);
      assert.strictEqual(finishBatch.remainingCount, 0, "No pending chunks should remain for tenant");
      console.log(`    Second batch finished indexing remaining chunks`);
    }

    // Verify in database
    const chunksInDb = await ChunkRepository.findByDocument(legacyDocId, acmeTenantId);
    for (const chunk of chunksInDb) {
      assert.ok(chunk.embeddingModel, "embedding_model must be populated");
      // Check pgvector column is not null in raw query
      const rawCheck = await query<{ has_embedding: boolean }>(
        `SELECT (embedding IS NOT NULL) as has_embedding FROM document_chunks WHERE id = $1`,
        [chunk.id]
      );
      assert.strictEqual(rawCheck.rows[0].has_embedding, true, "embedding vector must not be null");
    }
    console.log("    ✓ Legacy chunks backfilled and 768-dim embeddings persisted in pgvector");

    // ------------------------------------------------------------------------
    // PHASE 3: Lifecycle Integration & Error Handling
    // ------------------------------------------------------------------------
    console.log("\n--- Phase 3: Lifecycle Integration & Error Handling ---");

    // 3.1 Normal Upload Lifecycle (extract -> chunk -> embed -> ready)
    console.log("  3.1 Upload new document and verify automated end-to-end indexing");
    const docContent = `# Acme Billing Policy
## Refunds
Customers may request a full refund within 30 days of subscription renewal.
Refund processing takes 3-5 business days to appear on your bank statement.

## Plan Upgrades
Upgrades take effect immediately with prorated charges.`;

    const uploadedDoc = await DocumentService.uploadDocument({
      tenantId: acmeTenantId,
      userId: meeraUserId,
      filename: `billing_policy_${uniqueSuffix}.md`,
      mimeType: "text/markdown",
      fileBuffer: Buffer.from(docContent, "utf8"),
      customTitle: "Acme Billing Policy",
    });

    assert.strictEqual(uploadedDoc.status, "ready", "Status must be 'ready' after successful indexing");
    const uploadedChunks = await ChunkRepository.findByDocument(uploadedDoc.id, acmeTenantId);
    assert.ok(uploadedChunks.length >= 2, "Should create multiple chunks");
    for (const c of uploadedChunks) {
      assert.ok(c.embeddingModel, "Each chunk must have embeddingModel set");
    }
    console.log("    ✓ Uploaded document transitioned to 'ready' with all chunks embedded");

    // 3.2 Embedding Failure Lifecycle: Must Mark Document as 'failed'
    console.log("  3.2 Verify document marked as 'failed' when embedding generation fails");
    const failureProvider = new MockEmbeddingProvider("mock-text-embedding-768");
    failureProvider.simulateRateLimitTimes = 999;
    EmbeddingProviderFactory.setProvider(failureProvider);

    const uploadedFailedDoc = await DocumentService.uploadDocument({
      tenantId: acmeTenantId,
      userId: meeraUserId,
      filename: `failing_policy_${uniqueSuffix}.md`,
      mimeType: "text/markdown",
      fileBuffer: Buffer.from("# Will Fail\n\nContent that cannot be embedded.", "utf8"),
      customTitle: `Failing Document ${uniqueSuffix}`,
    });

    assert.strictEqual(uploadedFailedDoc.status, "failed", "Document status must be set to 'failed'");
    assert.ok(
      uploadedFailedDoc.errorMessage && uploadedFailedDoc.errorMessage.includes("Embedding generation failed"),
      `Error message must record embedding failure: ${uploadedFailedDoc.errorMessage}`
    );

    // Inspect document in database by ID
    const failedDocs = await query<{ status: string; error_message: string }>(
      "SELECT status, error_message FROM documents WHERE id = $1 AND tenant_id = $2",
      [uploadedFailedDoc.id, acmeTenantId]
    );
    assert.strictEqual(failedDocs.rows.length, 1);
    assert.strictEqual(failedDocs.rows[0].status, "failed", "Document status in DB must be 'failed'");
    assert.ok(
      failedDocs.rows[0].error_message.includes("Embedding generation failed"),
      "Error message in DB must record embedding failure"
    );
    console.log("    ✓ Document lifecycle safely marked status='failed' with descriptive error");

    // 3.3 Reprocess Recovers Failed Document
    console.log("  3.3 Verify reprocessing failed document with healthy provider restores it to 'ready'");
    // Restore healthy provider
    EmbeddingProviderFactory.setProvider(new MockEmbeddingProvider("mock-text-embedding-768"));
    const failedDocId = uploadedFailedDoc.id;

    const reprocessedDoc = await DocumentService.reprocessDocument(failedDocId, acmeTenantId);
    assert.strictEqual(reprocessedDoc.status, "ready", "Reprocessed document must be 'ready'");
    assert.strictEqual(reprocessedDoc.errorMessage, null, "Error message must be cleared");

    const reprocessedChunks = await ChunkRepository.findByDocument(failedDocId, acmeTenantId);
    assert.ok(reprocessedChunks.length > 0, "Reprocessed chunks must be created");
    for (const c of reprocessedChunks) {
      assert.ok(c.embeddingModel, "Reprocessed chunks must have embedding_model");
    }
    console.log("    ✓ Reprocess safely deleted old state and created indexed chunks");

    // ------------------------------------------------------------------------
    // PHASE 4: Semantic Vector Search & Keyword Search
    // ------------------------------------------------------------------------
    console.log("\n--- Phase 4: Semantic Vector Search & Keyword Search ---");

    // Upload another document with distinct topic
    const techDocContent = `# Acme API Documentation
## Rate Limits
All API endpoints are rate-limited to 1000 requests per minute per tenant.
Exceeding the limit results in HTTP 429 Too Many Requests response headers.

## Authentication
Use Bearer token authentication in the Authorization header.`;

    await DocumentService.uploadDocument({
      tenantId: acmeTenantId,
      userId: meeraUserId,
      filename: `api_docs_${uniqueSuffix}.md`,
      mimeType: "text/markdown",
      fileBuffer: Buffer.from(techDocContent, "utf8"),
      customTitle: "Acme API Docs",
    });

    // 4.1 Semantic Search
    console.log("  4.1 Semantic search: query 'How do I get a refund?'");
    const semanticRes = await RetrievalService.retrieve("How do I get a refund?", acmeTenantId, {
      mode: "semantic",
      topK: 3,
      similarityThreshold: 0.05,
    });

    assert.strictEqual(semanticRes.mode, "semantic");
    assert.ok(semanticRes.results.length > 0, "Semantic search should return matches");
    const topSemantic = semanticRes.results[0];
    assert.ok(topSemantic.similarityScore !== null, "Similarity score must be computed");
    assert.ok(
      topSemantic.content.toLowerCase().includes("refund"),
      `Top semantic chunk should discuss refunds, got: ${topSemantic.content}`
    );
    assert.strictEqual(topSemantic.matchType, "semantic");
    console.log(`    Top semantic match similarity: ${topSemantic.similarityScore?.toFixed(4)}`);
    console.log("    ✓ Semantic vector search ranked relevant refund chunk #1");

    // 4.2 Keyword Search
    console.log("  4.2 Keyword search: query 'HTTP 429 requests per minute'");
    const keywordRes = await RetrievalService.retrieve("HTTP 429 requests per minute", acmeTenantId, {
      mode: "keyword",
      topK: 3,
    });

    assert.strictEqual(keywordRes.mode, "keyword");
    assert.ok(keywordRes.results.length > 0, "Keyword search should return matches");
    const topKeyword = keywordRes.results[0];
    assert.ok(topKeyword.keywordScore !== null && topKeyword.keywordScore > 0, "Keyword score must be positive");
    assert.ok(
      topKeyword.content.toLowerCase().includes("429") || topKeyword.content.toLowerCase().includes("rate"),
      "Top keyword chunk should match API documentation"
    );
    assert.strictEqual(topKeyword.matchType, "keyword");
    console.log(`    Top keyword match rank_score: ${topKeyword.keywordScore?.toFixed(4)}`);
    console.log("    ✓ Keyword GIN full-text search ranked exact match chunk #1");

    // 4.3 Unready Document Exclusion from Retrieval (failed, processing, and partial indexing)
    console.log("  4.3 Verify unready document states are excluded from retrieval");
    await query("DELETE FROM documents WHERE title IN ('Partial Doc', 'Processing Doc', 'Failed Doc')");
    const testMockVec = await mockProvider.embedText("SecretUnreadyTestWord");
    const vectorLiteral = `[${testMockVec.join(",")}]`;
    const unreadySuffix = Date.now();
    const secretFailed = `ExclusiveSecretFailedContent_${unreadySuffix}`;
    const secretProcessing = `ExclusiveSecretProcessingContent_${unreadySuffix}`;
    const secretPartial = `ExclusiveSecretPartialContent_${unreadySuffix}`;

    // 4.3.1 Failed document
    const failedDocInsert = await query<{ id: string }>(
      `INSERT INTO documents (tenant_id, original_filename, storage_key, mime_type, file_size, status, uploaded_by, title)
       VALUES ($1, 'failed_doc.md', 'dummy/failed', 'text/markdown', 100, 'failed', $2, 'Failed Doc')
       RETURNING id;`,
      [acmeTenantId, meeraUserId]
    );
    await query(
      `INSERT INTO document_chunks (document_id, tenant_id, chunk_index, content, token_count, embedding, embedding_model)
       VALUES ($1, $2, 0, $3 || ': cannot be searched', 6, $4::vector, 'mock-text-embedding-768');`,
      [failedDocInsert.rows[0].id, acmeTenantId, secretFailed, vectorLiteral]
    );

    // 4.3.2 Processing document
    const processingDocInsert = await query<{ id: string }>(
      `INSERT INTO documents (tenant_id, original_filename, storage_key, mime_type, file_size, status, uploaded_by, title)
       VALUES ($1, 'processing_doc.md', 'dummy/processing', 'text/markdown', 100, 'processing', $2, 'Processing Doc')
       RETURNING id;`,
      [acmeTenantId, meeraUserId]
    );
    await query(
      `INSERT INTO document_chunks (document_id, tenant_id, chunk_index, content, token_count, embedding, embedding_model)
       VALUES ($1, $2, 0, $3 || ': cannot be searched', 6, $4::vector, 'mock-text-embedding-768');`,
      [processingDocInsert.rows[0].id, acmeTenantId, secretProcessing, vectorLiteral]
    );

    // 4.3.3 Partially indexed document (status='ready', but chunk 1 lacks embedding)
    const partialDocInsert = await query<{ id: string }>(
      `INSERT INTO documents (tenant_id, original_filename, storage_key, mime_type, file_size, status, uploaded_by, title)
       VALUES ($1, 'partial_doc.md', 'dummy/partial', 'text/markdown', 100, 'ready', $2, 'Partial Doc')
       RETURNING id;`,
      [acmeTenantId, meeraUserId]
    );
    await query(
      `INSERT INTO document_chunks (document_id, tenant_id, chunk_index, content, token_count, embedding, embedding_model)
       VALUES 
       ($1, $2, 0, $3 || ': chunk 0 has vector', 7, $4::vector, 'mock-text-embedding-768'),
       ($1, $2, 1, $3 || ': chunk 1 has null vector', 8, NULL, NULL);`,
      [partialDocInsert.rows[0].id, acmeTenantId, secretPartial, vectorLiteral]
    );

    // Search for failed doc content
    const searchFailedSemantic = await RetrievalService.retrieve(secretFailed, acmeTenantId, { mode: "semantic" });
    const searchFailedKeyword = await RetrievalService.retrieve(secretFailed, acmeTenantId, { mode: "keyword" });
    assert.strictEqual(searchFailedSemantic.results.length, 0, "Failed documents must never be returned in semantic search");
    assert.strictEqual(searchFailedKeyword.results.length, 0, "Failed documents must never be returned in keyword search");

    // Search for processing doc content
    const searchProcessing = await RetrievalService.retrieve(secretProcessing, acmeTenantId, { mode: "hybrid" });
    assert.strictEqual(searchProcessing.results.length, 0, "Processing documents must never be returned in hybrid search");

    // Search for partially indexed doc content
    const searchPartialSemantic = await RetrievalService.retrieve(secretPartial, acmeTenantId, { mode: "semantic" });
    const searchPartialKeyword = await RetrievalService.retrieve(secretPartial, acmeTenantId, { mode: "keyword" });
    assert.strictEqual(searchPartialSemantic.results.length, 0, "Partially indexed documents must never be returned in semantic search");
    assert.strictEqual(searchPartialKeyword.results.length, 0, "Partially indexed documents must never be returned in keyword search");
    console.log("    ✓ Unready documents (failed, processing, partially indexed) strictly excluded from retrieval");

    // Clean up temporary unready test docs to keep DB pristine
    await query("DELETE FROM documents WHERE id IN ($1, $2, $3)", [
      failedDocInsert.rows[0].id,
      processingDocInsert.rows[0].id,
      partialDocInsert.rows[0].id,
    ]);

    // ------------------------------------------------------------------------
    // PHASE 5: Hybrid Retrieval with Reciprocal Rank Fusion (RRF)
    // ------------------------------------------------------------------------
    console.log("\n--- Phase 5: Hybrid Retrieval with Reciprocal Rank Fusion (RRF) ---");

    // 5.1 Hybrid Search
    console.log("  5.1 Hybrid search: query 'subscription refund period'");
    const hybridRes = await RetrievalService.retrieve("subscription refund period", acmeTenantId, {
      mode: "hybrid",
      topK: 5,
      similarityThreshold: 0.05,
    });

    assert.strictEqual(hybridRes.mode, "hybrid");
    assert.ok(hybridRes.results.length > 0, "Hybrid search should return results");

    const topHybrid = hybridRes.results[0];
    assert.ok(topHybrid.rrfScore !== null && topHybrid.rrfScore > 0, "RRF score must be computed");
    assert.strictEqual(topHybrid.combinedRank, 1, "Top result must have combinedRank = 1");
    console.log(`    Top hybrid result RRF score: ${topHybrid.rrfScore?.toFixed(6)}, matchType: ${topHybrid.matchType}`);

    // Verify RRF scoring math:
    // If a chunk is rank 1 in semantic and rank 1 in keyword with k=60, semanticWeight=1, keywordWeight=1:
    // RRF = 1/(60+1) + 1/(60+1) = 2/61 = ~0.032786
    const testRrfChunks = RetrievalService.fuseWithRRF(
      [
        {
          id: "chunk-1",
          document_id: "doc-1",
          tenant_id: acmeTenantId,
          chunk_index: 0,
          content: "Content 1",
          heading_path: null,
          token_count: 50,
          embedding_model: "mock-text-embedding-768",
          document_title: "Title 1",
          original_filename: "doc1.md",
          source_type: "upload",
          similarity: 0.95,
        },
      ],
      [
        {
          id: "chunk-1",
          document_id: "doc-1",
          tenant_id: acmeTenantId,
          chunk_index: 0,
          content: "Content 1",
          heading_path: null,
          token_count: 50,
          embedding_model: "mock-text-embedding-768",
          document_title: "Title 1",
          original_filename: "doc1.md",
          source_type: "upload",
          rank_score: 0.88,
        },
      ],
      5,
      60
    );

    assert.strictEqual(testRrfChunks.length, 1);
    const expectedScore = Number((1 / 61 + 1 / 61).toFixed(6));
    assert.strictEqual(testRrfChunks[0].rrfScore, expectedScore, "RRF score calculation must match formula");
    assert.strictEqual(testRrfChunks[0].matchType, "hybrid", "Chunk appearing in both must be 'hybrid'");
    console.log("    ✓ RRF mathematical formula verified");

    // 5.2 topK Parameter
    console.log("  5.2 Verify topK parameter limits output length");
    const top1Res = await RetrievalService.retrieve("refund policy", acmeTenantId, {
      mode: "hybrid",
      topK: 1,
      similarityThreshold: 0.05,
    });
    assert.strictEqual(top1Res.results.length, 1, "topK=1 must return exactly 1 result");

    // 5.3 similarityThreshold Parameter
    console.log("  5.3 Verify similarityThreshold filters out weak semantic matches");
    const strictRes = await RetrievalService.retrieve("completely unrelated quantum teleportation", acmeTenantId, {
      mode: "semantic",
      similarityThreshold: 0.999, // Unreachable threshold
    });
    assert.strictEqual(strictRes.results.length, 0, "High threshold should filter out unrelated chunks");

    // 5.4 Empty or whitespace query
    console.log("  5.4 Verify empty or whitespace query returns empty matches safely");
    const emptyRes = await RetrievalService.retrieve("   ", acmeTenantId);
    assert.strictEqual(emptyRes.totalMatches, 0);
    assert.strictEqual(emptyRes.results.length, 0);
    console.log("    ✓ Empty query handled cleanly without error");

    // ------------------------------------------------------------------------
    // PHASE 6: Strict Tenant Isolation
    // ------------------------------------------------------------------------
    console.log("\n--- Phase 6: Strict Tenant Isolation ---");

    // Lookup Globex tenant and Lena (admin)
    const globexTenantRes = await query<{ id: string }>("SELECT id FROM tenants WHERE slug = 'globex'");
    const globexTenantId = globexTenantRes.rows[0].id;
    const lenaUserRes = await query<{ id: string }>("SELECT id FROM users WHERE email = 'lena@globex.test'");
    const lenaUserId = lenaUserRes.rows[0].id;

    // Upload secret document for Globex
    console.log("  6.1 Uploading confidential document to Globex tenant");
    const secretContent = `# Confidential Project Apollo
Launch date is scheduled for Q4. Classified budget: fifty million dollars.`;

    await DocumentService.uploadDocument({
      tenantId: globexTenantId,
      userId: lenaUserId,
      filename: `apollo_secret_${uniqueSuffix}.md`,
      mimeType: "text/markdown",
      fileBuffer: Buffer.from(secretContent, "utf8"),
      customTitle: "Project Apollo Confidential",
    });

    // 6.2 Search from Acme tenant: Must NEVER return Globex document
    console.log("  6.2 Acme tenant searching for 'Project Apollo Classified budget'");
    const acmeApolloSemantic = await RetrievalService.retrieve("Project Apollo Classified budget", acmeTenantId, {
      mode: "semantic",
      similarityThreshold: 0.01,
    });
    for (const chunk of acmeApolloSemantic.results) {
      assert.strictEqual(chunk.tenantId, acmeTenantId, "Acme semantic results must strictly belong to Acme");
      assert.notStrictEqual(chunk.tenantId, globexTenantId, "Must never return Globex tenant chunks");
      assert.ok(!chunk.content.includes("Apollo"), "Must never leak confidential Apollo text");
    }

    const acmeApolloKeyword = await RetrievalService.retrieve("Project Apollo Classified budget", acmeTenantId, {
      mode: "keyword",
    });
    for (const chunk of acmeApolloKeyword.results) {
      assert.strictEqual(chunk.tenantId, acmeTenantId, "Acme keyword results must strictly belong to Acme");
      assert.notStrictEqual(chunk.tenantId, globexTenantId, "Must never return Globex tenant chunks");
      assert.ok(!chunk.content.includes("Apollo"), "Must never leak confidential Apollo text");
    }

    const acmeApolloHybrid = await RetrievalService.retrieve("Project Apollo Classified budget", acmeTenantId, {
      mode: "hybrid",
      similarityThreshold: 0.01,
    });
    for (const chunk of acmeApolloHybrid.results) {
      assert.strictEqual(chunk.tenantId, acmeTenantId, "Acme hybrid results must strictly belong to Acme");
      assert.notStrictEqual(chunk.tenantId, globexTenantId, "Must never return Globex tenant chunks");
      assert.ok(!chunk.content.includes("Apollo"), "Must never leak confidential Apollo text");
    }
    console.log("    ✓ Confirmed zero leakage of Globex chunks across semantic, keyword, and hybrid modes");

    // 6.3 Search from Globex tenant: Must find Globex document
    console.log("  6.3 Globex tenant searching for 'Project Apollo'");
    const globexApollo = await RetrievalService.retrieve("Project Apollo", globexTenantId, {
      mode: "hybrid",
      similarityThreshold: 0.05,
    });
    assert.ok(globexApollo.results.length > 0, "Globex search should find its own document");
    assert.strictEqual(globexApollo.results[0].documentTitle, "Project Apollo Confidential");
    assert.strictEqual(globexApollo.results[0].tenantId, globexTenantId);
    console.log("    ✓ Globex tenant retrieved own document successfully");

    // ------------------------------------------------------------------------
    // PHASE 7: HTTP API Endpoints & RBAC
    // ------------------------------------------------------------------------
    console.log("\n--- Phase 7: HTTP API Endpoints & RBAC ---");

    // 7.1 Unauthenticated Request -> 401
    console.log("  7.1 Unauthenticated POST /api/retrieval returns 401");
    const unauthRes = await app.inject({
      method: "POST",
      url: "/api/retrieval",
      payload: { query: "refund policy" },
    });
    assert.strictEqual(unauthRes.statusCode, 401, "Unauthenticated request must return 401");

    // 7.2 Customer Role -> 403 Forbidden
    console.log("  7.2 Customer role (priya@example.com) POST /api/retrieval returns 403");
    const customerLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "priya@example.com", password: "demo1234" },
    });
    const customerCookie = extractCookie(customerLogin.headers["set-cookie"], "session_id");

    const customerRes = await app.inject({
      method: "POST",
      url: "/api/retrieval",
      headers: { cookie: `session_id=${customerCookie}` },
      payload: { query: "refund policy" },
    });
    assert.strictEqual(customerRes.statusCode, 403, "Customer role must be forbidden (403)");
    console.log("    ✓ Customer role correctly blocked by RBAC");

    // 7.3 Staff Role -> 200 OK on /api/retrieval
    console.log("  7.3 Staff role (rahul@acme.test) POST /api/retrieval returns 200");
    const staffLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "rahul@acme.test", password: "demo1234" },
    });
    const staffCookie = extractCookie(staffLogin.headers["set-cookie"], "session_id");

    const staffRes = await app.inject({
      method: "POST",
      url: "/api/retrieval",
      headers: { cookie: `session_id=${staffCookie}` },
      payload: { query: "refund policy", topK: 3, mode: "hybrid", similarityThreshold: 0.05 },
    });
    assert.strictEqual(staffRes.statusCode, 200, "Staff role should succeed (200)");
    const staffBody = JSON.parse(staffRes.payload);
    assert.strictEqual(staffBody.success, true);
    assert.ok(staffBody.data.results.length > 0);
    // Verify tenant isolation: all returned chunks must belong to Acme tenant
    for (const chunk of staffBody.data.results) {
      assert.strictEqual(chunk.tenantId, acmeTenantId, "Chunk tenant must match authenticated user tenant");
    }
    console.log("    ✓ Staff POST /api/retrieval succeeded with tenant-isolated data");

    // 7.4 POST /api/documents/retrieve alias endpoint
    console.log("  7.4 POST /api/documents/retrieve alias returns 200");
    const aliasRes = await app.inject({
      method: "POST",
      url: "/api/documents/retrieve",
      headers: { cookie: `session_id=${staffCookie}` },
      payload: { query: "API rate limits", topK: 2, similarityThreshold: 0.05 },
    });
    assert.strictEqual(aliasRes.statusCode, 200);
    const aliasBody = JSON.parse(aliasRes.payload);
    assert.strictEqual(aliasBody.success, true);
    console.log("    ✓ POST /api/documents/retrieve alias works correctly");

    // 7.5 POST /api/retrieval/index-pending
    console.log("  7.5 Admin POST /api/retrieval/index-pending returns 200");
    const meeraLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "meera@acme.test", password: "demo1234" },
    });
    const meeraCookie = extractCookie(meeraLogin.headers["set-cookie"], "session_id");

    const indexPendingRes = await app.inject({
      method: "POST",
      url: "/api/retrieval/index-pending",
      headers: { cookie: `session_id=${meeraCookie}` },
      payload: { batchSize: 50 },
    });
    assert.strictEqual(indexPendingRes.statusCode, 200);
    const indexPendingBody = JSON.parse(indexPendingRes.payload);
    assert.strictEqual(indexPendingBody.success, true);
    console.log("    ✓ POST /api/retrieval/index-pending executed successfully");

    // 7.6 Request Validation Error on Missing/Invalid Query
    console.log("  7.6 Empty query payload returns 400 Validation Error");
    const invalidRes = await app.inject({
      method: "POST",
      url: "/api/retrieval",
      headers: { cookie: `session_id=${staffCookie}` },
      payload: { query: "" },
    });
    assert.strictEqual(invalidRes.statusCode, 400);
    const invalidBody = JSON.parse(invalidRes.payload);
    assert.strictEqual(invalidBody.error.code, "VALIDATION_ERROR");
    console.log("    ✓ Request validation enforced on retrieval payload");

    console.log("\n========================================================");
    console.log("🎉 ALL RAG STEP 3 & STEP 4 TESTS PASSED SUCCESSFULLY!");
    console.log("========================================================\n");
  } finally {
    await app.close();
    await closePool();
  }
}

runStep3And4Tests().catch((err) => {
  console.error("\n❌ RAG Step 3 & 4 test suite failed with error:", err);
  process.exit(1);
});

