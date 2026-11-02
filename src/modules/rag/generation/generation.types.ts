import { RetrievalMode } from "../retrieval/retrieval.types.js";

export interface LLMGenerateOptions {
  systemInstruction?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface LLMGenerateResult {
  text: string;
  model: string;
  finishReason?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export interface ILLMProvider {
  readonly providerName: string;
  readonly modelName: string;

  /**
   * Generates a grounded completion for the given prompt.
   */
  generateText(prompt: string, options?: LLMGenerateOptions): Promise<LLMGenerateResult>;
}

export interface AnswerSource {
  documentId: string;
  chunkId: string;
  chunkIndex: number;
  headingPath: string | null;
  documentTitle: string;
  originalFilename: string;
  sourceLabel: string;
  similarityScore: number | null;
  keywordScore: number | null;
  rrfScore: number | null;
  matchType: "semantic" | "keyword" | "hybrid";
}

export interface GroundedAnswerRequest {
  question: string;
  topK?: number;
  similarityThreshold?: number;
  mode?: RetrievalMode;
  temperature?: number;
  maxTokens?: number;
}

export type GroundedAnswerOptions = Partial<GroundedAnswerRequest>;

export interface GroundedAnswerResult {
  question: string;
  answer: string;
  confidence: "grounded" | "insufficient_evidence" | "no_context";
  hasEvidence: boolean;
  sources: AnswerSource[];
  metadata: {
    model: string;
    provider: string;
    retrievalMode: string;
    totalChunksRetrieved: number;
    chunksUsedCount: number;
    latencyMs: number;
    tokenUsage?: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
    };
  };
}
