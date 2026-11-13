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

    // 2. Seed Teams (Departments)
    const teamsToSeed = [
      // Acme Cloud Departments
      {
        name: "Technical Support",
        tenantSlug: "acme",
        description: "API, cloud infrastructure, integrations, rate limits and system incidents.",
      },
      {
        name: "Billing & Finance",
        tenantSlug: "acme",
        description: "Invoices, refunds, payment processing, accounting and tax documentation.",
      },
      {
        name: "Account Management",
        tenantSlug: "acme",
        description: "Enterprise access, SSO, contracts, seat allocations and account lifecycle.",
      },
      {
        name: "Sales & Operations",
        tenantSlug: "acme",
        description: "Plan upgrades, enterprise renewals, operations, SLA terms and compliance.",
      },
      {
        name: "Customer Support",
        tenantSlug: "acme",
        description: "General inquiries, onboarding, product guidance and initial ticket triage.",
      },
      // Legacy Acme Aliases for backward compatibility
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
      // Globex Retail Teams (Preserved)
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

    const teamMap = new Map<string, string>(); // "acme:Billing & Finance" -> teamId

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
    console.log("  ✓ Seeded teams for Acme Cloud and Globex Retail");

    // 3. Seed Users
    const defaultPassword = "demo1234";
    const passwordHash = await hashPassword(defaultPassword);

    const seedUsers = [
      // --- Acme Cloud Demo Employees ---------------------------------------
      {
        name: "Meera Iyer",
        email: "meera@acme.test",
        role: "admin",
        tenantSlug: "acme",
        teamName: "Customer Support",
        title: "Head of Customer Operations",
      },
      {
        name: "Daniel Osei",
        email: "daniel@acme.test",
        role: "staff",
        tenantSlug: "acme",
        teamName: "Technical Support",
        title: "Technical Support Engineer",
      },
      {
        name: "Vikram Mehta",
        email: "vikram@acme.test",
        role: "staff",
        tenantSlug: "acme",
        teamName: "Billing & Finance",
        title: "Senior Accountant",
      },
      {
        name: "Rahul Verma",
        email: "rahul@acme.test",
        role: "staff",
        tenantSlug: "acme",
        teamName: "Billing & Finance",
        title: "Billing Specialist",
      },
      {
        name: "Sana Patel",
        email: "sana@acme.test",
        role: "staff",
        tenantSlug: "acme",
        teamName: "Account Management",
        title: "Senior Account Manager",
      },
      {
        name: "Chloe Martin",
        email: "chloe@acme.test",
        role: "staff",
        tenantSlug: "acme",
        teamName: "Sales & Operations",
        title: "Sales Operations Lead",
      },
      {
        name: "Alex Rivera",
        email: "alex@acme.test",
        role: "staff",
        tenantSlug: "acme",
        teamName: "Customer Support",
        title: "Customer Support Agent",
      },
      // Acme Cloud Customer
      {
        name: "Priya Nair",
        email: "priya@example.com",
        role: "customer",
        tenantSlug: "acme",
        teamName: null,
        title: "Enterprise Customer",
      },
      // Standard Test Accounts
      {
        name: "Default Admin",
        email: "admin@supportsense.local",
        role: "admin",
        tenantSlug: "acme",
        teamName: "Customer Support",
        title: "System Administrator",
      },
      {
        name: "Default Staff",
        email: "staff@supportsense.local",
        role: "staff",
        tenantSlug: "acme",
        teamName: "Technical Support",
        title: "Support Specialist",
      },
      {
        name: "Default Customer",
        email: "customer@supportsense.local",
        role: "customer",
        tenantSlug: "acme",
        teamName: null,
        title: "Standard Customer",
      },
      // --- Globex Retail Users (Preserved) ---------------------------------
      {
        name: "Lena Weber",
        email: "lena@globex.test",
        role: "admin",
        tenantSlug: "globex",
        teamName: "Support",
        title: "Retail Operations Manager",
      },
      {
        name: "Jonas Schmidt",
        email: "jonas@globex.test",
        role: "staff",
        tenantSlug: "globex",
        teamName: "Orders",
        title: "Orders Specialist",
      },
      {
        name: "Ines Garcia",
        email: "ines@globex.test",
        role: "staff",
        tenantSlug: "globex",
        teamName: "Returns",
        title: "Returns Specialist",
      },
      {
        name: "Elena Rostova",
        email: "elena@example.com",
        role: "customer",
        tenantSlug: "globex",
        teamName: null,
        title: "Retail Customer",
      },
    ];

    const userMap = new Map<string, { id: string; name: string; email: string }>();

    for (const u of seedUsers) {
      const tenantId = tenantMap.get(u.tenantSlug) || null;
      const teamId = u.teamName ? teamMap.get(`${u.tenantSlug}:${u.teamName}`) || null : null;

      const res = await client.query(
        `INSERT INTO users (name, email, password_hash, role, tenant_id, team_id, title)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (email) DO UPDATE SET
           name = EXCLUDED.name,
           password_hash = EXCLUDED.password_hash,
           role = EXCLUDED.role,
           tenant_id = EXCLUDED.tenant_id,
           team_id = EXCLUDED.team_id,
           title = EXCLUDED.title
         RETURNING id, name, email;`,
        [u.name, u.email.toLowerCase(), passwordHash, u.role.toLowerCase(), tenantId, teamId, u.title]
      );
      userMap.set(u.email.toLowerCase(), res.rows[0]);
    }
    console.log("  ✓ Seeded users with departments, titles, and credentials");

    // 4. Seed Realistic Departmental Tickets
    await client.query("DELETE FROM tickets WHERE subject IN ($1, $2, $3, $4, $5, $6, $7)", [
      "Charged twice for my annual plan upgrade",
      "API 429 rate limit exceeded during migration batch",
      "Need SSO configuration details for Okta integration",
      "Q3 Corporate Tax Invoice and VAT receipt needed",
      "Inquiry on Enterprise tier custom SLA and dedicated VPC",
      "How do I configure webhook signature verification?",
      "Damaged packaging on order GLX-77102",
    ]);

    const priya = userMap.get("priya@example.com")!;
    const defaultCust = userMap.get("customer@supportsense.local")!;
    const elena = userMap.get("elena@example.com")!;

    const daniel = userMap.get("daniel@acme.test")!;
    const rahul = userMap.get("rahul@acme.test")!;
    const vikram = userMap.get("vikram@acme.test")!;
    const sana = userMap.get("sana@acme.test")!;
    const chloe = userMap.get("chloe@acme.test")!;
    const alex = userMap.get("alex@acme.test")!;

    const acmeTenantId = tenantMap.get("acme")!;
    const globexTenantId = tenantMap.get("globex")!;

    const acmeBillingTeam = teamMap.get("acme:Billing & Finance") || teamMap.get("acme:Billing")!;
    const acmeTechTeam = teamMap.get("acme:Technical Support") || teamMap.get("acme:Technical")!;
    const acmeAccountTeam = teamMap.get("acme:Account Management") || teamMap.get("acme:Account")!;
    const acmeSalesTeam = teamMap.get("acme:Sales & Operations")!;
    const acmeSupportTeam = teamMap.get("acme:Customer Support")!;
    const globexReturnsTeam = teamMap.get("globex:Returns")!;

    const ticketsToSeed = [
      // 1. Billing Specialist ticket: Rahul Verma
      {
        tenantId: acmeTenantId,
        customerId: priya.id,
        customerName: priya.name,
        subject: "Charged twice for my annual plan upgrade",
        category: "BILLING",
        priority: "HIGH",
        status: "AWAITING_STAFF_REVIEW",
        assignedTeamId: acmeBillingTeam,
        assigneeId: rahul.id,
        createdAt: daysAgo(2),
        initialMessage:
          "Hi, I upgraded to the annual plan on 12 August and I see two charges of $240 on my card statement, both dated 12 August. Can you refund the duplicate? Order ref ORD-99381.",
        additionalMessages: [],
      },
      // 2. Technical Support Engineer ticket: Daniel Osei
      {
        tenantId: acmeTenantId,
        customerId: priya.id,
        customerName: priya.name,
        subject: "API 429 rate limit exceeded during migration batch",
        category: "TECHNICAL",
        priority: "URGENT",
        status: "AWAITING_STAFF_REVIEW",
        assignedTeamId: acmeTechTeam,
        assigneeId: daniel.id,
        createdAt: daysAgo(1),
        initialMessage:
          "Our sync job is getting 429 Too Many Requests even though we are sending under 50 req/sec. Is there a burst limit on our tier? We are blocked on customer account migrations.",
        additionalMessages: [],
      },
      // 3. Senior Accountant ticket: Vikram Mehta (Same Billing & Finance department)
      {
        tenantId: acmeTenantId,
        customerId: priya.id,
        customerName: priya.name,
        subject: "Q3 Corporate Tax Invoice and VAT receipt needed",
        category: "BILLING",
        priority: "MEDIUM",
        status: "AWAITING_STAFF_REVIEW",
        assignedTeamId: acmeBillingTeam,
        assigneeId: vikram.id,
        createdAt: daysAgo(2),
        initialMessage:
          "Hello Finance Team, our accounting department needs the Q3 tax breakdown invoice with VAT ID: ACME-VAT-88421 for our annual filing. Please provide the official receipt.",
        additionalMessages: [],
      },
      // 4. Senior Account Manager ticket: Sana Patel
      {
        tenantId: acmeTenantId,
        customerId: defaultCust.id,
        customerName: defaultCust.name,
        subject: "Need SSO configuration details for Okta integration",
        category: "ACCOUNT",
        priority: "MEDIUM",
        status: "RESOLVED",
        assignedTeamId: acmeAccountTeam,
        assigneeId: sana.id,
        createdAt: daysAgo(3),
        initialMessage:
          "We are migrating our corporate identity to Okta SAML 2.0 and need the ACS URL, Entity ID / Audience URI, and signing certificate details for our workspace domain.",
        additionalMessages: [
          {
            authorType: "STAFF",
            authorId: sana.id,
            authorName: sana.name,
            authorTitle: "Senior Account Manager",
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
      // 5. Sales Operations Lead ticket: Chloe Martin
      {
        tenantId: acmeTenantId,
        customerId: priya.id,
        customerName: priya.name,
        subject: "Inquiry on Enterprise tier custom SLA and dedicated VPC",
        category: "OTHER",
        priority: "MEDIUM",
        status: "NEW",
        assignedTeamId: acmeSalesTeam,
        assigneeId: chloe.id,
        createdAt: hoursAgo(10),
        initialMessage:
          "We are exploring upgrading 250 additional seats and require a custom 99.99% uptime guarantee with isolated VPC deployment. Could we schedule a call with Sales Operations?",
        additionalMessages: [],
      },
      // 6. Customer Support Agent ticket: Alex Rivera
      {
        tenantId: acmeTenantId,
        customerId: defaultCust.id,
        customerName: defaultCust.name,
        subject: "How do I configure webhook signature verification?",
        category: "TECHNICAL",
        priority: "LOW",
        status: "NEW",
        assignedTeamId: acmeSupportTeam,
        assigneeId: alex.id,
        createdAt: hoursAgo(4),
        initialMessage:
          "We just set up webhooks for ticket status changes. Where in the documentation can we find the HMAC SHA256 secret header specification?",
        additionalMessages: [],
      },
      // 7. Globex Ticket (Preserved)
      {
        tenantId: globexTenantId,
        customerId: elena.id,
        customerName: elena.name,
        subject: "Damaged packaging on order GLX-77102",
        category: "RETURNS",
        priority: "MEDIUM",
        status: "NEW",
        assignedTeamId: globexReturnsTeam,
        assigneeId: null,
        createdAt: hoursAgo(5),
        initialMessage:
          "The shipping parcel arrived torn open and two glass containers inside were cracked. Order reference GLX-77102. Can I get a replacement shipment or a refund for the broken items?",
        additionalMessages: [],
      },
    ];

    for (const tk of ticketsToSeed) {
      const tkRes = await client.query<{ id: string }>(
        `INSERT INTO tickets (
          tenant_id, customer_id, subject, status, category, priority, assigned_team_id, assignee_id, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
        RETURNING id`,
        [
          tk.tenantId,
          tk.customerId,
          tk.subject,
          tk.status,
          tk.category,
          tk.priority,
          tk.assignedTeamId,
          tk.assigneeId || null,
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

      // Additional messages
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

      console.log(`  ✓ Seeded ticket: "${tk.subject}" (${tk.status}) -> Assignee: ${tk.assigneeId ? "Assigned" : "Unassigned"}`);
    }

    await client.query("COMMIT");
    console.log("Database seeded successfully with Acme Cloud departments, employee personas, and tickets!");
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
