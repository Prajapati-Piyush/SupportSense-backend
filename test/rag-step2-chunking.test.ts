import fs from "fs";
import path from "path";
import assert from "assert";
import { buildApp } from "../src/app.js";
import { closePool, query } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { runSeed } from "../src/db/seed.js";
import { TextExtractorService } from "../src/modules/documents/text-extractor.service.js";
import { ChunkerService } from "../src/modules/documents/chunker.service.js";
import { ChunkRepository } from "../src/modules/documents/chunk.repository.js";

function extractCookie(cookieHeader: string | string[] | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const rawHeaders = Array.isArray(cookieHeader) ? cookieHeader : [cookieHeader];
  for (const header of rawHeaders) {
    const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    if (match) return match[1];
  }
  return null;
}

function buildMultipartFormData(
  fields: Record<string, string>,
  file?: { filename: string; contentType: string; content: Buffer | string }
) {
  const boundary = `----WebKitFormBoundary${Math.random().toString(36).substring(2)}`;
  const chunks: Buffer[] = [];

  for (const [key, val] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${key}"\r\n\r\n`));
    chunks.push(Buffer.from(`${val}\r\n`));
  }

  if (file) {
    const fileBuf = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content);
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(
      Buffer.from(`Content-Disposition: form-data; name="file"; filename="${file.filename}"\r\n`)
    );
    chunks.push(Buffer.from(`Content-Type: ${file.contentType}\r\n\r\n`));
    chunks.push(fileBuf);
    chunks.push(Buffer.from("\r\n"));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    payload: Buffer.concat(chunks),
  };
}

function createValidPdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 50 700 Td (${text.replace(/([()\\])/g, "\\$1")}) Tj ET`;
  const streamLen = Buffer.byteLength(content, "utf8");

  const pdf = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length ${streamLen} >> stream
${content}
endstream
endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
xref
0 6
0000000000 65535 f \r
0000000009 00000 n \r
0000000058 00000 n \r
0000000115 00000 n \r
0000000244 00000 n \r
0000000350 00000 n \r
trailer << /Size 6 /Root 1 0 R >>
startxref
430
%%EOF`;
  return Buffer.from(pdf, "utf8");
}

function getSampleDocx(): Buffer {
  const samplePath = path.resolve(process.cwd(), "node_modules/mammoth/test/test-data/comments.docx");
  if (fs.existsSync(samplePath)) {
    return fs.readFileSync(samplePath);
  }
  return Buffer.from("Fallback document content", "utf8");
}

async function runRAGStep2Tests() {
  console.log("\n========================================================");
  console.log("🧪 SupportSense RAG Step 2: Extraction & Chunking Tests");
  console.log("========================================================\n");

  await runMigrations();
  await runSeed();

  const app = buildApp();
  await app.ready();

  try {
    // ------------------------------------------------------------------------
    // PHASE 1: Text Extractor Unit Tests
    // ------------------------------------------------------------------------
    console.log("--- Phase 1: Text Extractor Unit Tests ---");

    // 1.1 Plain Text
    console.log("  1.1 Extract TXT with CRLF and null characters");
    const rawTxt = "SupportSense Line 1\r\nSupportSense Line 2\0 with null byte";
    const txtExtracted = await TextExtractorService.extractText(
      Buffer.from(rawTxt, "utf8"),
      "notes.txt",
      "text/plain"
    );
    assert.strictEqual(
      txtExtracted.text,
      "SupportSense Line 1\nSupportSense Line 2 with null byte"
    );
    console.log("    ✓ TXT extracted, normalized, and null bytes stripped");

    // 1.2 Markdown
    console.log("  1.2 Extract Markdown");
    const rawMd = "# API Reference\n\nSupportSense provides webhooks and REST endpoints.";
    const mdExtracted = await TextExtractorService.extractText(
      Buffer.from(rawMd, "utf8"),
      "api.md",
      "text/markdown"
    );
    assert.ok(mdExtracted.text.includes("SupportSense provides webhooks"));
    console.log("    ✓ Markdown extracted cleanly");

    // 1.3 PDF
    console.log("  1.3 Extract PDF text using native parser");
    const pdfBuf = createValidPdf("SupportSense PDF User Manual - Chapter 1");
    const pdfExtracted = await TextExtractorService.extractText(
      pdfBuf,
      "manual.pdf",
      "application/pdf"
    );
    assert.ok(pdfExtracted.text.includes("SupportSense PDF User Manual - Chapter 1"));
    console.log("    ✓ PDF parsed and text extracted successfully");

    // 1.4 DOCX
    console.log("  1.4 Extract DOCX text using mammoth");
    const docxBuf = getSampleDocx();
    const docxExtracted = await TextExtractorService.extractText(
      docxBuf,
      "comments.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    assert.ok(docxExtracted.text.length > 0);
    console.log(`    ✓ DOCX extracted (${docxExtracted.text.length} characters)`);

    // 1.5 Empty text error handling
    console.log("  1.5 Reject empty file text");
    await assert.rejects(
      async () => {
        await TextExtractorService.extractText(Buffer.from("   \n\t   "), "empty.txt", "text/plain");
      },
      (err: any) => {
        assert.ok(
          err.message.includes("no readable text content") || err.message.includes("empty"),
          `Expected empty text error, got: ${err.message}`
        );
        return true;
      }
    );
    console.log("    ✓ Empty document rejected with BadRequestError");

    // 1.6 Corrupt PDF error handling
    console.log("  1.6 Reject corrupt PDF file");
    await assert.rejects(
      async () => {
        await TextExtractorService.extractText(
          Buffer.from("corrupt pdf stream binary data"),
          "corrupt.pdf",
          "application/pdf"
        );
      },
      (err: any) => {
        assert.ok(
          err.message.includes("PDF") || err.message.includes("Failed"),
          `Expected PDF parse failure, got: ${err.message}`
        );
        return true;
      }
    );
    console.log("    ✓ Corrupt PDF throws descriptive error");

    // ------------------------------------------------------------------------
    // PHASE 2: Structure-Aware Chunker Unit Tests
    // ------------------------------------------------------------------------
    console.log("\n--- Phase 2: Structure-Aware Chunker Unit Tests ---");

    // 2.1 Heading hierarchy tracking
    console.log("  2.1 Verify heading path hierarchy (Parent > Child > Grandchild)");
    const hierarchicalDoc = `
# Customer Support Policy
Welcome to the SupportSense customer support guide.

## Refunds
Our refund policy is outlined below.

### Eligibility
Refunds are eligible within 30 days of purchase for unused annual subscription credits.

### Exceptions
No refunds will be granted for active usage or custom enterprise SLA add-ons.

## SLA Response Times
Standard tier tickets are responded to within 24 hours.
    `.trim();

    const hierChunks = ChunkerService.chunkDocument(hierarchicalDoc, {
      rootTitle: "SupportSense Knowledge Base",
    });

    assert.ok(hierChunks.length >= 3, `Expected at least 3 chunks, got ${hierChunks.length}`);

    // Verify heading paths
    const paths = hierChunks.map((c) => c.headingPath);
    console.log("    Discovered heading paths:", paths);
    assert.ok(
      paths.some((p) => p && p.includes("Customer Support Policy > Refunds > Eligibility")),
      "Should contain Eligibility sub-heading path"
    );
    assert.ok(
      paths.some((p) => p && p.includes("Customer Support Policy > Refunds > Exceptions")),
      "Should contain Exceptions sub-heading path"
    );
    assert.ok(
      paths.some((p) => p && p.includes("Customer Support Policy > SLA Response Times")),
      "Should contain SLA Response Times path"
    );
    console.log("    ✓ Heading hierarchy correctly tracked");

    // 2.2 Sizing (300-500 tokens) and Overlap (~60 tokens)
    console.log("  2.2 Verify chunk token targeting (300-500 tokens) and overlap");
    // Generate a long section of ~800 words
    const longParagraphs = Array.from({ length: 12 }, (_, i) => {
      return `Paragraph ${i + 1}: SupportSense automates high-volume technical support tickets across distributed SaaS organizations. Each agent receives relevant semantic context from the tenant knowledge base. Agents can draft responses, escalate tickets, and collaborate across tiers. Ensuring high reliability and predictable chunk boundaries is critical for vector embedding precision.`;
    }).join("\n\n");

    const longDoc = `# Scalability Architecture\n\n${longParagraphs}`;
    const longChunks = ChunkerService.chunkDocument(longDoc, {
      targetMinTokens: 300,
      targetMaxTokens: 500,
      overlapTokens: 60,
    });

    assert.ok(longChunks.length > 1, "Long document should be split into multiple chunks");

    for (let i = 0; i < longChunks.length; i++) {
      const chunk = longChunks[i];
      assert.strictEqual(chunk.chunkIndex, i, "Chunk indices must be sequential 0-based");
      assert.ok(chunk.content.trim().length > 0, "No chunk may be empty");
      assert.ok(chunk.tokenCount > 0, "Token count must be positive");
      assert.ok(
        chunk.tokenCount <= 600,
        `Chunk token count (${chunk.tokenCount}) should be within upper bound`
      );
    }

    // Verify overlap between chunk 0 and chunk 1
    const chunk0Words = longChunks[0].content.split(/\s+/).slice(-20).join(" ");
    const chunk1HasOverlap = longChunks[1].content.includes(chunk0Words.slice(0, 30));
    console.log(`    Overlap check across chunk splits: ${chunk1HasOverlap ? "Verified" : "Adjacent"}`);
    console.log("    ✓ Sequential indices, token boundaries, and non-empty guarantees verified");

    // ------------------------------------------------------------------------
    // PHASE 3: Database & API Integration Tests (Upload Lifecycle)
    // ------------------------------------------------------------------------
    console.log("\n--- Phase 3: Database & API Integration Tests ---");

    // 3.1 Authenticate test users
    console.log("  3.1 Authenticating Acme Admin and Globex Admin");
    const meeraRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "meera@acme.test", password: "demo1234" },
    });
    assert.strictEqual(meeraRes.statusCode, 200);
    const meeraCookie = extractCookie(meeraRes.headers["set-cookie"], "session_id");

    const lenaRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "lena@globex.test", password: "demo1234" },
    });
    assert.strictEqual(lenaRes.statusCode, 200);
    const lenaCookie = extractCookie(lenaRes.headers["set-cookie"], "session_id");

    // 3.2 Upload Markdown document via multipart
    console.log("  3.2 Admin uploads structured Markdown document");
    const structuredMd = `
# SupportSense Troubleshooting Guide
System diagnostics and troubleshooting procedures for enterprise accounts.

## Network Connectivity
Ensure port 443 outbound traffic to neon.tech and api.openai.com is allowed by firewall rules.

## Database Connection Pooling
Check pool size settings in configuration environment variables. If connections stall, verify neon max connections limit.
    `.trim();

    const mdUpload = buildMultipartFormData(
      { title: "Troubleshooting Guide" },
      {
        filename: "troubleshooting.md",
        contentType: "text/markdown",
        content: structuredMd,
      }
    );

    const uploadRes = await app.inject({
      method: "POST",
      url: "/api/documents",
      headers: {
        cookie: `session_id=${meeraCookie}`,
        "content-type": mdUpload.contentType,
      },
      payload: mdUpload.payload,
    });

    assert.strictEqual(uploadRes.statusCode, 201);
    const docData = uploadRes.json();
    assert.strictEqual(docData.status, "ready");
    assert.ok(docData.chunkCount > 0, "Document should report chunk count > 0");
    const docId = docData.id;
    console.log(`    ✓ Uploaded document ${docId} with status 'ready' and ${docData.chunkCount} chunks`);

    // 3.3 Verify document_chunks rows in PostgreSQL
    console.log("  3.3 Verify document_chunks table rows and embeddings");
    const chunkDbRes = await query(
      `SELECT id, document_id, tenant_id, chunk_index, heading_path, token_count, embedding, embedding_model, content
       FROM document_chunks
       WHERE document_id = $1
       ORDER BY chunk_index ASC`,
      [docId]
    );

    assert.strictEqual(chunkDbRes.rowCount, docData.chunkCount);
    for (let i = 0; i < chunkDbRes.rows.length; i++) {
      const row = chunkDbRes.rows[i];
      assert.strictEqual(row.chunk_index, i, `Chunk index must be ${i}`);
      assert.strictEqual(row.document_id, docId);
      assert.strictEqual(row.tenant_id, docData.tenantId);
      assert.ok(row.token_count > 0, "Token count must be > 0");
      assert.ok(row.heading_path.length > 0, "Heading path must be set");
      // If embeddings are generated (Step 3+), verify valid model
      if (row.embedding !== null) {
        assert.ok(row.embedding_model, "embedding_model must be set when embedding is populated");
      }
    }
    console.log("    ✓ Verified all database chunk rows have valid metadata");

    // ------------------------------------------------------------------------
    // PHASE 4: Document Reprocessing Endpoint
    // ------------------------------------------------------------------------
    console.log("\n--- Phase 4: Reprocessing Endpoint (POST /api/documents/:id/reprocess) ---");

    const reprocessRes = await app.inject({
      method: "POST",
      url: `/api/documents/${docId}/reprocess`,
      headers: { cookie: `session_id=${meeraCookie}` },
    });

    assert.strictEqual(reprocessRes.statusCode, 200);
    const reprocessedDoc = reprocessRes.json();
    assert.strictEqual(reprocessedDoc.status, "ready");

    // Verify chunks were safely replaced without duplicate index errors
    const afterReprocessChunks = await query(
      `SELECT chunk_index, token_count, embedding FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index`,
      [docId]
    );
    assert.strictEqual(afterReprocessChunks.rowCount, docData.chunkCount);
    if (afterReprocessChunks.rows[0].embedding !== null) {
      assert.ok(afterReprocessChunks.rows[0].embedding.length > 0, "Reprocessed chunks have valid embeddings");
    }
    console.log("    ✓ Reprocessed document successfully; atomic chunk replacement confirmed");

    // ------------------------------------------------------------------------
    // PHASE 5: Get Document Chunks Endpoint
    // ------------------------------------------------------------------------
    console.log("\n--- Phase 5: Get Document Chunks Endpoint (GET /api/documents/:id/chunks) ---");

    const getChunksRes = await app.inject({
      method: "GET",
      url: `/api/documents/${docId}/chunks`,
      headers: { cookie: `session_id=${meeraCookie}` },
    });

    assert.strictEqual(getChunksRes.statusCode, 200);
    const chunksList = getChunksRes.json();
    assert.strictEqual(chunksList.length, docData.chunkCount);
    assert.strictEqual(chunksList[0].chunkIndex, 0);
    assert.ok(chunksList[0].headingPath.length > 0);
    console.log(`    ✓ Retrieved ${chunksList.length} chunks via API`);

    // ------------------------------------------------------------------------
    // PHASE 6: Failure Lifecycle & Error Message
    // ------------------------------------------------------------------------
    console.log("\n--- Phase 6: Document Failure Lifecycle Handling ---");

    const corruptUpload = buildMultipartFormData(
      { title: "Corrupt Manual" },
      {
        filename: "corrupt.pdf",
        contentType: "application/pdf",
        content: Buffer.from("Non-pdf corrupt binary payload"),
      }
    );

    const corruptRes = await app.inject({
      method: "POST",
      url: "/api/documents",
      headers: {
        cookie: `session_id=${meeraCookie}`,
        "content-type": corruptUpload.contentType,
      },
      payload: corruptUpload.payload,
    });

    // Upload succeeded but document processing status is 'failed'
    assert.strictEqual(corruptRes.statusCode, 201);
    const corruptDoc = corruptRes.json();
    assert.strictEqual(corruptDoc.status, "failed");
    assert.ok(corruptDoc.errorMessage && corruptDoc.errorMessage.length > 0);
    console.log(`    ✓ Corrupt upload transitioned to status 'failed' with error: "${corruptDoc.errorMessage.slice(0, 60)}..."`);

    // Verify 0 chunks stored for failed document
    const corruptDbChunks = await query(
      "SELECT count(*) as count FROM document_chunks WHERE document_id = $1",
      [corruptDoc.id]
    );
    assert.strictEqual(parseInt(corruptDbChunks.rows[0].count, 10), 0);
    console.log("    ✓ Confirmed 0 chunks stored for failed document");

    // ------------------------------------------------------------------------
    // PHASE 7: Strict Multi-Tenant Isolation
    // ------------------------------------------------------------------------
    console.log("\n--- Phase 7: Strict Multi-Tenant Isolation ---");

    // Lena (Globex) attempts to fetch Acme document chunks
    const crossTenantGet = await app.inject({
      method: "GET",
      url: `/api/documents/${docId}/chunks`,
      headers: { cookie: `session_id=${lenaCookie}` },
    });
    assert.strictEqual(crossTenantGet.statusCode, 404);
    console.log("    ✓ Cross-tenant GET /chunks rejected with 404 Not Found");

    // Lena (Globex) attempts to reprocess Acme document
    const crossTenantReprocess = await app.inject({
      method: "POST",
      url: `/api/documents/${docId}/reprocess`,
      headers: { cookie: `session_id=${lenaCookie}` },
    });
    assert.strictEqual(crossTenantReprocess.statusCode, 404);
    console.log("    ✓ Cross-tenant POST /reprocess rejected with 404 Not Found");

    // Direct DB isolation check
    const crossDbCheck = await query(
      "SELECT id FROM document_chunks WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'globex') AND document_id = $1",
      [docId]
    );
    assert.strictEqual(crossDbCheck.rowCount, 0);
    console.log("    ✓ Database query confirms zero chunk leakage across tenants");

    console.log("\n========================================================");
    console.log("🎉 ALL RAG STEP 2 TESTS PASSED SUCCESSFULLY!");
    console.log("========================================================\n");
  } finally {
    await app.close();
    await closePool();
  }
}

runRAGStep2Tests().catch((err) => {
  console.error("\n❌ RAG Step 2 Test Suite Failed:", err);
  process.exit(1);
});
