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

    // Extract text from PDF using unpdf
    const extractedText = await extractTextFromPDF(fileData);
    console.log(`Extracted text length: ${extractedText.length} characters`);
    
    // Detect chapters using semantic analysis
    const chapters = await detectChapters(extractedText, book.title);
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
    console.log('Starting PDF text extraction with unpdf...');
    
    // Convert blob to ArrayBuffer for unpdf
    const arrayBuffer = await fileData.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    
    // Extract text using unpdf
    const { text } = await extractText(uint8Array, {
      mergePages: true, // Combine all pages into single text
      disableCombineTextItems: false, // Allow text combining for better readability
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

async function detectChapters(text: string, bookTitle: string): Promise<Chapter[]> {
  console.log('Starting chapter detection...');
  
  // Clean up the text first
  const cleanedText = cleanupText(text);
  
  // Try different detection methods in order of preference
  let chapters = detectChaptersByPatterns(cleanedText);
  
  if (chapters.length === 0) {
    console.log('Pattern detection failed, trying page break method...');
    chapters = detectChaptersByPageBreaks(cleanedText);
  }
  
  if (chapters.length === 0) {
    console.log('All detection methods failed, creating single chapter...');
    chapters = [{
      title: bookTitle || 'Full Book',
      content: cleanedText,
      wordCount: cleanedText.split(/\s+/).length,
      startIndex: 0,
      endIndex: cleanedText.length,
      detectionMethod: 'fallback_single',
      confidence: 0.1
    }];
  }
  
  console.log(`Chapter detection complete: ${chapters.length} chapters found`);
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

function detectChaptersByPatterns(text: string): Chapter[] {
  const chapters: Chapter[] = [];
  const lines = text.split('\n');
  
  // Patterns for chapter detection (in order of preference)
  const chapterPatterns = [
    /^(Chapter\s+)(\d+|[IVXLCDM]+|One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Eleven|Twelve|Thirteen|Fourteen|Fifteen|Sixteen|Seventeen|Eighteen|Nineteen|Twenty)\s*:?\s*(.*)$/i,
    /^(Ch\.?\s+)(\d+|[IVXLCDM]+)\s*:?\s*(.*)$/i,
    /^(\d+|[IVXLCDM]+)\.\s+(.+)$/,
    /^(Part\s+)(\d+|[IVXLCDM]+|One|Two|Three|Four|Five)\s*:?\s*(.*)$/i,
    /^(Section\s+)(\d+|[IVXLCDM]+)\s*:?\s*(.*)$/i
  ];
  
  let currentChapter: Partial<Chapter> = {};
  let currentContent: string[] = [];
  let chapterCount = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    let isChapterStart = false;
    let chapterTitle = '';
    let confidence = 0;
    
    // Check against all patterns
    for (const pattern of chapterPatterns) {
      const match = line.match(pattern);
      if (match) {
        isChapterStart = true;
        confidence = chapterPatterns.indexOf(pattern) === 0 ? 0.9 : 0.7;
        
        // Construct chapter title
        if (match[3]) {
          chapterTitle = `${match[1]}${match[2]}: ${match[3]}`.trim();
        } else if (match[2]) {
          chapterTitle = `${match[1]}${match[2]}`.trim();
        } else {
          chapterTitle = line;
        }
        break;
      }
    }
    
    // If we found a chapter start and we have previous content, save the previous chapter
    if (isChapterStart && currentContent.length > 0) {
      const content = currentContent.join('\n').trim();
      if (content.length > 100) { // Only save chapters with substantial content
        chapters.push({
          title: currentChapter.title || `Chapter ${chapterCount + 1}`,
          content: content,
          wordCount: content.split(/\s+/).length,
          startIndex: currentChapter.startIndex || 0,
          endIndex: text.indexOf(content) + content.length,
          detectionMethod: 'pattern_matching',
          confidence: currentChapter.confidence || 0.5
        });
        chapterCount++;
      }
      currentContent = [];
    }
    
    // Start new chapter
    if (isChapterStart) {
      currentChapter = {
        title: chapterTitle,
        startIndex: text.indexOf(line),
        confidence: confidence
      };
    } else if (line.length > 0) {
      currentContent.push(line);
    }
  }
  
  // Save the last chapter
  if (currentContent.length > 0) {
    const content = currentContent.join('\n').trim();
    if (content.length > 100) {
      chapters.push({
        title: currentChapter.title || `Chapter ${chapterCount + 1}`,
        content: content,
        wordCount: content.split(/\s+/).length,
        startIndex: currentChapter.startIndex || 0,
        endIndex: text.length,
        detectionMethod: 'pattern_matching',
        confidence: currentChapter.confidence || 0.5
      });
    }
  }
  
  console.log(`Pattern detection found ${chapters.length} chapters`);
  return chapters;
}

function detectChaptersByPageBreaks(text: string): Chapter[] {
  const chapters: Chapter[] = [];
  
  // Split by potential chapter breaks (multiple newlines + potential page markers)
  const sections = text.split(/\n\s*\n\s*\n/);
  
  if (sections.length > 1) {
    sections.forEach((section, index) => {
      const trimmedSection = section.trim();
      if (trimmedSection.length > 500) { // Only consider substantial sections
        const firstLine = trimmedSection.split('\n')[0].trim();
        const title = firstLine.length < 100 ? firstLine : `Chapter ${index + 1}`;
        
        chapters.push({
          title: title,
          content: trimmedSection,
          wordCount: trimmedSection.split(/\s+/).length,
          startIndex: text.indexOf(trimmedSection),
          endIndex: text.indexOf(trimmedSection) + trimmedSection.length,
          detectionMethod: 'page_breaks',
          confidence: 0.6
        });
      }
    });
  }
  
  console.log(`Page break detection found ${chapters.length} chapters`);
  return chapters;
}