import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { BadRequestError } from "../../../utils/errors.js";
import { GroundedAnswerService } from "./grounded-answer.service.js";

const generateAnswerBodySchema = z.object({
  question: z
    .string()
    .min(1, "Question must not be empty")
    .max(2000, "Question cannot exceed 2000 characters"),
  topK: z.coerce.number().int().min(1).max(10).optional(),
  similarityThreshold: z.coerce.number().min(0.0).max(1.0).optional(),
  mode: z.enum(["hybrid", "semantic", "keyword"]).optional(),
  temperature: z.coerce.number().min(0.0).max(1.0).optional(),
  maxTokens: z.coerce.number().int().min(50).max(2048).optional(),
});

export class GenerationController {
  /**
   * POST /api/rag/answer or POST /api/retrieval/answer
   * Generates a grounded answer strictly using retrieved documentation evidence.
   * Strictly tenant-isolated using req.user.tenantId.
   */
  static async generateAnswer(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const user = req.user!;
    const tenantId = user.tenantId;
    if (!tenantId) {
      throw new BadRequestError("Authenticated user has no associated tenant");
    }

    const parseResult = generateAnswerBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      throw parseResult.error;
    }

    const { question, topK, similarityThreshold, mode, temperature, maxTokens } =
      parseResult.data;

    const result = await GroundedAnswerService.generateAnswer(question, tenantId, {
      question,
      topK,
      similarityThreshold,
      mode,
      temperature,
      maxTokens,
    });

    reply.status(200).send(result);
  }
}

