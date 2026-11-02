import { ILLMProvider, LLMGenerateOptions, LLMGenerateResult } from "./generation.types.js";
import { HttpError } from "../../../utils/errors.js";

export class OpenAILLMProvider implements ILLMProvider {
  readonly providerName = "openai";
  readonly modelName: string;

  private readonly apiKey: string;
  private readonly baseUrl = "https://api.openai.com/v1";
  private readonly maxRetries = 2;
  private readonly initialBackoffMs = 500;

  constructor(apiKey: string, modelName = "gpt-4o-mini") {
    if (!apiKey || !apiKey.trim()) {
      throw new HttpError(
        500,
        "LLM_CONFIG_ERROR",
        "OpenAI API key is required but was not provided."
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

    const url = `${this.baseUrl}/chat/completions`;
    const timeoutMs = options.timeoutMs ?? 30000;

    const messages: Array<{ role: string; content: string }> = [];
    if (options.systemInstruction && options.systemInstruction.trim()) {
      messages.push({
        role: "system",
        content: options.systemInstruction.trim(),
      });
    }
    messages.push({
      role: "user",
      content: trimmedPrompt,
    });

    const body = {
      model: this.modelName,
      messages,
      temperature: options.temperature ?? 0.1,
      max_tokens: options.maxTokens ?? 1024,
    };

    const executeWithRetry = async (attempt = 0): Promise<LLMGenerateResult> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (response.ok) {
          const data: any = await response.json();
          const choice = data?.choices?.[0];

          if (!choice || !choice.message) {
            throw new HttpError(
              502,
              "LLM_PROVIDER_ERROR",
              "OpenAI response contained no completion message."
            );
          }

          const usage = data?.usage;

          return {
            text: (choice.message.content || "").trim(),
            model: this.modelName,
            finishReason: choice.finish_reason || "stop",
            usage: usage
              ? {
                  promptTokens: usage.prompt_tokens,
                  completionTokens: usage.completion_tokens,
                  totalTokens: usage.total_tokens,
                }
              : undefined,
          };
        }

        const status = response.status;
        let errorMessage = `HTTP ${status} from OpenAI API`;
        try {
          const errData: any = await response.json();
          if (errData?.error?.message) {
            errorMessage = errData.error.message;
          }
        } catch {
          // ignore
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
            `Authentication failed with OpenAI LLM provider: ${errorMessage}`
          );
        }

        throw new HttpError(
          status === 429 ? 429 : 502,
          status === 429 ? "LLM_RATE_LIMIT" : "LLM_PROVIDER_ERROR",
          `OpenAI generation failed: ${errorMessage}`
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
            `OpenAI request timed out after ${timeoutMs}ms.`
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
          `Failed to connect to OpenAI LLM provider: ${err.message || "Network error"}`
        );
      }
    };

    return executeWithRetry();
  }
}

