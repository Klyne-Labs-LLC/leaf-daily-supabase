-- Migration to clean up unused database tables and functions
-- This removes elements that are not actively used by the current system

-- ============================================================================
-- 1. IDENTIFY AND REMOVE UNUSED DATABASE FUNCTIONS
-- ============================================================================

-- These functions were created in previous migrations but are not being used
-- by the current simplified architecture

-- Clean up old job queue functions (not used by process-pdf-simple)
DROP FUNCTION IF EXISTS public.record_performance_metric CASCADE;
DROP FUNCTION IF EXISTS public.get_next_job CASCADE;
DROP FUNCTION IF EXISTS public.complete_job CASCADE;
DROP FUNCTION IF EXISTS public.enqueue_job CASCADE;

-- Keep cache-related functions as they're used by multiple processors
-- Keep update_processing_progress as it's used for progress tracking

-- ============================================================================
-- 2. REMOVE UNUSED TABLES
-- ============================================================================

-- Analysis shows these tables are used in edge functions but not by the current
-- simplified workflow. Since we're using process-pdf-simple, we can remove
-- the complex microservice tables.

-- Remove job queue table (not used by simplified processor)
DROP TABLE IF EXISTS public.processing_jobs CASCADE;

-- Keep processing_progress and processing_cache as they're used for tracking
-- and caching in the simplified workflow

-- ============================================================================
-- 3. CLEAN UP UNUSED COLUMNS FROM EXISTING TABLES
-- ============================================================================

-- Remove microservice-specific columns from books table that aren't used
-- by the simplified processor
ALTER TABLE public.books 
DROP COLUMN IF EXISTS workflow_version,
DROP COLUMN IF EXISTS text_extraction_completed_at,
DROP COLUMN IF EXISTS chapter_detection_completed_at;

-- Keep enhancement_status and processing_started_at as they're used

-- Remove unused columns from chapters table
ALTER TABLE public.chapters 
DROP COLUMN IF EXISTS enhancement_completed_at,
DROP COLUMN IF EXISTS ai_model_used,
DROP COLUMN IF EXISTS processing_metrics;

-- Keep enhancement_status as it's used by the AI summarization

-- ============================================================================
-- 4. REMOVE UNUSED INDEXES
-- ============================================================================

-- Remove indexes for dropped tables and columns
DROP INDEX IF EXISTS idx_processing_jobs_status_priority;
DROP INDEX IF EXISTS idx_processing_jobs_book_id;
DROP INDEX IF EXISTS idx_processing_jobs_depends_on;

-- Keep cache and progress indexes as those tables are still used

-- ============================================================================
-- 5. REMOVE UNUSED ROW LEVEL SECURITY POLICIES
-- ============================================================================

-- Clean up policies for dropped table (only if table exists)
DO $$ 
BEGIN
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'processing_jobs') THEN
        DROP POLICY IF EXISTS "Users can view jobs for their books" ON public.processing_jobs;
        DROP POLICY IF EXISTS "Service role can manage all jobs" ON public.processing_jobs;
    END IF;
END $$;

-- ============================================================================
-- 6. CLEAN UP TRIGGERS
-- ============================================================================

-- Remove trigger for dropped table (only if table exists)
DO $$ 
BEGIN
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'processing_jobs') THEN
        DROP TRIGGER IF EXISTS update_processing_jobs_updated_at ON public.processing_jobs;
    END IF;
END $$;

-- Keep triggers for books and chapters as they're still used

-- ============================================================================
-- 7. REMOVE UNUSED CONSTRAINTS
-- ============================================================================

-- Remove unique constraint that's no longer needed
ALTER TABLE public.processing_progress 
DROP CONSTRAINT IF EXISTS unique_book_stage;

-- Simplify processing_progress to allow multiple entries per book/stage
-- This is more flexible for the simplified processor

-- ============================================================================
-- 8. REVOKE UNUSED PERMISSIONS
-- ============================================================================

-- Revoke permissions for dropped functions (only if they exist)
DO $$ 
BEGIN
    IF EXISTS (SELECT FROM information_schema.routines WHERE routine_schema = 'public' AND routine_name = 'enqueue_job') THEN
        REVOKE ALL ON FUNCTION public.enqueue_job FROM service_role;
    END IF;
    
    IF EXISTS (SELECT FROM information_schema.routines WHERE routine_schema = 'public' AND routine_name = 'get_next_job') THEN
        REVOKE ALL ON FUNCTION public.get_next_job FROM service_role;
    END IF;
    
    IF EXISTS (SELECT FROM information_schema.routines WHERE routine_schema = 'public' AND routine_name = 'complete_job') THEN
        REVOKE ALL ON FUNCTION public.complete_job FROM service_role;
    END IF;
END $$;

-- Keep permissions for functions that are still used:
-- - update_processing_progress (used for progress tracking)
-- - get_cached_result (used for caching)
-- - store_cached_result (used for caching)
-- - cleanup_old_cache (used for maintenance)

-- ============================================================================
-- 9. UPDATE REMAINING FUNCTIONS FOR SIMPLIFIED ARCHITECTURE
-- ============================================================================

-- Update the progress function to be more flexible without unique constraints
CREATE OR REPLACE FUNCTION public.update_processing_progress(
  p_book_id UUID,
  p_stage TEXT,
  p_stage_progress INTEGER,
  p_overall_progress INTEGER,
  p_current_step TEXT DEFAULT NULL,
  p_message TEXT DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
  -- Insert progress record (allow multiple entries)
  INSERT INTO public.processing_progress (
    book_id, stage, stage_progress, overall_progress, current_step, message, updated_at
  ) VALUES (
    p_book_id, p_stage, p_stage_progress, p_overall_progress, p_current_step, p_message, now()
  );
    
  -- Update the book's processing status if needed
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

-- ============================================================================
-- 10. ADD CLEANUP COMMENTS
-- ============================================================================

COMMENT ON TABLE public.books IS 'Core books table for PDF processing (simplified architecture)';
COMMENT ON TABLE public.chapters IS 'Extracted chapters from processed books';
COMMENT ON TABLE public.processing_progress IS 'Progress tracking for PDF processing (allows multiple entries)';
COMMENT ON TABLE public.processing_cache IS 'Cache for avoiding duplicate processing work';

-- ============================================================================
-- CLEANUP COMPLETE
-- ============================================================================

-- This migration removes unused elements from the microservice architecture
-- and simplifies the system to support the current process-pdf-simple workflow
-- while keeping essential features like progress tracking and caching.