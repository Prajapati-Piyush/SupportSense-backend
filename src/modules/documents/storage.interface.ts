export interface StoredFileResult {
  storageKey: string;
  fileSize: number;
}

export interface StorageService {
  /**
   * Save a file buffer to storage.
   * Returns a unique storageKey and the verified fileSize.
   */
  save(
    fileBuffer: Buffer,
    originalFilename: string,
    mimeType: string,
    tenantId: string
  ): Promise<StoredFileResult>;

  /**
   * Retrieve a file buffer by storageKey.
   */
  get(storageKey: string): Promise<Buffer>;

  /**
   * Delete a stored file by storageKey.
   */
  delete(storageKey: string): Promise<void>;

  /**
   * Check if a file exists by storageKey.
   */
  exists(storageKey: string): Promise<boolean>;
}

