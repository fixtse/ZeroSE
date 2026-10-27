-- The physical vector type and HNSW expression depend on saved runtime settings.
-- Run once when Store opens; an existing dimension can never be changed implicitly.
CREATE FUNCTION zero_configure_embeddings(requested INTEGER) RETURNS VOID
LANGUAGE plpgsql AS $zero$
DECLARE
  configured INTEGER;
  physical INTEGER;
  namespace TEXT := current_schema();
BEGIN
  IF requested IS NULL OR requested < 1 OR requested > 4000 THEN
    RAISE EXCEPTION 'Embedding dimensions must be between 1 and 4000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(current_database() || ':' || namespace || ':embedding-dimensions', 0));
  SELECT dimensions INTO configured FROM schema_version WHERE version=1 FOR UPDATE;
  IF configured IS NOT NULL AND configured <> requested THEN
    RAISE EXCEPTION 'Database embedding dimensions do not match configuration';
  END IF;
  SELECT a.atttypmod INTO physical FROM pg_attribute a
    WHERE a.attrelid=to_regclass('memories') AND a.attname='embedding' AND NOT a.attisdropped;
  IF physical IS NULL OR (physical <> -1 AND physical <> requested) THEN
    RAISE EXCEPTION 'Database vector dimensions do not match configuration';
  END IF;
  IF physical = -1 THEN
    IF EXISTS (SELECT 1 FROM memories WHERE embedding IS NOT NULL AND public.vector_dims(embedding) <> requested) THEN
      RAISE EXCEPTION 'Stored vector dimensions do not match configuration';
    END IF;
    EXECUTE format('ALTER TABLE %I.memories ALTER COLUMN embedding TYPE public.vector(%s)', namespace, requested);
  END IF;
  IF to_regclass(format('%I.memories_embedding', namespace)) IS NULL THEN
    EXECUTE format('CREATE INDEX memories_embedding ON %I.memories USING hnsw ((embedding::public.halfvec(%s)) public.halfvec_cosine_ops)', namespace, requested);
  END IF;
  INSERT INTO schema_version(version, dimensions) VALUES(1, requested) ON CONFLICT DO NOTHING;
END;
$zero$;
