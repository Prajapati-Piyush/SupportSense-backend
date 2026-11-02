import { EmbeddingProviderFactory } from "./embedding-provider.factory.js";
import { ChunkForEmbedding, EmbeddedChunkResult } from "./embedding.types.js";
import { BadRequestError, HttpError } from "../../../utils/errors.js";

export class EmbeddingService {
  public static readonly BATCH_SIZE = 25;
  private static readonly MAX_RETRIES = 3;
  private static readonly INITIAL_BACKOFF_MS = 60;

  /**
   * Enriches chunk content with hierarchical heading path context where available.
   * e.g., "Account Settings > Security > Two-Factor Authentication\n\nTo enable 2FA..."
   */
  static prepareChunkText(content: string, headingPath?: string | null): string {
    const trimmedContent = (content || "").trim();
    const trimmedPath = (headingPath || "").trim();

    if (trimmedPath && !trimmedContent.startsWith(trimmedPath)) {
      return `${trimmedPath}\n\n${trimmedContent}`;
    }
    return trimmedContent;
  }

  /**
   * Helper that executes an embedding operation with bounded retries and exponential backoff
   * on transient errors (HTTP 429 rate limits and 5xx server/network errors).
   */
  static async executeWithRetry<T>(
    operation: () => Promise<T>,
    maxRetries = this.MAX_RETRIES,
    initialBackoffMs = this.INITIAL_BACKOFF_MS
  ): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await operation();
      } catch (err: any) {
        attempt++;
        const isRateLimit =
          err?.statusCode === 429 ||
          err?.message?.includes("429") ||
          err?.code === "EMBEDDING_RATE_LIMIT";
        const isTransient =
          isRateLimit ||
          (err?.statusCode >= 500 && err?.statusCode < 600) ||
          err?.code === "ECONNRESET" ||
          err?.code === "ETIMEDOUT";

        if (!isTransient || attempt > maxRetries) {
          throw err;
        }

        const delayMs = initialBackoffMs * Math.pow(2, attempt - 1) + Math.random() * 20;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  /**
   * Generates 768-dimensional embeddings for an array of document chunks.
   * Processes in safe batches to respect API payload limits.
   */
  static async embedChunks(chunks: ChunkForEmbedding[]): Promise<EmbeddedChunkResult[]> {
    if (!chunks || chunks.length === 0) {
      return [];
    }

    const provider = EmbeddingProviderFactory.getProvider();
    const results: EmbeddedChunkResult[] = [];

    // Process in sub-batches
    for (let i = 0; i < chunks.length; i += this.BATCH_SIZE) {
      const slice = chunks.slice(i, i + this.BATCH_SIZE);
      const preparedTexts = slice.map((c) => this.prepareChunkText(c.content, c.headingPath));

      const vectors = await this.executeWithRetry(() =>
        provider.embedBatch(preparedTexts, { taskType: "RETRIEVAL_DOCUMENT" })
      );

      if (vectors.length !== slice.length) {
        throw new HttpError(
          502,
          "EMBEDDING_BATCH_ERROR",
          `Expected ${slice.length} embeddings from provider, received ${vectors.length}.`
        );
      }

      for (let j = 0; j < slice.length; j++) {
        const chunk = slice[j];
        const vector = vectors[j];

        if (!Array.isArray(vector) || vector.length !== provider.dimensions) {
          throw new HttpError(
            502,
            "EMBEDDING_DIMENSION_MISMATCH",
            `Chunk ${chunk.id} produced ${vector?.length ?? 0}-dim vector (expected ${provider.dimensions}).`
          );
        }

        results.push({
          id: chunk.id,
          tenantId: chunk.tenantId,
          embedding: vector,
          model: provider.modelName,
        });
      }
    }

    return results;
  }

  /**
   * Generates an embedding for a user search or question query.
   */
  static async embedQuery(queryText: string): Promise<{ embedding: number[]; model: string }> {
    const trimmed = (queryText || "").trim();
    if (!trimmed) {
      throw new BadRequestError("Cannot generate embedding for an empty query.");
    }

    const provider = EmbeddingProviderFactory.getProvider();
    const embedding = await this.executeWithRetry(() =>
      provider.embedText(trimmed, { taskType: "RETRIEVAL_QUERY" })
    );

    if (!Array.isArray(embedding) || embedding.length !== provider.dimensions) {
      throw new HttpError(
        502,
        "EMBEDDING_DIMENSION_MISMATCH",
        `Query embedding produced ${embedding?.length ?? 0}-dim vector (expected ${provider.dimensions}).`
      );
    }

    return {
      embedding,
      model: provider.modelName,
    };
  }
}

