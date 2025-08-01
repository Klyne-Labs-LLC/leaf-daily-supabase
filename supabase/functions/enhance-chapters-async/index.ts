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

interface EnhancementResult {
  title: string;
  content: string;
  summary: string;
  keyQuotes: string[];
  processingTime: number;
  model: string;
}

interface BatchResult {
  processedChapters: number;
  successfulEnhancements: number;
  failedEnhancements: number;
  totalProcessingTime: number;
  rateLimitDelays: number;
}

// Rate limiting configuration
const RATE_LIMIT = {
  requestsPerMinute: 15, // Conservative rate limit for OpenAI
  requestsPerHour: 200,
  maxConcurrentRequests: 3,
  baseDelay: 1000, // 1 second base delay between requests
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

    console.log(`[ENHANCE-CHAPTERS] Starting enhancement for book ID: ${bookId}, batch ${batch_number}/${total_batches}, ${chapters.length} chapters`);

    const stage = 'enhancing_chapters';
    const baseProgress = 50 + (batch_number - 1) * (40 / total_batches); // 50-90% overall progress
    
    await updateProgress(bookId, stage, 0, baseProgress, 
      `Processing enhancement batch ${batch_number}/${total_batches}...`);

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
      `Found ${chapterData.length} chapters to enhance`);

    // Process chapters with rate limiting and batching
    const batchResult = await enhanceChaptersWithRateLimit(chapterData, book, bookId, batch_number, total_batches);

    const overallProgress = Math.min(90, baseProgress + (40 / total_batches));
    await updateProgress(bookId, stage, 100, overallProgress,
      `Batch ${batch_number}/${total_batches} complete: ${batchResult.successfulEnhancements}/${batchResult.processedChapters} enhanced`);

    // Update book enhancement status if this is the last batch
    if (batch_number === total_batches) {
      await updateBookEnhancementStatus(bookId);
      await updateProgress(bookId, 'completed', 100, 100, 'All processing completed successfully');
    }

    const processingTime = Math.round((Date.now() - startTime) / 1000);

    console.log(`[ENHANCE-CHAPTERS] Batch ${batch_number} completed in ${processingTime}s: ${batchResult.successfulEnhancements}/${batchResult.processedChapters} chapters enhanced`);

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
      await updateProgress(bookId, 'enhancing_chapters', 0, 50, `Error: ${error.message}`, true);
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
    
    const { data, error } = await supabase
      .from('chapters')
      .select('id, chapter_number, title, content, word_count')
      .eq('book_id', bookId)
      .in('chapter_number', chapterNumbers)
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

async function enhanceChaptersWithRateLimit(
  chapters: ChapterData[], 
  book: any, 
  bookId: string,
  batchNumber: number,
  totalBatches: number
): Promise<BatchResult> {
  const results: BatchResult = {
    processedChapters: 0,
    successfulEnhancements: 0,
    failedEnhancements: 0,
    totalProcessingTime: 0,
    rateLimitDelays: 0
  };

  const stage = 'enhancing_chapters';
  const baseProgress = 50 + (batchNumber - 1) * (40 / totalBatches);

  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i];
    
    try {
      const chapterStartTime = Date.now();
      
      // Update progress for this chapter
      const chapterProgress = 20 + Math.round((i / chapters.length) * 70); // 20-90% of stage
      const overallProgress = baseProgress + (chapterProgress / 100) * (40 / totalBatches);
      
      await updateProgress(bookId, stage, chapterProgress, overallProgress,
        `Enhancing chapter ${chapter.chapter_number}: "${chapter.title.substring(0, 50)}..."`);

      // Wait for rate limit compliance
      await waitForRateLimit();

      // Enhance the chapter
      const enhancement = await enhanceChapterWithAI(chapter, book, bookId);
      
      if (enhancement) {
        // Update the chapter in the database
        await updateChapterInDB(chapter.id, enhancement);
        results.successfulEnhancements++;
        
        console.log(`[ENHANCE-CHAPTERS] Enhanced chapter ${chapter.chapter_number}: ${enhancement.title}`);
      } else {
        results.failedEnhancements++;
        console.warn(`[ENHANCE-CHAPTERS] Failed to enhance chapter ${chapter.chapter_number}`);
      }
      
      results.processedChapters++;
      results.totalProcessingTime += Date.now() - chapterStartTime;
      
    } catch (error) {
      console.error(`[ENHANCE-CHAPTERS] Error enhancing chapter ${chapter.chapter_number}:`, error);
      results.failedEnhancements++;
      results.processedChapters++;
      
      // Mark chapter as failed in database
      await markChapterEnhancementFailed(chapter.id, error.message);
    }
    
    // Progressive delay to avoid overwhelming the API
    if (i < chapters.length - 1) {
      const delay = RATE_LIMIT.baseDelay + (i * 200); // Increasing delay
      await new Promise(resolve => setTimeout(resolve, delay));
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
    await new Promise(resolve => setTimeout(resolve, 500));
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

async function enhanceChapterWithAI(chapter: ChapterData, book: any, bookId: string): Promise<EnhancementResult | null> {
  const startTime = Date.now();
  let retryCount = 0;

  while (retryCount <= RATE_LIMIT.maxRetries) {
    try {
      // Create optimized prompt for chapter enhancement
      const prompt = createEnhancementPrompt(chapter, book);

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
              content: 'You are an expert editor who transforms raw PDF text into clean, readable content with summaries and key insights. Always respond with valid JSON only.'
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          temperature: 0.3,
          max_tokens: 3000, // Optimized for speed while maintaining quality
          timeout: 30000 // 30 second timeout
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
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        } else {
          throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
        }
      }

      const data = await response.json();
      const aiResponse = data.choices[0].message.content;
      
      try {
        const enhancement = JSON.parse(aiResponse);
        const processingTime = Date.now() - startTime;
        
        // Validate the enhancement
        if (!enhancement.title || !enhancement.content || !enhancement.summary) {
          throw new Error('Invalid enhancement format: missing required fields');
        }
        
        return {
          title: enhancement.title.substring(0, 200), // Ensure reasonable length
          content: enhancement.content,
          summary: enhancement.summary.substring(0, 500), // Limit summary length
          keyQuotes: Array.isArray(enhancement.keyQuotes) ? enhancement.keyQuotes.slice(0, 5) : [],
          processingTime: Math.round(processingTime / 1000),
          model: 'gpt-4o-mini'
        };
        
      } catch (parseError) {
        console.error('[ENHANCE-CHAPTERS] Failed to parse AI response:', parseError);
        // Fallback to basic enhancement
        return {
          title: chapter.title,
          content: chapter.content,
          summary: `Chapter ${chapter.chapter_number} from ${book.title}. AI enhancement parsing failed.`,
          keyQuotes: [],
          processingTime: Math.round((Date.now() - startTime) / 1000),
          model: 'fallback'
        };
      }

    } catch (error) {
      console.error(`[ENHANCE-CHAPTERS] Enhancement attempt ${retryCount + 1} failed:`, error);
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

function createEnhancementPrompt(chapter: ChapterData, book: any): string {
  // Truncate content if too long to fit in context window
  const maxContentLength = 8000; // Conservative limit for GPT-4o-mini context
  const content = chapter.content.length > maxContentLength 
    ? chapter.content.substring(0, maxContentLength) + '...[content truncated]'
    : chapter.content;

  return `Transform this raw PDF chapter into clean, readable content with summary and key insights.

BOOK: "${book.title}" by ${book.author || 'Unknown Author'}
CHAPTER: ${chapter.chapter_number} - "${chapter.title}"
GENRE: ${book.genre || 'Unknown'}
WORD COUNT: ${chapter.word_count}

TASKS:
1. Clean and reformat the content (fix spacing, merge broken sentences, proper paragraphs)
2. Create an engaging chapter title (max 150 characters)
3. Write a concise summary (100-300 words) highlighting key points
4. Extract 3-5 important quotes or key statements

CONTENT:
${content}

Respond in this EXACT JSON format:
{
  "title": "Enhanced chapter title",
  "content": "Cleaned and formatted chapter content...",
  "summary": "Concise summary highlighting main points and takeaways...",
  "keyQuotes": ["Quote 1", "Quote 2", "Quote 3"]
}`;
}

async function updateChapterInDB(chapterId: string, enhancement: EnhancementResult): Promise<void> {
  try {
    const { error } = await supabase
      .from('chapters')
      .update({
        title: enhancement.title,
        content: enhancement.content,
        summary: enhancement.summary,
        highlight_quotes: enhancement.keyQuotes,
        enhancement_status: 'completed',
        enhancement_completed_at: new Date().toISOString(),
        ai_model_used: enhancement.model,
        processing_metrics: {
          enhancement_processing_time: enhancement.processingTime,
          model_used: enhancement.model,
          enhanced_at: new Date().toISOString()
        }
      })
      .eq('id', chapterId);

    if (error) {
      throw new Error(`Database update failed: ${error.message}`);
    }

  } catch (error) {
    console.error('[ENHANCE-CHAPTERS] Failed to update chapter in database:', error);
    throw error;
  }
}

async function markChapterEnhancementFailed(chapterId: string, errorMessage: string): Promise<void> {
  try {
    await supabase
      .from('chapters')
      .update({
        enhancement_status: 'failed',
        processing_metrics: {
          enhancement_error: errorMessage,
          failed_at: new Date().toISOString()
        }
      })
      .eq('id', chapterId);
  } catch (error) {
    console.warn('[ENHANCE-CHAPTERS] Failed to mark chapter as failed:', error);
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

    console.log(`[ENHANCE-CHAPTERS] Updated book ${bookId} enhancement status: ${overallStatus} (${completed}/${totalChapters} chapters enhanced)`);

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
      p_current_step: isError ? 'ERROR' : 'enhancing',
      p_message: message
    });
  } catch (error) {
    console.warn('[ENHANCE-CHAPTERS] Progress update failed:', error);
  }
}