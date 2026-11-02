import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { RetrievalController } from "./retrieval.controller.js";
import { GenerationController } from "../generation/generation.controller.js";
import { authenticate } from "../../../middleware/auth.js";
import { requireRole } from "../../../middleware/rbac.js";

export const retrievalRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // All retrieval routes require authentication and staff or admin role
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("staff", "admin"));

  // Retrieval endpoints
  app.post("/", RetrievalController.retrieve);
  app.post("/retrieve", RetrievalController.retrieve);

  // Grounded answer generation endpoint
  app.post("/answer", GenerationController.generateAnswer);

  // Admin/staff backfill endpoint for chunks with NULL embeddings
  app.post("/index-pending", RetrievalController.indexPending);
};

