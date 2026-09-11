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
  console.log("\n==========================================");
  console.log("🚀 Starting SupportSense Auth & RBAC Tests");
  console.log("==========================================\n");

  // 1. Ensure migrations and seed run
  await runMigrations();
  await runSeed();

  const app = buildApp();
  await app.ready();

  try {
    // Test 1: Health Check
    console.log("Test 1: Health check endpoint");
    const resHealth = await app.inject({ method: "GET", url: "/health" });
    assert.strictEqual(resHealth.statusCode, 200);
    const healthJson = resHealth.json();
    assert.strictEqual(healthJson.status, "ok");
    console.log("  ✓ /health returned 200 OK");

    // Test 2: Unauthenticated /api/auth/me
    console.log("\nTest 2: Unauthenticated GET /api/auth/me");
    const resMeUnauth = await app.inject({ method: "GET", url: "/api/auth/me" });
    assert.strictEqual(resMeUnauth.statusCode, 401);
    const unauthJson = resMeUnauth.json();
    assert.strictEqual(unauthJson.error.code, "UNAUTHORIZED");
    console.log("  ✓ Correctly rejected with 401 UNAUTHORIZED");

    // Test 3: User Registration
    console.log("\nTest 3: POST /api/auth/register with valid customer");
    const testEmail = `test_${Date.now()}@example.com`;
    const resRegister = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Test User",
        email: testEmail,
        password: "securePassword123!",
        role: "customer",
      },
    });
    assert.strictEqual(resRegister.statusCode, 201);
    const registerJson = resRegister.json();
    assert.strictEqual(registerJson.user.email, testEmail);
    assert.strictEqual(registerJson.user.role, "customer");
    assert.strictEqual(registerJson.user.password_hash, undefined, "Password hash must never be returned");
    const registerCookie = resRegister.headers["set-cookie"];
    assert.ok(registerCookie, "set-cookie header must be present");
    assert.ok(
      String(registerCookie).includes("HttpOnly"),
      "Session cookie must be HttpOnly"
    );
    const regSessionId = extractCookie(registerCookie, "session_id");
    assert.ok(regSessionId, "session_id cookie must be extractable");
    console.log("  ✓ User registered and received HttpOnly session cookie");

    // Test 4: Authenticated /api/auth/me with Registration Cookie
    console.log("\nTest 4: GET /api/auth/me with registration session cookie");
    const resMeAuth = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: {
        cookie: `session_id=${regSessionId}`,
      },
    });
    assert.strictEqual(resMeAuth.statusCode, 200);
    const meAuthJson = resMeAuth.json();
    assert.strictEqual(meAuthJson.user.email, testEmail);
    assert.strictEqual(meAuthJson.user.role, "customer");
    console.log("  ✓ /api/auth/me returned correct authenticated user profile");

    // Test 5: Duplicate registration returns 409
    console.log("\nTest 5: POST /api/auth/register duplicate email conflict");
    const resDuplicate = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Test User 2",
        email: testEmail,
        password: "anotherPassword123!",
      },
    });
    assert.strictEqual(resDuplicate.statusCode, 409);
    assert.strictEqual(resDuplicate.json().error.code, "EMAIL_ALREADY_EXISTS");
    console.log("  ✓ Duplicate registration correctly rejected with 409 EMAIL_ALREADY_EXISTS");

    // Test 6: Login with invalid password
    console.log("\nTest 6: POST /api/auth/login with wrong password");
    const resWrongPass = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: testEmail,
        password: "wrongPassword999!",
      },
    });
    assert.strictEqual(resWrongPass.statusCode, 401);
    assert.strictEqual(resWrongPass.json().error.code, "INVALID_CREDENTIALS");
    console.log("  ✓ Invalid login correctly rejected with 401 INVALID_CREDENTIALS");

    // Test 7: Login with seeded customer (priya@example.com)
    console.log("\nTest 7: POST /api/auth/login with seed customer account (priya@example.com)");
    const resCustomerLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "priya@example.com",
        password: "demo1234",
      },
    });
    assert.strictEqual(resCustomerLogin.statusCode, 200);
    const customerLoginJson = resCustomerLogin.json();
    assert.strictEqual(customerLoginJson.user.role, "customer");
    const customerCookie = extractCookie(resCustomerLogin.headers["set-cookie"], "session_id");
    assert.ok(customerCookie);
    console.log("  ✓ Customer login successful and session established");

    // Test 8: RBAC - Customer access to /api/protected/profile
    console.log("\nTest 8: Customer access to GET /api/protected/profile");
    const resCustProfile = await app.inject({
      method: "GET",
      url: "/api/protected/profile",
      headers: { cookie: `session_id=${customerCookie}` },
    });
    assert.strictEqual(resCustProfile.statusCode, 200);
    console.log("  ✓ Customer allowed on general authenticated route");

    // Test 9: RBAC - Customer forbidden from /api/protected/staff and /admin
    console.log("\nTest 9: Customer access to GET /api/protected/staff & /api/protected/admin");
    const resCustStaff = await app.inject({
      method: "GET",
      url: "/api/protected/staff",
      headers: { cookie: `session_id=${customerCookie}` },
    });
    assert.strictEqual(resCustStaff.statusCode, 403);
    assert.strictEqual(resCustStaff.json().error.code, "FORBIDDEN_INSUFFICIENT_ROLE");

    const resCustAdmin = await app.inject({
      method: "GET",
      url: "/api/protected/admin",
      headers: { cookie: `session_id=${customerCookie}` },
    });
    assert.strictEqual(resCustAdmin.statusCode, 403);
    assert.strictEqual(resCustAdmin.json().error.code, "FORBIDDEN_INSUFFICIENT_ROLE");
    console.log("  ✓ Customer correctly blocked with 403 FORBIDDEN on staff & admin routes");

    // Test 10: Staff login and RBAC verification (rahul@acme.test)
    console.log("\nTest 10: Staff login (rahul@acme.test) & RBAC checks");
    const resStaffLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "rahul@acme.test",
        password: "demo1234",
      },
    });
    assert.strictEqual(resStaffLogin.statusCode, 200);
    const staffCookie = extractCookie(resStaffLogin.headers["set-cookie"], "session_id");

    const resStaffStaff = await app.inject({
      method: "GET",
      url: "/api/protected/staff",
      headers: { cookie: `session_id=${staffCookie}` },
    });
    assert.strictEqual(resStaffStaff.statusCode, 200);

    const resStaffAdmin = await app.inject({
      method: "GET",
      url: "/api/protected/admin",
      headers: { cookie: `session_id=${staffCookie}` },
    });
    assert.strictEqual(resStaffAdmin.statusCode, 403);
    console.log("  ✓ Staff allowed on /staff but forbidden on /admin");

    // Test 11: Admin login and full access verification (meera@acme.test)
    console.log("\nTest 11: Admin login (meera@acme.test) & full access checks");
    const resAdminLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "meera@acme.test",
        password: "demo1234",
      },
    });
    assert.strictEqual(resAdminLogin.statusCode, 200);
    const adminCookie = extractCookie(resAdminLogin.headers["set-cookie"], "session_id");

    const resAdminStaff = await app.inject({
      method: "GET",
      url: "/api/protected/staff",
      headers: { cookie: `session_id=${adminCookie}` },
    });
    assert.strictEqual(resAdminStaff.statusCode, 200);

    const resAdminAdmin = await app.inject({
      method: "GET",
      url: "/api/protected/admin",
      headers: { cookie: `session_id=${adminCookie}` },
    });
    assert.strictEqual(resAdminAdmin.statusCode, 200);
    console.log("  ✓ Admin allowed on both /staff and /admin routes");

    // Test 12: Logout and session invalidation
    console.log("\nTest 12: POST /api/auth/logout & session revocation");
    const resLogout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: `session_id=${adminCookie}` },
    });
    assert.strictEqual(resLogout.statusCode, 200);
    const logoutCookieHeader = resLogout.headers["set-cookie"];
    assert.ok(logoutCookieHeader);

    // Verifying former session is now rejected
    const resMeAfterLogout = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: `session_id=${adminCookie}` },
    });
    assert.strictEqual(resMeAfterLogout.statusCode, 401);
    assert.strictEqual(resMeAfterLogout.json().error.code, "SESSION_EXPIRED");
    console.log("  ✓ Logout cleared cookie and destroyed session in database");

    console.log("\n==========================================");
    console.log("🎉 ALL TESTS PASSED SUCCESSFULLY!");
    console.log("==========================================\n");
  } finally {
    await app.close();
    await closePool();
  }
}

runTests().catch(async (err) => {
  console.error("❌ Test suite failed:", err);
  await closePool();
  process.exit(1);
});

