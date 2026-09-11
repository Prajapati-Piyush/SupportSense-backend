import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Client } from "pg";
import { pool, closePool } from "./client.js";
import { env } from "../config/env.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function ensureDatabaseExists(): Promise<void> {
  const dbName = env.DATABASE_URL
    ? new URL(env.DATABASE_URL).pathname.replace(/^\//, "")
    : env.PGDATABASE;

  if (!dbName) return;

  // Connect to default 'postgres' database to check/create target database
  const maintenanceClient = new Client({
    host: env.PGHOST,
    port: env.PGPORT,
    user: env.PGUSER || undefined,
    password: env.PGPASSWORD || undefined,
    database: "postgres",
  });

  try {
    await maintenanceClient.connect();
    const res = await maintenanceClient.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [dbName]
    );
    if (res.rowCount === 0) {
      console.log(`Database "${dbName}" does not exist. Creating...`);
      // CREATE DATABASE cannot run inside a transaction or prepared statement with parameters
      const safeDbName = dbName.replace(/[^a-zA-Z0-9_]/g, "");
      await maintenanceClient.query(`CREATE DATABASE ${safeDbName}`);
      console.log(`Database "${dbName}" created successfully.`);
    }
  } catch (err: any) {
    // If we cannot connect to 'postgres' (e.g. cloud db or restricted user), ignore and try direct connection
    console.warn("Could not check/create database via maintenance connection:", err.message);
  } finally {
    await maintenanceClient.end().catch(() => {});
  }
}

export async function runMigrations(): Promise<void> {
  console.log("Running database migrations...");
  await ensureDatabaseExists();

  const client = await pool.connect();
  try {
    // Create migrations tracker table
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const migrationsDir = path.join(__dirname, "migrations");
    if (!fs.existsSync(migrationsDir)) {
      console.log("No migrations directory found.");
      return;
    }

    const files = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const alreadyApplied = await client.query(
        "SELECT 1 FROM schema_migrations WHERE version = $1",
        [file]
      );

      if (alreadyApplied.rowCount && alreadyApplied.rowCount > 0) {
        console.log(`  ✓ Migration already applied: ${file}`);
        continue;
      }

      console.log(`  Applying migration: ${file}...`);
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (version) VALUES ($1)",
          [file]
        );
        await client.query("COMMIT");
        console.log(`  ✓ Successfully applied: ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`  ❌ Failed applying migration: ${file}`);
        throw err;
      }
    }

    console.log("All migrations executed successfully.");
  } finally {
    client.release();
  }
}

// Allow direct execution: tsx src/db/migrate.ts
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigrations()
    .then(async () => {
      await closePool();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error("Migration error:", err);
      await closePool();
      process.exit(1);
    });
}

