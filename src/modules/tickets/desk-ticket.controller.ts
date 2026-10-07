import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { TicketRepository } from "./ticket.repository.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../utils/errors.js";
import { query } from "../../db/client.js";
import { TicketCategory, TicketPriority, TicketStatus } from "./ticket.types.js";

const replySchema = z.object({
  body: z.string().trim().min(1, "Reply message cannot be empty"),
});

const resolveSchema = z.object({
  addToKb: z.boolean().optional().default(false),
});

const assignSchema = z.object({
  teamId: z.string().optional().nullable(),
  assigneeId: z.string().optional().nullable(),
});

const updateDeskTicketSchema = z.object({
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
  assignedTeamId: z.string().optional().nullable(),
  assigneeId: z.string().optional().nullable(),
});

export class DeskTicketController {
  /**
   * GET /api/desk/tickets
   * Staff/Admin lists tickets in queue matching filters.
   */
  static async list(
    req: FastifyRequest<{
      Querystring: {
        q?: string;
        aiState?: string;
        priority?: string;
        category?: string;
        assignment?: string;
        teamId?: string;
        sort?: string;
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

    const { q, aiState, priority, category, assignment, teamId, sort, page, pageSize } =
      req.query;

    const result = await TicketRepository.findDeskTickets(
      tenantId,
      {
        q,
        aiState,
        priority,
        category,
        assignment,
        teamId,
        sort,
        page: page ? parseInt(page, 10) : 1,
        pageSize: pageSize ? parseInt(pageSize, 10) : 12,
      },
      user.role,
      user.teamId,
      user.id
    );

    reply.status(200).send(result);
  }

  /**
   * GET /api/desk/tickets/:id
   * Staff/Admin retrieves full ticket details, thread, and AI panels.
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

    if (
      user.role.toLowerCase() === "staff" &&
      user.teamId &&
      ticket.assignedTeamId &&
      ticket.assignedTeamId !== user.teamId
    ) {
      throw new ForbiddenError("Ticket is not assigned to your team.");
    }

    const messages = await TicketRepository.getTicketMessages(id);

    reply.status(200).send({
      ticket,
      messages,
      classification: ticket.category
        ? {
            category: ticket.category,
            priority: ticket.priority || "MEDIUM",
            suggestedTeam: ticket.assignedTeamName || "Support",
            confidence: 0.95,
            reasoning: "Ticket classification from records",
          }
        : null,
      draft: null,
      citations: [],
      rejectedEvidence: [],
      reviewHistory: [],
    });
  }

  /**
   * PATCH /api/desk/tickets/:id
   * Staff/Admin updates ticket status, priority, category, or assignment.
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

    if (
      user.role.toLowerCase() === "staff" &&
      user.teamId &&
      ticket.assignedTeamId &&
      ticket.assignedTeamId !== user.teamId
    ) {
      throw new ForbiddenError("Ticket is not assigned to your team.");
    }

    const input = updateDeskTicketSchema.parse(req.body || {});

    const updated = await TicketRepository.updateTicket({
      ticketId: id,
      tenantId,
      subject: input.subject,
      status: input.status as TicketStatus | undefined,
      priority: input.priority as TicketPriority | null | undefined,
      category: input.category as TicketCategory | null | undefined,
      assignedTeamId: input.assignedTeamId,
      assigneeId: input.assigneeId,
    });

    reply.status(200).send(updated);
  }

  /**
   * POST /api/desk/tickets/:id/reply
   * Staff/Admin posts a manual reply to the customer.
   */
  static async reply(
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ): Promise<void> {
    const user = req.user!;
    const tenantId = user.tenantId;
    if (!tenantId) {
      throw new BadRequestError("Authenticated user has no associated tenant");
    }

    const { id } = req.params;
    const input = replySchema.parse(req.body);

    const ticket = await TicketRepository.findTicketById(id, tenantId);
    if (!ticket) {
      throw new NotFoundError("That ticket could not be found.");
    }

    if (
      user.role.toLowerCase() === "staff" &&
      user.teamId &&
      ticket.assignedTeamId &&
      ticket.assignedTeamId !== user.teamId
    ) {
      throw new ForbiddenError("Ticket is not assigned to your team.");
    }

    const authorTitle = `${user.tenantName || "Acme Cloud"} ${user.teamName || "Support"}`;

    const message = await TicketRepository.appendMessage({
      ticketId: id,
      authorType: "STAFF",
      authorId: user.id,
      authorName: user.fullName,
      authorTitle,
      body: input.body,
      nextStatus: "AWAITING_CUSTOMER",
      unreadForCustomer: true,
      assigneeId: user.id,
    });

    reply.status(201).send(message);
  }

  /**
   * POST /api/desk/tickets/:id/resolve
   * Staff/Admin resolves ticket with optional KB flag.
   */
  static async resolve(
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ): Promise<void> {
    const user = req.user!;
    const tenantId = user.tenantId;
    if (!tenantId) {
      throw new BadRequestError("Authenticated user has no associated tenant");
    }

    const { id } = req.params;
    const input = resolveSchema.parse(req.body || {});

    const ticket = await TicketRepository.findTicketById(id, tenantId);
    if (!ticket) {
      throw new NotFoundError("That ticket could not be found.");
    }

    if (
      user.role.toLowerCase() === "staff" &&
      user.teamId &&
      ticket.assignedTeamId &&
      ticket.assignedTeamId !== user.teamId
    ) {
      throw new ForbiddenError("Ticket is not assigned to your team.");
    }

    const updated = await TicketRepository.resolveTicket({
      ticketId: id,
      tenantId,
      staffName: user.fullName,
      addToKb: Boolean(input.addToKb),
    });

    reply.status(200).send(updated);
  }

  /**
   * POST /api/desk/tickets/:id/assign
   * Staff/Admin reassigns ticket team or agent.
   */
  static async assign(
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ): Promise<void> {
    const user = req.user!;
    const tenantId = user.tenantId;
    if (!tenantId) {
      throw new BadRequestError("Authenticated user has no associated tenant");
    }

    const { id } = req.params;
    const input = assignSchema.parse(req.body || {});

    const ticket = await TicketRepository.findTicketById(id, tenantId);
    if (!ticket) {
      throw new NotFoundError("That ticket could not be found.");
    }

    let teamName: string | null = null;
    if (input.teamId) {
      const tm = await query<{ name: string }>(
        "SELECT name FROM teams WHERE id = $1 LIMIT 1",
        [input.teamId]
      );
      if (tm.rows[0]) {
        teamName = tm.rows[0].name;
      }
    }

    const updated = await TicketRepository.assignTicket({
      ticketId: id,
      tenantId,
      teamId: input.teamId,
      teamName,
      assigneeId: input.assigneeId,
      actorName: user.fullName,
    });

    reply.status(200).send(updated);
  }
}
