import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseKey);

interface WorkflowConfig {
  enableCaching: boolean;
  enableAsyncEnhancement: boolean;
  priorityLevel: number;
  maxRetries: number;
  timeoutSeconds: number;
}

const DEFAULT_WORKFLOW_CONFIG: WorkflowConfig = {
  enableCaching: true,
  enableAsyncEnhancement: true,
  priorityLevel: 5,
  maxRetries: 2,
  timeoutSeconds: 900 // 15 minutes total timeout
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  let bookId: string | undefined;

  try {
    const { bookId: requestBookId, config = {} } = await req.json();
    bookId = requestBookId;
    
    if (!bookId) {
      throw new Error('Book ID is required');
    }

    const workflowConfig: WorkflowConfig = { ...DEFAULT_WORKFLOW_CONFIG, ...config };

    console.log(`[ORCHESTRATOR] Starting optimized workflow for book ID: ${bookId}`);

    // Initialize workflow tracking
    await initializeWorkflow(bookId, workflowConfig);

    // Start the pipeline
    const result = await runOptimizedPipeline(bookId, workflowConfig);

    const processingTime = Math.round((Date.now() - startTime) / 1000);

    console.log(`[ORCHESTRATOR] Workflow initiated in ${processingTime}s for book ${bookId}`);

    return new Response(
      JSON.stringify({
        success: true,
        workflowId: result.workflowId,
        estimatedCompletionTime: result.estimatedCompletionTime,
        processingTime
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[ORCHESTRATOR] Error:', error);
    
    const processingTime = Math.round((Date.now() - startTime) / 1000);
    
    if (bookId) {
      await updateProgress(bookId, 'failed', 0, 0, `Workflow failed: ${error.message}`, true);
      await supabase
        .from('books')
        .update({ processing_status: 'failed' })
        .eq('id', bookId);
    }
    
    return new Response(
      JSON.stringify({ 
        error: error.message,
        processingTime 
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
});

async function initializeWorkflow(bookId: string, config: WorkflowConfig): Promise<void> {
  try {
    // Update book with workflow version and config
    await supabase
      .from('books')
      .update({
        workflow_version: 'v2_optimized',
        processing_status: 'processing',
        processing_started_at: new Date().toISOString()
      })
      .eq('id', bookId);

    // Initialize progress tracking
    await updateProgress(bookId, 'uploading', 100, 5, 'Workflow initialized, starting text extraction...');

    console.log(`[ORCHESTRATOR] Initialized workflow for book ${bookId} with config:`, config);

  } catch (error) {
    console.error('[ORCHESTRATOR] Failed to initialize workflow:', error);
    throw error;
  }
}

interface PipelineResult {
  workflowId: string;
  estimatedCompletionTime: string;
}

async function runOptimizedPipeline(bookId: string, config: WorkflowConfig): Promise<PipelineResult> {
  // Step 1: Check if we can use cached results for the entire workflow
  const fullCacheResult = await checkFullWorkflowCache(bookId);
  if (fullCacheResult) {
    console.log(`[ORCHESTRATOR] Full workflow cache hit for book ${bookId}`);
    await restoreFromCache(bookId, fullCacheResult);
    return {
      workflowId: `cached_${bookId}`,
      estimatedCompletionTime: new Date().toISOString()
    };
  }

  // Step 2: Start the optimized pipeline
  const workflowId = `workflow_${bookId}_${Date.now()}`;
  
  // Enqueue the first job with high priority
  await supabase.rpc('enqueue_job', {
    p_book_id: bookId,
    p_job_type: 'extract_text',
    p_input_data: {
      workflow_id: workflowId,
      config: config,
      started_at: new Date().toISOString()
    },
    p_priority: config.priorityLevel
  });

  // Calculate estimated completion time based on book size and config
  const estimatedTime = await calculateEstimatedCompletionTime(bookId, config);

  console.log(`[ORCHESTRATOR] Enqueued extraction job for book ${bookId}, estimated completion: ${estimatedTime}`);

  return {
    workflowId,
    estimatedCompletionTime: estimatedTime
  };
}

async function checkFullWorkflowCache(bookId: string): Promise<any | null> {
  try {
    // Get book details for cache key generation
    const { data: book, error: bookError } = await supabase
      .from('books')
      .select('user_id, file_name, file_size, title')
      .eq('id', bookId)
      .single();

    if (bookError || !book) {
      return null;
    }

    // Generate cache key for the entire workflow
    const cacheKey = await generateWorkflowCacheKey(book.user_id, book.file_name, book.file_size, book.title);
    
    // Check if we have a complete workflow result cached
    const { data } = await supabase.rpc('get_cached_result', {
      p_cache_key: cacheKey,
      p_cache_type: 'full_workflow'
    });
    
    if (data) {
      console.log(`[ORCHESTRATOR] Found full workflow cache for key: ${cacheKey}`);
      return data;
    }

    return null;
  } catch (error) {
    console.warn('[ORCHESTRATOR] Cache lookup failed:', error);
    return null;
  }
}

async function restoreFromCache(bookId: string, cacheData: any): Promise<void> {
  try {
    await updateProgress(bookId, 'extracting_text', 100, 15, 'Restored text from cache');
    await updateProgress(bookId, 'detecting_chapters', 100, 30, 'Restored chapters from cache');
    await updateProgress(bookId, 'storing_chapters', 100, 50, 'Restored chapter storage from cache');

    // Restore chapters from cache
    if (cacheData.chapters && Array.isArray(cacheData.chapters)) {
      // Clear existing chapters
      await supabase.from('chapters').delete().eq('book_id', bookId);
      
      // Insert cached chapters
      const chaptersForDB = cacheData.chapters.map((ch: any, index: number) => ({
        book_id: bookId,
        chapter_number: index + 1,
        part_number: 1,
        title: ch.title,
        content: ch.content,
        summary: ch.summary || null,
        word_count: ch.wordCount || ch.word_count,
        reading_time_minutes: Math.ceil((ch.wordCount || ch.word_count) / 200),
        highlight_quotes: ch.keyQuotes || ch.highlight_quotes || [],
        enhancement_status: ch.summary ? 'completed' : 'pending',
        metadata: {
          ...ch.metadata,
          restored_from_cache: true,
          cache_restored_at: new Date().toISOString()
        }
      }));

      await supabase.from('chapters').insert(chaptersForDB);
    }

    // Update book status
    await supabase
      .from('books')
      .update({
        processing_status: 'completed',
        processing_completed_at: new Date().toISOString(),
        total_word_count: cacheData.totalWordCount,
        estimated_total_reading_time: cacheData.totalReadingTime,
        enhancement_status: cacheData.enhancementStatus || 'completed'
      })
      .eq('id', bookId);

    await updateProgress(bookId, 'completed', 100, 100, 'Workflow completed from cache');

    console.log(`[ORCHESTRATOR] Successfully restored book ${bookId} from cache`);

  } catch (error) {
    console.error('[ORCHESTRATOR] Failed to restore from cache:', error);
    throw error;
  }
}

async function calculateEstimatedCompletionTime(bookId: string, config: WorkflowConfig): Promise<string> {
  try {
    // Get book size for estimation
    const { data: book } = await supabase
      .from('books')
      .select('file_size, total_pages')
      .eq('id', bookId)
      .single();

    if (!book) {
      // Default estimation: 5 minutes
      return new Date(Date.now() + 5 * 60 * 1000).toISOString();
    }

    // Estimation algorithm based on file size and historical data
    let estimatedMinutes = 2; // Base time

    // Add time based on file size
    const fileSizeMB = (book.file_size || 1000000) / (1024 * 1024);
    estimatedMinutes += Math.ceil(fileSizeMB / 2); // 1 minute per 2MB

    // Add time based on pages if available
    if (book.total_pages) {
      estimatedMinutes += Math.ceil(book.total_pages / 50); // 1 minute per 50 pages
    }

    // Factor in enhancement (if enabled)
    if (config.enableAsyncEnhancement) {
      estimatedMinutes += Math.ceil(fileSizeMB * 0.5); // Additional time for AI enhancement
    }

    // Apply priority adjustments
    if (config.priorityLevel <= 3) {
      estimatedMinutes *= 0.8; // 20% faster for high priority
    } else if (config.priorityLevel >= 8) {
      estimatedMinutes *= 1.5; // 50% slower for low priority
    }

    // Cap the estimation
    estimatedMinutes = Math.min(Math.max(estimatedMinutes, 2), 30); // Between 2-30 minutes

    return new Date(Date.now() + estimatedMinutes * 60 * 1000).toISOString();

  } catch (error) {
    console.warn('[ORCHESTRATOR] Failed to calculate estimated time:', error);
    // Default to 10 minutes
    return new Date(Date.now() + 10 * 60 * 1000).toISOString();
  }
}

async function generateWorkflowCacheKey(userId: string, fileName: string, fileSize: number, title: string): Promise<string> {
  const data = `workflow_v2:${userId}:${fileName}:${fileSize}:${title}`;
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function updateProgress(
  bookId: string, 
  stage: string, 
  stageProgress: number, 
  overallProgress: number, 
  message: string,
  isError: boolean = false
): Promise<void> {
  try {
    await supabase.rpc('update_processing_progress', {
      p_book_id: bookId,
      p_stage: stage,
      p_stage_progress: stageProgress,
      p_overall_progress: overallProgress,
      p_current_step: isError ? 'ERROR' : 'orchestrating',
      p_message: message
    });
  } catch (error) {
    console.warn('[ORCHESTRATOR] Progress update failed:', error);
  }
}

// Export the function for other edge functions to use
export { generateWorkflowCacheKey };