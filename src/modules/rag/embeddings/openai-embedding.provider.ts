import { IEmbeddingProvider, EmbeddingOptions } from "./embedding.types.js";
import { HttpError } from "../../../utils/errors.js";

export class OpenAIEmbeddingProvider implements IEmbeddingProvider {
  readonly providerName = "openai";
  readonly modelName: string;
  readonly dimensions = 768;

  private readonly apiKey: string;
  private readonly baseUrl = "https://api.openai.com/v1";
  private readonly maxRetries = 3;
  private readonly initialBackoffMs = 500;

  constructor(apiKey: string, modelName = "text-embedding-3-small") {
    if (!apiKey || !apiKey.trim()) {
      throw new HttpError(
        500,
        "EMBEDDING_CONFIG_ERROR",
        "OpenAI API key is required but was not provided."
      );
    }
    this.apiKey = apiKey.trim();
    this.modelName = modelName.trim();
  }

  async embedText(text: string, options?: EmbeddingOptions): Promise<number[]> {
    const results = await this.embedBatch([text], options);
    if (!results[0] || results[0].length !== this.dimensions) {
      throw new HttpError(
        502,
        "EMBEDDING_PROVIDER_ERROR",
        `OpenAI returned invalid embedding vector (expected ${this.dimensions} dimensions).`
      );
    }
    return results[0];
  }

  async embedBatch(texts: string[], _options?: EmbeddingOptions): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const url = `${this.baseUrl}/embeddings`;

    const executeWithRetry = async (attempt = 0): Promise<number[][]> => {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.modelName,
            input: texts,
            dimensions: this.dimensions,
          }),
        });

        if (response.ok) {
          const data: any = await response.json();
          const list = data?.data;

          if (!Array.isArray(list) || list.length !== texts.length) {
            throw new HttpError(
              502,
              "EMBEDDING_PROVIDER_ERROR",
              `OpenAI response length mismatch (${list?.length ?? 0} vs ${texts.length}).`
            );
          }

          // Sort by index just in case OpenAI returns out of order
          const sorted = [...list].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

          return sorted.map((item: any, idx: number) => {
            const values = item?.embedding;
            if (!Array.isArray(values) || values.length !== this.dimensions) {
              throw new HttpError(
                502,
                "EMBEDDING_PROVIDER_ERROR",
                `OpenAI embedding at index ${idx} has dimension ${values?.length ?? 0}, expected ${this.dimensions}.`
              );
            }
            return values as number[];
          });
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

        const isRetryable =
          status === 429 ||
          status === 500 ||
          status === 503 ||
          status === 504;

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
            `Authentication failed with OpenAI: ${errorMessage}`
          );
        }

        throw new HttpError(
          status === 429 ? 429 : 502,
          status === 429 ? "EMBEDDING_RATE_LIMIT" : "EMBEDDING_PROVIDER_ERROR",
          `OpenAI embedding failed: ${errorMessage}`
        );
      } catch (err: any) {
        if (err instanceof HttpError) throw err;

        if (attempt < this.maxRetries) {
          const jitter = Math.random() * 200;
          const delay = this.initialBackoffMs * Math.pow(2, attempt) + jitter;
          await new Promise((resolve) => setTimeout(resolve, delay));
          return executeWithRetry(attempt + 1);
        }

        throw new HttpError(
          502,
          "EMBEDDING_NETWORK_ERROR",
          `Failed to connect to OpenAI embedding provider: ${err.message || "Network error"}`
        );
      }
    };

    return executeWithRetry();
  }
}

