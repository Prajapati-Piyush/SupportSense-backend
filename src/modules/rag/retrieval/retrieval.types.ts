export type RetrievalMode = "hybrid" | "semantic" | "keyword";

export interface RetrievalOptions {
  topK?: number;
  similarityThreshold?: number;
  mode?: RetrievalMode;
  rrfK?: number;
  semanticWeight?: number;
  keywordWeight?: number;
}

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  tenantId: string;
  chunkIndex: number;
  content: string;
  headingPath: string | null;
  tokenCount: number;
  documentTitle: string;
  originalFilename: string;
  sourceType: string;
  similarityScore: number | null; // Cosine similarity: [0, 1]
  keywordScore: number | null;    // ts_rank_cd score
  rrfScore: number | null;        // Reciprocal rank fusion score (for hybrid)
  combinedRank: number;           // 1-based order in final output
  matchType: "semantic" | "keyword" | "hybrid";
}

export interface RetrievalResult {
  query: string;
  mode: RetrievalMode;
  totalMatches: number;
  results: RetrievedChunk[];
  metadata: {
    semanticMatchesCount: number;
    keywordMatchesCount: number;
    fusedCount: number;
    topK: number;
    similarityThreshold: number;
    embeddingModel: string;
  };
}

export interface SemanticMatchRow {
  id: string;
  document_id: string;
  tenant_id: string;
  chunk_index: number;
  content: string;
  heading_path: string | null;
  token_count: number;
  embedding_model: string | null;
  document_title: string;
  original_filename: string;
  source_type: string;
  similarity: string | number;
}

export interface KeywordMatchRow {
  id: string;
  document_id: string;
  tenant_id: string;
  chunk_index: number;
  content: string;
  heading_path: string | null;
  token_count: number;
  embedding_model: string | null;
  document_title: string;
  original_filename: string;
  source_type: string;
  rank_score: string | number;
}

