import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { StorageService, StoredFileResult } from "./storage.interface.js";

export class LocalStorageService implements StorageService {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = path.resolve(baseDir || path.join(process.cwd(), "uploads"));
  }

  /**
   * Resolve and validate a storageKey to prevent path traversal attacks.
   */
  private resolveSafePath(storageKey: string): string {
    // Prevent any ../ or null-byte characters
    const sanitizedKey = storageKey.replace(/\0/g, "").replace(/\.\.+/g, "");
    const fullPath = path.resolve(this.baseDir, sanitizedKey);

    if (!fullPath.startsWith(this.baseDir)) {
      throw new Error("Path traversal detected: invalid storage key");
    }

    return fullPath;
  }

  async save(
    fileBuffer: Buffer,
    originalFilename: string,
    _mimeType: string,
    tenantId: string
  ): Promise<StoredFileResult> {
    const ext = path.extname(originalFilename).toLowerCase();
    // Only alphanumeric safe extension
    const safeExt = ext.replace(/[^a-z0-9.]/g, "") || ".bin";
    const uniqueId = crypto.randomUUID();
    const safeTenant = tenantId.replace(/[^a-zA-Z0-9_-]/g, "");

    const storageKey = path.join(safeTenant, `${uniqueId}${safeExt}`).replace(/\\/g, "/");
    const fullPath = this.resolveSafePath(storageKey);

    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, fileBuffer);

    return {
      storageKey,
      fileSize: fileBuffer.length,
    };
  }

  async get(storageKey: string): Promise<Buffer> {
    const fullPath = this.resolveSafePath(storageKey);
    return fs.readFile(fullPath);
  }

  async delete(storageKey: string): Promise<void> {
    try {
      const fullPath = this.resolveSafePath(storageKey);
      await fs.unlink(fullPath);
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        throw err;
      }
    }
  }

  async exists(storageKey: string): Promise<boolean> {
    try {
      const fullPath = this.resolveSafePath(storageKey);
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }
}

