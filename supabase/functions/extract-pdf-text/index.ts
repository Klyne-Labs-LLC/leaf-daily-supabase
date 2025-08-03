import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import { extractText } from 'https://esm.sh/unpdf@1.1.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Initialize Supabase client
const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseKey);

interface ExtractionResult {
  text: string;
  metadata: {
    totalPages: number;
    totalCharacters: number;
    totalWords: number;
    extractionMethod: string;
    processingTime: number;
    fileSize: number;
    textHash: string;
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  let bookId: string | undefined;

  try {
    const { bookId: requestBookId } = await req.json();
    bookId = requestBookId;
    
    if (!bookId) {
      throw new Error('Book ID is required');
    }

    console.log(`[EXTRACT-TEXT] Starting extraction for book ID: ${bookId}`);

    // Update progress: Starting
    await updateProgress(bookId, 'extracting_text', 0, 5, 'Initializing PDF extraction...');

    // Get book details
    const { data: book, error: bookError } = await supabase
      .from('books')
      .select('*')
      .eq('id', bookId)
      .single();

    if (bookError || !book) {
      throw new Error('Book not found');
    }

    // Update book status
    await supabase
      .from('books')
      .update({ 
        processing_status: 'processing',
        processing_started_at: new Date().toISOString()
      })
      .eq('id', bookId);

    // Check cache first
    const cacheKey = await generateCacheKey(book.user_id, book.file_name, book.file_size);
    const cachedResult = await checkCache(cacheKey, 'text_extraction');
    
    if (cachedResult) {
      console.log(`[EXTRACT-TEXT] Cache hit for ${cacheKey}`);
      await updateProgress(bookId, 'extracting_text', 100, 15, 'Text extracted from cache');
      
      // Enqueue next job
      await enqueueNextJob(bookId, 'detect_chapters', cachedResult);
      
      return new Response(
        JSON.stringify({
          success: true,
          cached: true,
          text: cachedResult.text, // Include the actual text for direct calls
          metadata: cachedResult.metadata
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    await updateProgress(bookId, 'extracting_text', 10, 7, 'Downloading PDF file...');

    // Download PDF with streaming optimization
    const { data: fileData, error: downloadError } = await supabase.storage
      .from('book-pdfs')
      .download(`${book.user_id}/${sanitizeFileName(book.file_name)}`);

    if (downloadError || !fileData) {
      throw new Error(`Failed to download PDF: ${downloadError?.message}`);
    }

    console.log(`[EXTRACT-TEXT] Downloaded PDF: ${fileData.size} bytes`);
    await updateProgress(bookId, 'extracting_text', 25, 10, `Downloaded ${Math.round(fileData.size / (1024 * 1024))}MB PDF file`);

    // Extract text with progress updates
    const extractionResult = await extractTextWithProgress(fileData, bookId);
    
    const processingTime = Math.round((Date.now() - startTime) / 1000);
    const result: ExtractionResult = {
      text: extractionResult.text,
      metadata: {
        totalPages: extractionResult.totalPages || 0,
        totalCharacters: extractionResult.text.length,
        totalWords: extractionResult.text.split(/\s+/).length,
        extractionMethod: 'unpdf_optimized',
        processingTime,
        fileSize: fileData.size,
        textHash: await hashText(extractionResult.text)
      }
    };

    await updateProgress(bookId, 'extracting_text', 90, 14, 'Caching extraction results...');

    // Cache the result
    await storeInCache(cacheKey, 'text_extraction', result, fileData.size, processingTime);

    await updateProgress(bookId, 'extracting_text', 100, 15, 'Text extraction completed');

    // Update book with extraction completion
    await supabase
      .from('books')
      .update({
        text_extraction_completed_at: new Date().toISOString(),
        total_pages: result.metadata.totalPages,
        total_word_count: result.metadata.totalWords
      })
      .eq('id', bookId);

    // Enqueue next job
    await enqueueNextJob(bookId, 'detect_chapters', result);

    console.log(`[EXTRACT-TEXT] Completed in ${processingTime}s: ${result.metadata.totalWords} words, ${result.metadata.totalPages} pages`);

    return new Response(
      JSON.stringify({
        success: true,
        cached: false,
        text: result.text, // Include the actual text for direct calls
        metadata: result.metadata
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[EXTRACT-TEXT] Error:', error);
    
    const processingTime = Math.round((Date.now() - startTime) / 1000);
    
    if (bookId) {
      await updateProgress(bookId, 'extracting_text', 0, 5, `Error: ${error.message}`, true);
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

async function extractTextWithProgress(fileData: Blob, bookId: string): Promise<{ text: string; totalPages?: number }> {
  try {
    await updateProgress(bookId, 'extracting_text', 30, 11, 'Processing PDF structure...');
    
    const arrayBuffer = await fileData.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    
    await updateProgress(bookId, 'extracting_text', 50, 12, 'Extracting text from pages...');
    
    // Extract with memory optimization
    const result = await extractText(uint8Array, {
      mergePages: true,
      disableCombineTextItems: false,
      // Add streaming support if available
      onProgress: (progress: number) => {
        const adjustedProgress = 50 + Math.round(progress * 0.3); // 50-80%
        updateProgress(bookId, 'extracting_text', adjustedProgress, 12 + Math.round(progress * 0.01), 
          `Extracting text... ${Math.round(progress)}%`).catch(console.error);
      }
    });
    
    if (!result.text || result.text.trim().length === 0) {
      throw new Error('No text could be extracted from PDF');
    }
    
    await updateProgress(bookId, 'extracting_text', 85, 13, 'Cleaning and optimizing text...');
    
    const cleanedText = cleanupExtractedText(result.text);
    
    return {
      text: cleanedText,
      totalPages: result.totalPages || estimatePages(cleanedText)
    };
    
  } catch (error) {
    console.error('[EXTRACT-TEXT] PDF extraction failed:', error);
    throw new Error(`Failed to extract text: ${error.message}`);
  }
}

function cleanupExtractedText(text: string): string {
  return text
    // Remove excessive whitespace
    .replace(/\s{3,}/g, '  ')
    // Remove page headers/footers patterns  
    .replace(/^\s*\d+\s*$/gm, '') // Standalone page numbers
    .replace(/^.*Page \d+ of \d+.*$/gim, '') // "Page X of Y"
    .replace(/^\s*Chapter \d+ Page \d+\s*$/gim, '') // "Chapter X Page Y"
    // Remove form feeds and normalize line breaks
    .replace(/\f/g, '\n\n')
    .replace(/\n{4,}/g, '\n\n\n')
    // Normalize spaces
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function estimatePages(text: string): number {
  // Rough estimation: 250 words per page
  const wordCount = text.split(/\s+/).length;
  return Math.ceil(wordCount / 250);
}

function sanitizeFileName(fileName: string): string {
  return fileName
    .replace(/[^\w\s.-]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_');
}

async function generateCacheKey(userId: string, fileName: string, fileSize: number): Promise<string> {
  const data = `${userId}:${fileName}:${fileSize}`;
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hashText(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function checkCache(cacheKey: string, cacheType: string): Promise<ExtractionResult | null> {
  try {
    const { data } = await supabase.rpc('get_cached_result', {
      p_cache_key: cacheKey,
      p_cache_type: cacheType
    });
    
    return data ? data as ExtractionResult : null;
  } catch (error) {
    console.warn('[EXTRACT-TEXT] Cache lookup failed:', error);
    return null;
  }
}

async function storeInCache(cacheKey: string, cacheType: string, result: ExtractionResult, fileSize: number, processingTime: number): Promise<void> {
  try {
    const inputHash = await hashText(JSON.stringify({ fileSize, cacheKey }));
    
    await supabase.rpc('store_cached_result', {
      p_cache_key: cacheKey,
      p_cache_type: cacheType,
      p_input_hash: inputHash,
      p_output_data: result,
      p_file_size: fileSize,
      p_processing_time_seconds: processingTime
    });
  } catch (error) {
    console.warn('[EXTRACT-TEXT] Cache storage failed:', error);
  }
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
      p_current_step: isError ? 'ERROR' : 'extracting',
      p_message: message
    });
  } catch (error) {
    console.warn('[EXTRACT-TEXT] Progress update failed:', error);
  }
}

async function enqueueNextJob(bookId: string, jobType: string, inputData: any): Promise<void> {
  try {
    await supabase.rpc('enqueue_job', {
      p_book_id: bookId,
      p_job_type: jobType,
      p_input_data: inputData,
      p_priority: 5
    });
    
    console.log(`[EXTRACT-TEXT] Enqueued ${jobType} job for book ${bookId}`);
  } catch (error) {
    console.error('[EXTRACT-TEXT] Failed to enqueue next job:', error);
  }
}