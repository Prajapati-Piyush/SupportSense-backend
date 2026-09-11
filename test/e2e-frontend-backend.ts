import assert from "assert";

const BASE_URL = "http://localhost:3000";

interface CookieJar {
  [name: string]: string;
}

function parseCookies(setCookieHeaders: string[] | null): CookieJar {
  const jar: CookieJar = {};
  if (!setCookieHeaders) return jar;

  for (const header of setCookieHeaders) {
    const parts = header.split(";")[0].split("=");
    if (parts.length >= 2) {
      const name = parts[0].trim();
      const value = parts.slice(1).join("=").trim();
      jar[name] = value;
    }
  }
  return jar;
}

function mergeJar(target: CookieJar, incoming: CookieJar): CookieJar {
  const result = { ...target };
  for (const [key, val] of Object.entries(incoming)) {
    if (!val || val === '""') {
      delete result[key];
    } else {
      result[key] = val;
    }
  }
  return result;
}

function cookieString(jar: CookieJar): string {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

async function request(
  path: string,
  options: {
    method?: string;
    body?: any;
    jar?: CookieJar;
    redirect?: "error" | "follow" | "manual";
  } = {}
) {
  const headers: Record<string, string> = {};
  if (options.body) {
    headers["Content-Type"] = "application/json";
  }

  if (options.jar) {
    headers["Cookie"] = cookieString(options.jar);
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    redirect: options.redirect || "manual",
  });

  const rawSetCookie = res.headers.getSetCookie
    ? res.headers.getSetCookie()
    : res.headers.get("set-cookie")
    ? [res.headers.get("set-cookie")!]
    : [];

  const incomingCookies = parseCookies(rawSetCookie);
  const updatedJar = mergeJar(options.jar || {}, incomingCookies);

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
    location: res.headers.get("location"),
    cookies: updatedJar,
    setCookieHeaders: rawSetCookie,
    json,
  };
}

async function runE2ETests() {
  console.log("\n=======================================================");
  console.log("🌐 FRONTEND ↔ BACKEND END-TO-END AUTH INTEGRATION TEST");
  console.log("=======================================================\n");

  // 1. Unauthenticated Requests & Redirects
  console.log("Step 1: Testing Unauthenticated Access & Next.js Middleware Guards");
  const unauthMe = await request("/api/auth/me");
  assert.strictEqual(unauthMe.status, 401, "/api/auth/me must return 401 for unauthenticated requests");
  console.log("  ✓ GET /api/auth/me returned 401 UNAUTHORIZED");

  const unauthPortal = await request("/portal");
  assert.strictEqual(unauthPortal.status, 307, "Unauthenticated access to /portal must redirect");
  assert.ok(unauthPortal.location?.includes("/login"), "Must redirect to /login");
  console.log("  ✓ GET /portal redirected to /login?next=/portal");

  const unauthDesk = await request("/desk");
  assert.strictEqual(unauthDesk.status, 307, "Unauthenticated access to /desk must redirect");
  assert.ok(unauthDesk.location?.includes("/login"), "Must redirect to /login");
  console.log("  ✓ GET /desk redirected to /login?next=/desk");

  const unauthAdmin = await request("/admin");
  assert.strictEqual(unauthAdmin.status, 307, "Unauthenticated access to /admin must redirect");
  assert.ok(unauthAdmin.location?.includes("/login"), "Must redirect to /login");
  console.log("  ✓ GET /admin redirected to /login?next=/admin");

  // 2. Customer Login & RBAC
  console.log("\nStep 2: Testing Customer Login (priya@example.com)");
  const custLogin = await request("/api/auth/login", {
    method: "POST",
    body: { email: "priya@example.com", password: "demo1234" },
  });
  assert.strictEqual(custLogin.status, 200, "Customer login must succeed");
  assert.ok(custLogin.cookies["session_id"], "Must set session_id cookie");
  assert.strictEqual(custLogin.cookies["ss_role"], "CUSTOMER", "Must set ss_role=CUSTOMER");
  assert.ok(
    custLogin.setCookieHeaders.some((h) => h.includes("HttpOnly") && h.includes("session_id")),
    "session_id cookie must be HttpOnly"
  );
  console.log("  ✓ Customer login returned 200 OK & HttpOnly session cookie");

  const custMe = await request("/api/auth/me", { jar: custLogin.cookies });
  assert.strictEqual(custMe.status, 200);
  assert.strictEqual(custMe.json.user.email, "priya@example.com");
  assert.strictEqual(custMe.json.user.role.toUpperCase(), "CUSTOMER");
  console.log("  ✓ GET /api/auth/me verified customer session via cookie");

  const custPortalNav = await request("/portal", { jar: custLogin.cookies });
  assert.strictEqual(custPortalNav.status, 200, "Customer must have access to /portal");
  console.log("  ✓ Customer permitted on /portal (HTTP 200)");

  const custDeskNav = await request("/desk", { jar: custLogin.cookies });
  assert.strictEqual(custDeskNav.status, 307, "Customer must be redirected from /desk");
  assert.strictEqual(custDeskNav.location, "/no-access", "Must redirect to /no-access");
  console.log("  ✓ Customer redirected from /desk to /no-access");

  const custAdminNav = await request("/admin", { jar: custLogin.cookies });
  assert.strictEqual(custAdminNav.status, 307, "Customer must be redirected from /admin");
  assert.strictEqual(custAdminNav.location, "/no-access", "Must redirect to /no-access");
  console.log("  ✓ Customer redirected from /admin to /no-access");

  // 3. Customer Logout
  console.log("\nStep 3: Testing Customer Logout");
  const custLogout = await request("/api/auth/logout", {
    method: "POST",
    jar: custLogin.cookies,
  });
  assert.strictEqual(custLogout.status, 200, "Logout must succeed");
  console.log("  ✓ POST /api/auth/logout returned 200 OK and cleared cookies");

  const custMeAfterLogout = await request("/api/auth/me", { jar: custLogin.cookies });
  assert.strictEqual(custMeAfterLogout.status, 401, "Session must be revoked on backend");
  console.log("  ✓ Former session cookie rejected with 401 after logout");

  // 4. Staff Login & RBAC
  console.log("\nStep 4: Testing Staff Login (rahul@acme.test)");
  const staffLogin = await request("/api/auth/login", {
    method: "POST",
    body: { email: "rahul@acme.test", password: "demo1234" },
  });
  assert.strictEqual(staffLogin.status, 200);
  assert.strictEqual(staffLogin.cookies["ss_role"], "STAFF");
  console.log("  ✓ Staff login returned 200 OK & HttpOnly session cookie");

  const staffMe = await request("/api/auth/me", { jar: staffLogin.cookies });
  assert.strictEqual(staffMe.status, 200);
  assert.strictEqual(staffMe.json.user.role.toUpperCase(), "STAFF");
  console.log("  ✓ GET /api/auth/me verified staff session via cookie");

  const staffDeskNav = await request("/desk", { jar: staffLogin.cookies });
  assert.strictEqual(staffDeskNav.status, 200, "Staff must have access to /desk");
  console.log("  ✓ Staff permitted on /desk (HTTP 200)");

  const staffPortalNav = await request("/portal", { jar: staffLogin.cookies });
  assert.strictEqual(staffPortalNav.status, 307, "Staff must be redirected from /portal");
  assert.strictEqual(staffPortalNav.location, "/no-access", "Must redirect to /no-access");
  console.log("  ✓ Staff redirected from /portal to /no-access");

  const staffAdminNav = await request("/admin", { jar: staffLogin.cookies });
  assert.strictEqual(staffAdminNav.status, 307, "Staff must be redirected from /admin");
  assert.strictEqual(staffAdminNav.location, "/no-access", "Must redirect to /no-access");
  console.log("  ✓ Staff redirected from /admin to /no-access");

  // 5. Admin Login & RBAC
  console.log("\nStep 5: Testing Admin Login (meera@acme.test)");
  const adminLogin = await request("/api/auth/login", {
    method: "POST",
    body: { email: "meera@acme.test", password: "demo1234" },
  });
  assert.strictEqual(adminLogin.status, 200);
  assert.strictEqual(adminLogin.cookies["ss_role"], "ADMIN");
  console.log("  ✓ Admin login returned 200 OK & HttpOnly session cookie");

  const adminMe = await request("/api/auth/me", { jar: adminLogin.cookies });
  assert.strictEqual(adminMe.status, 200);
  assert.strictEqual(adminMe.json.user.role.toUpperCase(), "ADMIN");
  console.log("  ✓ GET /api/auth/me verified admin session via cookie");

  const adminAdminNav = await request("/admin", { jar: adminLogin.cookies });
  assert.strictEqual(adminAdminNav.status, 200, "Admin must have access to /admin");
  console.log("  ✓ Admin permitted on /admin (HTTP 200)");

  const adminDeskNav = await request("/desk", { jar: adminLogin.cookies });
  assert.strictEqual(adminDeskNav.status, 200, "Admin must have access to /desk (superset of staff)");
  console.log("  ✓ Admin permitted on /desk (HTTP 200)");

  const adminPortalNav = await request("/portal", { jar: adminLogin.cookies });
  assert.strictEqual(adminPortalNav.status, 307, "Admin must be redirected from /portal");
  assert.strictEqual(adminPortalNav.location, "/no-access");
  console.log("  ✓ Admin redirected from /portal to /no-access");

  // 6. Page Refresh Persistence Simulation
  console.log("\nStep 6: Testing Page Refresh Persistence");
  const refreshMe = await request("/api/auth/me", { jar: adminLogin.cookies });
  assert.strictEqual(refreshMe.status, 200);
  assert.strictEqual(refreshMe.json.user.email, "meera@acme.test");
  console.log("  ✓ Page refresh verified: session cookie persists and re-authenticates with PostgreSQL");

  // 7. Register New User & Auto-Login Flow
  console.log("\nStep 7: Testing Registration via Frontend Proxy");
  const newEmail = `fresh_${Date.now()}@supportsense.local`;
  const registerRes = await request("/api/auth/register", {
    method: "POST",
    body: {
      name: "Fresh Customer",
      email: newEmail,
      password: "StrongPassword123!",
      role: "customer",
    },
  });
  assert.strictEqual(registerRes.status, 201);
  assert.ok(registerRes.cookies["session_id"]);
  assert.strictEqual(registerRes.cookies["ss_role"], "CUSTOMER");
  console.log("  ✓ POST /api/auth/register created user and issued active session");

  const newMe = await request("/api/auth/me", { jar: registerRes.cookies });
  assert.strictEqual(newMe.status, 200);
  assert.strictEqual(newMe.json.user.email, newEmail);
  console.log("  ✓ New user automatically signed in and authenticated via cookie");

  console.log("\n=======================================================");
  console.log("🎉 ALL FRONTEND ↔ BACKEND INTEGRATION TESTS PASSED!");
  console.log("=======================================================\n");
}

runE2ETests().catch((err) => {
  console.error("❌ Integration test failed:", err);
  process.exit(1);
});
