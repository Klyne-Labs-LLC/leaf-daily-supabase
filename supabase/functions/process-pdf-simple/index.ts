import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import { extractText } from 'https://esm.sh/unpdf@1.1.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const openAIApiKey = Deno.env.get('OPENAI_API_KEY');
const supabase = createClient(supabaseUrl, supabaseKey);

interface Chapter {
  title: string;
  content: string;
  wordCount: number;
  startIndex: number;
  endIndex: number;
  detectionMethod: string;
  confidence: number;
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

    console.log(`[SIMPLE-PROCESSOR] Starting processing for book ID: ${bookId}`);

    // Update book status to processing
    await supabase
      .from('books')
      .update({ 
        processing_status: 'processing',
        processing_started_at: new Date().toISOString(),
        workflow_version: 'v2_simple'
      })
      .eq('id', bookId);

    await updateProgress(bookId, 'uploading', 100, 5, 'Starting PDF processing...');

    // Get book details
    const { data: book, error: bookError } = await supabase
      .from('books')
      .select('*')
      .eq('id', bookId)
      .single();

    if (bookError || !book) {
      throw new Error('Book not found');
    }

    // Step 1: Extract text from PDF
    await updateProgress(bookId, 'extracting_text', 0, 10, 'Downloading PDF file...');
    
    const sanitizedFileName = book.file_name
      .replace(/[^\w\s.-]/g, '')
      .replace(/\s+/g, '_')
      .replace(/_{2,}/g, '_');
      
    const { data: fileData, error: downloadError } = await supabase.storage
      .from('book-pdfs')
      .download(`${book.user_id}/${sanitizedFileName}`);

    if (downloadError || !fileData) {
      throw new Error('Failed to download PDF file');
    }

    await updateProgress(bookId, 'extracting_text', 30, 12, 'Extracting text from PDF...');

    // Extract text using unpdf
    const arrayBuffer = await fileData.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    
    const extractionResult = await extractText(uint8Array, {
      mergePages: true,
      disableCombineTextItems: false
    });
    
    if (!extractionResult.text || extractionResult.text.trim().length === 0) {
      throw new Error('No text could be extracted from PDF');
    }

    const cleanedText = cleanupExtractedText(extractionResult.text);
    const wordCount = cleanedText.split(/\s+/).length;
    const totalPages = extractionResult.totalPages || Math.ceil(wordCount / 250);

    await updateProgress(bookId, 'extracting_text', 100, 15, `Extracted ${wordCount} words from ${totalPages} pages`);

    // Update book with extraction results
    await supabase
      .from('books')
      .update({
        total_pages: totalPages,
        total_word_count: wordCount,
        text_extraction_completed_at: new Date().toISOString()
      })
      .eq('id', bookId);

    // Step 2: Detect chapters
    await updateProgress(bookId, 'detecting_chapters', 0, 20, 'Starting chapter detection...');
    
    const chapters = await detectChapters(cleanedText, book.title, bookId);
    
    await updateProgress(bookId, 'detecting_chapters', 100, 30, `Detected ${chapters.length} chapters`);

    // Update book with detection completion
    await supabase
      .from('books')
      .update({
        chapter_detection_completed_at: new Date().toISOString()
      })
      .eq('id', bookId);

    // Step 3: Store chapters
    await updateProgress(bookId, 'storing_chapters', 0, 35, 'Storing chapters in database...');
    
    await storeChapters(bookId, chapters);
    
    await updateProgress(bookId, 'storing_chapters', 100, 50, `Stored ${chapters.length} chapters`);

    // Step 4: Generate AI summaries (optional)
    if (openAIApiKey && chapters.length > 0) {
      await updateProgress(bookId, 'enhancing_chapters', 0, 60, 'Generating AI summaries...');
      
      await generateSummaries(bookId, chapters.slice(0, 5)); // First 5 chapters only
      
      await updateProgress(bookId, 'enhancing_chapters', 100, 90, 'AI summaries generated');
    }

    // Final completion
    const totalReadingTime = Math.ceil(wordCount / 200);
    
    await supabase
      .from('books')
      .update({
        processing_status: 'completed',
        processing_completed_at: new Date().toISOString(),
        estimated_total_reading_time: totalReadingTime,
        enhancement_status: openAIApiKey ? 'completed' : 'skipped'
      })
      .eq('id', bookId);

    await updateProgress(bookId, 'completed', 100, 100, 'Processing completed successfully');

    const processingTime = Math.round((Date.now() - startTime) / 1000);

    console.log(`[SIMPLE-PROCESSOR] Completed in ${processingTime}s: ${chapters.length} chapters, ${wordCount} words`);

    return new Response(
      JSON.stringify({
        success: true,
        processingTime,
        chapters: chapters.length,
        words: wordCount,
        pages: totalPages
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('[SIMPLE-PROCESSOR] Error:', error);
    
    const processingTime = Math.round((Date.now() - startTime) / 1000);
    
    if (bookId) {
      await updateProgress(bookId, 'failed', 0, 0, `Error: ${error.message}`, true);
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

function cleanupExtractedText(text: string): string {
  return text
    .replace(/\s{3,}/g, '  ')
    .replace(/^\s*\d+\s*$/gm, '')
    .replace(/^.*Page \d+ of \d+.*$/gim, '')
    .replace(/^\s*Chapter \d+ Page \d+\s*$/gim, '')
    .replace(/\f/g, '\n\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

async function detectChapters(text: string, bookTitle: string, bookId: string): Promise<Chapter[]> {
  await updateProgress(bookId, 'detecting_chapters', 20, 22, 'Analyzing chapter patterns...');
  
  const chapters: Chapter[] = [];
  
  // Simple pattern-based detection
  const chapterPattern = /^(?:Chapter|CHAPTER)\s+(\d+|[IVXLCDM]+|One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten)(?:\s*[:\.\-]\s*(.*))?$/gim;
  const lines = text.split('\n');
  const matches: Array<{index: number, title: string, lineNum: number}> = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length < 3 || line.length > 150) continue;
    
    chapterPattern.lastIndex = 0;
    const match = chapterPattern.exec(line);
    if (match) {
      const title = match[2] ? `Chapter ${match[1]}: ${match[2]}` : `Chapter ${match[1]}`;
      const textIndex = text.indexOf(line);
      if (textIndex !== -1) {
        matches.push({
          index: textIndex,
          title: title.trim(),
          lineNum: i
        });
      }
    }
  }
  
  await updateProgress(bookId, 'detecting_chapters', 60, 26, `Found ${matches.length} chapter markers`);
  
  if (matches.length >= 2) {
    // Create chapters from pattern matches
    matches.sort((a, b) => a.index - b.index);
    
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];
      const nextMatch = matches[i + 1];
      
      const startIndex = match.index;
      const endIndex = nextMatch ? nextMatch.index : text.length;
      const content = text.substring(startIndex, endIndex).trim();
      
      if (content.length > 500) {
        chapters.push({
          title: match.title,
          content: content,
          wordCount: content.split(/\s+/).length,
          startIndex: startIndex,
          endIndex: endIndex,
          detectionMethod: 'pattern_based',
          confidence: 0.9
        });
      }
    }
  } else {
    // Fallback to content-based chunking
    await updateProgress(bookId, 'detecting_chapters', 80, 28, 'Using content-based chapter detection...');
    
    const targetWordsPerChapter = 2500;
    const words = text.split(/\s+/);
    
    for (let i = 0; i < words.length; i += targetWordsPerChapter) {
      const chapterWords = words.slice(i, i + targetWordsPerChapter);
      const content = chapterWords.join(' ');
      
      if (content.trim().length > 100) {
        const chapterNum = Math.floor(i / targetWordsPerChapter) + 1;
        chapters.push({
          title: `${bookTitle} - Chapter ${chapterNum}`,
          content: content,
          wordCount: chapterWords.length,
          startIndex: i,
          endIndex: i + chapterWords.length,
          detectionMethod: 'content_based',
          confidence: 0.7
        });
      }
    }
  }
  
  return chapters;
}

async function storeChapters(bookId: string, chapters: Chapter[]): Promise<void> {
  // Clear existing chapters
  await supabase.from('chapters').delete().eq('book_id', bookId);
  
  // Prepare chapters for database
  const chaptersForDB = chapters.map((chapter, index) => ({
    book_id: bookId,
    chapter_number: index + 1,
    part_number: 1,
    title: chapter.title,
    content: chapter.content,
    summary: null,
    word_count: chapter.wordCount,
    reading_time_minutes: Math.ceil(chapter.wordCount / 200),
    highlight_quotes: extractQuotes(chapter.content),
    enhancement_status: 'pending',
    metadata: {
      detection_method: chapter.detectionMethod,
      detection_confidence: chapter.confidence,
      start_index: chapter.startIndex,
      end_index: chapter.endIndex,
      stored_at: new Date().toISOString()
    }
  }));
  
  // Insert in batches of 10
  for (let i = 0; i < chaptersForDB.length; i += 10) {
    const batch = chaptersForDB.slice(i, i + 10);
    await supabase.from('chapters').insert(batch);
    
    const progress = Math.round((i + batch.length) / chaptersForDB.length * 100);
    await updateProgress(bookId, 'storing_chapters', progress, 35 + (progress * 0.15), 
      `Stored ${i + batch.length}/${chaptersForDB.length} chapters`);
  }
}

function extractQuotes(content: string): string[] {
  const quotes: string[] = [];
  
  // Look for quoted text
  const quotedMatches = content.match(/"([^"]{20,200})"/g);
  if (quotedMatches) {
    quotes.push(...quotedMatches.slice(0, 3).map(q => q.replace(/"/g, '')));
  }
  
  return quotes.slice(0, 5);
}

async function generateSummaries(bookId: string, chapters: Chapter[]): Promise<void> {
  if (!openAIApiKey) return;
  
  for (let i = 0; i < chapters.length; i++) {
    try {
      const chapter = chapters[i];
      const progress = Math.round((i / chapters.length) * 100);
      
      await updateProgress(bookId, 'enhancing_chapters', progress, 60 + (progress * 0.3), 
        `Generating summary for chapter ${i + 1}...`);
      
      const summary = await generateChapterSummary(chapter);
      
      if (summary) {
        await supabase
          .from('chapters')
          .update({
            summary: summary,
            enhancement_status: 'completed',
            enhancement_completed_at: new Date().toISOString(),
            ai_model_used: 'gpt-4o-mini'
          })
          .eq('book_id', bookId)
          .eq('chapter_number', i + 1);
      }
      
      // Rate limiting - wait 3 seconds between requests
      await new Promise(resolve => setTimeout(resolve, 3000));
      
    } catch (error) {
      console.error(`[SIMPLE-PROCESSOR] Failed to generate summary for chapter ${i + 1}:`, error);
    }
  }
}

async function generateChapterSummary(chapter: Chapter): Promise<string | null> {
  if (!openAIApiKey) return null;
  
  try {
    const content = chapter.content.length > 4000 
      ? chapter.content.substring(0, 4000) + '...'
      : chapter.content;

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
            content: 'You are an expert book summarizer. Generate concise 100-200 word summaries that capture key points and insights.'
          },
          {
            role: 'user',
            content: `Summarize this chapter in 100-200 words:\n\nTitle: ${chapter.title}\n\nContent: ${content}`
          }
        ],
        temperature: 0.1,
        max_tokens: 300
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json();
    return data.choices[0].message.content.substring(0, 1000);
    
  } catch (error) {
    console.error('[SIMPLE-PROCESSOR] Summary generation failed:', error);
    return null;
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
      p_current_step: isError ? 'ERROR' : 'processing',
      p_message: message
    });
  } catch (error) {
    console.warn('[SIMPLE-PROCESSOR] Progress update failed:', error);
  }
}