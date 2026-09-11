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
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:", parsed.error.format());
  throw new Error("Invalid environment configuration");
}

export const env = parsed.data;

