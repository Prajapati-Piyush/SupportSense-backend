import assert from "assert";
import { buildApp } from "../src/app.js";
import { closePool, pool } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { runSeed } from "../src/db/seed.js";

interface CookieJar {
  [name: string]: string;
}

function parseCookies(cookieHeaders: string[] | string | undefined): CookieJar {
  const jar: CookieJar = {};
  if (!cookieHeaders) return jar;
  const headers = Array.isArray(cookieHeaders) ? cookieHeaders : [cookieHeaders];
  for (const header of headers) {
    const parts = header.split(";")[0].split("=");
    if (parts.length >= 2) {
      const name = parts[0].trim();
      const value = parts.slice(1).join("=").trim();
      jar[name] = value;
    }
  }
  return jar;
}

function cookieHeader(jar: CookieJar): string {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

async function runE2ETicketTests() {
  console.log("\n=======================================================");
  console.log("🎫 FULL TICKET FLOW END-TO-END VERIFICATION (POSTGRESQL)");
  console.log("=======================================================\n");

  await runMigrations();
  await runSeed();

  const app = buildApp();
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  console.log(`Test server listening on ${address}\n`);

  async function apiRequest(
    path: string,
    options: {
      method?: string;
      body?: any;
      jar?: CookieJar;
    } = {}
  ) {
    const headers: Record<string, string> = {};
    if (options.body) {
      headers["Content-Type"] = "application/json";
    }
    if (options.jar) {
      headers["Cookie"] = cookieHeader(options.jar);
    }

    const res = await fetch(`${address}${path}`, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const setCookies = res.headers.getSetCookie
      ? res.headers.getSetCookie()
      : res.headers.get("set-cookie")
      ? [res.headers.get("set-cookie")!]
      : [];
    const newCookies = parseCookies(setCookies);
    const updatedJar = { ...(options.jar || {}), ...newCookies };

    let json: any = null;
    const contentType = res.headers.get("content-type");
    if (contentType && contentType.includes("application/json")) {
      try {
        json = await res.json();
      } catch {}
    }

    return {
      status: res.status,
      headers: res.headers,
      cookies: updatedJar,
      json,
    };
  }

  try {
    // -------------------------------------------------------------------------
    // Phase 1: Verify PostgreSQL Seeded Tickets
    // -------------------------------------------------------------------------
    console.log("--- Phase 1: Verify 4 Seeded Tickets in PostgreSQL ---");
    const dbTickets = await pool.query(
      `SELECT t.id, t.subject, t.status, t.category, t.priority, t.tenant_id,
              u.email AS customer_email, tm.name AS team_name,
              (SELECT COUNT(*) FROM ticket_messages WHERE ticket_id = t.id) as msg_count
       FROM tickets t
       JOIN users u ON t.customer_id = u.id
       LEFT JOIN teams tm ON t.assigned_team_id = tm.id
       ORDER BY t.created_at ASC`
    );

    assert.ok(dbTickets.rows.length >= 4, "Must have at least 4 seeded tickets");
    console.log(`  ✓ Found ${dbTickets.rows.length} total tickets in PostgreSQL database:`);
    for (const r of dbTickets.rows) {
      console.log(
        `    - [${r.status}] ${r.subject.slice(0, 45)}... | ${r.customer_email} | ${r.category} | ${r.priority} | ${r.msg_count} msgs`
      );
      assert.ok(Number(r.msg_count) >= 1, "Each seeded ticket must have at least 1 message");
    }

    // -------------------------------------------------------------------------
    // Phase 2: Customer Authentication & Ticket Operations
    // -------------------------------------------------------------------------
    console.log("\n--- Phase 2: Customer Flow (Priya Nair) ---");

    // Login
    const custLogin = await apiRequest("/api/auth/login", {
      method: "POST",
      body: { email: "priya@example.com", password: "demo1234" },
    });
    assert.strictEqual(custLogin.status, 200, "Customer login must succeed");
    assert.ok(custLogin.cookies["session_id"], "Customer must receive session_id cookie");
    const custJar = custLogin.cookies;
    console.log("  ✓ Customer logged in successfully (HTTP-only session cookie established)");

    // Verify GET /api/auth/me
    const custMe = await apiRequest("/api/auth/me", { jar: custJar });
    assert.strictEqual(custMe.status, 200);
    assert.strictEqual(custMe.json.user.role, "customer");
    console.log("  ✓ Session validated via GET /api/auth/me (role: customer)");

    // Customer lists tickets (GET /api/tickets)
    const custList = await apiRequest("/api/tickets", { jar: custJar });
    assert.strictEqual(custList.status, 200);
    assert.ok(Array.isArray(custList.json));
    console.log(`  ✓ GET /api/tickets returned ${custList.json.length} tickets for Priya`);

    // Customer creates a new ticket (POST /api/tickets)
    const newSubject = `Urgent SSL Certificate Expiring in Staging — ${Date.now()}`;
    const newBody =
      "Our staging domain api-staging.acme.test is showing an expired Let's Encrypt certificate. Please renew or re-issue.";
    const custCreate = await apiRequest("/api/tickets", {
      method: "POST",
      jar: custJar,
      body: {
        subject: newSubject,
        body: newBody,
        categoryHint: "TECHNICAL",
      },
    });
    assert.strictEqual(custCreate.status, 201, "POST /api/tickets must return 201 Created");
    const createdTicket = custCreate.json;
    assert.ok(createdTicket.id, "Ticket must have an id");
    assert.strictEqual(createdTicket.subject, newSubject);
    assert.strictEqual(createdTicket.status, "AWAITING_STAFF_REVIEW");
    assert.strictEqual(createdTicket.messageCount, 1);
    console.log(`  ✓ POST /api/tickets created ticket #${createdTicket.reference} (${createdTicket.id})`);

    // Customer views ticket detail and thread (GET /api/tickets/:id)
    const custDetail = await apiRequest(`/api/tickets/${createdTicket.id}`, { jar: custJar });
    assert.strictEqual(custDetail.status, 200);
    assert.strictEqual(custDetail.json.ticket.id, createdTicket.id);
    assert.strictEqual(custDetail.json.messages.length, 1);
    assert.strictEqual(custDetail.json.messages[0].body, newBody);
    console.log("  ✓ GET /api/tickets/:id returned ticket details and thread");

    // Customer appends a message (POST /api/tickets/:id/messages)
    const customerReplyText = "Here is the error log snippet: SEC_ERROR_EXPIRED_CERTIFICATE on port 443.";
    const custAddMsg = await apiRequest(`/api/tickets/${createdTicket.id}/messages`, {
      method: "POST",
      jar: custJar,
      body: { body: customerReplyText },
    });
    assert.strictEqual(custAddMsg.status, 201);
    assert.strictEqual(custAddMsg.json.authorType, "CUSTOMER");
    console.log("  ✓ POST /api/tickets/:id/messages appended customer follow-up message");

    // Verify thread length is now 2
    const custDetailAfterReply = await apiRequest(`/api/tickets/${createdTicket.id}`, { jar: custJar });
    assert.strictEqual(custDetailAfterReply.json.messages.length, 2);
    console.log("  ✓ Thread verified: now contains 2 messages");

    // -------------------------------------------------------------------------
    // Phase 3: Staff Authentication & Desk Operations
    // -------------------------------------------------------------------------
    console.log("\n--- Phase 3: Staff Flow (Daniel Osei - Technical Team) ---");

    // Login as Daniel (Acme Technical Staff)
    const staffLogin = await apiRequest("/api/auth/login", {
      method: "POST",
      body: { email: "daniel@acme.test", password: "demo1234" },
    });
    assert.strictEqual(staffLogin.status, 200);
    assert.ok(staffLogin.cookies["session_id"]);
    const staffJar = staffLogin.cookies;
    console.log("  ✓ Staff member logged in (daniel@acme.test)");

    // Staff lists queue (GET /api/desk/tickets)
    const deskQueue = await apiRequest("/api/desk/tickets", { jar: staffJar });
    assert.strictEqual(deskQueue.status, 200);
    assert.ok(Array.isArray(deskQueue.json.items));
    console.log(`  ✓ GET /api/desk/tickets returned ${deskQueue.json.items.length} items in queue`);

    // Staff views the newly created ticket (GET /api/desk/tickets/:id)
    const staffDetail = await apiRequest(`/api/desk/tickets/${createdTicket.id}`, { jar: staffJar });
    assert.strictEqual(staffDetail.status, 200);
    assert.strictEqual(staffDetail.json.ticket.id, createdTicket.id);
    assert.strictEqual(staffDetail.json.messages.length, 2);
    console.log("  ✓ GET /api/desk/tickets/:id viewed ticket details and full conversation");

    // Staff posts a reply (POST /api/desk/tickets/:id/reply)
    const staffReplyText =
      "Hi Priya, I have renewed the Let's Encrypt wildcard certificate for the staging cluster and reloaded NGINX. Could you test again?";
    const staffReply = await apiRequest(`/api/desk/tickets/${createdTicket.id}/reply`, {
      method: "POST",
      jar: staffJar,
      body: { body: staffReplyText },
    });
    assert.strictEqual(staffReply.status, 201);
    assert.strictEqual(staffReply.json.authorType, "STAFF");
    console.log("  ✓ POST /api/desk/tickets/:id/reply posted staff response");

    // Customer checks and sees the staff reply
    const custCheckStaffReply = await apiRequest(`/api/tickets/${createdTicket.id}`, { jar: custJar });
    assert.strictEqual(custCheckStaffReply.status, 200);
    const messages = custCheckStaffReply.json.messages;
    const latestMsg = messages[messages.length - 1];
    assert.strictEqual(latestMsg.authorType, "STAFF");
    assert.ok(latestMsg.body.includes("renewed the Let's Encrypt wildcard certificate"));
    assert.strictEqual(custCheckStaffReply.json.ticket.status, "AWAITING_CUSTOMER");
    console.log("  ✓ Verified: Customer immediately sees staff reply and status: AWAITING_CUSTOMER");

    // Staff reassigns/claims ticket (POST /api/desk/tickets/:id/assign)
    const meRes = await apiRequest("/api/auth/me", { jar: staffJar });
    const staffAssign = await apiRequest(`/api/desk/tickets/${createdTicket.id}/assign`, {
      method: "POST",
      jar: staffJar,
      body: { assigneeId: meRes.json.user.id },
    });
    assert.strictEqual(staffAssign.status, 200);
    console.log("  ✓ POST /api/desk/tickets/:id/assign successfully assigned ticket to staff");

    // Staff resolves ticket (POST /api/desk/tickets/:id/resolve)
    const staffResolve = await apiRequest(`/api/desk/tickets/${createdTicket.id}/resolve`, {
      method: "POST",
      jar: staffJar,
      body: { addToKb: true },
    });
    assert.strictEqual(staffResolve.status, 200);
    assert.strictEqual(staffResolve.json.status, "RESOLVED");
    assert.strictEqual(staffResolve.json.inKb, true);
    console.log("  ✓ POST /api/desk/tickets/:id/resolve resolved ticket (status: RESOLVED, inKb: true)");

    // Customer verifies resolved status
    const custCheckResolved = await apiRequest(`/api/tickets/${createdTicket.id}`, { jar: custJar });
    assert.strictEqual(custCheckResolved.status, 200);
    assert.strictEqual(custCheckResolved.json.ticket.status, "RESOLVED");
    console.log("  ✓ Verified: Customer sees ticket status is RESOLVED");

    // -------------------------------------------------------------------------
    // Phase 4: Role-Based Access Control & Security Guards
    // -------------------------------------------------------------------------
    console.log("\n--- Phase 4: RBAC & Tenant Isolation Verification ---");

    // 1. Customer blocked from desk queue
    const custBlockedDesk = await apiRequest("/api/desk/tickets", { jar: custJar });
    assert.strictEqual(custBlockedDesk.status, 403, "Customer must be blocked from /api/desk/tickets with 403");
    console.log("  ✓ Customer forbidden from staff desk endpoints (HTTP 403)");

    // 2. Unauthenticated request blocked
    const unauthBlocked = await apiRequest("/api/tickets");
    assert.strictEqual(unauthBlocked.status, 401, "Unauthenticated access must return 401");
    console.log("  ✓ Unauthenticated requests rejected (HTTP 401)");

    // 3. Cross-tenant isolation (Elena from Globex cannot see Priya's ticket)
    const elenaLogin = await apiRequest("/api/auth/login", {
      method: "POST",
      body: { email: "elena@example.com", password: "demo1234" },
    });
    assert.strictEqual(elenaLogin.status, 200);
    const elenaJar = elenaLogin.cookies;

    const crossTenantCust = await apiRequest(`/api/tickets/${createdTicket.id}`, { jar: elenaJar });
    assert.ok(
      [403, 404].includes(crossTenantCust.status),
      "Cross-tenant customer must receive 403 or 404"
    );
    console.log(`  ✓ Tenant isolation: Elena (Globex) blocked from Acme ticket (HTTP ${crossTenantCust.status})`);

    // 4. Non-existent ticket returns 404
    const notFoundRes = await apiRequest("/api/tickets/00000000-0000-0000-0000-000000000000", {
      jar: custJar,
    });
    assert.strictEqual(notFoundRes.status, 404);
    console.log("  ✓ Non-existent ticket returns HTTP 404 NOT_FOUND");

    console.log("\n=======================================================");
    console.log("🎉 ALL END-TO-END TICKET MANAGEMENT TESTS PASSED!");
    console.log("=======================================================\n");
  } finally {
    await app.close();
    await closePool();
  }
}

runE2ETicketTests().catch(async (err) => {
  console.error("❌ E2E Ticket Test Failed:", err);
  await closePool();
  process.exit(1);
});

