-- 004_document_chunks_schema.sql
-- Step 1 RAG Foundation: Enable pgvector extension and create document_chunks table

-- 1. Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Create document_chunks table
CREATE TABLE IF NOT EXISTS document_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  heading_path TEXT,
  token_count INTEGER NOT NULL DEFAULT 0,
  embedding vector(768),
  embedding_model VARCHAR(64) DEFAULT 'gemini-embedding-001',
  tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(heading_path, '') || ' ' || content)
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Indexes for tenant isolation and fast retrieval
CREATE INDEX IF NOT EXISTS idx_document_chunks_tenant_id ON document_chunks (tenant_id);
CREATE INDEX IF NOT EXISTS idx_document_chunks_document_id ON document_chunks (document_id);
CREATE INDEX IF NOT EXISTS idx_document_chunks_tenant_doc ON document_chunks (tenant_id, document_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_document_chunks_doc_idx ON document_chunks (document_id, chunk_index);

-- Full-text search index (Lexical search branch in hybrid retrieval)
CREATE INDEX IF NOT EXISTS idx_document_chunks_tsv ON document_chunks USING gin (tsv);

-- HNSW vector cosine similarity index (Dense vector search branch in pgvector)
CREATE INDEX IF NOT EXISTS idx_document_chunks_embedding ON document_chunks
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- 4. Automatic updated_at trigger
DROP TRIGGER IF EXISTS trg_document_chunks_updated_at ON document_chunks;
CREATE TRIGGER trg_document_chunks_updated_at
BEFORE UPDATE ON document_chunks
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

-- 5. Compatibility view for chunks alias
CREATE OR REPLACE VIEW chunks AS SELECT * FROM document_chunks;

