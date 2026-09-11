import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { DeskTicketController } from "./desk-ticket.controller.js";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/rbac.js";

export const deskTicketRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Enforce staff/admin authentication for all endpoints under /api/desk/tickets
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("staff", "admin"));

  app.get("/", DeskTicketController.list);
  app.get("/:id", DeskTicketController.getById);
  app.post("/:id/reply", DeskTicketController.reply);
  app.post("/:id/resolve", DeskTicketController.resolve);
  app.post("/:id/assign", DeskTicketController.assign);
};

