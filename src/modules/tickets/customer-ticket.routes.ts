import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { CustomerTicketController } from "./customer-ticket.controller.js";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/rbac.js";

export const customerTicketRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Enforce customer authentication for all endpoints under /api/tickets
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("customer", "admin"));

  app.post("/", CustomerTicketController.create);
  app.get("/", CustomerTicketController.list);
  app.get("/:id", CustomerTicketController.getById);
  app.patch("/:id", CustomerTicketController.update);
  app.post("/:id/messages", CustomerTicketController.addMessage);
};

