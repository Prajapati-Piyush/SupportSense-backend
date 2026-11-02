export type EmbeddingTaskType =
  | "RETRIEVAL_DOCUMENT"
  | "RETRIEVAL_QUERY"
  | "SEMANTIC_SIMILARITY";

export interface EmbeddingOptions {
  taskType?: EmbeddingTaskType;
}

export interface IEmbeddingProvider {
  readonly providerName: string;
  readonly modelName: string;
  readonly dimensions: number; // Strictly 768 for SupportSense schema

  /**
   * Generates a single vector embedding for query or text.
   */
  embedText(text: string, options?: EmbeddingOptions): Promise<number[]>;

  /**
   * Generates embeddings for a batch of text strings.
   */
  embedBatch(texts: string[], options?: EmbeddingOptions): Promise<number[][]>;
}

export interface ChunkForEmbedding {
  id: string;
  tenantId: string;
  content: string;
  headingPath?: string | null;
}

export interface EmbeddedChunkResult {
  id: string;
  tenantId: string;
  embedding: number[];
  model: string;
}
