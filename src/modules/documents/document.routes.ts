import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { DocumentController } from "./document.controller.js";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/rbac.js";

export const documentRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // All document routes require authentication and staff/admin role
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("staff", "admin"));

  app.post("/", DocumentController.upload);
  app.get("/", DocumentController.list);
  app.get<{ Params: { id: string } }>("/:id", DocumentController.getById);
  app.delete<{ Params: { id: string } }>(
    "/:id",
    { preHandler: requireRole("admin") },
    DocumentController.delete
  );
};
