import { IEmbeddingProvider, EmbeddingOptions } from "./embedding.types.js";
import { HttpError } from "../../../utils/errors.js";

export class MockEmbeddingProvider implements IEmbeddingProvider {
  readonly providerName = "mock";
  readonly modelName: string;
  readonly dimensions = 768;

  // Simulation controls for testing resilience & retry logic
  public failureCounter = 0;
  public simulateRateLimitTimes = 0;
  public simulateNetworkErrorTimes = 0;

  constructor(modelName = "mock-text-embedding-768") {
    this.modelName = modelName.startsWith("mock") ? modelName : `mock-${modelName}`;
  }

  async embedText(text: string, options?: EmbeddingOptions): Promise<number[]> {
    const res = await this.embedBatch([text], options);
    return res[0];
  }

  async embedBatch(texts: string[], _options?: EmbeddingOptions): Promise<number[][]> {
    if (this.simulateRateLimitTimes > 0) {
      this.simulateRateLimitTimes--;
      throw new HttpError(429, "EMBEDDING_RATE_LIMIT", "Simulated Rate Limit (429)");
    }

    if (this.simulateNetworkErrorTimes > 0) {
      this.simulateNetworkErrorTimes--;
      throw new HttpError(502, "EMBEDDING_NETWORK_ERROR", "Simulated Network Error (502)");
    }

    return texts.map((t) => this.generateDeterministicVector(t));
  }

  /**
   * Produces a reproducible, unit-normalized 768-dimensional float array
   * based on word tokens in the text so that semantically similar texts
   * produce higher cosine similarity scores.
   */
  private generateDeterministicVector(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const cleaned = text.toLowerCase().trim();
    if (!cleaned) {
      vector[0] = 1;
      return vector;
    }

    const words = cleaned.split(/\W+/).filter(Boolean);

    // Hash each word into vector buckets
    for (const word of words) {
      let hash = 0;
      for (let i = 0; i < word.length; i++) {
        hash = (hash << 5) - hash + word.charCodeAt(i);
        hash |= 0;
      }

      // Populate pseudo-random indices
      for (let k = 0; k < 6; k++) {
        const idx = Math.abs((hash + k * 101) % this.dimensions);
        const sign = ((hash >> k) & 1) === 0 ? 1 : -1;
        vector[idx] += sign * (1 / Math.sqrt(words.length));
      }
    }

    // Add general text-length signal
    const globalHash = cleaned.length * 31;
    for (let i = 0; i < this.dimensions; i += 64) {
      vector[i] += 0.05 * Math.sin(globalHash + i);
    }

    // L2 Normalize the vector so ||v|| = 1.0 (vital for cosine similarity)
    let sumSq = 0;
    for (let i = 0; i < this.dimensions; i++) {
      sumSq += vector[i] * vector[i];
    }

    const norm = Math.sqrt(sumSq) || 1;
    for (let i = 0; i < this.dimensions; i++) {
      vector[i] = Number((vector[i] / norm).toFixed(6));
    }

    return vector;
  }
}

