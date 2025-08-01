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

    // Extract pages from PDF using unpdf
    const pages = await extractPagesFromPDF(fileData);
    console.log(`Extracted ${pages.length} pages from PDF`);
    
    // Analyze PDF structure and detect chapter page ranges
    const chapterRanges = await detectChapterPageRanges(pages, book.title);
    console.log(`Detected ${chapterRanges.length} chapter ranges`);
    
    // Extract chapters based on page ranges
    const chapters = await extractChaptersFromPages(pages, chapterRanges);
    console.log(`Extracted ${chapters.length} chapters`);
    
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

async function extractPagesFromPDF(fileData: Blob): Promise<string[]> {
  try {
    console.log('Starting page-by-page PDF extraction with unpdf...');
    
    // Convert blob to ArrayBuffer for unpdf
    const arrayBuffer = await fileData.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    
    // Extract text page by page without merging
    const { text, pages } = await extractText(uint8Array, {
      mergePages: false, // Keep pages separate for intelligent splitting
      disableCombineTextItems: false,
    });
    
    if (!pages || pages.length === 0) {
      throw new Error('No pages could be extracted from PDF');
    }
    
    console.log(`Successfully extracted ${pages.length} pages from PDF`);
    return pages.map(page => page.text || '').filter(pageText => pageText.trim().length > 0);
    
  } catch (error) {
    console.error('PDF page extraction failed:', error);
    throw new Error(`Failed to extract pages from PDF: ${error.message}`);
  }
}

interface ChapterRange {
  title: string;
  startPage: number;
  endPage: number;
  confidence: number;
  detectionMethod: string;
}

async function detectChapterPageRanges(pages: string[], bookTitle: string): Promise<ChapterRange[]> {
  console.log('Starting intelligent chapter page range detection...');
  
  const chapterRanges: ChapterRange[] = [];
  
  // Method 1: Look for chapter headings across pages
  const patternRanges = detectChaptersByPagePatterns(pages);
  if (patternRanges.length > 1) {
    console.log(`Found ${patternRanges.length} chapters using pattern detection`);
    return patternRanges;
  }
  
  // Method 2: Analyze page structure and content breaks
  const structuralRanges = detectChaptersByPageStructure(pages);
  if (structuralRanges.length > 1) {
    console.log(`Found ${structuralRanges.length} chapters using structural analysis`);
    return structuralRanges;
  }
  
  // Method 3: Smart page grouping based on content density
  const densityRanges = detectChaptersByContentDensity(pages);
  if (densityRanges.length > 1) {
    console.log(`Found ${densityRanges.length} chapters using content density analysis`);
    return densityRanges;
  }
  
  // Fallback: Split into reasonable chunks if book is too large
  const fallbackRanges = createFallbackChapterRanges(pages, bookTitle);
  console.log(`Using fallback method: ${fallbackRanges.length} chapters`);
  return fallbackRanges;
}

async function extractChaptersFromPages(pages: string[], chapterRanges: ChapterRange[]): Promise<Chapter[]> {
  const chapters: Chapter[] = [];
  
  for (const range of chapterRanges) {
    const chapterPages = pages.slice(range.startPage, range.endPage + 1);
    const content = chapterPages.join('\n\n').trim();
    const cleanedContent = cleanupText(content);
    
    if (cleanedContent.length > 100) { // Only include substantial chapters
      chapters.push({
        title: range.title,
        content: cleanedContent,
        wordCount: cleanedContent.split(/\s+/).length,
        startIndex: range.startPage,
        endIndex: range.endPage,
        detectionMethod: range.detectionMethod,
        confidence: range.confidence
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

function detectChaptersByPagePatterns(pages: string[]): ChapterRange[] {
  const ranges: ChapterRange[] = [];
  const chapterPatterns = [
    /^(Chapter\s+)(\d+|[IVXLCDM]+|One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Eleven|Twelve|Thirteen|Fourteen|Fifteen|Sixteen|Seventeen|Eighteen|Nineteen|Twenty)\s*:?\s*(.*)$/i,
    /^(Ch\.?\s+)(\d+|[IVXLCDM]+)\s*:?\s*(.*)$/i,
    /^(\d+|[IVXLCDM]+)\.\s+(.+)$/,
    /^(Part\s+)(\d+|[IVXLCDM]+|One|Two|Three|Four|Five)\s*:?\s*(.*)$/i
  ];
  
  let lastChapterPage = -1;
  
  for (let pageNum = 0; pageNum < pages.length; pageNum++) {
    const page = pages[pageNum];
    const lines = page.split('\n');
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      
      for (const pattern of chapterPatterns) {
        const match = trimmedLine.match(pattern);
        if (match) {
          // Save previous chapter if exists
          if (lastChapterPage >= 0) {
            const prevRange = ranges[ranges.length - 1];
            if (prevRange) {
              prevRange.endPage = pageNum - 1;
            }
          }
          
          // Create new chapter range
          let title = '';
          if (match[3]) {
            title = `${match[1]}${match[2]}: ${match[3]}`.trim();
          } else if (match[2]) {
            title = `${match[1]}${match[2]}`.trim();
          } else {
            title = trimmedLine;
          }
          
          ranges.push({
            title: title,
            startPage: pageNum,
            endPage: pages.length - 1, // Will be updated when next chapter is found
            confidence: 0.9,
            detectionMethod: 'page_pattern_matching'
          });
          
          lastChapterPage = pageNum;
          break;
        }
      }
    }
  }
  
  return ranges;
}

function detectChaptersByPageStructure(pages: string[]): ChapterRange[] {
  const ranges: ChapterRange[] = [];
  const minChapterPages = 5; // Minimum pages per chapter
  const maxChapterPages = 50; // Maximum pages per chapter for reasonable chunks
  
  // Look for structural breaks: pages with very little content followed by new content
  const breakPoints: number[] = [0]; // Always start with page 0
  
  for (let i = 1; i < pages.length - 1; i++) {
    const currentPage = pages[i].trim();
    const nextPage = pages[i + 1].trim();
    
    // Detect potential chapter breaks
    const isShortPage = currentPage.length < 200; // Very short page
    const nextPageStartsWithCapital = /^[A-Z]/.test(nextPage);
    const hasChapterLikeStart = /^(Chapter|CHAPTER|Ch\.|Part|PART|Section)/i.test(nextPage.split('\n')[0]);
    
    if ((isShortPage && nextPageStartsWithCapital) || hasChapterLikeStart) {
      breakPoints.push(i + 1);
    }
  }
  
  breakPoints.push(pages.length); // Always end with last page
  
  // Create chapter ranges from break points
  for (let i = 0; i < breakPoints.length - 1; i++) {
    const startPage = breakPoints[i];
    const endPage = breakPoints[i + 1] - 1;
    const chapterLength = endPage - startPage + 1;
    
    // Only create chapter if it's a reasonable length
    if (chapterLength >= minChapterPages && chapterLength <= maxChapterPages) {
      const firstPageContent = pages[startPage].split('\n')[0].trim();
      const title = firstPageContent.length > 0 && firstPageContent.length < 100 
        ? firstPageContent 
        : `Chapter ${i + 1}`;
        
      ranges.push({
        title: title,
        startPage: startPage,
        endPage: endPage,
        confidence: 0.7,
        detectionMethod: 'page_structure_analysis'
      });
    }
  }
  
  return ranges;
}

function detectChaptersByContentDensity(pages: string[]): ChapterRange[] {
  const ranges: ChapterRange[] = [];
  const targetWordsPerChapter = 5000; // Target ~5000 words per chapter
  const minWordsPerChapter = 2000;   // Minimum words per chapter
  
  let currentChapterStart = 0;
  let currentWordCount = 0;
  let chapterNumber = 1;
  
  for (let i = 0; i < pages.length; i++) {
    const pageWordCount = pages[i].split(/\s+/).length;
    currentWordCount += pageWordCount;
    
    // If we've hit our target or we're at the end
    if (currentWordCount >= targetWordsPerChapter || i === pages.length - 1) {
      // Only create chapter if it meets minimum requirements
      if (currentWordCount >= minWordsPerChapter || ranges.length === 0) {
        const firstPageContent = pages[currentChapterStart].split('\n')[0].trim();
        const title = firstPageContent.length > 0 && firstPageContent.length < 100 
          ? firstPageContent 
          : `Chapter ${chapterNumber}`;
          
        ranges.push({
          title: title,
          startPage: currentChapterStart,
          endPage: i,
          confidence: 0.6,
          detectionMethod: 'content_density_analysis'
        });
        
        chapterNumber++;
        currentChapterStart = i + 1;
        currentWordCount = 0;
      }
    }
  }
  
  return ranges;
}

function createFallbackChapterRanges(pages: string[], bookTitle: string): ChapterRange[] {
  const ranges: ChapterRange[] = [];
  const pagesPerChapter = Math.max(10, Math.floor(pages.length / 20)); // Max 20 chapters, min 10 pages each
  
  for (let i = 0; i < pages.length; i += pagesPerChapter) {
    const startPage = i;
    const endPage = Math.min(i + pagesPerChapter - 1, pages.length - 1);
    const chapterNumber = Math.floor(i / pagesPerChapter) + 1;
    
    ranges.push({
      title: `${bookTitle} - Part ${chapterNumber}`,
      startPage: startPage,
      endPage: endPage,
      confidence: 0.3,
      detectionMethod: 'fallback_chunking'
    });
  }
  
  return ranges;
}