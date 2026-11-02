import dotenv from "dotenv";
dotenv.config();
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  try {
    const res = await pool.query(`
      SELECT 
        dc.tenant_id,
        t.name as tenant_name,
        dc.document_id,
        d.title as doc_title,
        d.status as doc_status,
        dc.embedding_model,
        count(*) as chunk_count
      FROM document_chunks dc
      LEFT JOIN documents d ON dc.document_id = d.id
      LEFT JOIN tenants t ON dc.tenant_id = t.id
      GROUP BY dc.tenant_id, t.name, dc.document_id, d.title, d.status, dc.embedding_model
      ORDER BY t.name, d.title;
    `);

    console.log("CHUNKS_PER_DOC_AND_MODEL:");
    console.table(res.rows);

    const modelTotals = await pool.query(`
      SELECT embedding_model, count(*) as count
      FROM document_chunks
      GROUP BY embedding_model;
    `);
    console.log("MODEL_TOTALS:");
    console.table(modelTotals.rows);
  } catch (err) {
    console.error("Error:", err);
  } finally {
    await pool.end();
  }
}
run();

