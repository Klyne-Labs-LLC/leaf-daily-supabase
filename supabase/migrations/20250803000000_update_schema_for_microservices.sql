-- Migration to update database schema for microservice architecture
-- This adds all missing tables, columns, and functions needed by the edge functions

-- ============================================================================
-- 1. ADD MISSING COLUMNS TO EXISTING TABLES
-- ============================================================================

-- Add missing columns to books table
ALTER TABLE public.books 
ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS workflow_version TEXT DEFAULT 'v2_optimized',
ADD COLUMN IF NOT EXISTS enhancement_status TEXT DEFAULT 'pending' CHECK (enhancement_status IN ('pending', 'processing', 'completed', 'failed')),
ADD COLUMN IF NOT EXISTS text_extraction_completed_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS chapter_detection_completed_at TIMESTAMP WITH TIME ZONE;

-- Add missing columns to chapters table
ALTER TABLE public.chapters 
ADD COLUMN IF NOT EXISTS enhancement_status TEXT DEFAULT 'pending' CHECK (enhancement_status IN ('pending', 'processing', 'completed', 'failed')),
ADD COLUMN IF NOT EXISTS enhancement_completed_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS ai_model_used TEXT,
ADD COLUMN IF NOT EXISTS processing_metrics JSONB DEFAULT '{}';

-- ============================================================================
-- 2. CREATE NEW TABLES FOR MICROSERVICE ARCHITECTURE
-- ============================================================================

-- Create processing jobs table for workflow orchestration
CREATE TABLE IF NOT EXISTS public.processing_jobs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  book_id UUID NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL CHECK (job_type IN ('extract_text', 'detect_chapters', 'store_chapters', 'enhance_chapters')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'retrying')),
  priority INTEGER NOT NULL DEFAULT 5, -- 1 = highest, 10 = lowest
  progress_percentage INTEGER DEFAULT 0 CHECK (progress_percentage >= 0 AND progress_percentage <= 100),
  input_data JSONB,
  output_data JSONB,
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  depends_on_job UUID, -- For job dependencies
  estimated_duration_seconds INTEGER,
  actual_duration_seconds INTEGER,
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create processing cache table for avoiding duplicate work
CREATE TABLE IF NOT EXISTS public.processing_cache (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  cache_key TEXT NOT NULL UNIQUE, -- Hash of file content + processing params
  cache_type TEXT NOT NULL CHECK (cache_type IN ('text_extraction', 'chapter_detection', 'ai_enhancement', 'full_workflow')),
  input_hash TEXT NOT NULL, -- SHA256 of input data
  output_data JSONB NOT NULL,
  file_size INTEGER,
  processing_time_seconds INTEGER,
  hit_count INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  last_accessed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create progress tracking table for real-time updates
CREATE TABLE IF NOT EXISTS public.processing_progress (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  book_id UUID NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('uploading', 'extracting_text', 'detecting_chapters', 'storing_chapters', 'enhancing_chapters', 'generating_summaries', 'completed', 'failed')),
  stage_progress INTEGER DEFAULT 0 CHECK (stage_progress >= 0 AND stage_progress <= 100),
  overall_progress INTEGER DEFAULT 0 CHECK (overall_progress >= 0 AND overall_progress <= 100),
  current_step TEXT,
  total_steps INTEGER,
  estimated_completion_time TIMESTAMP WITH TIME ZONE,
  message TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- ============================================================================
-- 3. CREATE INDEXES FOR PERFORMANCE
-- ============================================================================

-- Indexes for processing_jobs
CREATE INDEX IF NOT EXISTS idx_processing_jobs_status_priority ON public.processing_jobs(status, priority, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_processing_jobs_book_id ON public.processing_jobs(book_id);
CREATE INDEX IF NOT EXISTS idx_processing_jobs_depends_on ON public.processing_jobs(depends_on_job) WHERE depends_on_job IS NOT NULL;

-- Indexes for processing_cache
CREATE INDEX IF NOT EXISTS idx_processing_cache_type_key ON public.processing_cache(cache_type, cache_key);
CREATE INDEX IF NOT EXISTS idx_processing_cache_cleanup ON public.processing_cache(created_at, hit_count);

-- Indexes for processing_progress
CREATE INDEX IF NOT EXISTS idx_processing_progress_book_id ON public.processing_progress(book_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_processing_progress_stage ON public.processing_progress(book_id, stage);

-- Indexes for chapters enhancement tracking
CREATE INDEX IF NOT EXISTS idx_chapters_book_enhancement ON public.chapters(book_id, enhancement_status);

-- ============================================================================
-- 4. CREATE DATABASE FUNCTIONS
-- ============================================================================

-- Function to enqueue a processing job
CREATE OR REPLACE FUNCTION public.enqueue_job(
  p_book_id UUID,
  p_job_type TEXT,
  p_input_data JSONB DEFAULT NULL,
  p_priority INTEGER DEFAULT 5,
  p_depends_on_job UUID DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
  job_id UUID;
BEGIN
  INSERT INTO public.processing_jobs (
    book_id, job_type, input_data, priority, depends_on_job
  ) VALUES (
    p_book_id, p_job_type, p_input_data, p_priority, p_depends_on_job
  ) RETURNING id INTO job_id;
  
  RETURN job_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get the next job from the queue
CREATE OR REPLACE FUNCTION public.get_next_job()
RETURNS TABLE (
  id UUID,
  book_id UUID,
  job_type TEXT,
  input_data JSONB,
  priority INTEGER,
  retry_count INTEGER
) AS $$
BEGIN
  RETURN QUERY
  UPDATE public.processing_jobs 
  SET 
    status = 'running',
    started_at = now(),
    updated_at = now()
  WHERE processing_jobs.id = (
    SELECT j.id 
    FROM public.processing_jobs j
    LEFT JOIN public.processing_jobs dep ON j.depends_on_job = dep.id
    WHERE j.status = 'pending' 
      AND (j.depends_on_job IS NULL OR dep.status = 'completed')
      AND j.retry_count < j.max_retries
    ORDER BY j.priority ASC, j.created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING 
    processing_jobs.id,
    processing_jobs.book_id,
    processing_jobs.job_type,
    processing_jobs.input_data,
    processing_jobs.priority,
    processing_jobs.retry_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to update processing progress
CREATE OR REPLACE FUNCTION public.update_processing_progress(
  p_book_id UUID,
  p_stage TEXT,
  p_stage_progress INTEGER,
  p_overall_progress INTEGER,
  p_current_step TEXT DEFAULT NULL,
  p_message TEXT DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
  -- Insert or update progress record
  INSERT INTO public.processing_progress (
    book_id, stage, stage_progress, overall_progress, current_step, message, updated_at
  ) VALUES (
    p_book_id, p_stage, p_stage_progress, p_overall_progress, p_current_step, p_message, now()
  )
  ON CONFLICT (book_id, stage) 
  DO UPDATE SET
    stage_progress = p_stage_progress,
    overall_progress = p_overall_progress,
    current_step = COALESCE(p_current_step, processing_progress.current_step),
    message = COALESCE(p_message, processing_progress.message),
    updated_at = now();
    
  -- Also update the book's processing status if needed
  IF p_stage = 'completed' THEN
    UPDATE public.books 
    SET processing_status = 'completed', processing_completed_at = now()
    WHERE id = p_book_id;
  ELSIF p_stage = 'failed' THEN
    UPDATE public.books 
    SET processing_status = 'failed'
    WHERE id = p_book_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get cached result
CREATE OR REPLACE FUNCTION public.get_cached_result(
  p_cache_key TEXT,
  p_cache_type TEXT
) RETURNS JSONB AS $$
DECLARE
  result JSONB;
BEGIN
  -- Get cached result and increment hit count
  UPDATE public.processing_cache 
  SET 
    hit_count = hit_count + 1,
    last_accessed_at = now()
  WHERE cache_key = p_cache_key AND cache_type = p_cache_type
  RETURNING output_data INTO result;
  
  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to store cached result
CREATE OR REPLACE FUNCTION public.store_cached_result(
  p_cache_key TEXT,
  p_cache_type TEXT,
  p_input_hash TEXT,
  p_output_data JSONB,
  p_file_size INTEGER DEFAULT NULL,
  p_processing_time_seconds INTEGER DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
  INSERT INTO public.processing_cache (
    cache_key, cache_type, input_hash, output_data, file_size, processing_time_seconds
  ) VALUES (
    p_cache_key, p_cache_type, p_input_hash, p_output_data, p_file_size, p_processing_time_seconds
  )
  ON CONFLICT (cache_key) 
  DO UPDATE SET
    output_data = p_output_data,
    hit_count = 0, -- Reset hit count for updated entries
    last_accessed_at = now();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to complete a job
CREATE OR REPLACE FUNCTION public.complete_job(
  p_job_id UUID,
  p_output_data JSONB DEFAULT NULL,
  p_success BOOLEAN DEFAULT TRUE,
  p_error_message TEXT DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
  IF p_success THEN
    UPDATE public.processing_jobs 
    SET 
      status = 'completed',
      output_data = p_output_data,
      completed_at = now(),
      actual_duration_seconds = EXTRACT(EPOCH FROM (now() - started_at))::INTEGER,
      updated_at = now()
    WHERE id = p_job_id;
  ELSE
    UPDATE public.processing_jobs 
    SET 
      status = CASE 
        WHEN retry_count < max_retries THEN 'pending'
        ELSE 'failed'
      END,
      retry_count = retry_count + 1,
      error_message = p_error_message,
      updated_at = now()
    WHERE id = p_job_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to cleanup old cache entries
CREATE OR REPLACE FUNCTION public.cleanup_old_cache()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  -- Delete cache entries older than 30 days with less than 2 hits
  DELETE FROM public.processing_cache 
  WHERE created_at < now() - INTERVAL '30 days' 
    AND hit_count < 2;
    
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- 5. ADD ROW LEVEL SECURITY POLICIES
-- ============================================================================

-- Enable RLS on new tables
ALTER TABLE public.processing_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.processing_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.processing_progress ENABLE ROW LEVEL SECURITY;

-- Policies for processing_jobs (users can view/manage jobs for their books)
CREATE POLICY "Users can view jobs for their books" 
ON public.processing_jobs 
FOR SELECT 
USING (
  EXISTS (
    SELECT 1 FROM public.books 
    WHERE books.id = processing_jobs.book_id 
    AND books.user_id = auth.uid()
  )
);

CREATE POLICY "Service role can manage all jobs" 
ON public.processing_jobs 
FOR ALL 
USING (auth.role() = 'service_role');

-- Policies for processing_cache (service role only, users don't need direct access)
CREATE POLICY "Service role can manage cache" 
ON public.processing_cache 
FOR ALL 
USING (auth.role() = 'service_role');

-- Policies for processing_progress (users can view progress for their books)
CREATE POLICY "Users can view progress for their books" 
ON public.processing_progress 
FOR SELECT 
USING (
  EXISTS (
    SELECT 1 FROM public.books 
    WHERE books.id = processing_progress.book_id 
    AND books.user_id = auth.uid()
  )
);

CREATE POLICY "Service role can manage all progress" 
ON public.processing_progress 
FOR ALL 
USING (auth.role() = 'service_role');

-- ============================================================================
-- 6. CREATE TRIGGERS FOR AUTOMATIC UPDATES
-- ============================================================================

-- Trigger to automatically update updated_at timestamps
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Add triggers to tables that need automatic updated_at updates
DROP TRIGGER IF EXISTS update_processing_jobs_updated_at ON public.processing_jobs;
CREATE TRIGGER update_processing_jobs_updated_at
  BEFORE UPDATE ON public.processing_jobs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_books_updated_at ON public.books;
CREATE TRIGGER update_books_updated_at
  BEFORE UPDATE ON public.books
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_chapters_updated_at ON public.chapters;
CREATE TRIGGER update_chapters_updated_at
  BEFORE UPDATE ON public.chapters
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================================
-- 7. ADD CONSTRAINTS AND UNIQUE INDEXES
-- ============================================================================

-- Ensure unique progress entries per book and stage
ALTER TABLE public.processing_progress 
DROP CONSTRAINT IF EXISTS unique_book_stage;

ALTER TABLE public.processing_progress 
ADD CONSTRAINT unique_book_stage UNIQUE (book_id, stage);

-- Ensure unique chapter numbering per book
ALTER TABLE public.chapters 
DROP CONSTRAINT IF EXISTS unique_book_chapter;

ALTER TABLE public.chapters 
ADD CONSTRAINT unique_book_chapter UNIQUE (book_id, chapter_number, part_number);

-- ============================================================================
-- 8. GRANT NECESSARY PERMISSIONS
-- ============================================================================

-- Grant permissions for the service role to use functions
GRANT EXECUTE ON FUNCTION public.enqueue_job TO service_role;
GRANT EXECUTE ON FUNCTION public.get_next_job TO service_role;
GRANT EXECUTE ON FUNCTION public.update_processing_progress TO service_role;
GRANT EXECUTE ON FUNCTION public.get_cached_result TO service_role;
GRANT EXECUTE ON FUNCTION public.store_cached_result TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_job TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_old_cache TO service_role;

-- Grant table permissions
GRANT ALL ON public.processing_jobs TO service_role;
GRANT ALL ON public.processing_cache TO service_role;
GRANT ALL ON public.processing_progress TO service_role;

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================

-- Add a comment to track this migration
COMMENT ON TABLE public.processing_jobs IS 'Job queue for microservice PDF processing workflow (v2_optimized)';
COMMENT ON TABLE public.processing_cache IS 'Cache for avoiding duplicate processing work';
COMMENT ON TABLE public.processing_progress IS 'Real-time progress tracking for PDF processing';