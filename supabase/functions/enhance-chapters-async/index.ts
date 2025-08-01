import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const openAIApiKey = Deno.env.get('OPENAI_API_KEY');
const supabase = createClient(supabaseUrl, supabaseKey);

interface ChapterData {
  id: string;
  chapter_number: number;
  title: string;
  content: string;
  word_count: number;
}

interface SummaryResult {
  summary: string;
  processingTime: number;
  model: string;
}

interface BatchResult {
  processedChapters: number;
  successfulSummaries: number;
  failedSummaries: number;
  totalProcessingTime: number;
  rateLimitDelays: number;
}

// Optimized rate limiting for summary-only processing
const RATE_LIMIT = {
  requestsPerMinute: 20, // Increased since we're doing less per request
  requestsPerHour: 300,
  maxConcurrentRequests: 5, // More concurrent for faster processing
  baseDelay: 500, // Reduced delay since requests are lighter
  backoffMultiplier: 2,
  maxRetries: 3
};

let activeRequests = 0;
let requestQueue: (() => Promise<any>)[] = [];
let lastRequestTime = 0;
let requestCounts = {
  minute: { count: 0, resetTime: Date.now() + 60000 },
  hour: { count: 0, resetTime: Date.now() + 3600000 }
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  let bookId: string | undefined;

  try {
    const { bookId: requestBookId, chapters, batch_number, total_batches } = await req.json();
    bookId = requestBookId;
    
    if (!bookId || !chapters || !Array.isArray(chapters)) {
      throw new Error('Book ID and chapters array are required');
    }

    if (!openAIApiKey) {
      console.log('[ENHANCE-CHAPTERS] OpenAI API key not found, skipping enhancement');
      return new Response(
        JSON.stringify({
          success: true,
          skipped: true,
          reason: 'No OpenAI API key configured'
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[ENHANCE-CHAPTERS] Starting summary generation for book ID: ${bookId}, batch ${batch_number}/${total_batches}, ${chapters.length} chapters`);

    const stage = 'generating_summaries';
    const baseProgress = 50 + (batch_number - 1) * (40 / total_batches); // 50-90% overall progress
    
    await updateProgress(bookId, stage, 0, baseProgress, 
      `Generating summaries for batch ${batch_number}/${total_batches}...`);

    // Get book details for context
    const { data: book, error: bookError } = await supabase
      .from('books')
      .select('title, author, genre')
      .eq('id', bookId)
      .single();

    if (bookError || !book) {
      throw new Error('Book not found');
    }

    // Get actual chapter IDs from database
    const chapterData = await getChapterDataFromDB(bookId, chapters);
    
    if (chapterData.length === 0) {
      throw new Error('No chapters found in database');
    }

    await updateProgress(bookId, stage, 10, baseProgress + 2, 
      `Found ${chapterData.length} chapters to summarize`);

    // Process chapters with optimized rate limiting
    const batchResult = await generateSummariesWithRateLimit(chapterData, book, bookId, batch_number, total_batches);

    const overallProgress = Math.min(90, baseProgress + (40 / total_batches));
    await updateProgress(bookId, stage, 100, overallProgress,
      `Batch ${batch_number}/${total_batches} complete: ${batchResult.successfulSummaries}/${batchResult.processedChapters} summarized`);

    // Update book enhancement status if this is the last batch
    if (batch_number === total_batches) {
      await updateBookEnhancementStatus(bookId);
      await updateProgress(bookId, 'completed', 100, 100, 'All summaries generated successfully');
    }

    const processingTime = Math.round((Date.now() - startTime) / 1000);

    console.log(`[ENHANCE-CHAPTERS] Batch ${batch_number} completed in ${processingTime}s: ${batchResult.successfulSummaries}/${batchResult.processedChapters} chapters summarized`);

    return new Response(
      JSON.stringify({
        success: true,
        ...batchResult,
        batchNumber: batch_number,
        totalBatches: total_batches,
        processingTime
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[ENHANCE-CHAPTERS] Error:', error);
    
    const processingTime = Math.round((Date.now() - startTime) / 1000);
    
    if (bookId) {
      await updateProgress(bookId, 'generating_summaries', 0, 50, `Error: ${error.message}`, true);
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

async function getChapterDataFromDB(bookId: string, chapters: ChapterData[]): Promise<ChapterData[]> {
  try {
    const chapterNumbers = chapters.map(ch => ch.chapter_number);
    
    // Only get chapters that don't already have summaries
    const { data, error } = await supabase
      .from('chapters')
      .select('id, chapter_number, title, content, word_count')
      .eq('book_id', bookId)
      .in('chapter_number', chapterNumbers)
      .is('summary', null) // Only chapters without summaries
      .order('chapter_number');
    
    if (error) {
      throw new Error(`Failed to fetch chapters: ${error.message}`);
    }
    
    return data || [];
  } catch (error) {
    console.error('[ENHANCE-CHAPTERS] Error fetching chapter data:', error);
    throw error;
  }
}

async function generateSummariesWithRateLimit(
  chapters: ChapterData[], 
  book: any, 
  bookId: string,
  batchNumber: number,
  totalBatches: number
): Promise<BatchResult> {
  const results: BatchResult = {
    processedChapters: 0,
    successfulSummaries: 0,
    failedSummaries: 0,
    totalProcessingTime: 0,
    rateLimitDelays: 0
  };

  const stage = 'generating_summaries';
  const baseProgress = 50 + (batchNumber - 1) * (40 / totalBatches);

  // Process multiple chapters concurrently for better performance
  const concurrentBatches = [];
  const batchSize = Math.min(3, chapters.length); // Process 3 at a time max
  
  for (let i = 0; i < chapters.length; i += batchSize) {
    const batch = chapters.slice(i, i + batchSize);
    concurrentBatches.push(batch);
  }

  for (let batchIndex = 0; batchIndex < concurrentBatches.length; batchIndex++) {
    const batch = concurrentBatches[batchIndex];
    
    // Process batch concurrently
    const batchPromises = batch.map(async (chapter, chapterIndex) => {
      const globalIndex = batchIndex * batchSize + chapterIndex;
      
      try {
        const chapterStartTime = Date.now();
        
        // Update progress for this chapter
        const chapterProgress = 20 + Math.round((globalIndex / chapters.length) * 70); // 20-90% of stage
        const overallProgress = baseProgress + (chapterProgress / 100) * (40 / totalBatches);
        
        await updateProgress(bookId, stage, chapterProgress, overallProgress,
          `Summarizing chapter ${chapter.chapter_number}: "${chapter.title.substring(0, 50)}..."`);

        // Wait for rate limit compliance
        await waitForRateLimit();

        // Generate the summary
        const summaryResult = await generateChapterSummary(chapter, book);
        
        if (summaryResult) {
          // Update the chapter in the database
          await updateChapterSummaryInDB(chapter.id, summaryResult);
          results.successfulSummaries++;
          
          console.log(`[ENHANCE-CHAPTERS] Generated summary for chapter ${chapter.chapter_number}: ${summaryResult.summary.length} chars`);
        } else {
          results.failedSummaries++;
          console.warn(`[ENHANCE-CHAPTERS] Failed to generate summary for chapter ${chapter.chapter_number}`);
        }
        
        results.processedChapters++;
        results.totalProcessingTime += Date.now() - chapterStartTime;
        
      } catch (error) {
        console.error(`[ENHANCE-CHAPTERS] Error summarizing chapter ${chapter.chapter_number}:`, error);
        results.failedSummaries++;
        results.processedChapters++;
        
        // Mark chapter as failed in database
        await markChapterSummaryFailed(chapter.id, error.message);
      }
    });

    // Wait for this batch to complete before moving to next
    await Promise.all(batchPromises);
    
    // Small delay between batches
    if (batchIndex < concurrentBatches.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      results.rateLimitDelays++;
    }
  }

  return results;
}

async function waitForRateLimit(): Promise<void> {
  // Reset counters if time windows have passed
  const now = Date.now();
  
  if (now >= requestCounts.minute.resetTime) {
    requestCounts.minute.count = 0;
    requestCounts.minute.resetTime = now + 60000;
  }
  
  if (now >= requestCounts.hour.resetTime) {
    requestCounts.hour.count = 0;
    requestCounts.hour.resetTime = now + 3600000;
  }

  // Wait for concurrent request limit
  while (activeRequests >= RATE_LIMIT.maxConcurrentRequests) {
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  // Wait for rate limits
  if (requestCounts.minute.count >= RATE_LIMIT.requestsPerMinute) {
    const waitTime = requestCounts.minute.resetTime - now;
    console.log(`[ENHANCE-CHAPTERS] Rate limit reached, waiting ${waitTime}ms`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }

  if (requestCounts.hour.count >= RATE_LIMIT.requestsPerHour) {
    const waitTime = requestCounts.hour.resetTime - now;
    console.log(`[ENHANCE-CHAPTERS] Hourly rate limit reached, waiting ${waitTime}ms`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }

  // Ensure minimum delay between requests
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < RATE_LIMIT.baseDelay) {
    await new Promise(resolve => setTimeout(resolve, RATE_LIMIT.baseDelay - timeSinceLastRequest));
  }

  // Update counters
  activeRequests++;
  requestCounts.minute.count++;
  requestCounts.hour.count++;
  lastRequestTime = Date.now();
}

async function generateChapterSummary(chapter: ChapterData, book: any): Promise<SummaryResult | null> {
  const startTime = Date.now();
  let retryCount = 0;

  while (retryCount <= RATE_LIMIT.maxRetries) {
    try {
      // Create optimized prompt for summary-only generation
      const prompt = createSummaryPrompt(chapter, book);

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openAIApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: 'You are an expert book summarizer. Generate concise 100-300 word summaries that capture key points and insights. Always respond with valid JSON only.'
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          temperature: 0.1, // Even lower temperature for faster, more consistent summaries
          max_tokens: 400, // Reduced token limit for 100-300 word summaries
          response_format: { type: "json_object" } // Ensure JSON response
        }),
      });

      if (!response.ok) {
        if (response.status === 429) {
          // Rate limited - exponential backoff
          const backoffDelay = RATE_LIMIT.baseDelay * Math.pow(RATE_LIMIT.backoffMultiplier, retryCount);
          console.log(`[ENHANCE-CHAPTERS] Rate limited, backing off for ${backoffDelay}ms`);
          await new Promise(resolve => setTimeout(resolve, backoffDelay));
          retryCount++;
          continue;
        } else if (response.status >= 500) {
          // Server error - retry
          retryCount++;
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        } else {
          throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
        }
      }

      const data = await response.json();
      const aiResponse = data.choices[0].message.content;
      
      try {
        const result = JSON.parse(aiResponse);
        const processingTime = Date.now() - startTime;
        
        // Validate the summary
        if (!result.summary) {
          throw new Error('Invalid summary format: missing summary field');
        }

        // Ensure summary is within our target range (100-300 words)
        const wordCount = result.summary.split(/\s+/).length;
        if (wordCount < 50 || wordCount > 350) {
          console.warn(`[ENHANCE-CHAPTERS] Summary word count (${wordCount}) outside target range for chapter ${chapter.chapter_number}`);
        }
        
        return {
          summary: result.summary.substring(0, 1000), // Hard limit to prevent DB issues
          processingTime: Math.round(processingTime / 1000),
          model: 'gpt-4o-mini'
        };
        
      } catch (parseError) {
        console.error('[ENHANCE-CHAPTERS] Failed to parse AI response:', parseError);
        // Fallback to basic summary
        return {
          summary: `Chapter ${chapter.chapter_number} from ${book.title}. This chapter contains approximately ${chapter.word_count} words and covers key topics from the book.`,
          processingTime: Math.round((Date.now() - startTime) / 1000),
          model: 'fallback'
        };
      }

    } catch (error) {
      console.error(`[ENHANCE-CHAPTERS] Summary generation attempt ${retryCount + 1} failed:`, error);
      retryCount++;
      
      if (retryCount > RATE_LIMIT.maxRetries) {
        console.error(`[ENHANCE-CHAPTERS] All retry attempts failed for chapter ${chapter.chapter_number}`);
        return null;
      }
      
      // Exponential backoff for retries
      const backoffDelay = RATE_LIMIT.baseDelay * Math.pow(RATE_LIMIT.backoffMultiplier, retryCount - 1);
      await new Promise(resolve => setTimeout(resolve, backoffDelay));
    } finally {
      activeRequests--;
    }
  }

  return null;
}

function createSummaryPrompt(chapter: ChapterData, book: any): string {
  // Aggressive content truncation for faster processing
  const maxContentLength = 4000; // Even smaller context for speed
  const content = chapter.content.length > maxContentLength 
    ? chapter.content.substring(0, maxContentLength) + '...[truncated]'
    : chapter.content;

  return `Summarize this chapter in 100-300 words. Focus on key points and insights.

BOOK: "${book.title}"
CHAPTER: ${chapter.chapter_number} - "${chapter.title}"

CONTENT:
${content}

Respond with JSON:
{
  "summary": "Your concise chapter summary here..."
}`;
}

async function updateChapterSummaryInDB(chapterId: string, summaryResult: SummaryResult): Promise<void> {
  try {
    const { error } = await supabase
      .from('chapters')
      .update({
        summary: summaryResult.summary,
        enhancement_status: 'completed',
        enhancement_completed_at: new Date().toISOString(),
        ai_model_used: summaryResult.model,
        processing_metrics: {
          summarized_at: new Date().toISOString(),
          model: summaryResult.model
        }
      })
      .eq('id', chapterId);

    if (error) {
      throw new Error(`Database update failed: ${error.message}`);
    }

  } catch (error) {
    console.error('[ENHANCE-CHAPTERS] Failed to update chapter summary in database:', error);
    throw error;
  }
}

async function markChapterSummaryFailed(chapterId: string, errorMessage: string): Promise<void> {
  try {
    await supabase
      .from('chapters')
      .update({
        enhancement_status: 'failed',
        processing_metrics: {
          failed_at: new Date().toISOString(),
          error: errorMessage
        }
      })
      .eq('id', chapterId);
  } catch (error) {
    console.warn('[ENHANCE-CHAPTERS] Failed to mark chapter summary as failed:', error);
  }
}

async function updateBookEnhancementStatus(bookId: string): Promise<void> {
  try {
    // Get count of enhancement status
    const { data: statusCounts } = await supabase
      .from('chapters')
      .select('enhancement_status')
      .eq('book_id', bookId);

    if (!statusCounts) return;

    const counts = statusCounts.reduce((acc: any, chapter: any) => {
      acc[chapter.enhancement_status] = (acc[chapter.enhancement_status] || 0) + 1;
      return acc;
    }, {});

    const totalChapters = statusCounts.length;
    const completed = counts.completed || 0;
    const failed = counts.failed || 0;

    let overallStatus: string;
    if (completed === totalChapters) {
      overallStatus = 'completed';
    } else if (completed + failed === totalChapters) {
      overallStatus = completed > failed ? 'completed' : 'failed';
    } else {
      overallStatus = 'processing';
    }

    await supabase
      .from('books')
      .update({
        enhancement_status: overallStatus
      })
      .eq('id', bookId);

    console.log(`[ENHANCE-CHAPTERS] Updated book ${bookId} enhancement status: ${overallStatus} (${completed}/${totalChapters} chapters summarized)`);

  } catch (error) {
    console.error('[ENHANCE-CHAPTERS] Failed to update book enhancement status:', error);
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
      p_current_step: isError ? 'ERROR' : 'summarizing',
      p_message: message
    });
  } catch (error) {
    console.warn('[ENHANCE-CHAPTERS] Progress update failed:', error);
  }
}