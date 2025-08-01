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

  try {
    const { bookId } = await req.json();
    
    if (!bookId) {
      throw new Error('Book ID is required');
    }

    console.log(`Processing PDF for book ID: ${bookId}`);

    // Update book status to processing
    await supabase
      .from('books')
      .update({ processing_status: 'processing' })
      .eq('id', bookId);

    // Get book details
    const { data: book, error: bookError } = await supabase
      .from('books')
      .select('*')
      .eq('id', bookId)
      .single();

    if (bookError || !book) {
      throw new Error('Book not found');
    }

    // Download PDF from storage - sanitize filename to match upload
    const sanitizedFileName = book.file_name
      .replace(/[^\w\s.-]/g, '') // Remove special characters except dots, hyphens, and spaces
      .replace(/\s+/g, '_') // Replace spaces with underscores
      .replace(/_{2,}/g, '_'); // Replace multiple underscores with single
      
    const { data: fileData, error: downloadError } = await supabase.storage
      .from('book-pdfs')
      .download(`${book.user_id}/${sanitizedFileName}`);

    if (downloadError || !fileData) {
      throw new Error('Failed to download PDF file');
    }

    console.log(`PDF file size: ${fileData.size} bytes`);

    // Extract text from PDF using memory-efficient approach
    const extractedText = await extractTextFromPDF(fileData);
    console.log(`Extracted text length: ${extractedText.length} characters`);
    
    // Use intelligent text-based chapter detection with size optimization
    const chapters = await detectIntelligentChapters(extractedText, book.title);
    console.log(`Detected ${chapters.length} chapters`);
    
    // Process chapters for database storage
    const processedChapters = chapters.map((chapter, index) => ({
      book_id: bookId,
      chapter_number: index + 1,
      part_number: 1,
      title: chapter.title,
      content: chapter.content,
      summary: null, // Will be generated later
      word_count: chapter.wordCount,
      reading_time_minutes: Math.ceil(chapter.wordCount / 200), // 200 words per minute
      highlight_quotes: [], // Will be extracted later
      metadata: {
        extraction_method: chapter.detectionMethod,
        detection_confidence: chapter.confidence,
        start_index: chapter.startIndex,
        end_index: chapter.endIndex,
        extracted_at: new Date().toISOString()
      }
    }));

    // Save chapters to database
    const { error: chaptersError } = await supabase
      .from('chapters')
      .insert(processedChapters);

    if (chaptersError) {
      throw new Error(`Failed to save chapters: ${chaptersError.message}`);
    }

    // Update book with completion details
    const totalWordCount = processedChapters.reduce((sum, ch) => sum + ch.word_count, 0);
    const totalReadingTime = processedChapters.reduce((sum, ch) => sum + ch.reading_time_minutes, 0);

    await supabase
      .from('books')
      .update({
        processing_status: 'completed',
        processing_completed_at: new Date().toISOString(),
        total_word_count: totalWordCount,
        estimated_total_reading_time: totalReadingTime
      })
      .eq('id', bookId);

    console.log(`Successfully processed ${processedChapters.length} chapters for book ${bookId}`);

    return new Response(
      JSON.stringify({
        success: true,
        chapters: processedChapters.length,
        totalWordCount,
        totalReadingTime,
        extractionMethod: 'unpdf_semantic'
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );

  } catch (error) {
    console.error('Error processing PDF:', error);
    
    // Update book status to failed if we have the bookId
    try {
      const { bookId } = await req.json();
      if (bookId) {
        await supabase
          .from('books')
          .update({ processing_status: 'failed' })
          .eq('id', bookId);
      }
    } catch {
      // Ignore errors in error handling
    }
    
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});

async function extractTextFromPDF(fileData: Blob): Promise<string> {
  try {
    console.log('Starting memory-efficient PDF text extraction with unpdf...');
    
    // Convert blob to ArrayBuffer for unpdf
    const arrayBuffer = await fileData.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    
    // Extract text using unpdf with memory optimization
    const { text } = await extractText(uint8Array, {
      mergePages: true, // Merge pages to reduce memory usage
      disableCombineTextItems: false,
    });
    
    if (!text || text.trim().length === 0) {
      throw new Error('No text could be extracted from PDF');
    }
    
    console.log(`Successfully extracted ${text.length} characters from PDF`);
    return text;
    
  } catch (error) {
    console.error('PDF extraction failed:', error);
    throw new Error(`Failed to extract text from PDF: ${error.message}`);
  }
}

async function detectIntelligentChapters(text: string, bookTitle: string): Promise<Chapter[]> {
  console.log('Starting intelligent chapter detection...');
  
  // Clean up the text first
  const cleanedText = cleanupText(text);
  
  // Method 1: Advanced pattern matching with better chapter detection
  let chapters = detectAdvancedChapterPatterns(cleanedText);
  
  if (chapters.length <= 1) {
    console.log('Advanced pattern detection found few chapters, trying content-based splitting...');
    chapters = detectChaptersByContentAnalysis(cleanedText, bookTitle);
  }
  
  if (chapters.length === 0) {
    console.log('All detection methods failed, creating optimized chunks...');
    chapters = createOptimizedChunks(cleanedText, bookTitle);
  }
  
  console.log(`Intelligent chapter detection complete: ${chapters.length} chapters found`);
  return chapters;
}

function detectAdvancedChapterPatterns(text: string): Chapter[] {
  const chapters: Chapter[] = [];
  
  // Enhanced patterns with better matching
  const chapterPatterns = [
    /^(?:Chapter|CHAPTER)\s+(\d+|[IVXLCDM]+|One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Eleven|Twelve|Thirteen|Fourteen|Fifteen|Sixteen|Seventeen|Eighteen|Nineteen|Twenty)(?:\s*[:\.\-]\s*(.*))?$/gim,
    /^(?:Ch\.?|CH\.?)\s+(\d+|[IVXLCDM]+)(?:\s*[:\.\-]\s*(.*))?$/gim,
    /^(?:Part|PART)\s+(\d+|[IVXLCDM]+|One|Two|Three|Four|Five)(?:\s*[:\.\-]\s*(.*))?$/gim,
    /^(\d+)[\.\)]\s+(.+)$/gm,
    /^\s*(\d+|[IVXLCDM]+)\s*[\.\-]\s*(.+)$/gm
  ];
  
  const lines = text.split('\n');
  let chapterMatches: Array<{index: number, title: string, lineNum: number}> = [];
  
  // Find all potential chapter starts
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length < 3 || line.length > 150) continue; // Skip very short/long lines
    
    for (const pattern of chapterPatterns) {
      pattern.lastIndex = 0; // Reset regex
      const match = pattern.exec(line);
      if (match) {
        const title = match[2] ? `Chapter ${match[1]}: ${match[2]}` : `Chapter ${match[1]}`;
        const textIndex = text.indexOf(line);
        chapterMatches.push({
          index: textIndex,
          title: title.trim(),
          lineNum: i
        });
        break;
      }
    }
  }
  
  // Sort matches by position and create chapters
  chapterMatches.sort((a, b) => a.index - b.index);
  
  for (let i = 0; i < chapterMatches.length; i++) {
    const match = chapterMatches[i];
    const nextMatch = chapterMatches[i + 1];
    
    const startIndex = match.index;
    const endIndex = nextMatch ? nextMatch.index : text.length;
    const content = text.substring(startIndex, endIndex).trim();
    
    if (content.length > 500) { // Only substantial chapters
      chapters.push({
        title: match.title,
        content: content,
        wordCount: content.split(/\s+/).length,
        startIndex: startIndex,
        endIndex: endIndex,
        detectionMethod: 'advanced_pattern_matching',
        confidence: 0.9
      });
    }
  }
  
  return chapters;
}

function cleanupText(text: string): string {
  // Remove headers, footers, and page numbers
  return text
    .replace(/^\s*\d+\s*$/gm, '') // Remove standalone page numbers
    .replace(/^.*Page \d+ of \d+.*$/gim, '') // Remove "Page X of Y" headers
    .replace(/^\s*Chapter \d+\s*Page \d+\s*$/gim, '') // Remove "Chapter X Page Y"
    .replace(/\f/g, '\n\n') // Replace form feeds with double newlines
    .replace(/\n{3,}/g, '\n\n') // Replace multiple newlines with double newlines
    .replace(/^\s+|\s+$/g, '') // Trim whitespace
    .replace(/[ \t]+/g, ' '); // Normalize spaces
}

function detectChaptersByContentAnalysis(text: string, bookTitle: string): Chapter[] {
  console.log('Starting content-based chapter splitting...');
  const chapters: Chapter[] = [];
  const targetWordsPerChapter = 3000; // Target 3000 words per chapter
  const minWordsPerChapter = 1500;    // Minimum words per chapter
  
  // Split text into sentences for better boundary detection
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 20);
  console.log(`Found ${sentences.length} sentences for chapter splitting`);
  
  let currentChapter = '';
  let currentWordCount = 0;
  let chapterNumber = 1;
  
  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i].trim() + '.';
    const sentenceWordCount = sentence.split(/\s+/).length;
    
    currentChapter += sentence + ' ';
    currentWordCount += sentenceWordCount;
    
    // Check if we should end this chapter
    const shouldEndChapter = 
      currentWordCount >= targetWordsPerChapter ||
      i === sentences.length - 1;
    
    if (shouldEndChapter && currentWordCount >= minWordsPerChapter) {
      // Create chapter title from first sentence or use generic title
      const firstSentence = currentChapter.split('.')[0].trim();
      const title = (firstSentence.length > 0 && firstSentence.length < 80) 
        ? `${bookTitle} - ${firstSentence}...`
        : `${bookTitle} - Chapter ${chapterNumber}`;
      
      chapters.push({
        title: title,
        content: currentChapter.trim(),
        wordCount: currentWordCount,
        startIndex: 0, // Will be calculated properly later
        endIndex: currentChapter.length,
        detectionMethod: 'content_analysis_sentences',
        confidence: 0.7
      });
      
      console.log(`Created chapter ${chapterNumber}: ${currentWordCount} words`);
      chapterNumber++;
      currentChapter = '';
      currentWordCount = 0;
    }
  }
  
  // Handle remaining content
  if (currentChapter.trim().length > 0 && currentWordCount >= 500) {
    const firstSentence = currentChapter.split('.')[0].trim();
    const title = (firstSentence.length > 0 && firstSentence.length < 80) 
      ? `${bookTitle} - ${firstSentence}...`
      : `${bookTitle} - Chapter ${chapterNumber}`;
      
    chapters.push({
      title: title,
      content: currentChapter.trim(),
      wordCount: currentWordCount,
      startIndex: 0,
      endIndex: currentChapter.length,
      detectionMethod: 'content_analysis_sentences',
      confidence: 0.7
    });
    console.log(`Created final chapter ${chapterNumber}: ${currentWordCount} words`);
  }
  
  console.log(`Content analysis complete: created ${chapters.length} chapters`);
  return chapters;
}

function createOptimizedChunks(text: string, bookTitle: string): Chapter[] {
  console.log('Creating optimized chunks as fallback...');
  const chapters: Chapter[] = [];
  const wordsPerChunk = 2500; // Smaller, more digestible chunks
  const words = text.split(/\s+/);
  
  console.log(`Splitting ${words.length} total words into chunks of ${wordsPerChunk} words each`);
  
  for (let i = 0; i < words.length; i += wordsPerChunk) {
    const chunkWords = words.slice(i, i + wordsPerChunk);
    const content = chunkWords.join(' ');
    
    if (content.trim().length > 100) {
      const chapterNumber = Math.floor(i / wordsPerChunk) + 1;
      const title = `${bookTitle} - Part ${chapterNumber}`;
      
      chapters.push({
        title: title,
        content: content,
        wordCount: chunkWords.length,
        startIndex: i,
        endIndex: i + chunkWords.length,
        detectionMethod: 'optimized_chunking',
        confidence: 0.5
      });
      
      console.log(`Created chunk ${chapterNumber}: ${chunkWords.length} words`);
    }
  }
  
  console.log(`Optimized chunking complete: created ${chapters.length} chapters`);
  return chapters;
}