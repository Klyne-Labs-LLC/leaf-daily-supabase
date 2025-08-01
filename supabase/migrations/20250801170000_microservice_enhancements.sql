-- Microservice Architecture Enhancements
-- This migration adds support for enhanced job processing and caching

-- Add job queue function support
CREATE OR REPLACE FUNCTION public.get_next_job(
  p_job_types TEXT[] DEFAULT NULL,
  p_max_priority INTEGER DEFAULT 10
) RETURNS TABLE (
  job_id UUID,
  book_id UUID,
  job_type TEXT,
  input_data JSONB,
  priority INTEGER,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  -- Get the next job to process based on priority and age
  RETURN QUERY
  UPDATE public.processing_jobs
  SET status = 'running', started_at = now()
  WHERE id = (
    SELECT pj.id
    FROM public.processing_jobs pj
    WHERE pj.status = 'pending'
      AND (p_job_types IS NULL OR pj.job_type = ANY(p_job_types))
      AND pj.priority <= p_max_priority
    ORDER BY pj.priority ASC, pj.created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING id, book_id, job_type, input_data, priority, created_at;
END;
$$ LANGUAGE plpgsql;

-- Enhanced progress tracking with stages
CREATE OR REPLACE FUNCTION public.get_processing_status(p_book_ids UUID[])
RETURNS TABLE (
  book_id UUID,
  current_stage TEXT,
  stage_progress INTEGER,
  overall_progress INTEGER,
  current_step TEXT,
  message TEXT,
  is_error BOOLEAN,
  last_updated TIMESTAMPTZ,
  estimated_completion TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT DISTINCT ON (pp.book_id)
    pp.book_id,
    pp.stage,
    pp.stage_progress,
    pp.overall_progress,
    pp.current_step,
    pp.message,
    pp.is_error,
    pp.updated_at,
    pp.estimated_completion_time
  FROM public.processing_progress pp
  WHERE pp.book_id = ANY(p_book_ids)
  ORDER BY pp.book_id, pp.updated_at DESC;
END;
$$ LANGUAGE plpgsql;

-- Cache cleanup function
CREATE OR REPLACE FUNCTION public.cleanup_old_cache(p_days_old INTEGER DEFAULT 30)
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM public.processing_cache
  WHERE created_at < now() - (p_days_old || ' days')::INTERVAL
    AND hit_count < 2; -- Keep frequently used cache entries longer
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Job retry mechanism
CREATE OR REPLACE FUNCTION public.retry_failed_job(p_job_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  job_exists BOOLEAN;
BEGIN
  UPDATE public.processing_jobs
  SET 
    status = 'pending',
    started_at = NULL,
    completed_at = NULL,
    retry_count = COALESCE(retry_count, 0) + 1,
    error_details = NULL,
    updated_at = now()
  WHERE id = p_job_id
    AND status = 'failed'
    AND COALESCE(retry_count, 0) < 3; -- Max 3 retries
  
  GET DIAGNOSTICS job_exists = FOUND;
  RETURN job_exists;
END;
$$ LANGUAGE plpgsql;

-- Enhanced book status tracking
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS workflow_version TEXT DEFAULT 'v2_optimized';
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS text_extraction_completed_at TIMESTAMPTZ;
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS chapter_detection_completed_at TIMESTAMPTZ;
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS enhancement_status TEXT DEFAULT 'pending' CHECK (enhancement_status IN ('pending', 'processing', 'completed', 'failed', 'skipped'));
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS enhancement_completed_at TIMESTAMPTZ;

-- Chapter enhancement status
ALTER TABLE public.chapters ADD COLUMN IF NOT EXISTS enhancement_status TEXT DEFAULT 'pending' CHECK (enhancement_status IN ('pending', 'processing', 'completed', 'failed', 'skipped'));
ALTER TABLE public.chapters ADD COLUMN IF NOT EXISTS enhancement_started_at TIMESTAMPTZ;
ALTER TABLE public.chapters ADD COLUMN IF NOT EXISTS enhancement_completed_at TIMESTAMPTZ;
ALTER TABLE public.chapters ADD COLUMN IF NOT EXISTS ai_model_used TEXT;
ALTER TABLE public.chapters ADD COLUMN IF NOT EXISTS enhancement_token_count INTEGER;

-- Job dependencies (for workflow orchestration)
ALTER TABLE public.processing_jobs ADD COLUMN IF NOT EXISTS depends_on_job UUID REFERENCES public.processing_jobs(id);
ALTER TABLE public.processing_jobs ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_processing_jobs_status_priority ON public.processing_jobs(status, priority, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_processing_jobs_book_type ON public.processing_jobs(book_id, job_type);
CREATE INDEX IF NOT EXISTS idx_processing_cache_type_key ON public.processing_cache(cache_type, cache_key);
CREATE INDEX IF NOT EXISTS idx_processing_progress_book_updated ON public.processing_progress(book_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chapters_book_enhancement ON public.chapters(book_id, enhancement_status);

-- Add function to update job status
CREATE OR REPLACE FUNCTION public.update_job_status(
  p_job_id UUID,
  p_status TEXT,
  p_error_details JSONB DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
  UPDATE public.processing_jobs
  SET 
    status = p_status,
    completed_at = CASE WHEN p_status IN ('completed', 'failed') THEN now() ELSE completed_at END,
    error_details = p_error_details,
    updated_at = now()
  WHERE id = p_job_id;
END;
$$ LANGUAGE plpgsql;

-- Add function to calculate cache statistics
CREATE OR REPLACE FUNCTION public.get_cache_stats()
RETURNS TABLE (
  cache_type TEXT,
  total_entries BIGINT,
  total_hits BIGINT,
  avg_processing_time NUMERIC,
  cache_size_mb NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    pc.cache_type,
    COUNT(*) as total_entries,
    SUM(pc.hit_count) as total_hits,
    AVG(pc.processing_time_seconds) as avg_processing_time,
    ROUND(SUM(pg_column_size(pc.output_data))::NUMERIC / (1024 * 1024), 2) as cache_size_mb
  FROM public.processing_cache pc
  GROUP BY pc.cache_type
  ORDER BY total_entries DESC;
END;
$$ LANGUAGE plpgsql;

-- Function to estimate processing time based on historical data
CREATE OR REPLACE FUNCTION public.estimate_processing_time(
  p_file_size INTEGER,
  p_job_type TEXT DEFAULT 'extract_text'
) RETURNS INTEGER AS $$
DECLARE
  avg_time NUMERIC;
  base_time INTEGER := 60; -- 1 minute base
BEGIN
  -- Get average processing time for similar file sizes
  SELECT AVG(processing_time_seconds)
  INTO avg_time
  FROM public.processing_cache
  WHERE cache_type = p_job_type
    AND file_size BETWEEN p_file_size * 0.8 AND p_file_size * 1.2
    AND processing_time_seconds IS NOT NULL
    AND processing_time_seconds > 0;
  
  IF avg_time IS NULL THEN
    -- Fallback estimation based on file size
    RETURN base_time + (p_file_size / (1024 * 1024 * 2)); -- 1 second per 2MB
  END IF;
  
  RETURN GREATEST(base_time, avg_time::INTEGER);
END;
$$ LANGUAGE plpgsql;

-- Add trigger to update book enhancement status
CREATE OR REPLACE FUNCTION public.update_book_enhancement_status()
RETURNS TRIGGER AS $$
BEGIN
  -- Update book enhancement status based on chapters
  IF TG_OP = 'UPDATE' AND NEW.enhancement_status != OLD.enhancement_status THEN
    UPDATE public.books
    SET enhancement_status = (
      CASE 
        WHEN (SELECT COUNT(*) FROM public.chapters WHERE book_id = NEW.book_id AND enhancement_status = 'failed') > 0 THEN 'failed'
        WHEN (SELECT COUNT(*) FROM public.chapters WHERE book_id = NEW.book_id AND enhancement_status IN ('pending', 'processing')) > 0 THEN 'processing'
        WHEN (SELECT COUNT(*) FROM public.chapters WHERE book_id = NEW.book_id AND enhancement_status = 'completed') = 
             (SELECT COUNT(*) FROM public.chapters WHERE book_id = NEW.book_id) THEN 'completed'
        ELSE 'processing'
      END
    ),
    enhancement_completed_at = CASE 
      WHEN (SELECT COUNT(*) FROM public.chapters WHERE book_id = NEW.book_id AND enhancement_status = 'completed') = 
           (SELECT COUNT(*) FROM public.chapters WHERE book_id = NEW.book_id) 
      THEN now() 
      ELSE NULL 
    END
    WHERE id = NEW.book_id;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_book_enhancement_status_trigger
AFTER UPDATE ON public.chapters
FOR EACH ROW
WHEN (NEW.enhancement_status IS DISTINCT FROM OLD.enhancement_status)
EXECUTE FUNCTION public.update_book_enhancement_status();

-- Grant necessary permissions
GRANT EXECUTE ON FUNCTION public.get_next_job(TEXT[], INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_processing_status(UUID[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_old_cache(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.retry_failed_job(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_job_status(UUID, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_cache_stats() TO authenticated;
GRANT EXECUTE ON FUNCTION public.estimate_processing_time(INTEGER, TEXT) TO authenticated;