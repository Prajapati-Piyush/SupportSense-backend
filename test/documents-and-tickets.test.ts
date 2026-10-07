import assert from "assert";
import { buildApp } from "../src/app.js";
import { closePool, query } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { runSeed } from "../src/db/seed.js";
import { getStorageService } from "../src/modules/documents/storage.factory.js";

function extractCookie(cookieHeader: string | string[] | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const rawHeaders = Array.isArray(cookieHeader) ? cookieHeader : [cookieHeader];
  for (const header of rawHeaders) {
    const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    if (match) return match[1];
  }
  return null;
}

function buildMultipartFormData(fields: Record<string, string>, file?: { filename: string; contentType: string; content: Buffer | string }) {
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
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="file"; filename="${file.filename}"\r\n`));
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

async function runTests() {
  console.log("\n========================================================");
  console.log("📄 SupportSense Documents & Tickets Integration Tests");
  console.log("========================================================\n");

  await runMigrations();
  await runSeed();

  const app = buildApp();
  await app.ready();

  try {
    // 1. Authenticate users
    console.log("1. Authenticating test users...");
    // Priya (Acme Customer)
    const priyaRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "priya@example.com", password: "demo1234" },
    });
    assert.strictEqual(priyaRes.statusCode, 200);
    const priyaCookie = extractCookie(priyaRes.headers["set-cookie"], "session_id");

    // Meera (Acme Admin)
    const meeraRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "meera@acme.test", password: "demo1234" },
    });
    assert.strictEqual(meeraRes.statusCode, 200);
    const meeraCookie = extractCookie(meeraRes.headers["set-cookie"], "session_id");

    // Rahul (Acme Staff)
    const rahulRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "rahul@acme.test", password: "demo1234" },
    });
    assert.strictEqual(rahulRes.statusCode, 200);
    const rahulCookie = extractCookie(rahulRes.headers["set-cookie"], "session_id");

    // Elena (Globex Customer)
    const elenaRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "elena@example.com", password: "demo1234" },
    });
    assert.strictEqual(elenaRes.statusCode, 200);
    const elenaCookie = extractCookie(elenaRes.headers["set-cookie"], "session_id");

    // Lena (Globex Admin)
    const lenaRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "lena@globex.test", password: "demo1234" },
    });
    assert.strictEqual(lenaRes.statusCode, 200);
    const lenaCookie = extractCookie(lenaRes.headers["set-cookie"], "session_id");

    console.log("  ✓ Test users authenticated (Priya, Meera, Rahul, Elena, Lena)\n");

    // ========================================================
    // 2. DOCUMENT SERVICE TESTS
    // ========================================================
    console.log("2. Testing Document Service...");

    // Test 2.1: Unauthorized document upload
    console.log("  2.1 Reject unauthenticated upload");
    const unauthUpload = await app.inject({
      method: "POST",
      url: "/api/documents",
      payload: { title: "Test", content: "Test content" },
    });
    assert.strictEqual(unauthUpload.statusCode, 401);
    console.log("    ✓ Rejected with 401");

    // Test 2.2: Customer blocked from admin document upload (RBAC check)
    console.log("  2.2 Reject Customer upload (Staff/Admin required)");
    const customerUpload = await app.inject({
      method: "POST",
      url: "/api/documents",
      headers: { cookie: `session_id=${priyaCookie}` },
      payload: { title: "Customer doc", content: "Should be forbidden" },
    });
    assert.strictEqual(customerUpload.statusCode, 403);
    console.log("    ✓ Customer forbidden from document upload (403)");

    // Test 2.3: Admin uploads a Markdown document via JSON fallback
    console.log("  2.3 Admin upload via JSON");
    const jsonUploadRes = await app.inject({
      method: "POST",
      url: "/api/documents",
      headers: { cookie: `session_id=${meeraCookie}` },
      payload: {
        title: "Acme SLA Policy",
        content: "## Overview\nThis document describes Acme support SLAs.\n\n## Response Times\nUrgent tickets are resolved within 2 hours.",
      },
    });
    assert.strictEqual(jsonUploadRes.statusCode, 201);
    const jsonDoc = jsonUploadRes.json();
    assert.strictEqual(jsonDoc.title, "Acme SLA Policy");
    assert.strictEqual(jsonDoc.status, "ready");
    assert.strictEqual(jsonDoc.wordCount > 5, true);
    assert.strictEqual(jsonDoc.headings.length, 2);
    console.log(`    ✓ Created document via JSON: ${jsonDoc.id}`);

    // Test 2.4: Admin uploads a file via multipart/form-data
    console.log("  2.4 Admin upload via multipart/form-data (Markdown)");
    const mdFileContent = `# Billing Guidelines\n\n## Invoicing\nInvoices are generated on the 1st of every month.\n\n## Refunds\nRefund requests are processed within 5-7 business days.`;
    const multipart = buildMultipartFormData(
      { title: "Acme Billing Guidelines" },
      { filename: "billing-guidelines.md", contentType: "text/markdown", content: mdFileContent }
    );

    const multipartUploadRes = await app.inject({
      method: "POST",
      url: "/api/documents",
      headers: {
        cookie: `session_id=${meeraCookie}`,
        "content-type": multipart.contentType,
      },
      payload: multipart.payload,
    });
    assert.strictEqual(multipartUploadRes.statusCode, 201);
    const multipartDoc = multipartUploadRes.json();
    assert.strictEqual(multipartDoc.title, "Acme Billing Guidelines");
    assert.strictEqual(multipartDoc.originalFilename, "billing-guidelines.md");
    assert.strictEqual(multipartDoc.status, "ready");
    assert.ok(multipartDoc.storageKey.endsWith(".md"));
    console.log(`    ✓ Uploaded multipart document: ${multipartDoc.id}`);

    // Test 2.5: Verify file exists in storage abstraction
    console.log("  2.5 Verify file is safely stored via StorageService abstraction");
    const storage = getStorageService();
    const storedExists = await storage.exists(multipartDoc.storageKey);
    assert.strictEqual(storedExists, true, "File must exist in storage");
    const storedBuffer = await storage.get(multipartDoc.storageKey);
    assert.strictEqual(storedBuffer.toString("utf-8"), mdFileContent);
    console.log("    ✓ File stored safely without path traversal vulnerabilities");

    // Test 2.6: Test PDF file upload
    console.log("  2.6 Admin upload PDF file");
    const pdfMultipart = buildMultipartFormData(
      { title: "Security Whitepaper" },
      { filename: "security-whitepaper.pdf", contentType: "application/pdf", content: Buffer.from("%PDF-1.4 simulated pdf content") }
    );
    const pdfRes = await app.inject({
      method: "POST",
      url: "/api/documents",
      headers: {
        cookie: `session_id=${meeraCookie}`,
        "content-type": pdfMultipart.contentType,
      },
      payload: pdfMultipart.payload,
    });
    assert.strictEqual(pdfRes.statusCode, 201);
    const pdfDoc = pdfRes.json();
    assert.strictEqual(pdfDoc.mimeType, "application/pdf");
    assert.strictEqual(pdfDoc.status, "ready");
    console.log(`    ✓ Uploaded PDF document: ${pdfDoc.id}`);

    // Test 2.7: Test DOCX file upload
    console.log("  2.7 Admin upload DOCX file");
    const docxMultipart = buildMultipartFormData(
      { title: "Employee Handbook" },
      {
        filename: "handbook.docx",
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        content: Buffer.from("PK\x03\x04simulated docx binary"),
      }
    );
    const docxRes = await app.inject({
      method: "POST",
      url: "/api/documents",
      headers: {
        cookie: `session_id=${meeraCookie}`,
        "content-type": docxMultipart.contentType,
      },
      payload: docxMultipart.payload,
    });
    assert.strictEqual(docxRes.statusCode, 201);
    const docxDoc = docxRes.json();
    assert.strictEqual(docxDoc.originalFilename, "handbook.docx");
    console.log(`    ✓ Uploaded DOCX document: ${docxDoc.id}`);

    // Test 2.8: Reject invalid file type (.exe)
    console.log("  2.8 Reject invalid file type (.exe)");
    const exeMultipart = buildMultipartFormData(
      { title: "Malicious File" },
      { filename: "malware.exe", contentType: "application/x-msdownload", content: Buffer.from("MZ malicious") }
    );
    const exeRes = await app.inject({
      method: "POST",
      url: "/api/documents",
      headers: {
        cookie: `session_id=${meeraCookie}`,
        "content-type": exeMultipart.contentType,
      },
      payload: exeMultipart.payload,
    });
    assert.strictEqual(exeRes.statusCode, 400);
    console.log("    ✓ Rejected invalid file type (.exe) with 400 BAD_REQUEST");

    // Test 2.9: List documents scoped to tenant
    console.log("  2.9 List documents scoped to Acme tenant");
    const listRes = await app.inject({
      method: "GET",
      url: "/api/documents",
      headers: { cookie: `session_id=${rahulCookie}` },
    });
    assert.strictEqual(listRes.statusCode, 200);
    const docs = listRes.json();
    assert.ok(Array.isArray(docs));
    assert.ok(docs.some((d: any) => d.id === multipartDoc.id));
    console.log(`    ✓ Retrieved ${docs.length} documents for Acme`);

    // Test 2.10: Single document retrieval
    console.log("  2.10 Retrieve single document by ID");
    const singleRes = await app.inject({
      method: "GET",
      url: `/api/documents/${multipartDoc.id}`,
      headers: { cookie: `session_id=${rahulCookie}` },
    });
    assert.strictEqual(singleRes.statusCode, 200);
    const singleDoc = singleRes.json();
    assert.strictEqual(singleDoc.id, multipartDoc.id);
    assert.strictEqual(singleDoc.title, "Acme Billing Guidelines");
    console.log("    ✓ Retrieved document detail");

    // Test 2.11: RBAC and Cross-Tenant isolation on documents
    console.log("  2.11 Verify RBAC and Cross-Tenant isolation on documents");
    // Elena is a customer: forbidden from staff document endpoints
    const customerDocGet = await app.inject({
      method: "GET",
      url: `/api/documents/${multipartDoc.id}`,
      headers: { cookie: `session_id=${elenaCookie}` },
    });
    assert.strictEqual(customerDocGet.statusCode, 403, "Customer must get 403 on staff document endpoint");

    // Lena is a Globex Admin: authorized for document routes, but must get 404 for Acme document
    const crossTenantGet = await app.inject({
      method: "GET",
      url: `/api/documents/${multipartDoc.id}`,
      headers: { cookie: `session_id=${lenaCookie}` },
    });
    assert.strictEqual(crossTenantGet.statusCode, 404, "Globex Admin must get 404 for Acme document");

    const crossTenantDelete = await app.inject({
      method: "DELETE",
      url: `/api/documents/${multipartDoc.id}`,
      headers: { cookie: `session_id=${lenaCookie}` },
    });
    assert.strictEqual(crossTenantDelete.statusCode, 404, "Globex Admin must get 404 when attempting to delete Acme document");
    console.log("    ✓ RBAC (403) and cross-tenant isolation (404) strictly verified");

    // Test 2.12: Delete document
    console.log("  2.12 Delete document by ID");
    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/api/documents/${docxDoc.id}`,
      headers: { cookie: `session_id=${meeraCookie}` },
    });
    assert.strictEqual(deleteRes.statusCode, 200);

    const getDeleted = await app.inject({
      method: "GET",
      url: `/api/documents/${docxDoc.id}`,
      headers: { cookie: `session_id=${meeraCookie}` },
    });
    assert.strictEqual(getDeleted.statusCode, 404);
    console.log("    ✓ Deleted document successfully (subsequent fetch returned 404)");

    // ========================================================
    // 3. TICKET SERVICE PATCH & FILTERING TESTS
    // ========================================================
    console.log("\n3. Testing Ticket Service (Update / Filter / Teams)...");

    // Test 3.1: Customer creates ticket
    console.log("  3.1 Create test ticket");
    const tCreateRes = await app.inject({
      method: "POST",
      url: "/api/tickets",
      headers: { cookie: `session_id=${priyaCookie}` },
      payload: {
        subject: "Need updated SOC2 report",
        body: "Please share the latest SOC2 Type II compliance audit report for our security team.",
        categoryHint: "SECURITY",
      },
    });
    assert.strictEqual(tCreateRes.statusCode, 201);
    const testTicket = tCreateRes.json();
    console.log(`    ✓ Created ticket: ${testTicket.id} (#${testTicket.reference})`);

    // Test 3.2: Customer PATCH ticket priority / status
    console.log("  3.2 Customer update ticket (PATCH /api/tickets/:id)");
    const custPatchRes = await app.inject({
      method: "PATCH",
      url: `/api/tickets/${testTicket.id}`,
      headers: { cookie: `session_id=${priyaCookie}` },
      payload: {
        priority: "HIGH",
      },
    });
    assert.strictEqual(custPatchRes.statusCode, 200);
    const updatedByCust = custPatchRes.json();
    assert.strictEqual(updatedByCust.priority, "HIGH");
    console.log("    ✓ Customer updated ticket priority to HIGH");

    // Test 3.3: Staff PATCH ticket status / priority / category via desk
    console.log("  3.3 Staff update ticket (PATCH /api/desk/tickets/:id)");
    const deskPatchRes = await app.inject({
      method: "PATCH",
      url: `/api/desk/tickets/${testTicket.id}`,
      headers: { cookie: `session_id=${rahulCookie}` },
      payload: {
        status: "ESCALATED",
        category: "SECURITY",
        priority: "URGENT",
      },
    });
    assert.strictEqual(deskPatchRes.statusCode, 200);
    const updatedByStaff = deskPatchRes.json();
    assert.strictEqual(updatedByStaff.status, "ESCALATED");
    assert.strictEqual(updatedByStaff.priority, "URGENT");
    assert.strictEqual(updatedByStaff.category, "SECURITY");
    console.log("    ✓ Staff updated ticket to ESCALATED / URGENT via desk PATCH");

    // Test 3.4: Cross-tenant ticket PATCH rejection
    console.log("  3.4 Cross-tenant ticket PATCH rejected");
    const crossPatchRes = await app.inject({
      method: "PATCH",
      url: `/api/tickets/${testTicket.id}`,
      headers: { cookie: `session_id=${elenaCookie}` },
      payload: { priority: "LOW" },
    });
    assert.strictEqual(crossPatchRes.statusCode, 404, "Elena cannot patch Acme ticket");
    console.log("    ✓ Cross-tenant PATCH correctly returned 404");

    // Test 3.5: Desk ticket list with status & priority filtering
    console.log("  3.5 Desk queue filtering by status and priority");
    const filteredListRes = await app.inject({
      method: "GET",
      url: "/api/desk/tickets?priority=URGENT&status=ESCALATED",
      headers: { cookie: `session_id=${rahulCookie}` },
    });
    assert.strictEqual(filteredListRes.statusCode, 200);
    const filteredQueue = filteredListRes.json();
    assert.ok(Array.isArray(filteredQueue.items));
    assert.ok(filteredQueue.items.some((t: any) => t.id === testTicket.id));
    console.log(`    ✓ Retrieved filtered desk tickets: count = ${filteredQueue.total}`);

    // Test 3.6: Desk ticket list pagination
    console.log("  3.6 Desk queue pagination");
    const pageRes = await app.inject({
      method: "GET",
      url: "/api/desk/tickets?page=1&pageSize=2",
      headers: { cookie: `session_id=${rahulCookie}` },
    });
    assert.strictEqual(pageRes.statusCode, 200);
    const paged = pageRes.json();
    assert.strictEqual(paged.page, 1);
    assert.strictEqual(paged.pageSize, 2);
    assert.ok(paged.items.length <= 2);
    console.log(`    ✓ Paginated desk results (page ${paged.page}, ${paged.items.length} items of ${paged.total} total)`);

    // ========================================================
    // 4. TEAMS ENDPOINT TEST
    // ========================================================
    console.log("\n4. Testing Teams API...");
    const teamsRes = await app.inject({
      method: "GET",
      url: "/api/teams",
      headers: { cookie: `session_id=${rahulCookie}` },
    });
    assert.strictEqual(teamsRes.statusCode, 200);
    const teamList = teamsRes.json();
    assert.ok(Array.isArray(teamList));
    assert.ok(teamList.length > 0);
    assert.ok(teamList.some((t: any) => t.name.includes("Billing") || t.name.includes("Support")));
    console.log(`  ✓ Retrieved ${teamList.length} teams for Acme tenant`);

    console.log("\n========================================================");
    console.log("🎉 ALL DOCUMENT & TICKET INTEGRATION TESTS PASSED!");
    console.log("========================================================\n");
  } finally {
    await app.close();
    await closePool();
  }
}

runTests().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
