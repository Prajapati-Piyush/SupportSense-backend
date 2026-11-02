import path from "path";
import { getStorageService } from "./storage.factory.js";
import { DocumentRepository } from "./document.repository.js";
import { TextExtractorService } from "./text-extractor.service.js";
import { ChunkerService } from "./chunker.service.js";
import { ChunkRepository, DocumentChunkPublic } from "./chunk.repository.js";
import { EmbeddingService } from "../rag/embeddings/embedding.service.js";
import {
  ALLOWED_EXTENSIONS,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE_BYTES,
  DocumentPublic,
} from "./document.types.js";
import { BadRequestError, NotFoundError } from "../../utils/errors.js";

export interface UploadFileInput {
  tenantId: string;
  userId: string;
  filename: string;
  mimeType: string;
  fileBuffer: Buffer;
  customTitle?: string | null;
}

export class DocumentService {
  /**
   * Sanitizes filename to prevent directory traversal or malformed paths.
   */
  static sanitizeFilename(filename: string): string {
    const base = path.basename(filename);
    return base.replace(/[^a-zA-Z0-9._-]/g, "_");
  }

  /**
   * Validates file size, extension, and MIME type.
   */
  static validateFile(filename: string, mimeType: string, sizeBytes: number): void {
    if (sizeBytes <= 0) {
      throw new BadRequestError("File is empty (0 bytes)");
    }

    if (sizeBytes > MAX_FILE_SIZE_BYTES) {
      throw new BadRequestError(
        `File size (${(sizeBytes / 1024 / 1024).toFixed(1)}MB) exceeds maximum allowed size of 15MB`
      );
    }

    const ext = path.extname(filename).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext as any)) {
      throw new BadRequestError(
        `Unsupported file type "${ext}". Allowed types: ${ALLOWED_EXTENSIONS.join(", ")}`
      );
    }

    const isMimeAllowed = (ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType.toLowerCase());
    // Also allow generic application/octet-stream if extension is recognized
    if (!isMimeAllowed && mimeType !== "application/octet-stream") {
      throw new BadRequestError(`Unsupported MIME type: ${mimeType}`);
    }
  }

  static async uploadDocument(input: UploadFileInput): Promise<DocumentPublic> {
    const cleanFilename = this.sanitizeFilename(input.filename);
    const fileSize = input.fileBuffer.length;

    this.validateFile(cleanFilename, input.mimeType, fileSize);

    const title =
      input.customTitle?.trim() || cleanFilename.replace(/\.[^.]+$/, "");

    const storage = getStorageService();

    // 1. Save file to storage abstraction
    const stored = await storage.save(
      input.fileBuffer,
      cleanFilename,
      input.mimeType,
      input.tenantId
    );

    // 2. Insert record in PostgreSQL with initial status "uploaded"
    const doc = await DocumentRepository.create({
      tenantId: input.tenantId,
      title,
      originalFilename: cleanFilename,
      storageKey: stored.storageKey,
      mimeType: input.mimeType,
      fileSize: stored.fileSize,
      status: "uploaded",
      content: null,
      uploadedBy: input.userId,
    });

    // 3. Process document (extract text -> chunk -> save chunks -> embed chunks -> ready)
    try {
      return await this.processDocument(
        doc.id,
        input.tenantId,
        input.fileBuffer,
        cleanFilename,
        input.mimeType,
        title
      );
    } catch (err: any) {
      // Document upload succeeded and record is stored, but extraction/chunking/embedding failed.
      // The status has been transitioned to 'failed' with error_message in DB.
      const failedDoc = await DocumentRepository.findById(doc.id, input.tenantId);
      return failedDoc || doc;
    }
  }

  /**
   * Internal processing pipeline:
   * 1. Status -> "processing"
   * 2. Text extraction via TextExtractorService
   * 3. Structure-aware chunking via ChunkerService
   * 4. Persist chunks in document_chunks table
   * 5. Generate and persist 768-dim embeddings via EmbeddingService
   * 6. Status -> "ready" (or "failed" with error_message)
   */
  static async processDocument(
    documentId: string,
    tenantId: string,
    fileBuffer: Buffer,
    filename: string,
    mimeType: string,
    title: string
  ): Promise<DocumentPublic> {
    // 1. Mark as processing
    await DocumentRepository.updateProcessingResult(documentId, tenantId, {
      status: "processing",
      errorMessage: null,
    });

    let extractedText = "";

    try {
      const extracted = await TextExtractorService.extractText(
        fileBuffer,
        filename,
        mimeType
      );
      extractedText = extracted.text;
    } catch (err: any) {
      const errMsg = err.message || "Failed to extract text from document";
      await DocumentRepository.updateProcessingResult(documentId, tenantId, {
        status: "failed",
        errorMessage: errMsg,
      });
      throw err;
    }

    try {
      // Structure-aware chunking (300-500 tokens, heading paths, overlap)
      const chunks = ChunkerService.chunkDocument(extractedText, {
        rootTitle: title,
      });

      if (!chunks || chunks.length === 0) {
        throw new BadRequestError(`Document "${filename}" produced no readable chunks`);
      }

      // Persist chunks to document_chunks table (returns inserted rows with IDs)
      const insertedRows = await ChunkRepository.replaceChunks(documentId, tenantId, chunks);

      // Step 3: Generate embeddings and persist them
      try {
        const embeddedResults = await EmbeddingService.embedChunks(
          insertedRows.map((r) => ({
            id: r.id,
            tenantId: r.tenant_id,
            content: r.content,
            headingPath: r.heading_path,
          }))
        );

        await ChunkRepository.saveChunkEmbeddings(embeddedResults);
      } catch (embErr: any) {
        const errMsg = `Embedding generation failed: ${embErr.message || "Provider error"}`;
        await DocumentRepository.updateProcessingResult(documentId, tenantId, {
          status: "failed",
          errorMessage: errMsg,
        });
        throw new Error(errMsg);
      }

      // Verify no pending un-embedded chunks remain
      const pendingCount = await ChunkRepository.countPendingByDocument(documentId, tenantId);
      if (pendingCount > 0) {
        const errMsg = `Incomplete indexing: ${pendingCount} chunks lack embeddings`;
        await DocumentRepository.updateProcessingResult(documentId, tenantId, {
          status: "failed",
          errorMessage: errMsg,
        });
        throw new BadRequestError(errMsg);
      }

      // Transition status to "ready"
      await DocumentRepository.updateProcessingResult(documentId, tenantId, {
        content: extractedText,
        status: "ready",
        errorMessage: null,
      });

      const readyDoc = await DocumentRepository.findById(documentId, tenantId);
      if (!readyDoc) {
        throw new NotFoundError("Document not found after processing");
      }

      return readyDoc;
    } catch (err: any) {
      const errMsg = err.message || "Failed to chunk and save document";
      await DocumentRepository.updateProcessingResult(documentId, tenantId, {
        status: "failed",
        errorMessage: errMsg,
      });
      throw err;
    }
  }

  /**
   * Reprocesses an existing document from scratch.
   */
  static async reprocessDocument(
    documentId: string,
    tenantId: string
  ): Promise<DocumentPublic> {
    const doc = await DocumentRepository.findById(documentId, tenantId);
    if (!doc) {
      throw new NotFoundError(`Document with ID "${documentId}" not found`);
    }

    const storage = getStorageService();
    const fileBuffer = await storage.get(doc.storageKey);

    return this.processDocument(
      doc.id,
      tenantId,
      fileBuffer,
      doc.originalFilename,
      doc.mimeType,
      doc.title
    );
  }

  /**
   * Backfills embeddings for existing chunks that have NULL embeddings.
   * Useful for indexing documents processed prior to Step 3.
   */
  static async indexPendingChunks(
    tenantId: string,
    batchSize = 50
  ): Promise<{ indexedCount: number; remainingCount: number }> {
    const pendingChunks = await ChunkRepository.findPendingChunks(tenantId, batchSize);

    if (pendingChunks.length === 0) {
      const remaining = await ChunkRepository.countPendingChunks(tenantId);
      return { indexedCount: 0, remainingCount: remaining };
    }

    const embeddedResults = await EmbeddingService.embedChunks(
      pendingChunks.map((c) => ({
        id: c.id,
        tenantId: c.tenant_id,
        content: c.content,
        headingPath: c.heading_path,
      }))
    );

    await ChunkRepository.saveChunkEmbeddings(embeddedResults);

    // Promote any documents that now have zero pending chunks to 'ready'
    const affectedDocIds = [...new Set(pendingChunks.map((c) => c.document_id))];
    for (const docId of affectedDocIds) {
      const remainingForDoc = await ChunkRepository.countPendingByDocument(docId, tenantId);
      if (remainingForDoc === 0) {
        await DocumentRepository.updateProcessingResult(docId, tenantId, {
          status: "ready",
          errorMessage: null,
        });
      }
    }

    const remaining = await ChunkRepository.countPendingChunks(tenantId);
    return {
      indexedCount: embeddedResults.length,
      remainingCount: remaining,
    };
  }

  static async getDocument(
    documentId: string,
    tenantId: string
  ): Promise<DocumentPublic> {
    const doc = await DocumentRepository.findById(documentId, tenantId);
    if (!doc) {
      throw new NotFoundError(`Document with ID "${documentId}" not found`);
    }
    return doc;
  }

  static async listDocuments(tenantId: string): Promise<DocumentPublic[]> {
    return DocumentRepository.findByTenant(tenantId);
  }

  static async getDocumentChunks(
    documentId: string,
    tenantId: string
  ): Promise<DocumentChunkPublic[]> {
    const doc = await DocumentRepository.findById(documentId, tenantId);
    if (!doc) {
      throw new NotFoundError(`Document with ID "${documentId}" not found`);
    }
    return ChunkRepository.findByDocument(documentId, tenantId);
  }

  static async deleteDocument(
    documentId: string,
    tenantId: string
  ): Promise<void> {
    const doc = await DocumentRepository.findById(documentId, tenantId);
    if (!doc) {
      throw new NotFoundError(`Document with ID "${documentId}" not found`);
    }

    // Delete chunks (cascade or explicit)
    await ChunkRepository.deleteByDocument(documentId, tenantId);

    // Delete file from storage
    const storage = getStorageService();
    await storage.delete(doc.storageKey);

    // Delete DB record
    await DocumentRepository.delete(documentId, tenantId);
  }
}
