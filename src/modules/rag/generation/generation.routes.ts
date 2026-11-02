import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { GenerationController } from "./generation.controller.js";
import { authenticate } from "../../../middleware/auth.js";
import { requireRole } from "../../../middleware/rbac.js";

export const generationRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // All grounded generation routes require session authentication and staff/admin RBAC
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("staff", "admin"));

  // Grounded answer generation endpoints
  app.post("/answer", GenerationController.generateAnswer);
  app.post("/", GenerationController.generateAnswer);
};

