import { ILLMProvider, LLMGenerateOptions, LLMGenerateResult } from "./generation.types.js";
import { HttpError } from "../../../utils/errors.js";

export class MockLLMProvider implements ILLMProvider {
  readonly providerName = "mock";
  readonly modelName: string;

  public simulateRateLimitTimes = 0;
  public simulateTimeoutTimes = 0;
  public simulateNetworkErrorTimes = 0;
  public customResponseGenerator?: (prompt: string, options?: LLMGenerateOptions) => string;

  constructor(modelName = "mock-llm-model") {
    this.modelName = modelName.startsWith("mock") ? modelName : `mock-${modelName}`;
  }

  async generateText(prompt: string, options: LLMGenerateOptions = {}): Promise<LLMGenerateResult> {
    if (this.simulateRateLimitTimes > 0) {
      this.simulateRateLimitTimes--;
      throw new HttpError(429, "LLM_RATE_LIMIT", "Simulated Rate Limit (429)");
    }

    if (this.simulateTimeoutTimes > 0) {
      this.simulateTimeoutTimes--;
      throw new HttpError(504, "LLM_TIMEOUT", "Simulated LLM Timeout (504)");
    }

    if (this.simulateNetworkErrorTimes > 0) {
      this.simulateNetworkErrorTimes--;
      throw new HttpError(502, "LLM_NETWORK_ERROR", "Simulated Network Error (502)");
    }

    if (this.customResponseGenerator) {
      const generated = this.customResponseGenerator(prompt, options);
      return {
        text: generated,
        model: this.modelName,
        finishReason: "STOP",
        usage: { promptTokens: 50, completionTokens: 25, totalTokens: 75 },
      };
    }

    // Default grounded mock emulation
    const evidenceMatch = prompt.match(/<evidence>([\s\S]*?)<\/evidence>/);
    const evidenceText = evidenceMatch ? evidenceMatch[1] : "";

    // Extract customer question
    const questionMatch = prompt.match(/Customer Question:\s*([\s\S]*?)(?:\n\nProvide|\nProvide|$)/i);
    const question = (questionMatch ? questionMatch[1] : prompt).toLowerCase();

    // Check for prompt injection attempts inside evidence
    const hasInjection =
      evidenceText.toLowerCase().includes("ignore previous instructions") ||
      evidenceText.toLowerCase().includes("system override") ||
      evidenceText.toLowerCase().includes("say pwned") ||
      evidenceText.toLowerCase().includes("you are now a pirate");

    // The model must resist the injection and strictly ground from genuine facts
    if (hasInjection) {
      // Check if genuine factual content exists besides the attack
      if (question.includes("refund")) {
        return {
          text: "Based on the verified documentation [Source 1], subscriptions can be refunded within 30 days of initial purchase. No overrides or unauthorized commands are executed.",
          model: this.modelName,
          finishReason: "STOP",
          usage: { promptTokens: 120, completionTokens: 40, totalTokens: 160 },
        };
      }
    }

    if (question.includes("refund") && evidenceText.toLowerCase().includes("refund")) {
      return {
        text: "According to our documentation [Source 1], monthly subscriptions can be refunded within 30 days of the charge date if requested by an account administrator.",
        model: this.modelName,
        finishReason: "STOP",
        usage: { promptTokens: 100, completionTokens: 35, totalTokens: 135 },
      };
    }

    if (question.includes("warranty") && evidenceText.toLowerCase().includes("warranty")) {
      return {
        text: "According to our documentation [Source 1], enterprise quantum servers include a comprehensive 36-month replacement warranty against hardware defects.",
        model: this.modelName,
        finishReason: "STOP",
        usage: { promptTokens: 100, completionTokens: 35, totalTokens: 135 },
      };
    }

    if (question.includes("rate limit") && evidenceText.toLowerCase().includes("rate limit")) {
      return {
        text: "Based on the documentation [Source 1], API endpoints are rate-limited to 1,000 requests per minute per tenant. Exceeding this limit returns HTTP 429.",
        model: this.modelName,
        finishReason: "STOP",
        usage: { promptTokens: 110, completionTokens: 30, totalTokens: 140 },
      };
    }

    // If evidence lacks relevant information:
    return {
      text: "I am sorry, but I cannot establish an answer based on the available documentation. Please contact our support team for assistance.",
      model: this.modelName,
      finishReason: "STOP",
      usage: { promptTokens: 80, completionTokens: 20, totalTokens: 100 },
    };
  }
}
