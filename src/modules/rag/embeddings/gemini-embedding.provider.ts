import { IEmbeddingProvider, EmbeddingOptions } from "./embedding.types.js";
import { HttpError } from "../../../utils/errors.js";

export class GeminiEmbeddingProvider implements IEmbeddingProvider {
  readonly providerName = "gemini";
  readonly modelName: string;
  readonly dimensions = 768;

  private readonly apiKey: string;
  private readonly baseUrl = "https://generativelanguage.googleapis.com/v1beta";
  private readonly maxRetries = 3;
  private readonly initialBackoffMs = 500;

  constructor(apiKey: string, modelName = "text-embedding-004") {
    if (!apiKey || !apiKey.trim()) {
      throw new HttpError(
        500,
        "EMBEDDING_CONFIG_ERROR",
        "Gemini API key is required but was not provided."
      );
    }
    this.apiKey = apiKey.trim();
    this.modelName = modelName.trim();
  }

  async embedText(text: string, options?: EmbeddingOptions): Promise<number[]> {
    const taskType = options?.taskType || "RETRIEVAL_QUERY";
    const results = await this.embedBatch([text], { taskType });
    if (!results[0] || results[0].length !== this.dimensions) {
      throw new HttpError(
        502,
        "EMBEDDING_PROVIDER_ERROR",
        `Gemini returned invalid embedding vector (expected ${this.dimensions} dimensions).`
      );
    }
    return results[0];
  }

  async embedBatch(texts: string[], options?: EmbeddingOptions): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const modelRef = this.modelName.startsWith("models/")
      ? this.modelName
      : `models/${this.modelName}`;

    const taskType = options?.taskType || "RETRIEVAL_DOCUMENT";

    const requests = texts.map((t) => ({
      model: modelRef,
      content: {
        parts: [{ text: t }],
      },
      taskType,
      outputDimensionality: this.dimensions,
    }));

    const url = `${this.baseUrl}/${modelRef}:batchEmbedContents?key=${this.apiKey}`;

    const executeWithRetry = async (attempt = 0): Promise<number[][]> => {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ requests }),
        });

        if (response.ok) {
          const data: any = await response.json();
          const embeddingsList = data?.embeddings;

          if (!Array.isArray(embeddingsList) || embeddingsList.length !== texts.length) {
            throw new HttpError(
              502,
              "EMBEDDING_PROVIDER_ERROR",
              `Gemini batchEmbedContents response mismatched requested length (${embeddingsList?.length ?? 0} vs ${texts.length}).`
            );
          }

          return embeddingsList.map((item: any, idx: number) => {
            const values = item?.values;
            if (!Array.isArray(values) || values.length !== this.dimensions) {
              throw new HttpError(
                502,
                "EMBEDDING_PROVIDER_ERROR",
                `Gemini embedding at index ${idx} has dimension ${values?.length ?? 0}, expected ${this.dimensions}.`
              );
            }
            return values as number[];
          });
        }

        // Handle error responses
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

        const isRetryable =
          status === 429 || // Rate limit / Quota
          status === 500 || // Internal server error
          status === 503 || // Service unavailable
          status === 504;   // Gateway timeout

        if (isRetryable && attempt < this.maxRetries) {
          const jitter = Math.random() * 200;
          const delay = this.initialBackoffMs * Math.pow(2, attempt) + jitter;
          await new Promise((resolve) => setTimeout(resolve, delay));
          return executeWithRetry(attempt + 1);
        }

        if (status === 401 || status === 403) {
          throw new HttpError(
            502,
            "EMBEDDING_AUTH_ERROR",
            `Authentication failed with embedding provider: ${errorMessage}`
          );
        }

        throw new HttpError(
          status === 429 ? 429 : 502,
          status === 429 ? "EMBEDDING_RATE_LIMIT" : "EMBEDDING_PROVIDER_ERROR",
          `Gemini embedding failed: ${errorMessage}`
        );
      } catch (err: any) {
        if (err instanceof HttpError) {
          throw err;
        }

        // Network connection error (DNS, socket timeout, ECONNRESET)
        if (attempt < this.maxRetries) {
          const jitter = Math.random() * 200;
          const delay = this.initialBackoffMs * Math.pow(2, attempt) + jitter;
          await new Promise((resolve) => setTimeout(resolve, delay));
          return executeWithRetry(attempt + 1);
        }

        throw new HttpError(
          502,
          "EMBEDDING_NETWORK_ERROR",
          `Failed to connect to Gemini embedding provider: ${err.message || "Network error"}`
        );
      }
    };

    return executeWithRetry();
  }
}

