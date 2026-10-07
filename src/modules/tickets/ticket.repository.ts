import { query } from "../../db/client.js";
import {
  AuthorType,
  DeskQueueFilters,
  Paginated,
  Ticket,
  TicketCategory,
  TicketMessage,
  TicketMessageRow,
  TicketPriority,
  TicketStatus,
} from "./ticket.types.js";

interface TicketQueryRow {
  id: string;
  reference: number;
  tenant_id: string;
  customer_id: string;
  customer_name: string;
  customer_email: string;
  subject: string;
  status: TicketStatus;
  category: TicketCategory | null;
  priority: TicketPriority | null;
  assigned_team_id: string | null;
  assigned_team_name: string | null;
  assignee_id: string | null;
  assignee_name: string | null;
  in_kb: boolean;
  unread_for_customer: boolean;
  created_at: Date;
  updated_at: Date;
  last_message_preview: string | null;
  message_count: string | number;
}

function mapTicketRow(row: TicketQueryRow): Ticket {
  return {
    id: row.id,
    reference: Number(row.reference),
    tenantId: row.tenant_id,
    customerId: row.customer_id,
    customerName: row.customer_name || "Customer",
    customerEmail: row.customer_email || "",
    subject: row.subject,
    status: row.status,
    category: row.category,
    priority: row.priority,
    assignedTeamId: row.assigned_team_id,
    assignedTeamName: row.assigned_team_name,
    assigneeId: row.assignee_id,
    assigneeName: row.assignee_name,
    inKb: Boolean(row.in_kb),
    unreadForCustomer: Boolean(row.unread_for_customer),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastMessagePreview: row.last_message_preview || "",
    messageCount: Number(row.message_count || 0),
  };
}

function mapMessageRow(row: TicketMessageRow): TicketMessage {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    authorType: row.author_type,
    authorId: row.author_id,
    authorName: row.author_name,
    authorTitle: row.author_title,
    body: row.body,
    createdAt: row.created_at.toISOString(),
  };
}

const TICKET_SELECT_FIELDS = `
  t.id,
  t.reference,
  t.tenant_id,
  t.customer_id,
  u.name AS customer_name,
  u.email AS customer_email,
  t.subject,
  t.status,
  t.category,
  t.priority,
  t.assigned_team_id,
  tm.name AS assigned_team_name,
  t.assignee_id,
  asg.name AS assignee_name,
  t.in_kb,
  t.unread_for_customer,
  t.created_at,
  t.updated_at,
  COALESCE(last_msg.body, '') AS last_message_preview,
  COALESCE(msg_cnt.cnt, 0) AS message_count
`;

const TICKET_JOINS = `
  JOIN users u ON t.customer_id = u.id
  LEFT JOIN teams tm ON t.assigned_team_id = tm.id
  LEFT JOIN users asg ON t.assignee_id = asg.id
  LEFT JOIN LATERAL (
    SELECT body FROM ticket_messages
    WHERE ticket_id = t.id AND author_type != 'SYSTEM'
    ORDER BY created_at DESC LIMIT 1
  ) last_msg ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS cnt FROM ticket_messages
    WHERE ticket_id = t.id AND author_type != 'SYSTEM'
  ) msg_cnt ON true
`;

export class TicketRepository {
  /**
   * Create a ticket with an initial customer message inside a transaction.
   */
  static async createTicket(data: {
    tenantId: string;
    customerId: string;
    customerName: string;
    subject: string;
    body: string;
    category?: TicketCategory | null;
    priority?: TicketPriority | null;
    assignedTeamId?: string | null;
  }): Promise<Ticket> {
    const client = await (await import("../../db/client.js")).pool.connect();
    try {
      await client.query("BEGIN");

      // 1. Insert Ticket
      const ticketRes = await client.query<{ id: string }>(
        `INSERT INTO tickets (
          tenant_id, customer_id, subject, status, category, priority, assigned_team_id, unread_for_customer
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, false)
        RETURNING id`,
        [
          data.tenantId,
          data.customerId,
          data.subject.trim(),
          "AWAITING_STAFF_REVIEW",
          data.category || null,
          data.priority || null,
          data.assignedTeamId || null,
        ]
      );
      const ticketId = ticketRes.rows[0].id;

      // 2. Insert initial customer message
      await client.query(
        `INSERT INTO ticket_messages (
          ticket_id, author_type, author_id, author_name, body
        ) VALUES ($1, 'CUSTOMER', $2, $3, $4)`,
        [ticketId, data.customerId, data.customerName, data.body.trim()]
      );

      await client.query("COMMIT");

      // 3. Retrieve populated ticket
      const created = await this.findTicketById(ticketId, data.tenantId);
      if (!created) throw new Error("Failed to retrieve created ticket");
      return created;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Append a message to a ticket and update ticket state.
   */
  static async appendMessage(data: {
    ticketId: string;
    authorType: AuthorType;
    authorId: string | null;
    authorName: string;
    authorTitle?: string | null;
    body: string;
    nextStatus?: TicketStatus;
    unreadForCustomer?: boolean;
    assigneeId?: string | null;
  }): Promise<TicketMessage> {
    const client = await (await import("../../db/client.js")).pool.connect();
    try {
      await client.query("BEGIN");

      const msgRes = await client.query<TicketMessageRow>(
        `INSERT INTO ticket_messages (
          ticket_id, author_type, author_id, author_name, author_title, body
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *`,
        [
          data.ticketId,
          data.authorType,
          data.authorId,
          data.authorName,
          data.authorTitle || null,
          data.body.trim(),
        ]
      );

      // Build updates for ticket
      const updates: string[] = ["updated_at = NOW()"];
      const params: any[] = [data.ticketId];

      if (data.nextStatus) {
        params.push(data.nextStatus);
        updates.push(`status = $${params.length}`);
      }
      if (data.unreadForCustomer !== undefined) {
        params.push(data.unreadForCustomer);
        updates.push(`unread_for_customer = $${params.length}`);
      }
      if (data.assigneeId) {
        params.push(data.assigneeId);
        updates.push(`assignee_id = COALESCE(assignee_id, $${params.length})`);
      }

      await client.query(
        `UPDATE tickets SET ${updates.join(", ")} WHERE id = $1`,
        params
      );

      await client.query("COMMIT");
      return mapMessageRow(msgRes.rows[0]);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Find all tickets belonging to a specific customer within a tenant with optional filtering.
   */
  static async findCustomerTickets(
    tenantId: string,
    customerId: string,
    filters?: {
      status?: string;
      priority?: string;
      q?: string;
      page?: number;
      pageSize?: number;
    }
  ): Promise<Ticket[]> {
    const conditions: string[] = ["t.tenant_id = $1", "t.customer_id = $2"];
    const params: any[] = [tenantId, customerId];

    if (filters?.status && filters.status !== "ALL") {
      params.push(filters.status);
      conditions.push(`t.status = $${params.length}`);
    }

    if (filters?.priority && filters.priority !== "ALL") {
      params.push(filters.priority);
      conditions.push(`t.priority = $${params.length}`);
    }

    if (filters?.q && filters.q.trim()) {
      params.push(`%${filters.q.trim().toLowerCase()}%`);
      const qIndex = params.length;
      conditions.push(`(
        lower(t.subject) LIKE $${qIndex} OR
        t.reference::text LIKE $${qIndex} OR
        lower(COALESCE(last_msg.body, '')) LIKE $${qIndex}
      )`);
    }

    let limitClause = "";
    if (filters?.pageSize) {
      const page = Math.max(Number(filters.page) || 1, 1);
      const pageSize = Math.max(Number(filters.pageSize) || 12, 1);
      const offset = (page - 1) * pageSize;
      params.push(pageSize, offset);
      limitClause = `LIMIT $${params.length - 1} OFFSET $${params.length}`;
    }

    const res = await query<TicketQueryRow>(
      `SELECT ${TICKET_SELECT_FIELDS}
       FROM tickets t
       ${TICKET_JOINS}
       WHERE ${conditions.join(" AND ")}
       ORDER BY t.updated_at DESC
       ${limitClause}`,
      params
    );

    return res.rows.map(mapTicketRow);
  }

  /**
   * Update ticket fields with strict tenant isolation.
   */
  static async updateTicket(data: {
    ticketId: string;
    tenantId: string;
    subject?: string;
    status?: TicketStatus;
    priority?: TicketPriority | null;
    category?: TicketCategory | null;
    assignedTeamId?: string | null;
    assigneeId?: string | null;
    unreadForCustomer?: boolean;
    inKb?: boolean;
  }): Promise<Ticket | null> {
    const updates: string[] = ["updated_at = NOW()"];
    const params: any[] = [data.ticketId, data.tenantId];

    if (data.subject !== undefined) {
      params.push(data.subject.trim());
      updates.push(`subject = $${params.length}`);
    }
    if (data.status !== undefined) {
      params.push(data.status);
      updates.push(`status = $${params.length}`);
    }
    if (data.priority !== undefined) {
      params.push(data.priority);
      updates.push(`priority = $${params.length}`);
    }
    if (data.category !== undefined) {
      params.push(data.category);
      updates.push(`category = $${params.length}`);
    }
    if (data.assignedTeamId !== undefined) {
      params.push(data.assignedTeamId);
      updates.push(`assigned_team_id = $${params.length}`);
    }
    if (data.assigneeId !== undefined) {
      params.push(data.assigneeId);
      updates.push(`assignee_id = $${params.length}`);
    }
    if (data.unreadForCustomer !== undefined) {
      params.push(data.unreadForCustomer);
      updates.push(`unread_for_customer = $${params.length}`);
    }
    if (data.inKb !== undefined) {
      params.push(data.inKb);
      updates.push(`in_kb = $${params.length}`);
    }

    const res = await query(
      `UPDATE tickets
       SET ${updates.join(", ")}
       WHERE id = $1 AND tenant_id = $2
       RETURNING id`,
      params
    );

    if (!res.rows[0]) return null;
    return this.findTicketById(data.ticketId, data.tenantId);
  }

  /**
   * Find single ticket by ID scoped to tenant.
   */
  static async findTicketById(ticketId: string, tenantId: string): Promise<Ticket | null> {
    const res = await query<TicketQueryRow>(
      `SELECT ${TICKET_SELECT_FIELDS}
       FROM tickets t
       ${TICKET_JOINS}
       WHERE t.id = $1 AND t.tenant_id = $2
       LIMIT 1`,
      [ticketId, tenantId]
    );

    return res.rows[0] ? mapTicketRow(res.rows[0]) : null;
  }

  /**
   * Find messages for a ticket ordered chronologically.
   */
  static async getTicketMessages(ticketId: string): Promise<TicketMessage[]> {
    const res = await query<TicketMessageRow>(
      `SELECT * FROM ticket_messages
       WHERE ticket_id = $1
       ORDER BY created_at ASC`,
      [ticketId]
    );

    return res.rows.map(mapMessageRow);
  }

  /**
   * List tickets for the Staff / Admin desk queue with filters and pagination.
   */
  static async findDeskTickets(
    tenantId: string,
    filters: DeskQueueFilters,
    userRole: string,
    userTeamId: string | null,
    userId: string
  ): Promise<Paginated<Ticket>> {
    const conditions: string[] = ["t.tenant_id = $1"];
    const params: any[] = [tenantId];

    // STAFF see their assigned team tickets by default + unassigned tickets in their tenant. ADMIN owns the whole desk.
    if (userRole.toLowerCase() === "staff") {
      if (userTeamId) {
        params.push(userTeamId);
        conditions.push(`(t.assigned_team_id = $${params.length} OR t.assigned_team_id IS NULL)`);
      }
    } else if (filters.teamId && filters.teamId !== "ALL") {
      params.push(filters.teamId);
      conditions.push(`t.assigned_team_id = $${params.length}`);
    }

    if (filters.priority && filters.priority !== "ALL") {
      params.push(filters.priority);
      conditions.push(`t.priority = $${params.length}`);
    }

    if (filters.category && filters.category !== "ALL") {
      params.push(filters.category);
      conditions.push(`t.category = $${params.length}`);
    }

    if (filters.assignment === "MINE") {
      params.push(userId);
      conditions.push(`t.assignee_id = $${params.length}`);
    } else if (filters.assignment === "UNASSIGNED") {
      conditions.push("t.assignee_id IS NULL");
    }

    if (filters.aiState && filters.aiState !== "ALL") {
      switch (filters.aiState) {
        case "DRAFT_READY":
          conditions.push("t.status IN ('AWAITING_STAFF_REVIEW', 'AI_PROCESSING', 'NEW')");
          break;
        case "ESCALATED":
          conditions.push("t.status = 'ESCALATED'");
          break;
        case "AWAITING_CUSTOMER":
          conditions.push("t.status = 'AWAITING_CUSTOMER'");
          break;
        case "RESOLVED":
          conditions.push("t.status = 'RESOLVED'");
          break;
      }
    }

    if (filters.q && filters.q.trim()) {
      params.push(`%${filters.q.trim().toLowerCase()}%`);
      const qIndex = params.length;
      conditions.push(`(
        lower(t.subject) LIKE $${qIndex} OR
        lower(u.name) LIKE $${qIndex} OR
        t.reference::text LIKE $${qIndex} OR
        lower(COALESCE(last_msg.body, '')) LIKE $${qIndex}
      )`);
    }

    const whereClause = conditions.join(" AND ");

    // Sorting
    let orderBy = `
      CASE t.priority
        WHEN 'URGENT' THEN 1
        WHEN 'HIGH' THEN 2
        WHEN 'MEDIUM' THEN 3
        WHEN 'LOW' THEN 4
        ELSE 5
      END ASC,
      t.created_at ASC
    `;

    if (filters.sort === "NEWEST") {
      orderBy = "t.created_at DESC";
    } else if (filters.sort === "OLDEST") {
      orderBy = "t.created_at ASC";
    }

    // Total count query
    const countRes = await query<{ count: string }>(
      `SELECT COUNT(*) FROM tickets t
       JOIN users u ON t.customer_id = u.id
       LEFT JOIN LATERAL (
         SELECT body FROM ticket_messages
         WHERE ticket_id = t.id AND author_type != 'SYSTEM'
         ORDER BY created_at DESC LIMIT 1
       ) last_msg ON true
       WHERE ${whereClause}`,
      params
    );
    const total = parseInt(countRes.rows[0]?.count || "0", 10);

    // Pagination
    const page = Math.max(Number(filters.page) || 1, 1);
    const pageSize = Math.max(Number(filters.pageSize) || 12, 1);
    const offset = (page - 1) * pageSize;

    params.push(pageSize, offset);
    const dataRes = await query<TicketQueryRow>(
      `SELECT ${TICKET_SELECT_FIELDS}
       FROM tickets t
       ${TICKET_JOINS}
       WHERE ${whereClause}
       ORDER BY ${orderBy}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return {
      items: dataRes.rows.map(mapTicketRow),
      page,
      pageSize,
      total,
    };
  }

  /**
   * Resolve a ticket with optional KB promotion flag and system message.
   */
  static async resolveTicket(data: {
    ticketId: string;
    tenantId: string;
    staffName: string;
    addToKb: boolean;
  }): Promise<Ticket> {
    const client = await (await import("../../db/client.js")).pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `UPDATE tickets
         SET status = 'RESOLVED', in_kb = $1, updated_at = NOW()
         WHERE id = $2 AND tenant_id = $3`,
        [data.addToKb, data.ticketId, data.tenantId]
      );

      const sysBody = `Ticket marked resolved by ${data.staffName}.${
        data.addToKb ? " Queued for knowledge-base ingestion." : ""
      }`;

      await client.query(
        `INSERT INTO ticket_messages (
          ticket_id, author_type, author_id, author_name, body
        ) VALUES ($1, 'SYSTEM', NULL, 'SupportSense', $2)`,
        [data.ticketId, sysBody]
      );

      await client.query("COMMIT");
      const updated = await this.findTicketById(data.ticketId, data.tenantId);
      if (!updated) throw new Error("Ticket not found after resolve");
      return updated;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Assign a ticket to a team or an agent.
   */
  static async assignTicket(data: {
    ticketId: string;
    tenantId: string;
    teamId?: string | null;
    teamName?: string | null;
    assigneeId?: string | null;
    actorName: string;
  }): Promise<Ticket> {
    const client = await (await import("../../db/client.js")).pool.connect();
    try {
      await client.query("BEGIN");

      const updates: string[] = ["updated_at = NOW()"];
      const params: any[] = [data.ticketId, data.tenantId];

      if (data.teamId !== undefined) {
        params.push(data.teamId);
        updates.push(`assigned_team_id = $${params.length}`);
        // Clear assignee when reassigning team unless specified
        if (data.assigneeId === undefined) {
          updates.push("assignee_id = NULL");
        }
      }

      if (data.assigneeId !== undefined) {
        params.push(data.assigneeId);
        updates.push(`assignee_id = $${params.length}`);
      }

      await client.query(
        `UPDATE tickets SET ${updates.join(", ")} WHERE id = $1 AND tenant_id = $2`,
        params
      );

      let sysNote = "Ticket reassigned.";
      if (data.teamName) {
        sysNote = `Reassigned to the ${data.teamName} team.`;
      }

      await client.query(
        `INSERT INTO ticket_messages (
          ticket_id, author_type, author_id, author_name, body
        ) VALUES ($1, 'SYSTEM', NULL, 'SupportSense', $2)`,
        [data.ticketId, sysNote]
      );

      await client.query("COMMIT");
      const updated = await this.findTicketById(data.ticketId, data.tenantId);
      if (!updated) throw new Error("Ticket not found after assignment");
      return updated;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}

