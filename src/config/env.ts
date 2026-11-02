import dotenv from "dotenv";
import { z } from "zod";

// Load environment variables from .env file
dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  HOST: z.string().default("0.0.0.0"),

  // Database
  DATABASE_URL: z.string().optional(),
  PGHOST: z.string().default("localhost"),
  PGPORT: z.coerce.number().default(5432),
  PGDATABASE: z.string().default("supportsense"),
  PGUSER: z.string().optional(),
  PGPASSWORD: z.string().optional(),

  // Auth / Session
  COOKIE_SECRET: z.string().min(16).default("supportsense_default_super_secret_cookie_key_32_chars!"),
  SESSION_TTL_SECONDS: z.coerce.number().default(60 * 60 * 24 * 7), // 7 days

  // CORS
  CORS_ORIGIN: z.string().default("http://localhost:3000"),

  // RAG / Embeddings / Retrieval
  EMBEDDING_PROVIDER: z.enum(["gemini", "openai", "mock"]).default("gemini"),
  GEMINI_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  EMBEDDING_MODEL: z.string().default("text-embedding-004"),
  RETRIEVAL_TOP_K: z.coerce.number().default(5),
  RETRIEVAL_SIMILARITY_THRESHOLD: z.coerce.number().default(0.3),
  RETRIEVAL_RRF_K: z.coerce.number().default(60),

  // RAG / LLM Answer Generation
  LLM_PROVIDER: z.enum(["gemini", "openai", "mock"]).default("gemini"),
  LLM_MODEL: z.string().default("gemini-1.5-flash"),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(1).default(0.1),
  LLM_MAX_TOKENS: z.coerce.number().min(50).max(4096).default(1024),
  LLM_TIMEOUT_MS: z.coerce.number().min(1000).max(120000).default(30000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:", parsed.error.format());
  throw new Error("Invalid environment configuration");
}

export const env = parsed.data;
