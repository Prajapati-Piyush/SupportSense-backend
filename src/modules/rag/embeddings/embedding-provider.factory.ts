import { IEmbeddingProvider } from "./embedding.types.js";
import { GeminiEmbeddingProvider } from "./gemini-embedding.provider.js";
import { OpenAIEmbeddingProvider } from "./openai-embedding.provider.js";
import { MockEmbeddingProvider } from "./mock-embedding.provider.js";
import { env } from "../../../config/env.js";
import { HttpError } from "../../../utils/errors.js";

export class EmbeddingProviderFactory {
  private static instance: IEmbeddingProvider | null = null;
  private static customOverride: IEmbeddingProvider | null = null;

  /**
   * Overrides the current provider (primarily for unit/integration tests).
   */
  static setProvider(provider: IEmbeddingProvider | null): void {
    this.customOverride = provider;
  }

  static resetProvider(): void {
    this.customOverride = null;
    this.instance = null;
  }

  /**
   * Lazily retrieves or instantiates the embedding provider.
   * Fails safely in production if credentials are missing, without breaking unrelated app features at boot.
   */
  static getProvider(): IEmbeddingProvider {
    if (this.customOverride) {
      return this.customOverride;
    }

    if (!this.instance) {
      this.instance = this.createProvider();
    }

    return this.instance;
  }

  /**
   * Factory creation logic with environment safety checks.
   * Allows envOverrides for unit-testing environment configurations (e.g., simulating production).
   */
  static createProvider(envOverrides?: {
    NODE_ENV?: string;
    EMBEDDING_PROVIDER?: string;
    EMBEDDING_MODEL?: string;
    GEMINI_API_KEY?: string;
    GOOGLE_API_KEY?: string;
    OPENAI_API_KEY?: string;
  }): IEmbeddingProvider {
    const nodeEnv = envOverrides?.NODE_ENV ?? env.NODE_ENV;
    const isProduction = nodeEnv === "production";
    const providerType = envOverrides?.EMBEDDING_PROVIDER ?? env.EMBEDDING_PROVIDER;
    const rawModel = envOverrides?.EMBEDDING_MODEL ?? env.EMBEDDING_MODEL ?? "text-embedding-004";

    // 1. Explicit mock configuration
    if (providerType === "mock") {
      if (isProduction) {
        throw new HttpError(
          500,
          "EMBEDDING_CONFIG_ERROR",
          "MockEmbeddingProvider is forbidden in production environment. Configure a real provider ('gemini' or 'openai')."
        );
      }
      return new MockEmbeddingProvider(
        rawModel.startsWith("mock") ? rawModel : `mock-${rawModel}`
      );
    }

    // 2. OpenAI provider
    if (providerType === "openai") {
      const apiKey = envOverrides?.OPENAI_API_KEY ?? env.OPENAI_API_KEY;
      if (!apiKey || !apiKey.trim()) {
        if (isProduction) {
          throw new HttpError(
            500,
            "EMBEDDING_CONFIG_ERROR",
            "Missing OPENAI_API_KEY in production environment. Real credentials are required."
          );
        }
        console.warn(
          "⚠️ Notice: OPENAI_API_KEY is not configured. Falling back to MockEmbeddingProvider for offline/local execution."
        );
        return new MockEmbeddingProvider("mock-text-embedding-3-small");
      }
      return new OpenAIEmbeddingProvider(
        apiKey,
        rawModel === "text-embedding-004" ? "text-embedding-3-small" : rawModel
      );
    }

    // 3. Default: Gemini provider
    const geminiKey =
      envOverrides?.GEMINI_API_KEY ??
      env.GEMINI_API_KEY ??
      envOverrides?.GOOGLE_API_KEY ??
      env.GOOGLE_API_KEY;

    if (!geminiKey || !geminiKey.trim()) {
      if (isProduction) {
        throw new HttpError(
          500,
          "EMBEDDING_CONFIG_ERROR",
          "Missing GEMINI_API_KEY / GOOGLE_API_KEY in production environment. Real credentials are required."
        );
      }
      console.warn(
        "⚠️ Notice: Neither GEMINI_API_KEY nor GOOGLE_API_KEY is configured. Falling back to MockEmbeddingProvider for offline/local execution."
      );
      return new MockEmbeddingProvider(
        rawModel.startsWith("mock") ? rawModel : `mock-${rawModel}`
      );
    }

    return new GeminiEmbeddingProvider(geminiKey, rawModel);
  }
}
