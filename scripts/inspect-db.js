import dotenv from "dotenv";
dotenv.config();
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL.includes("neon.tech")
  ? process.env.DATABASE_URL
  : "postgresql://neondb_owner:npg_5bjHsxV2aqQh@ep-wispy-mud-b3zgip9b-pooler.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  try {
    const docCols = await pool.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'documents' ORDER BY ordinal_position;"
    );
    console.log("DOC_COLS:", docCols.rows);

    const chunkCols = await pool.query(
      "SELECT column_name, data_type, udt_name FROM information_schema.columns WHERE table_name = 'document_chunks' ORDER BY ordinal_position;"
    );
    console.log("CHUNK_COLS:", chunkCols.rows);

    const docs = await pool.query("SELECT id, tenant_id, title, status FROM documents;");
    console.log("EXISTING_DOCUMENTS (" + docs.rowCount + "):", docs.rows);

    const chunkSummary = await pool.query(
      "SELECT count(*) as total, embedding_model, count(embedding) as with_embedding, count(*) - count(embedding) as null_embedding FROM document_chunks GROUP BY embedding_model;"
    );
    console.log("CHUNKS_BY_MODEL:", chunkSummary.rows);

    const tenants = await pool.query("SELECT id, name, slug FROM tenants;");
    console.log("TENANTS:", tenants.rows);

    const users = await pool.query("SELECT id, tenant_id, email, role, (password_hash IS NOT NULL) as has_pwd FROM users;");
    console.log("ALL USERS:", users.rows);
  } catch (err) {
    console.error("Query Error:", err);
  } finally {
    await pool.end();
  }
}

run();
