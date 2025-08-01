-- Workflow Optimization Schema
-- Adds job queuing, progress tracking, and caching for optimized PDF processing

-- Create processing jobs table for workflow orchestration
CREATE TABLE public.processing_jobs (
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
  estimated_duration_seconds INTEGER,
  actual_duration_seconds INTEGER,
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create processing cache table for avoiding duplicate work
CREATE TABLE public.processing_cache (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  cache_key TEXT NOT NULL UNIQUE, -- Hash of file content + processing params
  cache_type TEXT NOT NULL CHECK (cache_type IN ('text_extraction', 'chapter_detection', 'ai_enhancement')),
  input_hash TEXT NOT NULL, -- SHA256 of input data
  output_data JSONB NOT NULL,
  file_size INTEGER,
  processing_time_seconds INTEGER,
  hit_count INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  last_accessed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create progress tracking table for real-time updates
CREATE TABLE public.processing_progress (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  book_id UUID NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('uploading', 'extracting_text', 'detecting_chapters', 'storing_chapters', 'enhancing_chapters', 'completed', 'failed')),
  stage_progress INTEGER DEFAULT 0 CHECK (stage_progress >= 0 AND stage_progress <= 100),
  overall_progress INTEGER DEFAULT 0 CHECK (overall_progress >= 0 AND overall_progress <= 100),
  current_step TEXT,
  total_steps INTEGER,
  estimated_completion_time TIMESTAMP WITH TIME ZONE,
  message TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(book_id, stage)
);

-- Add workflow tracking columns to existing books table
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS workflow_version TEXT DEFAULT 'v1';
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS text_extraction_completed_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS chapter_detection_completed_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS enhancement_status TEXT DEFAULT 'pending' CHECK (enhancement_status IN ('pending', 'processing', 'completed', 'failed'));

-- Add enhanced chapter metadata
ALTER TABLE public.chapters ADD COLUMN IF NOT EXISTS enhancement_status TEXT DEFAULT 'pending' CHECK (enhancement_status IN ('pending', 'processing', 'completed', 'failed', 'skipped'));
ALTER TABLE public.chapters ADD COLUMN IF NOT EXISTS enhancement_completed_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE public.chapters ADD COLUMN IF NOT EXISTS ai_model_used TEXT;
ALTER TABLE public.chapters ADD COLUMN IF NOT EXISTS processing_metrics JSONB DEFAULT '{}';

-- Enable RLS on new tables
ALTER TABLE public.processing_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.processing_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.processing_progress ENABLE ROW LEVEL SECURITY;

-- Create policies for processing_jobs
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
USING (auth.jwt() ->> 'role' = 'service_role');

-- Create policies for processing_progress
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
USING (auth.jwt() ->> 'role' = 'service_role');

-- Create policies for processing_cache (service role only)
CREATE POLICY "Service role can manage cache" 
ON public.processing_cache 
FOR ALL 
USING (auth.jwt() ->> 'role' = 'service_role');

-- Create indexes for performance
CREATE INDEX idx_processing_jobs_book_id ON public.processing_jobs(book_id);
CREATE INDEX idx_processing_jobs_status ON public.processing_jobs(status);
CREATE INDEX idx_processing_jobs_job_type ON public.processing_jobs(job_type);
CREATE INDEX idx_processing_jobs_priority ON public.processing_jobs(priority, created_at);
CREATE INDEX idx_processing_cache_key ON public.processing_cache(cache_key);
CREATE INDEX idx_processing_cache_type ON public.processing_cache(cache_type);
CREATE INDEX idx_processing_cache_hash ON public.processing_cache(input_hash);
CREATE INDEX idx_processing_progress_book_id ON public.processing_progress(book_id);
CREATE INDEX idx_processing_progress_stage ON public.processing_progress(stage);

-- Create triggers for automatic timestamp updates
CREATE TRIGGER update_processing_jobs_updated_at
BEFORE UPDATE ON public.processing_jobs
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_processing_cache_updated_at
BEFORE UPDATE ON public.processing_cache
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_processing_progress_updated_at
BEFORE UPDATE ON public.processing_progress
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Update cache last_accessed_at on reads
CREATE OR REPLACE FUNCTION public.update_cache_access()
RETURNS TRIGGER AS $$
BEGIN
  NEW.last_accessed_at = now();
  NEW.hit_count = OLD.hit_count + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_cache_access_trigger
BEFORE UPDATE ON public.processing_cache
FOR EACH ROW
WHEN (OLD.last_accessed_at < now() - INTERVAL '1 minute') -- Only update if more than 1 minute old
EXECUTE FUNCTION public.update_cache_access();

-- Create job queue management functions
CREATE OR REPLACE FUNCTION public.enqueue_job(
  p_book_id UUID,
  p_job_type TEXT,
  p_input_data JSONB DEFAULT NULL,
  p_priority INTEGER DEFAULT 5
) RETURNS UUID AS $$
DECLARE
  job_id UUID;
BEGIN
  INSERT INTO public.processing_jobs (book_id, job_type, input_data, priority)
  VALUES (p_book_id, p_job_type, p_input_data, p_priority)
  RETURNING id INTO job_id;
  
  RETURN job_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create progress update function
CREATE OR REPLACE FUNCTION public.update_processing_progress(
  p_book_id UUID,
  p_stage TEXT,
  p_stage_progress INTEGER DEFAULT NULL,
  p_overall_progress INTEGER DEFAULT NULL,
  p_current_step TEXT DEFAULT NULL,
  p_message TEXT DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
  INSERT INTO public.processing_progress (
    book_id, stage, stage_progress, overall_progress, current_step, message
  ) VALUES (
    p_book_id, p_stage, p_stage_progress, p_overall_progress, p_current_step, p_message
  )
  ON CONFLICT (book_id, stage) 
  DO UPDATE SET
    stage_progress = COALESCE(EXCLUDED.stage_progress, processing_progress.stage_progress),
    overall_progress = COALESCE(EXCLUDED.overall_progress, processing_progress.overall_progress),
    current_step = COALESCE(EXCLUDED.current_step, processing_progress.current_step),
    message = COALESCE(EXCLUDED.message, processing_progress.message),
    updated_at = now();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create cache lookup function
CREATE OR REPLACE FUNCTION public.get_cached_result(
  p_cache_key TEXT,
  p_cache_type TEXT
) RETURNS JSONB AS $$
DECLARE
  result JSONB;
BEGIN
  UPDATE public.processing_cache 
  SET last_accessed_at = now(), hit_count = hit_count + 1
  WHERE cache_key = p_cache_key AND cache_type = p_cache_type
  RETURNING output_data INTO result;
  
  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create cache store function
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
    output_data = EXCLUDED.output_data,
    processing_time_seconds = EXCLUDED.processing_time_seconds,
    last_accessed_at = now();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;