import { ILLMProvider, LLMGenerateOptions, LLMGenerateResult } from "./generation.types.js";
import { HttpError } from "../../../utils/errors.js";

export class GeminiLLMProvider implements ILLMProvider {
  readonly providerName = "gemini";
  readonly modelName: string;

  private readonly apiKey: string;
  private readonly baseUrl = "https://generativelanguage.googleapis.com/v1beta";
  private readonly maxRetries = 2;
  private readonly initialBackoffMs = 500;

  constructor(apiKey: string, modelName = "gemini-1.5-flash") {
    if (!apiKey || !apiKey.trim()) {
      throw new HttpError(
        500,
        "LLM_CONFIG_ERROR",
        "Gemini API key is required but was not provided."
      );
    }
    this.apiKey = apiKey.trim();
    this.modelName = modelName.trim();
  }

  async generateText(prompt: string, options: LLMGenerateOptions = {}): Promise<LLMGenerateResult> {
    const trimmedPrompt = (prompt || "").trim();
    if (!trimmedPrompt) {
      throw new HttpError(400, "BAD_REQUEST", "Prompt must not be empty.");
    }

    const modelRef = this.modelName.startsWith("models/")
      ? this.modelName
      : `models/${this.modelName}`;

    const url = `${this.baseUrl}/${modelRef}:generateContent?key=${this.apiKey}`;
    const timeoutMs = options.timeoutMs ?? 30000;

    const body: Record<string, any> = {
      contents: [
        {
          role: "user",
          parts: [{ text: trimmedPrompt }],
        },
      ],
      generationConfig: {
        temperature: options.temperature ?? 0.1,
        maxOutputTokens: options.maxTokens ?? 1024,
      },
    };

    if (options.systemInstruction && options.systemInstruction.trim()) {
      body.systemInstruction = {
        parts: [{ text: options.systemInstruction.trim() }],
      };
    }

    const executeWithRetry = async (attempt = 0): Promise<LLMGenerateResult> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (response.ok) {
          const data: any = await response.json();
          const candidate = data?.candidates?.[0];

          if (!candidate) {
            throw new HttpError(
              502,
              "LLM_PROVIDER_ERROR",
              "Gemini response contained no completion candidates."
            );
          }

          if (candidate.finishReason === "SAFETY") {
            throw new HttpError(
              502,
              "LLM_SAFETY_BLOCK",
              "Gemini response was blocked by content safety filters."
            );
          }

          const textPart = candidate.content?.parts?.map((p: any) => p.text || "").join("") || "";
          const usage = data?.usageMetadata;

          return {
            text: textPart.trim(),
            model: this.modelName,
            finishReason: candidate.finishReason || "STOP",
            usage: usage
              ? {
                  promptTokens: usage.promptTokenCount,
                  completionTokens: usage.candidatesTokenCount,
                  totalTokens: usage.totalTokenCount,
                }
              : undefined,
          };
        }

        const status = response.status;
        let errorMessage = `HTTP ${status} from Gemini API`;
        try {
          const errData: any = await response.json();
          if (errData?.error?.message) {
            errorMessage = errData.error.message;
          }
        } catch {
          // Non-JSON error body
        }

        const isRetryable = status === 429 || status === 500 || status === 503 || status === 504;

        if (isRetryable && attempt < this.maxRetries) {
          const delay = this.initialBackoffMs * Math.pow(2, attempt) + Math.random() * 200;
          await new Promise((resolve) => setTimeout(resolve, delay));
          return executeWithRetry(attempt + 1);
        }

        if (status === 401 || status === 403) {
          throw new HttpError(
            502,
            "LLM_AUTH_ERROR",
            `Authentication failed with Gemini LLM provider: ${errorMessage}`
          );
        }

        throw new HttpError(
          status === 429 ? 429 : 502,
          status === 429 ? "LLM_RATE_LIMIT" : "LLM_PROVIDER_ERROR",
          `Gemini generation failed: ${errorMessage}`
        );
      } catch (err: any) {
        clearTimeout(timer);

        if (err instanceof HttpError) {
          throw err;
        }

        if (err.name === "AbortError" || controller.signal.aborted) {
          throw new HttpError(
            504,
            "LLM_TIMEOUT",
            `Gemini request timed out after ${timeoutMs}ms.`
          );
        }

        if (attempt < this.maxRetries) {
          const delay = this.initialBackoffMs * Math.pow(2, attempt) + Math.random() * 200;
          await new Promise((resolve) => setTimeout(resolve, delay));
          return executeWithRetry(attempt + 1);
        }

        throw new HttpError(
          502,
          "LLM_NETWORK_ERROR",
          `Failed to connect to Gemini LLM provider: ${err.message || "Network error"}`
        );
      }
    };

    return executeWithRetry();
  }
}

