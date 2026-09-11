import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { TicketRepository } from "./ticket.repository.js";
import { ForbiddenError, NotFoundError } from "../../utils/errors.js";
import { TicketCategory, TicketPriority } from "./ticket.types.js";
import { query } from "../../db/client.js";

const createTicketSchema = z.object({
  subject: z.string().trim().min(3, "Subject must be at least 3 characters"),
  body: z.string().trim().min(5, "Message body must be at least 5 characters"),
  categoryHint: z.string().optional().nullable(),
});

const addMessageSchema = z.object({
  body: z.string().trim().min(1, "Message body cannot be empty"),
});

export class CustomerTicketController {
  /**
   * POST /api/tickets
   * Customer creates a new ticket with an initial message.
   */
  static async create(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const user = req.user!;
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
        [user.tenantId || "t-acme", search]
      );
      if (teamRes.rows[0]) {
        assignedTeamId = teamRes.rows[0].id;
      }
    }

    const ticket = await TicketRepository.createTicket({
      tenantId: user.tenantId || "t-acme",
      customerId: user.id,
      customerName: user.fullName,
      subject: input.subject,
      body: input.body,
      category: (input.categoryHint as TicketCategory) || null,
      priority: null,
      assignedTeamId,
    });

    reply.status(201).send(ticket);
  }

  /**
   * GET /api/tickets
   * Customer retrieves their own tickets.
   */
  static async list(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const user = req.user!;
    const tickets = await TicketRepository.findCustomerTickets(
      user.tenantId || "t-acme",
      user.id
    );

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
    const { id } = req.params;

    const ticket = await TicketRepository.findTicketById(id, user.tenantId || "t-acme");
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
   * POST /api/tickets/:id/messages
   * Customer appends a reply to their ticket thread.
   */
  static async addMessage(
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ): Promise<void> {
    const user = req.user!;
    const { id } = req.params;
    const input = addMessageSchema.parse(req.body);

    const ticket = await TicketRepository.findTicketById(id, user.tenantId || "t-acme");
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

