import { ILLMProvider } from "./generation.types.js";
import { GeminiLLMProvider } from "./gemini-llm.provider.js";
import { OpenAILLMProvider } from "./openai-llm.provider.js";
import { MockLLMProvider } from "./mock-llm.provider.js";
import { env } from "../../../config/env.js";
import { HttpError } from "../../../utils/errors.js";

export class LLMProviderFactory {
  private static instance: ILLMProvider | null = null;
  private static customOverride: ILLMProvider | null = null;

  static setProvider(provider: ILLMProvider | null): void {
    this.customOverride = provider;
  }

  static resetProvider(): void {
    this.customOverride = null;
    this.instance = null;
  }

  static getProvider(): ILLMProvider {
    if (this.customOverride) {
      return this.customOverride;
    }

    if (!this.instance) {
      this.instance = this.createProvider();
    }

    return this.instance;
  }

  static createProvider(envOverrides?: {
    NODE_ENV?: string;
    LLM_PROVIDER?: string;
    LLM_MODEL?: string;
    GEMINI_API_KEY?: string;
    GOOGLE_API_KEY?: string;
    OPENAI_API_KEY?: string;
  }): ILLMProvider {
    const nodeEnv = envOverrides?.NODE_ENV ?? env.NODE_ENV;
    const isProduction = nodeEnv === "production";
    const providerType = envOverrides?.LLM_PROVIDER ?? env.LLM_PROVIDER;
    const rawModel = envOverrides?.LLM_MODEL ?? env.LLM_MODEL ?? "gemini-1.5-flash";

    if (providerType === "mock") {
      if (isProduction) {
        throw new HttpError(
          500,
          "LLM_CONFIG_ERROR",
          "MockLLMProvider is forbidden in production environment. Configure a real provider ('gemini' or 'openai')."
        );
      }
      return new MockLLMProvider(rawModel.startsWith("mock") ? rawModel : `mock-${rawModel}`);
    }

    if (providerType === "openai") {
      const apiKey = envOverrides?.OPENAI_API_KEY ?? env.OPENAI_API_KEY;
      if (!apiKey || !apiKey.trim()) {
        if (isProduction) {
          throw new HttpError(
            500,
            "LLM_CONFIG_ERROR",
            "OPENAI_API_KEY is required in production when LLM_PROVIDER is 'openai'."
          );
        }
        console.warn(
          "⚠️ Notice: OPENAI_API_KEY is not configured for LLM. Falling back to MockLLMProvider for offline/local execution."
        );
        return new MockLLMProvider("mock-gpt-4o-mini");
      }
      return new OpenAILLMProvider(
        apiKey,
        rawModel === "gemini-1.5-flash" ? "gpt-4o-mini" : rawModel
      );
    }

    // Default: Gemini
    const geminiKey =
      envOverrides?.GEMINI_API_KEY ??
      env.GEMINI_API_KEY ??
      envOverrides?.GOOGLE_API_KEY ??
      env.GOOGLE_API_KEY;

    if (!geminiKey || !geminiKey.trim()) {
      if (isProduction) {
        throw new HttpError(
          500,
          "LLM_CONFIG_ERROR",
          "Missing GEMINI_API_KEY / GOOGLE_API_KEY in production environment. Real LLM credentials are required."
        );
      }
      console.warn(
        "⚠️ Notice: Neither GEMINI_API_KEY nor GOOGLE_API_KEY is configured for LLM. Falling back to MockLLMProvider for offline/local execution."
      );
      return new MockLLMProvider(rawModel.startsWith("mock") ? rawModel : `mock-${rawModel}`);
    }

    return new GeminiLLMProvider(geminiKey, rawModel);
  }
}

