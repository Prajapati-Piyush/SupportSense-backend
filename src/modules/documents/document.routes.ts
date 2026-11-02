import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { DocumentController } from "./document.controller.js";
import { RetrievalController } from "../rag/retrieval/retrieval.controller.js";
import { GenerationController } from "../rag/generation/generation.controller.js";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/rbac.js";

export const documentRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // All document routes require authentication and staff/admin role
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("staff", "admin"));

  // Document upload and management
  app.post("/", DocumentController.upload);
  app.get("/", DocumentController.list);

  // RAG Retrieval & Indexing endpoints
  app.post("/retrieve", RetrievalController.retrieve);
  app.post("/answer", GenerationController.generateAnswer);
  app.post("/index-pending", RetrievalController.indexPending);

  // Document-specific routes
  app.get<{ Params: { id: string } }>("/:id", DocumentController.getById);
  app.get<{ Params: { id: string } }>("/:id/chunks", DocumentController.getChunks);
  app.post<{ Params: { id: string } }>("/:id/reprocess", DocumentController.reprocess);
  app.delete<{ Params: { id: string } }>(
    "/:id",
    { preHandler: requireRole("admin") },
    DocumentController.delete
  );
};
