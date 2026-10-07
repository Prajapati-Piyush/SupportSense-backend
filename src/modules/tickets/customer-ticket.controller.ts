import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { TicketRepository } from "./ticket.repository.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../utils/errors.js";
import { TicketCategory, TicketPriority, TicketStatus } from "./ticket.types.js";
import { query } from "../../db/client.js";

const createTicketSchema = z.object({
  subject: z.string().trim().min(3, "Subject must be at least 3 characters"),
  body: z.string().trim().min(5, "Message body must be at least 5 characters"),
  categoryHint: z.string().optional().nullable(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional().nullable(),
});

const addMessageSchema = z.object({
  body: z.string().trim().min(1, "Message body cannot be empty"),
});

const updateTicketSchema = z.object({
  subject: z.string().trim().min(3).optional(),
  status: z
    .enum([
      "NEW",
      "AI_PROCESSING",
      "AWAITING_STAFF_REVIEW",
      "ESCALATED",
      "AWAITING_CUSTOMER",
      "RESOLVED",
      "CLOSED",
    ])
    .optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional().nullable(),
  category: z
    .enum(["BILLING", "TECHNICAL", "ACCOUNT", "ORDERS", "RETURNS", "SECURITY", "OTHER"])
    .optional()
    .nullable(),
});

export class CustomerTicketController {
  /**
   * POST /api/tickets
   * Customer creates a new ticket with an initial message.
   */
  static async create(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const user = req.user!;
    const tenantId = user.tenantId;
    if (!tenantId) {
      throw new BadRequestError("Authenticated user has no associated tenant");
    }

    const input = createTicketSchema.parse(req.body);

    let assignedTeamId: string | null = null;
    if (input.categoryHint) {
      const cat = input.categoryHint.toUpperCase();
      let search = `%${cat}%`;
      if (cat === "TECHNICAL") search = "%Tech%";
      else if (cat === "BILLING") search = "%Billing%";
      else if (cat === "ORDERS") search = "%Order%";
      else if (cat === "RETURNS") search = "%Return%";
      else if (cat === "ACCOUNT") search = "%Account%";

      const teamRes = await query<{ id: string }>(
        `SELECT id FROM teams
         WHERE tenant_id = $1 AND (name ILIKE $2 OR description ILIKE $2)
         ORDER BY (name ILIKE $2) DESC
         LIMIT 1`,
        [tenantId, search]
      );
      if (teamRes.rows[0]) {
        assignedTeamId = teamRes.rows[0].id;
      }
    }

    const ticket = await TicketRepository.createTicket({
      tenantId,
      customerId: user.id,
      customerName: user.fullName,
      subject: input.subject,
      body: input.body,
      category: (input.categoryHint as TicketCategory) || null,
      priority: (input.priority as TicketPriority) || null,
      assignedTeamId,
    });

    reply.status(201).send(ticket);
  }

  /**
   * GET /api/tickets
   * Customer retrieves their own tickets with optional filtering.
   */
  static async list(
    req: FastifyRequest<{
      Querystring: {
        status?: string;
        priority?: string;
        q?: string;
        page?: string;
        pageSize?: string;
      };
    }>,
    reply: FastifyReply
  ): Promise<void> {
    const user = req.user!;
    const tenantId = user.tenantId;
    if (!tenantId) {
      throw new BadRequestError("Authenticated user has no associated tenant");
    }

    const { status, priority, q, page, pageSize } = req.query;

    const tickets = await TicketRepository.findCustomerTickets(tenantId, user.id, {
      status,
      priority,
      q,
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
    });

    reply.status(200).send(tickets);
  }

  /**
   * GET /api/tickets/:id
   * Customer retrieves details and thread for their ticket.
   */
  static async getById(
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ): Promise<void> {
    const user = req.user!;
    const tenantId = user.tenantId;
    if (!tenantId) {
      throw new BadRequestError("Authenticated user has no associated tenant");
    }

    const { id } = req.params;

    const ticket = await TicketRepository.findTicketById(id, tenantId);
    if (!ticket) {
      throw new NotFoundError("That ticket could not be found.");
    }

    if (ticket.customerId !== user.id) {
      throw new ForbiddenError("This ticket belongs to another customer.");
    }

    const allMessages = await TicketRepository.getTicketMessages(id);
    const visibleMessages = allMessages.filter((m) => m.authorType !== "SYSTEM");

    reply.status(200).send({
      ticket,
      messages: visibleMessages,
    });
  }

  /**
   * PATCH /api/tickets/:id
   * Customer updates their own ticket (e.g. resolve or close)
   */
  static async update(
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ): Promise<void> {
    const user = req.user!;
    const tenantId = user.tenantId;
    if (!tenantId) {
      throw new BadRequestError("Authenticated user has no associated tenant");
    }

    const { id } = req.params;

    const ticket = await TicketRepository.findTicketById(id, tenantId);
    if (!ticket) {
      throw new NotFoundError("That ticket could not be found.");
    }

    if (ticket.customerId !== user.id) {
      throw new ForbiddenError("This ticket belongs to another customer.");
    }

    const input = updateTicketSchema.parse(req.body);

    const updated = await TicketRepository.updateTicket({
      ticketId: id,
      tenantId,
      subject: input.subject,
      status: input.status,
      priority: input.priority,
      category: input.category,
    });

    reply.status(200).send(updated);
  }

  /**
   * POST /api/tickets/:id/messages
   * Customer appends a reply to their ticket thread.
   */
  static async addMessage(
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ): Promise<void> {
    const user = req.user!;
    const tenantId = user.tenantId;
    if (!tenantId) {
      throw new BadRequestError("Authenticated user has no associated tenant");
    }

    const { id } = req.params;
    const input = addMessageSchema.parse(req.body);

    const ticket = await TicketRepository.findTicketById(id, tenantId);
    if (!ticket) {
      throw new NotFoundError("That ticket could not be found.");
    }

    if (ticket.customerId !== user.id) {
      throw new ForbiddenError("This ticket belongs to another customer.");
    }

    const message = await TicketRepository.appendMessage({
      ticketId: id,
      authorType: "CUSTOMER",
      authorId: user.id,
      authorName: user.fullName,
      body: input.body,
      nextStatus: "AWAITING_STAFF_REVIEW",
      unreadForCustomer: false,
    });

    reply.status(201).send(message);
  }
}
