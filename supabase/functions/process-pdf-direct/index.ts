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
  timeoutSeconds: 900
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

    console.log(`[DIRECT-PROCESSOR] Starting direct workflow for book ID: ${bookId}`);

    // Initialize workflow tracking
    await initializeWorkflow(bookId, workflowConfig);

    // Run the complete pipeline directly
    const result = await runDirectPipeline(bookId, workflowConfig);

    const processingTime = Math.round((Date.now() - startTime) / 1000);

    console.log(`[DIRECT-PROCESSOR] Workflow completed in ${processingTime}s for book ${bookId}`);

    return new Response(
      JSON.stringify({
        success: true,
        result,
        processingTime
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[DIRECT-PROCESSOR] Error:', error);
    
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
        workflow_version: 'v2_direct',
        processing_status: 'processing',
        processing_started_at: new Date().toISOString()
      })
      .eq('id', bookId);

    // Initialize progress tracking
    await updateProgress(bookId, 'uploading', 100, 5, 'Workflow initialized, starting text extraction...');

    console.log(`[DIRECT-PROCESSOR] Initialized workflow for book ${bookId} with config:`, config);

  } catch (error) {
    console.error('[DIRECT-PROCESSOR] Failed to initialize workflow:', error);
    throw error;
  }
}

async function runDirectPipeline(bookId: string, config: WorkflowConfig): Promise<any> {
  // Step 1: Check if we can use cached results for the entire workflow
  const fullCacheResult = await checkFullWorkflowCache(bookId);
  if (fullCacheResult) {
    console.log(`[DIRECT-PROCESSOR] Full workflow cache hit for book ${bookId}`);
    await restoreFromCache(bookId, fullCacheResult);
    return { cached: true, result: fullCacheResult };
  }

  // Step 2: Call extract-pdf-text function directly
  console.log(`[DIRECT-PROCESSOR] Calling extract-pdf-text function...`);
  const extractResult = await callFunction('extract-pdf-text', { bookId });
  
  if (!extractResult.success) {
    throw new Error(`Text extraction failed: ${extractResult.error}`);
  }

  // Step 3: Call detect-chapters function directly
  console.log(`[DIRECT-PROCESSOR] Calling detect-chapters function...`);
  const detectResult = await callFunction('detect-chapters', { 
    bookId, 
    text: extractResult.text,
    metadata: extractResult.metadata 
  });
  
  if (!detectResult.success) {
    throw new Error(`Chapter detection failed: ${detectResult.error}`);
  }

  // Step 4: Call store-chapters function directly
  console.log(`[DIRECT-PROCESSOR] Calling store-chapters function...`);
  const storeResult = await callFunction('store-chapters', { 
    bookId, 
    chapters: detectResult.chapters,
    bookTitle: await getBookTitle(bookId)
  });
  
  if (!storeResult.success) {
    throw new Error(`Chapter storage failed: ${storeResult.error}`);
  }

  // Step 5: Call enhance-chapters-async function if enabled
  if (config.enableAsyncEnhancement) {
    console.log(`[DIRECT-PROCESSOR] Calling enhance-chapters-async function...`);
    const enhanceResult = await callFunction('enhance-chapters-async', { 
      bookId, 
      chapters: storeResult.chapters || detectResult.chapters.slice(0, 5), // First batch
      batch_number: 1,
      total_batches: Math.ceil((detectResult.chapters?.length || 0) / 5)
    });
    
    if (!enhanceResult.success) {
      console.warn(`[DIRECT-PROCESSOR] Chapter enhancement failed: ${enhanceResult.error}`);
      // Don't fail the entire workflow for enhancement failures
    }
  }

  // Final progress update
  await updateProgress(bookId, 'completed', 100, 100, 'Processing completed successfully');

  return {
    cached: false,
    extractResult,
    detectResult,
    storeResult
  };
}

async function callFunction(functionName: string, data: any): Promise<any> {
  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/${functionName}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const result = await response.json();
    return result;
  } catch (error) {
    console.error(`[DIRECT-PROCESSOR] Error calling ${functionName}:`, error);
    return { success: false, error: error.message };
  }
}

async function getBookTitle(bookId: string): Promise<string> {
  const { data: book } = await supabase
    .from('books')
    .select('title')
    .eq('id', bookId)
    .single();
  
  return book?.title || 'Unknown Book';
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
      console.log(`[DIRECT-PROCESSOR] Found full workflow cache for key: ${cacheKey}`);
      return data;
    }

    return null;
  } catch (error) {
    console.warn('[DIRECT-PROCESSOR] Cache lookup failed:', error);
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

    console.log(`[DIRECT-PROCESSOR] Successfully restored book ${bookId} from cache`);

  } catch (error) {
    console.error('[DIRECT-PROCESSOR] Failed to restore from cache:', error);
    throw error;
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
      p_current_step: isError ? 'ERROR' : 'processing',
      p_message: message
    });
  } catch (error) {
    console.warn('[DIRECT-PROCESSOR] Progress update failed:', error);
  }
}