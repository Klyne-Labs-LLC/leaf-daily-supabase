-- Performance Optimizations for PDF Processing System
-- This migration adds advanced performance optimizations, better indexing, and system monitoring

-- Add performance tracking table
CREATE TABLE IF NOT EXISTS public.performance_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id UUID REFERENCES public.books(id) ON DELETE CASCADE,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('text_extraction', 'chapter_detection', 'ai_enhancement', 'full_workflow')),
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  processing_time_seconds INTEGER,
  memory_usage_peak_mb INTEGER,
  memory_usage_avg_mb INTEGER,
  cpu_usage_percent NUMERIC(5,2),
  success BOOLEAN DEFAULT TRUE,
  error_details JSONB,
  optimization_level TEXT DEFAULT 'balanced',
  file_size_bytes BIGINT,
  chapters_processed INTEGER,
  cache_hit_rate NUMERIC(5,4),
  api_calls_count INTEGER,
  quality_score NUMERIC(5,4),
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Add system health monitoring table
CREATE TABLE IF NOT EXISTS public.system_health (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp TIMESTAMPTZ DEFAULT now(),
  metric_name TEXT NOT NULL,
  metric_value NUMERIC,
  metric_unit TEXT,
  severity TEXT CHECK (severity IN ('info', 'warning', 'critical')),
  metadata JSONB,
  resolved_at TIMESTAMPTZ
);

-- Enhanced processing cache with size limits and TTL
ALTER TABLE public.processing_cache ADD COLUMN IF NOT EXISTS cache_size_bytes BIGINT;
ALTER TABLE public.processing_cache ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE public.processing_cache ADD COLUMN IF NOT EXISTS access_count INTEGER DEFAULT 0;
ALTER TABLE public.processing_cache ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE public.processing_cache ADD COLUMN IF NOT EXISTS compression_ratio NUMERIC(5,4);
ALTER TABLE public.processing_cache ADD COLUMN IF NOT EXISTS quality_score NUMERIC(5,4);

-- Add memory optimization fields to books table
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS processing_optimization_level TEXT DEFAULT 'balanced' CHECK (processing_optimization_level IN ('fast', 'balanced', 'quality', 'memory_optimized'));
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS processing_strategy TEXT;
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS memory_peak_usage_mb INTEGER;
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS processing_retries INTEGER DEFAULT 0;
ALTER TABLE public.books ADD COLUMN IF NOT EXISTS estimated_processing_time_seconds INTEGER;

-- Add chapter processing optimization fields
ALTER TABLE public.chapters ADD COLUMN IF NOT EXISTS processing_complexity_score NUMERIC(5,4);
ALTER TABLE public.chapters ADD COLUMN IF NOT EXISTS optimization_applied JSONB;
ALTER TABLE public.chapters ADD COLUMN IF NOT EXISTS quality_metrics JSONB;

-- Create performance indexes
CREATE INDEX IF NOT EXISTS idx_performance_metrics_book_operation ON public.performance_metrics(book_id, operation_type);
CREATE INDEX IF NOT EXISTS idx_performance_metrics_timestamp ON public.performance_metrics(start_time DESC);
CREATE INDEX IF NOT EXISTS idx_performance_metrics_success ON public.performance_metrics(success, operation_type) WHERE success = FALSE;

CREATE INDEX IF NOT EXISTS idx_system_health_timestamp ON public.system_health(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_system_health_severity ON public.system_health(severity, timestamp DESC) WHERE severity IN ('warning', 'critical');

-- Enhanced cache indexes with performance focus
CREATE INDEX IF NOT EXISTS idx_processing_cache_expires ON public.processing_cache(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_processing_cache_access ON public.processing_cache(last_accessed_at DESC, access_count DESC);
CREATE INDEX IF NOT EXISTS idx_processing_cache_size ON public.processing_cache(cache_size_bytes DESC);

-- Composite indexes for complex queries
CREATE INDEX IF NOT EXISTS idx_books_processing_status_optimization ON public.books(processing_status, processing_optimization_level) WHERE processing_status IN ('processing', 'failed');
CREATE INDEX IF NOT EXISTS idx_chapters_enhancement_book ON public.chapters(book_id, enhancement_status, processing_complexity_score) WHERE enhancement_status != 'completed';

-- Function to calculate processing complexity score
CREATE OR REPLACE FUNCTION public.calculate_complexity_score(
  p_word_count INTEGER,
  p_content_length INTEGER,
  p_chapter_title TEXT
) RETURNS NUMERIC AS $$
DECLARE
  complexity_score NUMERIC := 0.5;
BEGIN
  -- Base complexity based on content length
  complexity_score := complexity_score + LEAST(p_content_length::NUMERIC / 10000, 0.3);
  
  -- Word count factor
  complexity_score := complexity_score + LEAST(p_word_count::NUMERIC / 5000, 0.2);
  
  -- Title complexity (technical terms, length)
  IF LENGTH(p_chapter_title) > 50 THEN
    complexity_score := complexity_score + 0.1;
  END IF;
  
  -- Technical content indicators
  IF p_content_length > 0 AND (
    LOWER(p_chapter_title) LIKE '%technical%' OR
    LOWER(p_chapter_title) LIKE '%analysis%' OR
    LOWER(p_chapter_title) LIKE '%theory%' OR
    LOWER(p_chapter_title) LIKE '%research%'
  ) THEN
    complexity_score := complexity_score + 0.15;
  END IF;
  
  RETURN LEAST(complexity_score, 1.0);
END;
$$ LANGUAGE plpgsql;

-- Function to estimate processing time based on historical data and complexity
CREATE OR REPLACE FUNCTION public.estimate_processing_time_advanced(
  p_file_size_bytes BIGINT,
  p_optimization_level TEXT DEFAULT 'balanced',
  p_chapter_count INTEGER DEFAULT NULL
) RETURNS INTEGER AS $$
DECLARE
  base_time INTEGER := 30; -- 30 seconds base
  file_size_mb NUMERIC;
  time_per_mb NUMERIC := 10; -- 10 seconds per MB
  optimization_multiplier NUMERIC := 1.0;
  complexity_multiplier NUMERIC := 1.0;
  avg_historical_time NUMERIC;
BEGIN
  file_size_mb := p_file_size_bytes::NUMERIC / (1024 * 1024);
  
  -- Get historical average for similar files
  SELECT AVG(processing_time_seconds)
  INTO avg_historical_time
  FROM public.performance_metrics pm
  JOIN public.books b ON pm.book_id = b.id
  WHERE pm.operation_type = 'full_workflow'
    AND pm.success = TRUE
    AND b.file_size BETWEEN p_file_size_bytes * 0.8 AND p_file_size_bytes * 1.2
    AND pm.created_at > now() - INTERVAL '30 days'
  LIMIT 100;
  
  -- Optimization level adjustments
  CASE p_optimization_level
    WHEN 'fast' THEN optimization_multiplier := 0.7;
    WHEN 'quality' THEN optimization_multiplier := 1.5;
    WHEN 'memory_optimized' THEN optimization_multiplier := 1.3;
    ELSE optimization_multiplier := 1.0;
  END CASE;
  
  -- Chapter count complexity
  IF p_chapter_count IS NOT NULL AND p_chapter_count > 50 THEN
    complexity_multiplier := 1.2;
  ELSIF p_chapter_count IS NOT NULL AND p_chapter_count < 10 THEN
    complexity_multiplier := 0.8;
  END IF;
  
  -- Calculate final estimate
  IF avg_historical_time IS NOT NULL THEN
    RETURN GREATEST(
      base_time,
      (avg_historical_time * optimization_multiplier * complexity_multiplier)::INTEGER
    );
  ELSE
    RETURN GREATEST(
      base_time,
      (base_time + (file_size_mb * time_per_mb) * optimization_multiplier * complexity_multiplier)::INTEGER
    );
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Function to optimize cache automatically
CREATE OR REPLACE FUNCTION public.optimize_cache_auto()
RETURNS TABLE (
  optimization_type TEXT,
  entries_affected INTEGER,
  space_freed_bytes BIGINT
) AS $$
DECLARE
  expired_count INTEGER := 0;
  lowaccess_count INTEGER := 0;
  duplicate_count INTEGER := 0;
  expired_space BIGINT := 0;
  lowaccess_space BIGINT := 0;
  duplicate_space BIGINT := 0;
BEGIN
  -- Remove expired entries
  DELETE FROM public.processing_cache
  WHERE expires_at IS NOT NULL AND expires_at < now()
  RETURNING cache_size_bytes INTO expired_space;
  
  GET DIAGNOSTICS expired_count = ROW_COUNT;
  
  -- Remove low-access old entries
  DELETE FROM public.processing_cache
  WHERE access_count < 2 
    AND created_at < now() - INTERVAL '7 days'
    AND last_accessed_at < now() - INTERVAL '3 days'
  RETURNING cache_size_bytes INTO lowaccess_space;
  
  GET DIAGNOSTICS lowaccess_count = ROW_COUNT;
  
  -- Remove duplicates (keep highest access count)
  WITH duplicate_entries AS (
    SELECT input_hash, 
           array_agg(id ORDER BY access_count DESC, created_at DESC) as ids,
           array_agg(cache_size_bytes ORDER BY access_count DESC, created_at DESC) as sizes
    FROM public.processing_cache
    GROUP BY input_hash
    HAVING COUNT(*) > 1
  )
  DELETE FROM public.processing_cache
  WHERE id IN (
    SELECT unnest(ids[2:]) -- Keep first, delete rest
    FROM duplicate_entries
  );
  
  GET DIAGNOSTICS duplicate_count = ROW_COUNT;
  
  -- Return optimization results
  RETURN QUERY VALUES 
    ('expired_entries', expired_count, COALESCE(expired_space, 0)),
    ('low_access_entries', lowaccess_count, COALESCE(lowaccess_space, 0)),
    ('duplicate_entries', duplicate_count, COALESCE(duplicate_space, 0));
END;
$$ LANGUAGE plpgsql;

-- Function to get system performance summary
CREATE OR REPLACE FUNCTION public.get_performance_summary(
  p_days INTEGER DEFAULT 7
)
RETURNS TABLE (
  metric_name TEXT,
  metric_value NUMERIC,
  metric_unit TEXT,
  trend TEXT
) AS $$
BEGIN
  RETURN QUERY
  WITH recent_metrics AS (
    SELECT 
      operation_type,
      AVG(processing_time_seconds) as avg_processing_time,
      AVG(memory_usage_peak_mb) as avg_memory_usage,
      AVG(cache_hit_rate) as avg_cache_hit_rate,
      AVG(quality_score) as avg_quality_score,
      COUNT(CASE WHEN success THEN 1 END)::NUMERIC / COUNT(*)::NUMERIC as success_rate
    FROM public.performance_metrics
    WHERE created_at > now() - (p_days || ' days')::INTERVAL
    GROUP BY operation_type
  ),
  older_metrics AS (
    SELECT 
      operation_type,
      AVG(processing_time_seconds) as avg_processing_time,
      AVG(memory_usage_peak_mb) as avg_memory_usage,
      AVG(cache_hit_rate) as avg_cache_hit_rate,
      AVG(quality_score) as avg_quality_score,
      COUNT(CASE WHEN success THEN 1 END)::NUMERIC / COUNT(*)::NUMERIC as success_rate
    FROM public.performance_metrics
    WHERE created_at BETWEEN now() - (p_days * 2 || ' days')::INTERVAL AND now() - (p_days || ' days')::INTERVAL
    GROUP BY operation_type
  )
  SELECT 
    'avg_processing_time' as metric_name,
    ROUND(rm.avg_processing_time, 2) as metric_value,
    'seconds' as metric_unit,
    CASE 
      WHEN om.avg_processing_time IS NULL THEN 'no_data'
      WHEN rm.avg_processing_time < om.avg_processing_time * 0.95 THEN 'improving'
      WHEN rm.avg_processing_time > om.avg_processing_time * 1.05 THEN 'degrading'
      ELSE 'stable'
    END as trend
  FROM recent_metrics rm
  LEFT JOIN older_metrics om ON rm.operation_type = om.operation_type
  WHERE rm.operation_type = 'full_workflow'
  
  UNION ALL
  
  SELECT 
    'cache_hit_rate' as metric_name,
    ROUND(rm.avg_cache_hit_rate * 100, 1) as metric_value,
    'percent' as metric_unit,
    CASE 
      WHEN om.avg_cache_hit_rate IS NULL THEN 'no_data'
      WHEN rm.avg_cache_hit_rate > om.avg_cache_hit_rate * 1.05 THEN 'improving'
      WHEN rm.avg_cache_hit_rate < om.avg_cache_hit_rate * 0.95 THEN 'degrading'
      ELSE 'stable'
    END as trend
  FROM recent_metrics rm
  LEFT JOIN older_metrics om ON rm.operation_type = om.operation_type
  WHERE rm.operation_type = 'full_workflow'
  
  UNION ALL
  
  SELECT 
    'success_rate' as metric_name,
    ROUND(rm.success_rate * 100, 1) as metric_value,
    'percent' as metric_unit,
    CASE 
      WHEN om.success_rate IS NULL THEN 'no_data'
      WHEN rm.success_rate > om.success_rate * 1.02 THEN 'improving'
      WHEN rm.success_rate < om.success_rate * 0.98 THEN 'degrading'
      ELSE 'stable'
    END as trend
  FROM recent_metrics rm
  LEFT JOIN older_metrics om ON rm.operation_type = om.operation_type
  WHERE rm.operation_type = 'full_workflow';
END;
$$ LANGUAGE plpgsql;

-- Function to record performance metrics
CREATE OR REPLACE FUNCTION public.record_performance_metric(
  p_book_id UUID,
  p_operation_type TEXT,
  p_processing_time_seconds INTEGER,
  p_memory_usage_peak_mb INTEGER DEFAULT NULL,
  p_success BOOLEAN DEFAULT TRUE,
  p_metadata JSONB DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
  metric_id UUID;
BEGIN
  INSERT INTO public.performance_metrics (
    book_id,
    operation_type,
    start_time,
    end_time,
    processing_time_seconds,
    memory_usage_peak_mb,
    success,
    metadata
  ) VALUES (
    p_book_id,
    p_operation_type,
    now() - (p_processing_time_seconds || ' seconds')::INTERVAL,
    now(),
    p_processing_time_seconds,
    p_memory_usage_peak_mb,
    p_success,
    p_metadata
  ) RETURNING id INTO metric_id;
  
  RETURN metric_id;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update chapter complexity scores
CREATE OR REPLACE FUNCTION public.update_chapter_complexity()
RETURNS TRIGGER AS $$
BEGIN
  NEW.processing_complexity_score := public.calculate_complexity_score(
    NEW.word_count,
    LENGTH(NEW.content),
    NEW.title
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_chapter_complexity
  BEFORE INSERT OR UPDATE ON public.chapters
  FOR EACH ROW
  EXECUTE FUNCTION public.update_chapter_complexity();

-- Create materialized view for performance dashboard
CREATE MATERIALIZED VIEW IF NOT EXISTS public.performance_dashboard AS
SELECT 
  DATE_TRUNC('hour', created_at) as hour,
  operation_type,
  COUNT(*) as total_operations,
  COUNT(CASE WHEN success THEN 1 END) as successful_operations,
  AVG(processing_time_seconds) as avg_processing_time,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY processing_time_seconds) as p95_processing_time,
  AVG(memory_usage_peak_mb) as avg_memory_usage,
  MAX(memory_usage_peak_mb) as peak_memory_usage
FROM public.performance_metrics
WHERE created_at > now() - INTERVAL '7 days'
GROUP BY DATE_TRUNC('hour', created_at), operation_type
ORDER BY hour DESC;

-- Create unique index on materialized view
CREATE UNIQUE INDEX IF NOT EXISTS idx_performance_dashboard_unique 
ON public.performance_dashboard(hour, operation_type);

-- Function to refresh performance dashboard
CREATE OR REPLACE FUNCTION public.refresh_performance_dashboard()
RETURNS VOID AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.performance_dashboard;
END;
$$ LANGUAGE plpgsql;

-- Grant necessary permissions
GRANT SELECT ON public.performance_metrics TO authenticated;
GRANT SELECT ON public.system_health TO authenticated;
GRANT SELECT ON public.performance_dashboard TO authenticated;

GRANT EXECUTE ON FUNCTION public.calculate_complexity_score(INTEGER, INTEGER, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.estimate_processing_time_advanced(BIGINT, TEXT, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_performance_summary(INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_performance_metric(UUID, TEXT, INTEGER, INTEGER, BOOLEAN, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.optimize_cache_auto() TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_performance_dashboard() TO service_role;

-- Add comments for documentation
COMMENT ON TABLE public.performance_metrics IS 'Tracks detailed performance metrics for all PDF processing operations';
COMMENT ON TABLE public.system_health IS 'Monitors overall system health and alerts for performance issues';
COMMENT ON FUNCTION public.estimate_processing_time_advanced IS 'Advanced processing time estimation using historical data and complexity analysis';
COMMENT ON FUNCTION public.optimize_cache_auto IS 'Automatically optimizes cache by removing expired, low-access, and duplicate entries';
COMMENT ON MATERIALIZED VIEW public.performance_dashboard IS 'Aggregated performance metrics for monitoring dashboard';

-- Create scheduled job for cache optimization (requires pg_cron extension)
-- SELECT cron.schedule('optimize-cache', '0 2 * * *', 'SELECT public.optimize_cache_auto();');

-- Create scheduled job for dashboard refresh (every hour)
-- SELECT cron.schedule('refresh-dashboard', '0 * * * *', 'SELECT public.refresh_performance_dashboard();');