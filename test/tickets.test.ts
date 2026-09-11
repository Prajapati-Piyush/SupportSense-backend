import assert from "assert";
import { buildApp } from "../src/app.js";
import { closePool } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { runSeed } from "../src/db/seed.js";

function extractCookie(cookieHeader: string | string[] | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const rawHeaders = Array.isArray(cookieHeader) ? cookieHeader : [cookieHeader];
  for (const header of rawHeaders) {
    const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    if (match) return match[1];
  }
  return null;
}

async function runTests() {
  console.log("\n=============================================");
  console.log("🎫 Running SupportSense Ticket Backend Tests");
  console.log("=============================================\n");

  await runMigrations();
  await runSeed();

  const app = buildApp();
  await app.ready();

  try {
    // 1. Authenticate users
    console.log("Authenticating test accounts...");
    // Priya (Acme Customer)
    const priyaRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "priya@example.com", password: "demo1234" },
    });
    assert.strictEqual(priyaRes.statusCode, 200);
    const priyaCookie = extractCookie(priyaRes.headers["set-cookie"], "session_id");

    // Elena (Globex Customer)
    const elenaRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "elena@example.com", password: "demo1234" },
    });
    assert.strictEqual(elenaRes.statusCode, 200);
    const elenaCookie = extractCookie(elenaRes.headers["set-cookie"], "session_id");

    // Rahul (Acme Staff - Billing)
    const rahulRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "rahul@acme.test", password: "demo1234" },
    });
    assert.strictEqual(rahulRes.statusCode, 200);
    const rahulCookie = extractCookie(rahulRes.headers["set-cookie"], "session_id");

    // Meera (Acme Admin)
    const meeraRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "meera@acme.test", password: "demo1234" },
    });
    assert.strictEqual(meeraRes.statusCode, 200);
    const meeraCookie = extractCookie(meeraRes.headers["set-cookie"], "session_id");

    console.log("  ✓ All test accounts authenticated");

    // Test 1: Unauthenticated request to /api/tickets returns 401
    console.log("\nTest 1: Unauthenticated access to /api/tickets");
    const unauthRes = await app.inject({ method: "GET", url: "/api/tickets" });
    assert.strictEqual(unauthRes.statusCode, 401);
    console.log("  ✓ Correctly rejected with 401 UNAUTHORIZED");

    // Test 2: Customer can list their own tickets
    console.log("\nTest 2: Customer (Priya) listing tickets");
    const priyaList = await app.inject({
      method: "GET",
      url: "/api/tickets",
      headers: { cookie: `session_id=${priyaCookie}` },
    });
    assert.strictEqual(priyaList.statusCode, 200);
    const priyaTickets = priyaList.json();
    assert.ok(Array.isArray(priyaTickets), "Response must be an array");
    assert.ok(priyaTickets.length >= 2, "Priya should have at least 2 seeded tickets");
    assert.ok(
      priyaTickets.every((t: any) => t.customerEmail === "priya@example.com"),
      "All tickets must belong to Priya"
    );
    console.log(`  ✓ Retrieved ${priyaTickets.length} tickets for Priya`);

    // Test 3: Customer can create a new ticket with initial message
    console.log("\nTest 3: Customer (Priya) creating a new ticket");
    const createRes = await app.inject({
      method: "POST",
      url: "/api/tickets",
      headers: { cookie: `session_id=${priyaCookie}` },
      payload: {
        subject: "Cannot download monthly VAT invoice",
        body: "The PDF export button on the billing page gives a 500 server error since yesterday. Invoice #INV-2026-08.",
        categoryHint: "BILLING",
      },
    });
    assert.strictEqual(createRes.statusCode, 201);
    const newTicket = createRes.json();
    assert.strictEqual(newTicket.subject, "Cannot download monthly VAT invoice");
    assert.strictEqual(newTicket.status, "AWAITING_STAFF_REVIEW");
    assert.strictEqual(newTicket.messageCount, 1);
    console.log("  ✓ Created ticket with initial message and reference #" + newTicket.reference);

    // Test 4: Customer can view ticket detail and thread
    console.log("\nTest 4: Customer viewing ticket detail");
    const detailRes = await app.inject({
      method: "GET",
      url: `/api/tickets/${newTicket.id}`,
      headers: { cookie: `session_id=${priyaCookie}` },
    });
    assert.strictEqual(detailRes.statusCode, 200);
    const detailJson = detailRes.json();
    assert.strictEqual(detailJson.ticket.id, newTicket.id);
    assert.strictEqual(detailJson.messages.length, 1);
    assert.strictEqual(detailJson.messages[0].authorType, "CUSTOMER");
    console.log("  ✓ Retrieved ticket detail with thread messages");

    // Test 5: Customer can add a reply message
    console.log("\nTest 5: Customer adding message to ticket");
    const addMsgRes = await app.inject({
      method: "POST",
      url: `/api/tickets/${newTicket.id}/messages`,
      headers: { cookie: `session_id=${priyaCookie}` },
      payload: { body: "Here is an update: I tried clearing cache and it still fails." },
    });
    assert.strictEqual(addMsgRes.statusCode, 201);
    const addedMsg = addMsgRes.json();
    assert.strictEqual(addedMsg.authorType, "CUSTOMER");

    const recheckDetail = await app.inject({
      method: "GET",
      url: `/api/tickets/${newTicket.id}`,
      headers: { cookie: `session_id=${priyaCookie}` },
    });
    assert.strictEqual(recheckDetail.json().messages.length, 2);
    console.log("  ✓ Customer message appended to thread");

    // Test 6: Customer cannot access another customer's ticket (Elena trying to access Priya's ticket)
    console.log("\nTest 6: Cross-tenant / cross-customer access block");
    const crossAccess = await app.inject({
      method: "GET",
      url: `/api/tickets/${newTicket.id}`,
      headers: { cookie: `session_id=${elenaCookie}` },
    });
    assert.ok([403, 404].includes(crossAccess.statusCode), "Cross access must be 403 or 404");
    console.log(`  ✓ Elena correctly blocked from Priya's ticket (${crossAccess.statusCode})`);

    // Test 7: Customer cannot use staff desk endpoints (403 FORBIDDEN)
    console.log("\nTest 7: Customer blocked from staff desk endpoint");
    const custDeskRes = await app.inject({
      method: "GET",
      url: "/api/desk/tickets",
      headers: { cookie: `session_id=${priyaCookie}` },
    });
    assert.strictEqual(custDeskRes.statusCode, 403);
    console.log("  ✓ Customer blocked from /api/desk/tickets with 403 FORBIDDEN");

    // Test 8: Staff (Rahul) lists desk tickets
    console.log("\nTest 8: Staff (Rahul) listing desk queue");
    const rahulDesk = await app.inject({
      method: "GET",
      url: "/api/desk/tickets",
      headers: { cookie: `session_id=${rahulCookie}` },
    });
    assert.strictEqual(rahulDesk.statusCode, 200);
    const rahulQueue = rahulDesk.json();
    assert.ok(Array.isArray(rahulQueue.items));
    assert.ok(rahulQueue.total >= 1);
    console.log(`  ✓ Staff retrieved desk queue (${rahulQueue.items.length} items)`);

    // Test 9: Staff (Rahul) views ticket detail
    console.log("\nTest 9: Staff (Rahul) viewing ticket detail");
    const seededBillingTicket = priyaTickets.find((t: any) => t.category === "BILLING");
    assert.ok(seededBillingTicket, "Must find seeded billing ticket");

    const staffDetail = await app.inject({
      method: "GET",
      url: `/api/desk/tickets/${seededBillingTicket.id}`,
      headers: { cookie: `session_id=${rahulCookie}` },
    });
    assert.strictEqual(staffDetail.statusCode, 200);
    const staffDetailJson = staffDetail.json();
    assert.strictEqual(staffDetailJson.ticket.id, seededBillingTicket.id);
    console.log("  ✓ Staff viewed ticket detail");

    // Test 10: Staff posts reply
    console.log("\nTest 10: Staff (Rahul) replying to ticket");
    const staffReplyRes = await app.inject({
      method: "POST",
      url: `/api/desk/tickets/${seededBillingTicket.id}/reply`,
      headers: { cookie: `session_id=${rahulCookie}` },
      payload: {
        body: "Hi Priya, I have reviewed the billing statement and initiated a refund for $240. It will appear on your card in 3-5 business days.",
      },
    });
    assert.strictEqual(staffReplyRes.statusCode, 201);
    const staffReplyJson = staffReplyRes.json();
    assert.strictEqual(staffReplyJson.authorType, "STAFF");
    console.log("  ✓ Staff reply posted");

    // Test 11: Customer sees the staff reply
    console.log("\nTest 11: Customer sees staff reply");
    const custViewUpdated = await app.inject({
      method: "GET",
      url: `/api/tickets/${seededBillingTicket.id}`,
      headers: { cookie: `session_id=${priyaCookie}` },
    });
    assert.strictEqual(custViewUpdated.statusCode, 200);
    const msgs = custViewUpdated.json().messages;
    const staffMsg = msgs.find((m: any) => m.authorType === "STAFF");
    assert.ok(staffMsg, "Staff message must be present in customer view");
    assert.ok(staffMsg.body.includes("initiated a refund"));
    console.log("  ✓ Staff reply verified in customer ticket view");

    // Test 12: Staff resolves ticket
    console.log("\nTest 12: Staff resolving ticket");
    const resolveRes = await app.inject({
      method: "POST",
      url: `/api/desk/tickets/${seededBillingTicket.id}/resolve`,
      headers: { cookie: `session_id=${rahulCookie}` },
      payload: { addToKb: true },
    });
    assert.strictEqual(resolveRes.statusCode, 200);
    const resolvedTicket = resolveRes.json();
    assert.strictEqual(resolvedTicket.status, "RESOLVED");
    assert.strictEqual(resolvedTicket.inKb, true);
    console.log("  ✓ Ticket status updated to RESOLVED");

    // Test 13: Customer sees resolved status
    console.log("\nTest 13: Customer verifies resolved status");
    const custViewResolved = await app.inject({
      method: "GET",
      url: `/api/tickets/${seededBillingTicket.id}`,
      headers: { cookie: `session_id=${priyaCookie}` },
    });
    assert.strictEqual(custViewResolved.statusCode, 200);
    assert.strictEqual(custViewResolved.json().ticket.status, "RESOLVED");
    console.log("  ✓ Customer view reflects RESOLVED status");

    // Test 14: Non-existent ticket returns 404
    console.log("\nTest 14: Non-existent ticket returns 404");
    const nonExistent = await app.inject({
      method: "GET",
      url: "/api/tickets/00000000-0000-0000-0000-000000000000",
      headers: { cookie: `session_id=${priyaCookie}` },
    });
    assert.strictEqual(nonExistent.statusCode, 404);
    console.log("  ✓ Non-existent ticket returned 404 NOT_FOUND");

    // Test 15: Staff assigns ticket (POST /api/desk/tickets/:id/assign)
    console.log("\nTest 15: Staff assigns ticket to an agent");
    const assignRes = await app.inject({
      method: "POST",
      url: `/api/desk/tickets/${newTicket.id}/assign`,
      headers: { cookie: `session_id=${meeraCookie}` },
      payload: { assigneeId: rahulRes.json().user.id },
    });
    assert.strictEqual(assignRes.statusCode, 200);
    const assignedTicket = assignRes.json();
    assert.strictEqual(assignedTicket.assigneeId, rahulRes.json().user.id);
    console.log("  ✓ Ticket assigned successfully to Rahul");

    console.log("\n=============================================");
    console.log("🎉 ALL TICKET BACKEND TESTS PASSED!");
    console.log("=============================================\n");
  } finally {
    await app.close();
    await closePool();
  }
}

runTests().catch(async (err) => {
  console.error("❌ Ticket test suite failed:", err);
  await closePool();
  process.exit(1);
});
