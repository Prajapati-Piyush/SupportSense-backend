import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { BadRequestError } from "../../../utils/errors.js";
import { RetrievalService } from "./retrieval.service.js";
import { DocumentService } from "../../documents/document.service.js";

const retrieveBodySchema = z.object({
  query: z
    .string()
    .min(1, "Search query must not be empty")
    .max(2000, "Query cannot exceed 2000 characters"),
  topK: z.coerce.number().int().min(1).max(100).optional(),
  similarityThreshold: z.coerce.number().min(0.0).max(1.0).optional(),
  mode: z.enum(["hybrid", "semantic", "keyword"]).optional(),
  rrfK: z.coerce.number().int().min(1).max(500).optional(),
  semanticWeight: z.coerce.number().min(0).max(10).optional(),
  keywordWeight: z.coerce.number().min(0).max(10).optional(),
});

const indexPendingBodySchema = z.object({
  batchSize: z.coerce.number().int().min(1).max(500).optional().default(50),
});

export class RetrievalController {
  /**
   * POST /api/retrieval or POST /api/documents/retrieve
   * Performs semantic, keyword, or hybrid retrieval.
   * Strictly tenant-isolated using req.user.tenantId.
   */
  static async retrieve(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const user = req.user!;
    const tenantId = user.tenantId;
    if (!tenantId) {
      throw new BadRequestError("Authenticated user has no associated tenant");
    }

    const parseResult = retrieveBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      throw parseResult.error;
    }

    const {
      query,
      topK,
      similarityThreshold,
      mode,
      rrfK,
      semanticWeight,
      keywordWeight,
    } = parseResult.data;

    const result = await RetrievalService.retrieve(query, tenantId, {
      topK,
      similarityThreshold,
      mode,
      rrfK,
      semanticWeight,
      keywordWeight,
    });

    reply.status(200).send({
      success: true,
      data: result,
    });
  }

  /**
   * POST /api/retrieval/index-pending or POST /api/documents/index-pending
   * Backfills embeddings for document chunks with NULL embedding.
   */
  static async indexPending(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const user = req.user!;
    const tenantId = user.tenantId;
    if (!tenantId) {
      throw new BadRequestError("Authenticated user has no associated tenant");
    }

    const parseResult = indexPendingBodySchema.safeParse(req.body || {});
    if (!parseResult.success) {
      throw parseResult.error;
    }

    const { batchSize } = parseResult.data;
    const result = await DocumentService.indexPendingChunks(tenantId, batchSize);

    reply.status(200).send({
      success: true,
      message: `Indexed ${result.indexedCount} chunks (${result.remainingCount} remaining)`,
      data: result,
    });
  }
}

