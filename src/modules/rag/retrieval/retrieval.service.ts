import { env } from "../../../config/env.js";
import { EmbeddingProviderFactory } from "../embeddings/embedding-provider.factory.js";
import { EmbeddingService } from "../embeddings/embedding.service.js";
import { RetrievalRepository } from "./retrieval.repository.js";
import {
  RetrievalMode,
  RetrievalOptions,
  RetrievalResult,
  RetrievedChunk,
  SemanticMatchRow,
  KeywordMatchRow,
} from "./retrieval.types.js";

export class RetrievalService {
  /**
   * Retrieves relevant chunks using semantic search, keyword search, or hybrid RRF fusion.
   * All queries are strictly tenant-isolated.
   */
  static async retrieve(
    queryText: string,
    tenantId: string,
    options: RetrievalOptions = {}
  ): Promise<RetrievalResult> {
    const trimmedQuery = queryText.trim();
    const mode: RetrievalMode = options.mode ?? "hybrid";
    const topK = Math.max(1, Math.min(options.topK ?? env.RETRIEVAL_TOP_K, 100));
    const similarityThreshold = options.similarityThreshold ?? env.RETRIEVAL_SIMILARITY_THRESHOLD;
    const rrfK = options.rrfK ?? env.RETRIEVAL_RRF_K;
    const semanticWeight = options.semanticWeight ?? 1.0;
    const keywordWeight = options.keywordWeight ?? 1.0;

    let activeModel = "";
    try {
      activeModel = EmbeddingProviderFactory.getProvider().modelName;
    } catch {
      activeModel = "unknown";
    }

    // Handle empty or whitespace query
    if (!trimmedQuery) {
      return {
        query: queryText,
        mode,
        totalMatches: 0,
        results: [],
        metadata: {
          semanticMatchesCount: 0,
          keywordMatchesCount: 0,
          fusedCount: 0,
          topK,
          similarityThreshold,
          embeddingModel: activeModel,
        },
      };
    }

    if (mode === "semantic") {
      const semanticMatches = await this.executeSemanticSearch(
        trimmedQuery,
        tenantId,
        similarityThreshold,
        topK
      );

      const results: RetrievedChunk[] = semanticMatches.map((row, idx) => ({
        chunkId: row.id,
        documentId: row.document_id,
        tenantId: row.tenant_id,
        chunkIndex: row.chunk_index,
        content: row.content,
        headingPath: row.heading_path,
        tokenCount: row.token_count,
        documentTitle: row.document_title,
        originalFilename: row.original_filename,
        sourceType: row.source_type,
        similarityScore: Number(row.similarity),
        keywordScore: null,
        rrfScore: null,
        combinedRank: idx + 1,
        matchType: "semantic",
      }));

      return {
        query: trimmedQuery,
        mode: "semantic",
        totalMatches: results.length,
        results,
        metadata: {
          semanticMatchesCount: results.length,
          keywordMatchesCount: 0,
          fusedCount: results.length,
          topK,
          similarityThreshold,
          embeddingModel: activeModel,
        },
      };
    }

    if (mode === "keyword") {
      const keywordMatches = await RetrievalRepository.searchKeyword(
        tenantId,
        trimmedQuery,
        topK
      );

      const results: RetrievedChunk[] = keywordMatches.map((row, idx) => ({
        chunkId: row.id,
        documentId: row.document_id,
        tenantId: row.tenant_id,
        chunkIndex: row.chunk_index,
        content: row.content,
        headingPath: row.heading_path,
        tokenCount: row.token_count,
        documentTitle: row.document_title,
        originalFilename: row.original_filename,
        sourceType: row.source_type,
        similarityScore: null,
        keywordScore: Number(row.rank_score),
        rrfScore: null,
        combinedRank: idx + 1,
        matchType: "keyword",
      }));

      return {
        query: trimmedQuery,
        mode: "keyword",
        totalMatches: results.length,
        results,
        metadata: {
          semanticMatchesCount: 0,
          keywordMatchesCount: results.length,
          fusedCount: results.length,
          topK,
          similarityThreshold,
          embeddingModel: activeModel,
        },
      };
    }

    // Hybrid mode: execute semantic and keyword search, then fuse with RRF
    // Fetch up to 2 * topK from each search stream to ensure rich overlap
    const fetchLimit = Math.max(topK * 2, 20);

    let semanticMatches: SemanticMatchRow[] = [];
    let keywordMatches: KeywordMatchRow[] = [];

    const [semanticRes, keywordRes] = await Promise.allSettled([
      this.executeSemanticSearch(trimmedQuery, tenantId, similarityThreshold, fetchLimit),
      RetrievalRepository.searchKeyword(tenantId, trimmedQuery, fetchLimit),
    ]);

    if (semanticRes.status === "fulfilled") {
      semanticMatches = semanticRes.value;
    } else {
      console.warn(
        "Semantic search failed during hybrid retrieval; proceeding with keyword results",
        semanticRes.reason
      );
    }

    if (keywordRes.status === "fulfilled") {
      keywordMatches = keywordRes.value;
    } else {
      console.warn(
        "Keyword search failed during hybrid retrieval; proceeding with semantic results",
        keywordRes.reason
      );
    }

    // If both failed, throw error
    if (semanticRes.status === "rejected" && keywordRes.status === "rejected") {
      throw new Error("Both semantic and keyword retrieval streams failed.");
    }

    const fusedResults = this.fuseWithRRF(
      semanticMatches,
      keywordMatches,
      topK,
      rrfK,
      semanticWeight,
      keywordWeight
    );

    return {
      query: trimmedQuery,
      mode: "hybrid",
      totalMatches: fusedResults.length,
      results: fusedResults,
      metadata: {
        semanticMatchesCount: semanticMatches.length,
        keywordMatchesCount: keywordMatches.length,
        fusedCount: fusedResults.length,
        topK,
        similarityThreshold,
        embeddingModel: activeModel,
      },
    };
  }

  /**
   * Helper to embed query and run semantic search
   */
  private static async executeSemanticSearch(
    queryText: string,
    tenantId: string,
    threshold: number,
    limit: number
  ): Promise<SemanticMatchRow[]> {
    const queryResult = await EmbeddingService.embedQuery(queryText);
    return RetrievalRepository.searchSemantic(
      tenantId,
      queryResult.embedding,
      threshold,
      limit
    );
  }

  /**
   * Fuses semantic and keyword search result lists using Reciprocal Rank Fusion (RRF).
   *
   * Formula:
   * RRF(d) = sum( weight_m / (k + rank_m(d)) )
   *
   * where:
   * - k is the smoothing parameter (standard 60)
   * - rank_m(d) is 1-based rank in source list m
   */
  static fuseWithRRF(
    semanticMatches: SemanticMatchRow[],
    keywordMatches: KeywordMatchRow[],
    topK: number,
    k: number = 60,
    semanticWeight: number = 1.0,
    keywordWeight: number = 1.0
  ): RetrievedChunk[] {
    interface FusionEntry {
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
      similarityScore: number | null;
      keywordScore: number | null;
      rrfScore: number;
      inSemantic: boolean;
      inKeyword: boolean;
    }

    const entryMap = new Map<string, FusionEntry>();

    // Process semantic matches
    semanticMatches.forEach((row, idx) => {
      const rank = idx + 1; // 1-based rank
      const rrfContribution = semanticWeight * (1 / (k + rank));
      const simScore = Number(row.similarity);

      entryMap.set(row.id, {
        chunkId: row.id,
        documentId: row.document_id,
        tenantId: row.tenant_id,
        chunkIndex: row.chunk_index,
        content: row.content,
        headingPath: row.heading_path,
        tokenCount: row.token_count,
        documentTitle: row.document_title,
        originalFilename: row.original_filename,
        sourceType: row.source_type,
        similarityScore: simScore,
        keywordScore: null,
        rrfScore: rrfContribution,
        inSemantic: true,
        inKeyword: false,
      });
    });

    // Process keyword matches
    keywordMatches.forEach((row, idx) => {
      const rank = idx + 1; // 1-based rank
      const rrfContribution = keywordWeight * (1 / (k + rank));
      const kwScore = Number(row.rank_score);

      const existing = entryMap.get(row.id);
      if (existing) {
        existing.rrfScore += rrfContribution;
        existing.keywordScore = kwScore;
        existing.inKeyword = true;
      } else {
        entryMap.set(row.id, {
          chunkId: row.id,
          documentId: row.document_id,
          tenantId: row.tenant_id,
          chunkIndex: row.chunk_index,
          content: row.content,
          headingPath: row.heading_path,
          tokenCount: row.token_count,
          documentTitle: row.document_title,
          originalFilename: row.original_filename,
          sourceType: row.source_type,
          similarityScore: null,
          keywordScore: kwScore,
          rrfScore: rrfContribution,
          inSemantic: false,
          inKeyword: true,
        });
      }
    });

    // Sort entries:
    // 1. By rrfScore descending
    // 2. Tie-break: highest similarityScore
    // 3. Tie-break: highest keywordScore
    const sorted = Array.from(entryMap.values()).sort((a, b) => {
      if (Math.abs(b.rrfScore - a.rrfScore) > 1e-9) {
        return b.rrfScore - a.rrfScore;
      }
      const simA = a.similarityScore ?? 0;
      const simB = b.similarityScore ?? 0;
      if (Math.abs(simB - simA) > 1e-6) {
        return simB - simA;
      }
      const kwA = a.keywordScore ?? 0;
      const kwB = b.keywordScore ?? 0;
      return kwB - kwA;
    });

    // Take topK
    const topResults = sorted.slice(0, topK);

    return topResults.map((entry, idx) => {
      let matchType: "hybrid" | "semantic" | "keyword" = "hybrid";
      if (entry.inSemantic && entry.inKeyword) {
        matchType = "hybrid";
      } else if (entry.inSemantic) {
        matchType = "semantic";
      } else {
        matchType = "keyword";
      }

      return {
        chunkId: entry.chunkId,
        documentId: entry.documentId,
        tenantId: entry.tenantId,
        chunkIndex: entry.chunkIndex,
        content: entry.content,
        headingPath: entry.headingPath,
        tokenCount: entry.tokenCount,
        documentTitle: entry.documentTitle,
        originalFilename: entry.originalFilename,
        sourceType: entry.sourceType,
        similarityScore: entry.similarityScore !== null ? Number(entry.similarityScore.toFixed(4)) : null,
        keywordScore: entry.keywordScore !== null ? Number(entry.keywordScore.toFixed(4)) : null,
        rrfScore: Number(entry.rrfScore.toFixed(6)),
        combinedRank: idx + 1,
        matchType,
      };
    });
  }
}

