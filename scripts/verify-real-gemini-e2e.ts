import assert from "assert";
import dotenv from "dotenv";
dotenv.config();

import { buildApp } from "../src/app.js";
import { pool } from "../src/db/client.js";
import { EmbeddingProviderFactory } from "../src/modules/rag/embeddings/embedding-provider.factory.js";
import { GeminiEmbeddingProvider } from "../src/modules/rag/embeddings/gemini-embedding.provider.js";
import { LLMProviderFactory } from "../src/modules/rag/generation/llm-provider.factory.js";
import { GeminiLLMProvider } from "../src/modules/rag/generation/gemini-llm.provider.js";

function extractCookie(cookieHeader: string | string[] | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const rawHeaders = Array.isArray(cookieHeader) ? cookieHeader : [cookieHeader];
  for (const header of rawHeaders) {
    const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    if (match) return match[1];
  }
  return null;
}

async function runEndToEndVerification() {
  console.log("\n========================================================");
  console.log("🚀 Real Gemini End-to-End Verification of RAG Steps 1–6");
  console.log("========================================================\n");

  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  assert.ok(apiKey, "GEMINI_API_KEY must exist");

  const embeddingModel = process.env.EMBEDDING_MODEL || "gemini-embedding-001";
  const llmModel = process.env.LLM_MODEL || "gemini-3.5-flash";

  console.log(`Embedding Model: ${embeddingModel} (768 dimensions)`);
  console.log(`LLM Model: ${llmModel}`);

  // Set real providers explicitly
  const realEmbeddingProvider = new GeminiEmbeddingProvider(apiKey, embeddingModel);
  EmbeddingProviderFactory.setProvider(realEmbeddingProvider);

  const realLLMProvider = new GeminiLLMProvider(apiKey, llmModel);
  LLMProviderFactory.setProvider(realLLMProvider);

  const app = buildApp();
  await app.ready();

  // Snapshot tickets & messages count to verify NO side effects
  const ticketsCountBefore = parseInt((await pool.query("SELECT COUNT(*) FROM tickets;")).rows[0].count, 10);
  const messagesCountBefore = parseInt((await pool.query("SELECT COUNT(*) FROM ticket_messages;")).rows[0].count, 10);
  console.log(`Initial DB State: ${ticketsCountBefore} tickets, ${messagesCountBefore} messages.`);

  try {
    // ------------------------------------------------------------------------
    // Step 1: Login as Acme Admin
    // ------------------------------------------------------------------------
    console.log("\n--- Step 1: Authenticate as Acme Admin ---");
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "meera@acme.test",
        password: "demo1234",
      },
    });

    assert.strictEqual(loginRes.statusCode, 200, "Admin login must succeed");
    const adminUser = JSON.parse(loginRes.payload).user;
    const acmeTenantId = adminUser.tenantId;
    assert.strictEqual(adminUser.role, "admin");
    const acmeCookie = extractCookie(loginRes.headers["set-cookie"], "session_id");
    assert.ok(acmeCookie, "Session cookie 'session_id' must be set");
    console.log(`  ✓ Signed in as ${adminUser.email} (Tenant: Acme Cloud, ${acmeTenantId})`);

    // ------------------------------------------------------------------------
    // Step 2: Upload a Real Test Knowledge Document
    // ------------------------------------------------------------------------
    console.log("\n--- Step 2: Upload Real Test Document & Verify Real Gemini Indexing ---");
    const docUniqueId = Date.now();
    const docTitle = `Acme Ultra Cloud SLA Policy ${docUniqueId}`;
    const docContent = `# Acme Ultra Cloud SLA Policy

## Overview
Acme Ultra Cloud guarantees 99.99% uptime for all mission-critical cloud compute workloads.

## Downtime Compensation
If availability drops below 99.99% in any calendar month, eligible customers receive a 25% credit on their monthly invoice.
If availability drops below 99.50%, customers receive an automatic 50% credit.
To claim downtime credit, file a claim through the customer portal within 30 days of the incident.

## Exclusions
Maintenance windows announced at least 72 hours in advance are strictly excluded from downtime calculations.
`;

    // Upload via DocumentService / app route
    // Fastify injection with multipart boundary
    const boundary = "---------------------------974767299852498929531610575";
    const bodyParts = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="title"`,
      "",
      docTitle,
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="ultra_sla_${docUniqueId}.md"`,
      "Content-Type: text/markdown",
      "",
      docContent,
      `--${boundary}--`,
      "",
    ].join("\r\n");

    const uploadRes = await app.inject({
      method: "POST",
      url: "/api/documents",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        cookie: `session_id=${acmeCookie}`,
      },
      payload: bodyParts,
    });

    assert.strictEqual(uploadRes.statusCode, 201, `Document upload must return 201, got ${uploadRes.statusCode}: ${uploadRes.payload}`);
    const payloadParsed = JSON.parse(uploadRes.payload);
    const uploadedDoc = payloadParsed.document || payloadParsed;
    assert.strictEqual(uploadedDoc.title, docTitle);
    assert.strictEqual(uploadedDoc.status, "ready", "Document must be ready after real embedding generation");
    console.log(`  ✓ Document uploaded successfully: ID ${uploadedDoc.id}, Status: '${uploadedDoc.status}'`);

    // Verify chunk persistence in DB
    const chunkRows = await pool.query(
      `SELECT id, chunk_index, token_count, embedding_model, (embedding IS NOT NULL) as has_vector
       FROM document_chunks
       WHERE document_id = $1 AND tenant_id = $2
       ORDER BY chunk_index;`,
      [uploadedDoc.id, acmeTenantId]
    );

    assert.ok(chunkRows.rows.length > 0, "Document must produce chunks");
    for (const chk of chunkRows.rows) {
      assert.strictEqual(chk.has_vector, true, "Chunk must have non-null embedding");
      assert.strictEqual(chk.embedding_model, embeddingModel, `Chunk model must be ${embeddingModel}`);
    }
    console.log(`  ✓ Verified ${chunkRows.rows.length} chunks stored with real ${embeddingModel} embeddings in Neon PostgreSQL.`);

    // ------------------------------------------------------------------------
    // Step 3: Hybrid Search Retrieval
    // ------------------------------------------------------------------------
    console.log("\n--- Step 3: Test Hybrid Search Retrieval via /api/retrieval ---");
    const testQuery = "What is the downtime credit if availability drops below 99.50%?";
    const retrievalRes = await app.inject({
      method: "POST",
      url: "/api/retrieval",
      headers: {
        cookie: `session_id=${acmeCookie}`,
        "content-type": "application/json",
      },
      payload: {
        query: testQuery,
        mode: "hybrid",
        topK: 5,
      },
    });

    assert.strictEqual(retrievalRes.statusCode, 200, `Retrieval must return 200: ${retrievalRes.payload}`);
    const resParsed = JSON.parse(retrievalRes.payload);
    const retrievalData = resParsed.data || resParsed;
    assert.ok(retrievalData.results.length > 0, "Hybrid retrieval must return matching chunks");

    const topMatch = retrievalData.results.find((r: any) => r.documentId === uploadedDoc.id);
    assert.ok(topMatch, "Retrieved results must contain the newly indexed document");
    console.log(`  ✓ Retrieved top matching chunk from "${topMatch.documentTitle}" (Match type: ${topMatch.matchType}, RRF score: ${topMatch.rrfScore})`);

    // ------------------------------------------------------------------------
    // Step 4: Grounded Answer Generation (/api/rag/answer)
    // ------------------------------------------------------------------------
    console.log("\n--- Step 4: Test Grounded Answer Generation via /api/rag/answer ---");
    const answerRes = await app.inject({
      method: "POST",
      url: "/api/rag/answer",
      headers: {
        cookie: `session_id=${acmeCookie}`,
        "content-type": "application/json",
      },
      payload: {
        question: "What is the credit for availability dropping below 99.50% and what is the claim window?",
        mode: "hybrid",
        topK: 5,
      },
    });

    assert.strictEqual(answerRes.statusCode, 200, `RAG answer must return 200: ${answerRes.payload}`);
    const answerData = JSON.parse(answerRes.payload);
    console.log("  Answer response confidence:", answerData.confidence);
    console.log("  Answer text:\n   ", answerData.answer.replace(/\n/g, "\n    "));
    console.log("  Sources count:", answerData.sources.length);
    console.log("  Metadata model:", answerData.metadata.model, "provider:", answerData.metadata.provider);

    assert.strictEqual(answerData.confidence, "grounded", "Confidence must be 'grounded'");
    assert.strictEqual(answerData.hasEvidence, true, "hasEvidence must be true");
    assert.ok(answerData.answer.includes("50%"), "Answer must cite 50% credit from policy");
    assert.ok(answerData.answer.includes("30 days") || answerData.answer.includes("30-day") || answerData.answer.toLowerCase().includes("30"), "Answer must cite 30-day claim window");
    assert.ok(answerData.sources.some((s: any) => s.documentId === uploadedDoc.id), "Citations must include uploaded document");
    console.log("  ✓ Grounded answer correctly reflects factual SLA policy and citations match document chunks.");

    // ------------------------------------------------------------------------
    // Step 5: Unrelated Question -> Abstention Verification
    // ------------------------------------------------------------------------
    console.log("\n--- Step 5: Test Unrelated Question (Abstention Verification) ---");
    const unrelatedRes = await app.inject({
      method: "POST",
      url: "/api/rag/answer",
      headers: {
        cookie: `session_id=${acmeCookie}`,
        "content-type": "application/json",
      },
      payload: {
        question: "What is the orbital speed of Jupiter's volcanic moon Io in kilometers per second?",
        mode: "hybrid",
        topK: 5,
      },
    });

    assert.strictEqual(unrelatedRes.statusCode, 200, `Unrelated answer must return 200: ${unrelatedRes.payload}`);
    const unrelatedData = JSON.parse(unrelatedRes.payload);
    console.log("  Unrelated response confidence:", unrelatedData.confidence);
    console.log("  Unrelated answer text:\n   ", unrelatedData.answer.replace(/\n/g, "\n    "));

    assert.ok(
      unrelatedData.confidence === "no_context" || unrelatedData.confidence === "insufficient_evidence",
      `Confidence must be refusal ('no_context' or 'insufficient_evidence'), got ${unrelatedData.confidence}`
    );
    assert.ok(
      unrelatedData.answer.toLowerCase().includes("cannot establish an answer") ||
      unrelatedData.answer.toLowerCase().includes("cannot find") ||
      unrelatedData.answer.toLowerCase().includes("available documentation"),
      "Must return standardized refusal without hallucination"
    );
    console.log("  ✓ Correctly abstained from answering unrelated question without hallucinating.");

    // ------------------------------------------------------------------------
    // Step 6: Multi-Tenant Isolation Verification
    // ------------------------------------------------------------------------
    console.log("\n--- Step 6: Verify Strict Tenant Isolation Across Tenants ---");
    // Login as Globex staff user
    const globexLoginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "jonas@globex.test",
        password: "demo1234",
      },
    });

    assert.strictEqual(globexLoginRes.statusCode, 200, "Globex user login must succeed");
    const globexCookie = extractCookie(globexLoginRes.headers["set-cookie"], "session_id");
    assert.ok(globexCookie, "Globex session cookie must be set");

    // Test Globex attempting to query Acme's Ultra SLA policy
    const crossTenantRes = await app.inject({
      method: "POST",
      url: "/api/rag/answer",
      headers: {
        cookie: `session_id=${globexCookie}`,
        "content-type": "application/json",
      },
      payload: {
        question: `What is the downtime compensation in Acme Ultra Cloud SLA Policy ${docUniqueId}?`,
        mode: "hybrid",
        topK: 5,
      },
    });

    assert.strictEqual(crossTenantRes.statusCode, 200);
    const crossTenantData = JSON.parse(crossTenantRes.payload);
    assert.ok(
      crossTenantData.confidence === "no_context" || crossTenantData.confidence === "insufficient_evidence",
      "Globex tenant MUST NOT retrieve Acme's documents"
    );
    assert.strictEqual(
      crossTenantData.sources.some((s: any) => s.documentId === uploadedDoc.id),
      false,
      "No chunks from Acme may ever be returned to Globex"
    );
    console.log("  ✓ Strict Tenant Isolation verified: Globex tenant received 0 Acme chunks and abstained.");

    // Clean up temporary test document to leave database pristine
    await pool.query("DELETE FROM document_chunks WHERE document_id = $1;", [uploadedDoc.id]);
    await pool.query("DELETE FROM documents WHERE id = $1;", [uploadedDoc.id]);
    console.log("  ✓ Test document cleaned up from database.");

    // ------------------------------------------------------------------------
    // Step 7: Zero Side Effects on Tickets or Messages
    // ------------------------------------------------------------------------
    console.log("\n--- Step 7: Verify Zero Side Effects on Tickets and Messages ---");
    const ticketsCountAfter = parseInt((await pool.query("SELECT COUNT(*) FROM tickets;")).rows[0].count, 10);
    const messagesCountAfter = parseInt((await pool.query("SELECT COUNT(*) FROM ticket_messages;")).rows[0].count, 10);

    assert.strictEqual(ticketsCountAfter, ticketsCountBefore, "Ticket count must remain unchanged");
    assert.strictEqual(messagesCountAfter, messagesCountBefore, "Message count must remain unchanged");
    console.log(`  ✓ Confirmed: Tickets (${ticketsCountBefore} -> ${ticketsCountAfter}) and Messages (${messagesCountBefore} -> ${messagesCountAfter}) were completely unaffected.`);

    console.log("\n========================================================");
    console.log("🎉 ALL REAL GEMINI END-TO-END RAG VERIFICATIONS PASSED!");
    console.log("========================================================\n");
  } finally {
    await app.close();
    await pool.end();
  }
}

runEndToEndVerification().catch((err) => {
  console.error("❌ Verification failed:", err);
  process.exit(1);
});
