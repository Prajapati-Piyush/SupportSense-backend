import { fileURLToPath } from "url";
import { pool, closePool } from "./client.js";
import { hashPassword } from "../utils/password.js";

function daysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

function hoursAgo(hours: number): Date {
  const d = new Date();
  d.setHours(d.getHours() - hours);
  return d;
}

export async function runSeed(): Promise<void> {
  console.log("Seeding initial database records...");
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1. Seed Tenants
    const tenants = [
      { name: "Acme Cloud", slug: "acme" },
      { name: "Globex Retail", slug: "globex" },
    ];

    const tenantMap = new Map<string, string>();

    for (const t of tenants) {
      const res = await client.query(
        `INSERT INTO tenants (name, slug)
         VALUES ($1, $2)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
         RETURNING id, slug;`,
        [t.name, t.slug]
      );
      tenantMap.set(t.slug, res.rows[0].id);
    }
    console.log("  ✓ Seeded tenants:", Array.from(tenantMap.keys()).join(", "));

    // 2. Seed Teams
    const teamsToSeed = [
      {
        name: "Billing",
        tenantSlug: "acme",
        description: "Invoices, refunds, plan changes and payment failures.",
      },
      {
        name: "Technical",
        tenantSlug: "acme",
        description: "API, integrations, rate limits and incident follow-up.",
      },
      {
        name: "Account",
        tenantSlug: "acme",
        description: "Access, SSO, seats, data export and account lifecycle.",
      },
      {
        name: "Orders",
        tenantSlug: "globex",
        description: "Order status, delivery windows and address changes.",
      },
      {
        name: "Returns",
        tenantSlug: "globex",
        description: "Returns, exchanges, damaged goods and refunds.",
      },
      {
        name: "Support",
        tenantSlug: "globex",
        description: "Accounts, loyalty programme and everything else.",
      },
    ];

    const teamMap = new Map<string, string>(); // "acme:Billing" -> teamId

    for (const tm of teamsToSeed) {
      const tenantId = tenantMap.get(tm.tenantSlug)!;
      const res = await client.query(
        `INSERT INTO teams (tenant_id, name, description)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, name) DO UPDATE SET description = EXCLUDED.description
         RETURNING id, name;`,
        [tenantId, tm.name, tm.description]
      );
      teamMap.set(`${tm.tenantSlug}:${tm.name}`, res.rows[0].id);
    }
    console.log("  ✓ Seeded teams for Acme and Globex");

    // 3. Seed Users
    const defaultPassword = "demo1234";
    const passwordHash = await hashPassword(defaultPassword);

    const seedUsers = [
      // Acme Users
      {
        name: "Meera Iyer",
        email: "meera@acme.test",
        role: "admin",
        tenantSlug: "acme",
        teamName: "Billing",
      },
      {
        name: "Rahul Verma",
        email: "rahul@acme.test",
        role: "staff",
        tenantSlug: "acme",
        teamName: "Billing",
      },
      {
        name: "Daniel Osei",
        email: "daniel@acme.test",
        role: "staff",
        tenantSlug: "acme",
        teamName: "Technical",
      },
      {
        name: "Sana Patel",
        email: "sana@acme.test",
        role: "staff",
        tenantSlug: "acme",
        teamName: "Account",
      },
      {
        name: "Priya Nair",
        email: "priya@example.com",
        role: "customer",
        tenantSlug: "acme",
        teamName: null,
      },
      // Globex Users
      {
        name: "Lena Weber",
        email: "lena@globex.test",
        role: "admin",
        tenantSlug: "globex",
        teamName: "Support",
      },
      {
        name: "Jonas Schmidt",
        email: "jonas@globex.test",
        role: "staff",
        tenantSlug: "globex",
        teamName: "Orders",
      },
      {
        name: "Ines Garcia",
        email: "ines@globex.test",
        role: "staff",
        tenantSlug: "globex",
        teamName: "Returns",
      },
      {
        name: "Elena Rostova",
        email: "elena@example.com",
        role: "customer",
        tenantSlug: "globex",
        teamName: null,
      },
      // Generic test users
      {
        name: "Default Admin",
        email: "admin@supportsense.local",
        role: "admin",
        tenantSlug: "acme",
        teamName: "Billing",
      },
      {
        name: "Default Staff",
        email: "staff@supportsense.local",
        role: "staff",
        tenantSlug: "acme",
        teamName: "Billing",
      },
      {
        name: "Default Customer",
        email: "customer@supportsense.local",
        role: "customer",
        tenantSlug: "acme",
        teamName: null,
      },
    ];

    const userMap = new Map<string, { id: string; name: string; email: string }>();

    for (const u of seedUsers) {
      const tenantId = tenantMap.get(u.tenantSlug) || null;
      const teamId = u.teamName ? teamMap.get(`${u.tenantSlug}:${u.teamName}`) || null : null;

      const res = await client.query(
        `INSERT INTO users (name, email, password_hash, role, tenant_id, team_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (email) DO UPDATE SET
           name = EXCLUDED.name,
           password_hash = EXCLUDED.password_hash,
           role = EXCLUDED.role,
           tenant_id = EXCLUDED.tenant_id,
           team_id = EXCLUDED.team_id
         RETURNING id, name, email;`,
        [u.name, u.email.toLowerCase(), passwordHash, u.role.toLowerCase(), tenantId, teamId]
      );
      userMap.set(u.email.toLowerCase(), res.rows[0]);
    }
    console.log("  ✓ Seeded users with team assignments");

    // 4. Seed 4 Realistic Tickets
    // Clean old seeded tickets if re-running
    await client.query("DELETE FROM tickets WHERE subject IN ($1, $2, $3, $4)", [
      "Charged twice for my annual plan upgrade",
      "API 429 rate limit exceeded during migration batch",
      "Need SSO configuration details for Okta integration",
      "Damaged packaging on order GLX-77102",
    ]);

    const priya = userMap.get("priya@example.com")!;
    const defaultCust = userMap.get("customer@supportsense.local")!;
    const elena = userMap.get("elena@example.com")!;
    const sana = userMap.get("sana@acme.test")!;

    const acmeTenantId = tenantMap.get("acme")!;
    const globexTenantId = tenantMap.get("globex")!;

    const acmeBillingTeam = teamMap.get("acme:Billing")!;
    const acmeTechTeam = teamMap.get("acme:Technical")!;
    const acmeAccountTeam = teamMap.get("acme:Account")!;
    const globexReturnsTeam = teamMap.get("globex:Returns")!;

    const ticketsToSeed = [
      // Ticket 1: Acme / Priya Nair (Billing, HIGH, AWAITING_STAFF_REVIEW)
      {
        tenantId: acmeTenantId,
        customerId: priya.id,
        customerName: priya.name,
        subject: "Charged twice for my annual plan upgrade",
        category: "BILLING",
        priority: "HIGH",
        status: "AWAITING_STAFF_REVIEW",
        assignedTeamId: acmeBillingTeam,
        createdAt: daysAgo(2),
        initialMessage:
          "Hi, I upgraded to the annual plan on 12 August and I see two charges of $240 on my card statement, both dated 12 August. Can you refund the duplicate? Order ref ORD-99381.",
        additionalMessages: [],
      },
      // Ticket 2: Acme / Priya Nair (Technical, URGENT, AWAITING_STAFF_REVIEW)
      {
        tenantId: acmeTenantId,
        customerId: priya.id,
        customerName: priya.name,
        subject: "API 429 rate limit exceeded during migration batch",
        category: "TECHNICAL",
        priority: "URGENT",
        status: "AWAITING_STAFF_REVIEW",
        assignedTeamId: acmeTechTeam,
        createdAt: daysAgo(1),
        initialMessage:
          "Our sync job is getting 429 Too Many Requests even though we are sending under 50 req/sec. Is there a burst limit on our tier? We are blocked on customer account migrations.",
        additionalMessages: [],
      },
      // Ticket 3: Acme / Default Customer (Account, MEDIUM, RESOLVED with messages)
      {
        tenantId: acmeTenantId,
        customerId: defaultCust.id,
        customerName: defaultCust.name,
        subject: "Need SSO configuration details for Okta integration",
        category: "ACCOUNT",
        priority: "MEDIUM",
        status: "RESOLVED",
        assignedTeamId: acmeAccountTeam,
        createdAt: daysAgo(3),
        initialMessage:
          "We are migrating our corporate identity to Okta SAML 2.0 and need the ACS URL, Entity ID / Audience URI, and signing certificate details for our workspace domain.",
        additionalMessages: [
          {
            authorType: "STAFF",
            authorId: sana.id,
            authorName: sana.name,
            authorTitle: "Acme Cloud Account",
            body: "Hi there, I have configured SAML 2.0 for your workspace. The ACS URL is https://app.supportsense.test/api/auth/saml/callback and the Entity ID is supportsense:acme. Please find our metadata certificate linked in the settings panel.",
            createdAt: daysAgo(2),
          },
          {
            authorType: "SYSTEM",
            authorId: null,
            authorName: "SupportSense",
            authorTitle: null,
            body: `Ticket marked resolved by ${sana.name}. Queued for knowledge-base ingestion.`,
            createdAt: daysAgo(2),
          },
        ],
      },
      // Ticket 4: Globex / Elena Rostova (Returns, MEDIUM, NEW)
      {
        tenantId: globexTenantId,
        customerId: elena.id,
        customerName: elena.name,
        subject: "Damaged packaging on order GLX-77102",
        category: "RETURNS",
        priority: "MEDIUM",
        status: "NEW",
        assignedTeamId: globexReturnsTeam,
        createdAt: hoursAgo(5),
        initialMessage:
          "The shipping parcel arrived torn open and two glass containers inside were cracked. Order reference GLX-77102. Can I get a replacement shipment or a refund for the broken items?",
        additionalMessages: [],
      },
    ];

    for (const tk of ticketsToSeed) {
      const tkRes = await client.query<{ id: string }>(
        `INSERT INTO tickets (
          tenant_id, customer_id, subject, status, category, priority, assigned_team_id, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
        RETURNING id`,
        [
          tk.tenantId,
          tk.customerId,
          tk.subject,
          tk.status,
          tk.category,
          tk.priority,
          tk.assignedTeamId,
          tk.createdAt,
        ]
      );
      const ticketId = tkRes.rows[0].id;

      // Initial customer message
      await client.query(
        `INSERT INTO ticket_messages (
          ticket_id, author_type, author_id, author_name, body, created_at
        ) VALUES ($1, 'CUSTOMER', $2, $3, $4, $5)`,
        [ticketId, tk.customerId, tk.customerName, tk.initialMessage, tk.createdAt]
      );

      // Additional messages (e.g. staff reply and resolve for Ticket 3)
      for (const msg of tk.additionalMessages) {
        await client.query(
          `INSERT INTO ticket_messages (
            ticket_id, author_type, author_id, author_name, author_title, body, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            ticketId,
            msg.authorType,
            msg.authorId,
            msg.authorName,
            msg.authorTitle,
            msg.body,
            msg.createdAt,
          ]
        );
      }

      console.log(`  ✓ Seeded ticket: "${tk.subject}" (${tk.status})`);
    }

    await client.query("COMMIT");
    console.log("Database seeded successfully with teams and 4 realistic tickets!");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Failed to seed database:", err);
    throw err;
  } finally {
    client.release();
  }
}

// Allow direct execution: tsx src/db/seed.ts
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runSeed()
    .then(async () => {
      await closePool();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error("Seed error:", err);
      await closePool();
      process.exit(1);
    });
}
