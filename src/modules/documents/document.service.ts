import path from "path";
import { getStorageService } from "./storage.factory.js";
import { DocumentRepository } from "./document.repository.js";
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
  static sanitizeFilename(raw: string): string {
    // Strip directory paths and dangerous characters
    const base = path.basename(raw).trim();
    return base.replace(/[^\w\s.-]/g, "_").slice(0, 255) || "uploaded_document";
  }

  static validateFile(filename: string, mimeType: string, fileSize: number): void {
    if (fileSize <= 0) {
      throw new BadRequestError("Uploaded file is empty");
    }

    if (fileSize > MAX_FILE_SIZE_BYTES) {
      throw new BadRequestError(
        `File size (${(fileSize / (1024 * 1024)).toFixed(1)}MB) exceeds maximum allowed limit of ${
          MAX_FILE_SIZE_BYTES / (1024 * 1024)
        }MB`
      );
    }

    const ext = path.extname(filename).toLowerCase();
    const isExtensionAllowed = (ALLOWED_EXTENSIONS as readonly string[]).includes(ext);
    if (!isExtensionAllowed) {
      throw new BadRequestError(
        `Unsupported file type "${ext}". Supported formats are: ${ALLOWED_EXTENSIONS.join(", ")}`
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

    // Extract text content if txt or md
    let extractedContent: string | null = null;
    const ext = path.extname(cleanFilename).toLowerCase();
    if (ext === ".md" || ext === ".markdown" || ext === ".txt") {
      extractedContent = input.fileBuffer.toString("utf8");
    }

    const storage = getStorageService();

    // 1. Save file to storage
    const stored = await storage.save(
      input.fileBuffer,
      cleanFilename,
      input.mimeType,
      input.tenantId
    );

    // 2. Insert record in PostgreSQL
    const doc = await DocumentRepository.create({
      tenantId: input.tenantId,
      title,
      originalFilename: cleanFilename,
      storageKey: stored.storageKey,
      mimeType: input.mimeType,
      fileSize: stored.fileSize,
      status: "ready", // ready for consumption
      content: extractedContent,
      uploadedBy: input.userId,
    });

    return doc;
  }

  static async listDocuments(tenantId: string): Promise<DocumentPublic[]> {
    return DocumentRepository.findByTenant(tenantId);
  }

  static async getDocument(id: string, tenantId: string): Promise<DocumentPublic> {
    const doc = await DocumentRepository.findById(id, tenantId);
    if (!doc) {
      throw new NotFoundError("Document not found");
    }
    return doc;
  }

  static async deleteDocument(id: string, tenantId: string): Promise<void> {
    const doc = await DocumentRepository.findById(id, tenantId);
    if (!doc) {
      throw new NotFoundError("Document not found");
    }

    // Delete file from storage
    const storage = getStorageService();
    await storage.delete(doc.storageKey);

    // Delete record from PostgreSQL
    await DocumentRepository.delete(id, tenantId);
  }
}

