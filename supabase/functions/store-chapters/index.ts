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

interface Chapter {
  title: string;
  content: string;
  wordCount: number;
  startIndex: number;
  endIndex: number;
  detectionMethod: string;
  confidence: number;
  boundary_strength?: number;
}

interface StorageResult {
  storedChapters: number;
  totalWordCount: number;
  totalReadingTime: number;
  processingTime: number;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  let bookId: string | undefined;

  try {
    const { bookId: requestBookId, chapters, bookTitle } = await req.json();
    bookId = requestBookId;
    
    if (!bookId || !chapters || !Array.isArray(chapters)) {
      throw new Error('Book ID and chapters array are required');
    }

    console.log(`[STORE-CHAPTERS] Starting storage for book ID: ${bookId}, ${chapters.length} chapters`);

    await updateProgress(bookId, 'storing_chapters', 0, 35, 'Preparing chapter storage...');

    // Validate chapters data
    const validatedChapters = validateChapters(chapters);
    if (validatedChapters.length === 0) {
      throw new Error('No valid chapters found');
    }

    await updateProgress(bookId, 'storing_chapters', 10, 37, `Validated ${validatedChapters.length} chapters`);

    // Clear any existing chapters for this book (in case of reprocessing)
    await clearExistingChapters(bookId);

    await updateProgress(bookId, 'storing_chapters', 20, 39, 'Preparing batch insert...');

    // Prepare chapters for database insertion with batch optimization
    const chaptersForDB = await prepareChaptersForDB(bookId, validatedChapters);

    await updateProgress(bookId, 'storing_chapters', 40, 41, 'Inserting chapters in batches...');

    // Insert chapters in optimized batches
    const insertedChapters = await insertChaptersInBatches(chaptersForDB);

    await updateProgress(bookId, 'storing_chapters', 70, 43, 'Updating book metadata...');

    // Calculate aggregated statistics
    const stats = calculateBookStats(validatedChapters);

    // Update book with completion details
    await updateBookCompletionStatus(bookId, stats);

    await updateProgress(bookId, 'storing_chapters', 90, 45, 'Enqueuing enhancement jobs...');

    // Enqueue async enhancement jobs for each chapter
    await enqueueEnhancementJobs(bookId, insertedChapters);

    const processingTime = Math.round((Date.now() - startTime) / 1000);
    
    const result: StorageResult = {
      storedChapters: insertedChapters.length,
      totalWordCount: stats.totalWordCount,
      totalReadingTime: stats.totalReadingTime,
      processingTime
    };

    await updateProgress(bookId, 'storing_chapters', 100, 50, `Stored ${insertedChapters.length} chapters successfully`);

    console.log(`[STORE-CHAPTERS] Completed in ${processingTime}s: ${insertedChapters.length} chapters stored`);

    return new Response(
      JSON.stringify({
        success: true,
        ...result
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[STORE-CHAPTERS] Error:', error);
    
    const processingTime = Math.round((Date.now() - startTime) / 1000);
    
    if (bookId) {
      await updateProgress(bookId, 'storing_chapters', 0, 35, `Error: ${error.message}`, true);
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

function validateChapters(chapters: Chapter[]): Chapter[] {
  const validated: Chapter[] = [];
  
  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i];
    
    // Validate required fields
    if (!chapter.title || !chapter.content) {
      console.warn(`[STORE-CHAPTERS] Skipping chapter ${i + 1}: missing title or content`);
      continue;
    }
    
    // Validate content length
    if (chapter.content.length < 100) {
      console.warn(`[STORE-CHAPTERS] Skipping chapter ${i + 1}: content too short (${chapter.content.length} chars)`);
      continue;
    }
    
    // Validate word count
    const actualWordCount = chapter.content.split(/\s+/).length;
    if (actualWordCount < 50) {
      console.warn(`[STORE-CHAPTERS] Skipping chapter ${i + 1}: word count too low (${actualWordCount} words)`);
      continue;
    }
    
    // Ensure title is reasonable length
    const sanitizedTitle = chapter.title.length > 200 
      ? chapter.title.substring(0, 197) + '...'
      : chapter.title;
    
    validated.push({
      ...chapter,
      title: sanitizedTitle,
      wordCount: actualWordCount,
      // Ensure numeric fields are valid
      startIndex: Math.max(0, chapter.startIndex || 0),
      endIndex: Math.max(chapter.startIndex || 0, chapter.endIndex || chapter.content.length),
      confidence: Math.max(0, Math.min(1, chapter.confidence || 0.5))
    });
  }
  
  console.log(`[STORE-CHAPTERS] Validated ${validated.length} out of ${chapters.length} chapters`);
  return validated;
}

async function clearExistingChapters(bookId: string): Promise<void> {
  try {
    const { error } = await supabase
      .from('chapters')
      .delete()
      .eq('book_id', bookId);
    
    if (error) {
      console.warn(`[STORE-CHAPTERS] Failed to clear existing chapters: ${error.message}`);
    } else {
      console.log(`[STORE-CHAPTERS] Cleared existing chapters for book ${bookId}`);
    }
  } catch (error) {
    console.warn(`[STORE-CHAPTERS] Error clearing existing chapters:`, error);
  }
}

interface ChapterForDB {
  book_id: string;
  chapter_number: number;
  part_number: number;
  title: string;
  content: string;
  summary: string | null;
  word_count: number;
  reading_time_minutes: number;
  highlight_quotes: string[];
  enhancement_status: string;
  metadata: any;
}

async function prepareChaptersForDB(bookId: string, chapters: Chapter[]): Promise<ChapterForDB[]> {
  const chaptersForDB: ChapterForDB[] = [];
  
  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i];
    
    // Calculate reading time (average 200 words per minute)
    const readingTime = Math.ceil(chapter.wordCount / 200);
    
    // Extract potential highlight quotes (simple heuristic)
    const highlightQuotes = extractPotentialQuotes(chapter.content);
    
    chaptersForDB.push({
      book_id: bookId,
      chapter_number: i + 1,
      part_number: 1,
      title: chapter.title,
      content: chapter.content,
      summary: null, // Will be enhanced later
      word_count: chapter.wordCount,
      reading_time_minutes: readingTime,
      highlight_quotes: highlightQuotes,
      enhancement_status: 'pending',
      metadata: {
        detection_method: chapter.detectionMethod,
        detection_confidence: chapter.confidence,
        boundary_strength: chapter.boundary_strength,
        start_index: chapter.startIndex,
        end_index: chapter.endIndex,
        stored_at: new Date().toISOString(),
        processing_version: 'v2_optimized'
      }
    });
  }
  
  return chaptersForDB;
}

function extractPotentialQuotes(content: string): string[] {
  const quotes: string[] = [];
  
  // Look for quoted text
  const quotedMatches = content.match(/"([^"]{20,200})"/g);
  if (quotedMatches) {
    quotes.push(...quotedMatches.slice(0, 3).map(q => q.replace(/"/g, '')));
  }
  
  // Look for sentences that might be important (starting with certain phrases)
  const importantPhrases = [
    'The key is', 'It is important', 'Remember that', 'The main point',
    'In conclusion', 'To summarize', 'Most importantly', 'This means'
  ];
  
  const sentences = content.split(/[.!?]+/);
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (trimmed.length > 50 && trimmed.length < 300) {
      for (const phrase of importantPhrases) {
        if (trimmed.toLowerCase().includes(phrase.toLowerCase())) {
          quotes.push(trimmed);
          break;
        }
      }
    }
    
    if (quotes.length >= 5) break; // Limit to 5 quotes per chapter
  }
  
  return quotes.slice(0, 5); // Maximum 5 quotes
}

async function insertChaptersInBatches(chapters: ChapterForDB[]): Promise<ChapterForDB[]> {
  const batchSize = 10; // Optimal batch size for Supabase
  const insertedChapters: ChapterForDB[] = [];
  
  for (let i = 0; i < chapters.length; i += batchSize) {
    const batch = chapters.slice(i, i + batchSize);
    
    try {
      const { data, error } = await supabase
        .from('chapters')
        .insert(batch)
        .select('*');
      
      if (error) {
        console.error(`[STORE-CHAPTERS] Batch insert failed for chapters ${i + 1}-${i + batch.length}:`, error);
        
        // Try inserting individually as fallback
        for (const chapter of batch) {
          try {
            const { data: singleData, error: singleError } = await supabase
              .from('chapters')
              .insert([chapter])
              .select('*');
            
            if (singleError) {
              console.error(`[STORE-CHAPTERS] Individual insert failed for chapter ${chapter.chapter_number}:`, singleError);
            } else if (singleData) {
              insertedChapters.push(...singleData);
            }
          } catch (singleErr) {
            console.error(`[STORE-CHAPTERS] Exception during individual insert:`, singleErr);
          }
        }
      } else if (data) {
        insertedChapters.push(...data);
        console.log(`[STORE-CHAPTERS] Successfully inserted batch ${Math.floor(i / batchSize) + 1}: ${data.length} chapters`);
      }
      
      // Progress update for each batch
      const progress = Math.min(90, 40 + Math.round((i + batch.length) / chapters.length * 30));
      await updateProgress(chapters[0].book_id, 'storing_chapters', progress, 41 + Math.round(progress * 0.04), 
        `Inserted ${insertedChapters.length}/${chapters.length} chapters`);
      
    } catch (error) {
      console.error(`[STORE-CHAPTERS] Exception during batch insert:`, error);
    }
    
    // Small delay between batches to avoid overwhelming the database
    if (i + batchSize < chapters.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  console.log(`[STORE-CHAPTERS] Total chapters inserted: ${insertedChapters.length}/${chapters.length}`);
  return insertedChapters;
}

interface BookStats {
  totalWordCount: number;
  totalReadingTime: number;
  averageWordsPerChapter: number;
  chapterCount: number;
}

function calculateBookStats(chapters: Chapter[]): BookStats {
  const totalWordCount = chapters.reduce((sum, ch) => sum + ch.wordCount, 0);
  const totalReadingTime = chapters.reduce((sum, ch) => sum + Math.ceil(ch.wordCount / 200), 0);
  
  return {
    totalWordCount,
    totalReadingTime,
    averageWordsPerChapter: Math.round(totalWordCount / chapters.length),
    chapterCount: chapters.length
  };
}

async function updateBookCompletionStatus(bookId: string, stats: BookStats): Promise<void> {
  try {
    const { error } = await supabase
      .from('books')
      .update({
        processing_status: 'completed',
        processing_completed_at: new Date().toISOString(),
        total_word_count: stats.totalWordCount,
        estimated_total_reading_time: stats.totalReadingTime,
        enhancement_status: 'pending' // Enhancement will happen async
      })
      .eq('id', bookId);
    
    if (error) {
      console.error(`[STORE-CHAPTERS] Failed to update book completion status:`, error);
    } else {
      console.log(`[STORE-CHAPTERS] Updated book ${bookId} with completion status`);
    }
  } catch (error) {
    console.error(`[STORE-CHAPTERS] Exception updating book status:`, error);
  }
}

async function enqueueEnhancementJobs(bookId: string, chapters: ChapterForDB[]): Promise<void> {
  try {
    // Group chapters into batches for efficient AI processing
    const enhancementBatchSize = 5; // Process 5 chapters at a time
    const batches: ChapterForDB[][] = [];
    
    for (let i = 0; i < chapters.length; i += enhancementBatchSize) {
      batches.push(chapters.slice(i, i + enhancementBatchSize));
    }
    
    // Enqueue enhancement jobs with staggered priorities
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const priority = 5 + i; // Lower priority for later batches (higher number = lower priority)
      
      await supabase.rpc('enqueue_job', {
        p_book_id: bookId,
        p_job_type: 'enhance_chapters',
        p_input_data: {
          chapters: batch.map(ch => ({
            id: ch.book_id, // Will be replaced with actual ID after insert
            chapter_number: ch.chapter_number,
            title: ch.title,
            content: ch.content,
            word_count: ch.word_count
          })),
          batch_number: i + 1,
          total_batches: batches.length
        },
        p_priority: Math.min(priority, 10) // Cap at priority 10
      });
    }
    
    console.log(`[STORE-CHAPTERS] Enqueued ${batches.length} enhancement job batches for book ${bookId}`);
    
  } catch (error) {
    console.error(`[STORE-CHAPTERS] Failed to enqueue enhancement jobs:`, error);
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
      p_current_step: isError ? 'ERROR' : 'storing',
      p_message: message
    });
  } catch (error) {
    console.warn('[STORE-CHAPTERS] Progress update failed:', error);
  }
}