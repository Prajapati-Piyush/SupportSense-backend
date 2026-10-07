import { FastifyReply, FastifyRequest } from "fastify";
import { DocumentService } from "./document.service.js";
import { BadRequestError } from "../../utils/errors.js";

export class DocumentController {
  /**
   * POST /api/documents
   * Supports multipart/form-data file uploads AND JSON fallback { title, content }
   */
  static async upload(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const user = req.user!;
    const tenantId = user.tenantId;
    if (!tenantId) {
      throw new BadRequestError("Authenticated user has no associated tenant");
    }

    const contentType = req.headers["content-type"] || "";

    if (contentType.includes("multipart/form-data")) {
      const part = await req.file();
      if (!part) {
        throw new BadRequestError("No file provided in multipart request");
      }

      const fileBuffer = await part.toBuffer();
      // Look for title in part.fields if passed
      let customTitle: string | null = null;
      if (part.fields && "title" in part.fields) {
        const titleField: any = part.fields.title;
        customTitle = typeof titleField.value === "string" ? titleField.value : null;
      }

      const doc = await DocumentService.uploadDocument({
        tenantId,
        userId: user.id,
        filename: part.filename,
        mimeType: part.mimetype,
        fileBuffer,
        customTitle,
      });

      reply.status(201).send(doc);
      return;
    }

    // JSON fallback { title, content, filename? }
    const body: any = req.body;
    if (!body || typeof body.title !== "string" || typeof body.content !== "string") {
      throw new BadRequestError(
        "Invalid request. Provide a multipart file upload or JSON { title, content }"
      );
    }

    const filename = (body.filename as string) || `${body.title.trim().replace(/\s+/g, "_")}.md`;
    const fileBuffer = Buffer.from(body.content, "utf8");

    const doc = await DocumentService.uploadDocument({
      tenantId,
      userId: user.id,
      filename,
      mimeType: "text/markdown",
      fileBuffer,
      customTitle: body.title,
    });

    reply.status(201).send(doc);
  }

  /**
   * GET /api/documents
   */
  static async list(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const user = req.user!;
    const tenantId = user.tenantId;
    if (!tenantId) {
      throw new BadRequestError("Authenticated user has no associated tenant");
    }

    const docs = await DocumentService.listDocuments(tenantId);
    reply.status(200).send(docs);
  }

  /**
   * GET /api/documents/:id
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

    const doc = await DocumentService.getDocument(req.params.id, tenantId);
    reply.status(200).send(doc);
  }

  /**
   * DELETE /api/documents/:id
   */
  static async delete(
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ): Promise<void> {
    const user = req.user!;
    const tenantId = user.tenantId;
    if (!tenantId) {
      throw new BadRequestError("Authenticated user has no associated tenant");
    }

    await DocumentService.deleteDocument(req.params.id, tenantId);
    reply.status(200).send({ message: "Document deleted successfully" });
  }
}

