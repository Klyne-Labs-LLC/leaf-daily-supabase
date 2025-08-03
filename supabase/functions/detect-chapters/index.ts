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

interface DetectionResult {
  chapters: Chapter[];
  metadata: {
    detectionMethod: string;
    totalChapters: number;
    averageWordsPerChapter: number;
    confidenceScore: number;
    processingTime: number;
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
    const { bookId: requestBookId, text, metadata: extractionMetadata } = await req.json();
    bookId = requestBookId;
    
    if (!bookId || !text) {
      throw new Error('Book ID and text are required');
    }

    console.log(`[DETECT-CHAPTERS] Starting detection for book ID: ${bookId}`);
    console.log(`[DETECT-CHAPTERS] Text length: ${text.length} characters`);

    await updateProgress(bookId, 'detecting_chapters', 0, 20, 'Starting chapter detection...');

    // Get book details for context
    const { data: book, error: bookError } = await supabase
      .from('books')
      .select('title, author, genre')
      .eq('id', bookId)
      .single();

    if (bookError || !book) {
      throw new Error('Book not found');
    }

    // Check cache first
    const cacheKey = await generateCacheKey(text, book.title);
    const cachedResult = await checkCache(cacheKey, 'chapter_detection');
    
    if (cachedResult) {
      console.log(`[DETECT-CHAPTERS] Cache hit for ${cacheKey}`);
      await updateProgress(bookId, 'detecting_chapters', 100, 30, 'Chapters detected from cache');
      
      // Enqueue next job
      await enqueueNextJob(bookId, 'store_chapters', { 
        chapters: cachedResult.chapters, 
        bookTitle: book.title 
      });
      
      return new Response(
        JSON.stringify({
          success: true,
          cached: true,
          chapters: cachedResult.chapters, // Include the actual chapters for direct calls
          metadata: cachedResult.metadata
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    await updateProgress(bookId, 'detecting_chapters', 10, 22, 'Analyzing text structure...');

    // Run multiple detection algorithms in parallel
    const detectionResults = await runParallelDetection(text, book, bookId);
    
    await updateProgress(bookId, 'detecting_chapters', 70, 27, 'Selecting best chapter boundaries...');

    // Select the best detection result
    const bestResult = selectBestDetection(detectionResults);
    
    await updateProgress(bookId, 'detecting_chapters', 85, 28, 'Optimizing chapter content...');

    // Post-process chapters for optimal reading experience
    const optimizedChapters = await optimizeChapters(bestResult.chapters, text);
    
    const processingTime = Math.round((Date.now() - startTime) / 1000);
    const result: DetectionResult = {
      chapters: optimizedChapters,
      metadata: {
        detectionMethod: bestResult.method,
        totalChapters: optimizedChapters.length,
        averageWordsPerChapter: Math.round(optimizedChapters.reduce((sum, ch) => sum + ch.wordCount, 0) / optimizedChapters.length),
        confidenceScore: bestResult.confidence,
        processingTime,
        textHash: extractionMetadata?.textHash || await hashText(text)
      }
    };

    await updateProgress(bookId, 'detecting_chapters', 95, 29, 'Caching detection results...');

    // Cache the result
    await storeInCache(cacheKey, 'chapter_detection', result, processingTime);

    await updateProgress(bookId, 'detecting_chapters', 100, 30, `Detected ${optimizedChapters.length} chapters`);

    // Update book with detection completion
    await supabase
      .from('books')
      .update({
        chapter_detection_completed_at: new Date().toISOString()
      })
      .eq('id', bookId);

    // Enqueue next job
    await enqueueNextJob(bookId, 'store_chapters', { 
      chapters: optimizedChapters, 
      bookTitle: book.title 
    });

    console.log(`[DETECT-CHAPTERS] Completed in ${processingTime}s: ${optimizedChapters.length} chapters, confidence: ${bestResult.confidence}`);

    return new Response(
      JSON.stringify({
        success: true,
        cached: false,
        chapters: result.chapters, // Include the actual chapters for direct calls
        metadata: result.metadata
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[DETECT-CHAPTERS] Error:', error);
    
    const processingTime = Math.round((Date.now() - startTime) / 1000);
    
    if (bookId) {
      await updateProgress(bookId, 'detecting_chapters', 0, 20, `Error: ${error.message}`, true);
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

interface DetectionResult {
  chapters: Chapter[];
  method: string;
  confidence: number;
}

async function runParallelDetection(text: string, book: any, bookId: string): Promise<DetectionResult[]> {
  const detectionMethods = [
    () => detectPatternBasedChapters(text, bookId),
    () => detectStructuralChapters(text, bookId),
    () => detectSemanticChapters(text, book.title, bookId),
    () => detectAdaptiveChapters(text, book, bookId)
  ];

  // Run all detection methods in parallel
  const results = await Promise.allSettled(
    detectionMethods.map(method => method())
  );

  const successfulResults: DetectionResult[] = [];
  
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.chapters.length > 0) {
      successfulResults.push(result.value);
    }
  }

  if (successfulResults.length === 0) {
    // Fallback to simple chunking
    const fallbackChapters = createOptimizedChunks(text, book.title);
    successfulResults.push({
      chapters: fallbackChapters,
      method: 'fallback_chunking',
      confidence: 0.3
    });
  }

  return successfulResults;
}

async function detectPatternBasedChapters(text: string, bookId: string): Promise<DetectionResult> {
  await updateProgress(bookId, 'detecting_chapters', 15, 23, 'Analyzing chapter patterns...');
  
  const chapters: Chapter[] = [];
  
  // Enhanced pattern matching with multiple strategies
  const chapterPatterns = [
    // Standard chapter patterns
    {
      regex: /^(?:Chapter|CHAPTER)\s+(\d+|[IVXLCDM]+|One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Eleven|Twelve|Thirteen|Fourteen|Fifteen|Sixteen|Seventeen|Eighteen|Nineteen|Twenty)(?:\s*[:\.\-]\s*(.*))?$/gim,
      confidence: 0.95,
      priority: 1
    },
    // Part-based patterns
    {
      regex: /^(?:Part|PART)\s+(\d+|[IVXLCDM]+|One|Two|Three|Four|Five)(?:\s*[:\.\-]\s*(.*))?$/gim,
      confidence: 0.90,
      priority: 2
    },
    // Numbered sections
    {
      regex: /^(\d+)[\.\)]\s+(.{10,80})$/gm,
      confidence: 0.75,
      priority: 3
    },
    // Book-specific patterns (detecting based on consistent formatting)
    {
      regex: /^[A-Z\s]{3,50}$/gm, // All caps headers
      confidence: 0.60,
      priority: 4
    }
  ];

  const lines = text.split('\n');
  let bestMatches: Array<{index: number, title: string, lineNum: number, confidence: number}> = [];
  let highestConfidence = 0;

  // Try each pattern and keep the best results
  for (const pattern of chapterPatterns) {
    const matches: Array<{index: number, title: string, lineNum: number, confidence: number}> = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.length < 3 || line.length > 150) continue;
      
      pattern.regex.lastIndex = 0;
      const match = pattern.regex.exec(line);
      if (match) {
        const title = match[2] ? `Chapter ${match[1]}: ${match[2]}` : (match[1] ? `Chapter ${match[1]}` : line);
        const textIndex = text.indexOf(line);
        if (textIndex !== -1) {
          matches.push({
            index: textIndex,
            title: title.trim(),
            lineNum: i,
            confidence: pattern.confidence
          });
        }
      }
    }

    // If this pattern found more chapters and has decent confidence, use it
    if (matches.length >= 2 && pattern.confidence > highestConfidence) {
      bestMatches = matches;
      highestConfidence = pattern.confidence;
    }
  }

  // Create chapters from best matches
  bestMatches.sort((a, b) => a.index - b.index);
  
  for (let i = 0; i < bestMatches.length; i++) {
    const match = bestMatches[i];
    const nextMatch = bestMatches[i + 1];
    
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
        confidence: match.confidence,
        boundary_strength: calculateBoundaryStrength(lines, match.lineNum)
      });
    }
  }

  return {
    chapters,
    method: 'pattern_based',
    confidence: highestConfidence
  };
}

async function detectStructuralChapters(text: string, bookId: string): Promise<DetectionResult> {
  await updateProgress(bookId, 'detecting_chapters', 25, 24, 'Analyzing document structure...');
  
  const chapters: Chapter[] = [];
  const lines = text.split('\n');
  
  // Analyze document structure patterns
  const structuralIndicators = {
    pageBreaks: text.split('\f').length - 1,
    doubleLineBreaks: (text.match(/\n\n+/g) || []).length,
    shortLines: lines.filter(line => line.trim().length > 0 && line.trim().length < 100).length,
    longParagraphs: (text.match(/[^\n]{500,}/g) || []).length
  };

  // Use structural breaks as chapter boundaries
  const structuralBreaks: Array<{index: number, type: string, strength: number}> = [];
  
  // Find major structural breaks
  let currentIndex = 0;
  const textParts = text.split(/\n\n\n+/); // Triple+ line breaks
  
  for (let i = 0; i < textParts.length; i++) {
    if (i > 0) {
      const breakStrength = calculateStructuralBreakStrength(textParts[i-1], textParts[i]);
      if (breakStrength > 0.5) {
        structuralBreaks.push({
          index: currentIndex,
          type: 'structural_break',
          strength: breakStrength
        });
      }
    }
    currentIndex += textParts[i].length + 3; // +3 for the \n\n\n
  }

  // Create chapters from structural breaks
  structuralBreaks.sort((a, b) => a.index - b.index);
  
  for (let i = 0; i < structuralBreaks.length; i++) {
    const breakPoint = structuralBreaks[i];
    const nextBreak = structuralBreaks[i + 1];
    
    const startIndex = i === 0 ? 0 : breakPoint.index;
    const endIndex = nextBreak ? nextBreak.index : text.length;
    const content = text.substring(startIndex, endIndex).trim();
    
    if (content.length > 1000) { // Ensure substantial chapters
      const title = generateStructuralTitle(content, i + 1);
      chapters.push({
        title: title,
        content: content,
        wordCount: content.split(/\s+/).length,
        startIndex: startIndex,
        endIndex: endIndex,
        detectionMethod: 'structural',
        confidence: breakPoint.strength,
        boundary_strength: breakPoint.strength
      });
    }
  }

  const avgConfidence = chapters.length > 0 
    ? chapters.reduce((sum, ch) => sum + ch.confidence, 0) / chapters.length 
    : 0.4;

  return {
    chapters,
    method: 'structural',
    confidence: avgConfidence
  };
}

async function detectSemanticChapters(text: string, bookTitle: string, bookId: string): Promise<DetectionResult> {
  await updateProgress(bookId, 'detecting_chapters', 35, 25, 'Analyzing content semantics...');
  
  const chapters: Chapter[] = [];
  
  // Analyze text for semantic boundaries
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 20);
  const semanticBreaks: Array<{index: number, strength: number}> = [];
  
  // Look for topic shifts, character introductions, scene changes
  for (let i = 1; i < sentences.length - 1; i++) {
    const prevSentence = sentences[i-1].trim();
    const currentSentence = sentences[i].trim();
    const nextSentence = sentences[i+1].trim();
    
    const semanticShift = calculateSemanticShift(prevSentence, currentSentence, nextSentence);
    
    if (semanticShift > 0.6) {
      const sentenceText = currentSentence + '.';
      const index = text.indexOf(sentenceText);
      if (index !== -1) {
        semanticBreaks.push({
          index: index,
          strength: semanticShift
        });
      }
    }
  }

  // Create chapters from semantic breaks with optimal sizing
  const targetWordsPerChapter = 2500;
  const minWordsPerChapter = 1200;
  const maxWordsPerChapter = 4000;
  
  let chapterStart = 0;
  let chapterNumber = 1;
  let currentWords = 0;
  let lastBreakPoint = 0;

  for (const breakPoint of semanticBreaks) {
    const segmentText = text.substring(chapterStart, breakPoint.index);
    const segmentWords = segmentText.split(/\s+/).length;
    currentWords += segmentWords;

    // Check if we should create a chapter here
    const shouldBreak = (
      currentWords >= minWordsPerChapter && 
      (currentWords >= targetWordsPerChapter || breakPoint.strength > 0.8)
    ) || currentWords >= maxWordsPerChapter;

    if (shouldBreak) {
      const content = text.substring(chapterStart, breakPoint.index).trim();
      if (content.length > 500) {
        const title = generateSemanticTitle(content, bookTitle, chapterNumber);
        chapters.push({
          title: title,
          content: content,
          wordCount: currentWords,
          startIndex: chapterStart,
          endIndex: breakPoint.index,
          detectionMethod: 'semantic',
          confidence: breakPoint.strength,
          boundary_strength: breakPoint.strength
        });
        
        chapterStart = breakPoint.index;
        chapterNumber++;
        currentWords = 0;
      }
    }
  }

  // Handle remaining content
  if (chapterStart < text.length - 500) {
    const content = text.substring(chapterStart).trim();
    const wordCount = content.split(/\s+/).length;
    if (wordCount > 300) {
      const title = generateSemanticTitle(content, bookTitle, chapterNumber);
      chapters.push({
        title: title,
        content: content,
        wordCount: wordCount,
        startIndex: chapterStart,
        endIndex: text.length,
        detectionMethod: 'semantic',
        confidence: 0.7,
        boundary_strength: 0.7
      });
    }
  }

  const avgConfidence = chapters.length > 0 
    ? chapters.reduce((sum, ch) => sum + ch.confidence, 0) / chapters.length 
    : 0.6;

  return {
    chapters,
    method: 'semantic',
    confidence: avgConfidence
  };
}

async function detectAdaptiveChapters(text: string, book: any, bookId: string): Promise<DetectionResult> {
  await updateProgress(bookId, 'detecting_chapters', 45, 26, 'Running adaptive detection...');
  
  // Adaptive approach that considers document characteristics
  const textLength = text.length;
  const wordCount = text.split(/\s+/).length;
  
  // Determine optimal strategy based on document characteristics
  let strategy: 'short_form' | 'medium_form' | 'long_form' | 'academic' | 'narrative';
  
  if (wordCount < 20000) {
    strategy = 'short_form';
  } else if (wordCount < 80000) {
    strategy = 'medium_form';
  } else if (wordCount < 200000) {
    strategy = 'long_form';
  } else if (book.genre?.includes('academic') || text.includes('bibliography') || text.includes('references')) {
    strategy = 'academic';
  } else {
    strategy = 'narrative';
  }

  const chapters = await applyAdaptiveStrategy(text, strategy, book.title);
  
  return {
    chapters,
    method: `adaptive_${strategy}`,
    confidence: 0.8
  };
}

// Helper functions

function calculateBoundaryStrength(lines: string[], lineNum: number): number {
  let strength = 0.5;
  
  // Check surrounding context
  const prevLine = lineNum > 0 ? lines[lineNum - 1].trim() : '';
  const nextLine = lineNum < lines.length - 1 ? lines[lineNum + 1].trim() : '';
  
  // Strong indicators
  if (prevLine === '' && nextLine === '') strength += 0.3; // Isolated line
  if (lines[lineNum].match(/^[A-Z\s]+$/)) strength += 0.2; // All caps
  if (lines[lineNum].match(/^\d+[\.\)]/)) strength += 0.2; // Numbered
  
  return Math.min(strength, 1.0);
}

function calculateStructuralBreakStrength(beforeText: string, afterText: string): number {
  let strength = 0.3;
  
  const beforeWords = beforeText.trim().split(/\s+/).length;
  const afterWords = afterText.trim().split(/\s+/).length;
  
  // Strong break if both sides have substantial content
  if (beforeWords > 100 && afterWords > 100) strength += 0.4;
  
  // Check for formatting changes
  const beforeEndsWithPunctuation = /[.!?]$/.test(beforeText.trim());
  const afterStartsCapitalized = /^[A-Z]/.test(afterText.trim());
  
  if (beforeEndsWithPunctuation && afterStartsCapitalized) strength += 0.3;
  
  return Math.min(strength, 1.0);
}

function calculateSemanticShift(prev: string, current: string, next: string): number {
  let shift = 0.3;
  
  // Look for topic change indicators
  const topicMarkers = ['meanwhile', 'later', 'the next', 'suddenly', 'then', 'now', 'after'];
  const timeMarkers = ['morning', 'evening', 'day', 'night', 'week', 'month', 'year'];
  const placeMarkers = ['at', 'in', 'outside', 'inside', 'nearby', 'across'];
  
  const currentLower = current.toLowerCase();
  
  for (const marker of topicMarkers) {
    if (currentLower.includes(marker)) shift += 0.2;
  }
  
  for (const marker of timeMarkers) {
    if (currentLower.includes(marker)) shift += 0.15;
  }
  
  for (const marker of placeMarkers) {
    if (currentLower.includes(marker)) shift += 0.1;
  }
  
  return Math.min(shift, 1.0);
}

function generateStructuralTitle(content: string, chapterNum: number): string {
  const firstLine = content.split('\n').find(line => line.trim().length > 0)?.trim() || '';
  
  if (firstLine.length > 10 && firstLine.length < 80) {
    return firstLine;
  }
  
  return `Chapter ${chapterNum}`;
}

function generateSemanticTitle(content: string, bookTitle: string, chapterNum: number): string {
  // Extract potential title from first meaningful sentence
  const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 10);
  const firstSentence = sentences[0]?.trim();
  
  if (firstSentence && firstSentence.length < 80) {
    return `${bookTitle} - ${firstSentence}...`;
  }
  
  return `${bookTitle} - Chapter ${chapterNum}`;
}

async function applyAdaptiveStrategy(text: string, strategy: string, bookTitle: string): Promise<Chapter[]> {
  const chapters: Chapter[] = [];
  
  const strategyConfig = {
    short_form: { targetWords: 1500, minWords: 800, maxWords: 2500 },
    medium_form: { targetWords: 2500, minWords: 1500, maxWords: 4000 },
    long_form: { targetWords: 3500, minWords: 2000, maxWords: 6000 },
    academic: { targetWords: 4000, minWords: 2500, maxWords: 8000 },
    narrative: { targetWords: 3000, minWords: 1800, maxWords: 5000 }
  };
  
  const config = strategyConfig[strategy as keyof typeof strategyConfig] || strategyConfig.medium_form;
  
  const words = text.split(/\s+/);
  let chapterStart = 0;
  let chapterNum = 1;
  
  while (chapterStart < words.length) {
    const remainingWords = words.length - chapterStart;
    const chapterSize = Math.min(
      Math.max(config.minWords, Math.min(config.targetWords, remainingWords)), 
      config.maxWords
    );
    
    const chapterWords = words.slice(chapterStart, chapterStart + chapterSize);
    const content = chapterWords.join(' ');
    
    if (content.trim().length > 100) {
      chapters.push({
        title: `${bookTitle} - Part ${chapterNum}`,
        content: content,
        wordCount: chapterWords.length,
        startIndex: chapterStart,
        endIndex: chapterStart + chapterSize,
        detectionMethod: `adaptive_${strategy}`,
        confidence: 0.8
      });
    }
    
    chapterStart += chapterSize;
    chapterNum++;
  }
  
  return chapters;
}

function selectBestDetection(results: DetectionResult[]): DetectionResult {
  if (results.length === 0) {
    throw new Error('No chapter detection results available');
  }
  
  // Score each result based on multiple factors
  const scoredResults = results.map(result => {
    let score = result.confidence * 0.4; // Base confidence score
    
    // Prefer reasonable chapter counts (3-50 chapters)
    const chapterCount = result.chapters.length;
    if (chapterCount >= 3 && chapterCount <= 50) {
      score += 0.3;
    } else if (chapterCount > 50) {
      score -= 0.2; // Penalize too many chapters
    }
    
    // Prefer consistent chapter sizes
    const wordCounts = result.chapters.map(ch => ch.wordCount);
    const avgWords = wordCounts.reduce((sum, count) => sum + count, 0) / wordCounts.length;
    const variance = wordCounts.reduce((sum, count) => sum + Math.pow(count - avgWords, 2), 0) / wordCounts.length;
    const consistency = Math.max(0, 1 - (variance / (avgWords * avgWords))); // Normalized variance
    score += consistency * 0.2;
    
    // Prefer methods that found meaningful boundaries
    if (result.method.includes('pattern') || result.method.includes('semantic')) {
      score += 0.1;
    }
    
    return { ...result, score };
  });
  
  // Return the highest scoring result
  scoredResults.sort((a, b) => b.score - a.score);
  return scoredResults[0];
}

async function optimizeChapters(chapters: Chapter[], fullText: string): Promise<Chapter[]> {
  const optimized: Chapter[] = [];
  
  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i];
    
    // Optimize chapter boundaries for better reading experience
    let optimizedContent = chapter.content;
    let optimizedStart = chapter.startIndex;
    let optimizedEnd = chapter.endIndex;
    
    // Try to end chapters at natural breakpoints (sentence endings)
    if (i < chapters.length - 1) { // Not the last chapter
      const nextChapterStart = chapters[i + 1].startIndex;
      const boundaryText = fullText.substring(chapter.endIndex - 200, nextChapterStart + 200);
      const sentences = boundaryText.split(/[.!?]+/);
      
      // Find the best sentence boundary near the original chapter end
      for (let j = Math.floor(sentences.length / 2); j < sentences.length - 1; j++) {
        const sentenceEnd = boundaryText.indexOf(sentences[j]) + sentences[j].length + 1;
        const actualEnd = chapter.endIndex - 200 + sentenceEnd;
        
        if (actualEnd > chapter.startIndex + 500 && actualEnd < nextChapterStart - 100) {
          optimizedEnd = actualEnd;
          optimizedContent = fullText.substring(optimizedStart, optimizedEnd).trim();
          break;
        }
      }
    }
    
    optimized.push({
      ...chapter,
      content: optimizedContent,
      startIndex: optimizedStart,
      endIndex: optimizedEnd,
      wordCount: optimizedContent.split(/\s+/).length
    });
  }
  
  return optimized;
}

function createOptimizedChunks(text: string, bookTitle: string): Chapter[] {
  const chapters: Chapter[] = [];
  const targetWords = 2000;
  const words = text.split(/\s+/);
  
  for (let i = 0; i < words.length; i += targetWords) {
    const chunkWords = words.slice(i, i + targetWords);
    const content = chunkWords.join(' ');
    
    if (content.trim().length > 100) {
      const chapterNum = Math.floor(i / targetWords) + 1;
      chapters.push({
        title: `${bookTitle} - Part ${chapterNum}`,
        content: content,
        wordCount: chunkWords.length,
        startIndex: i,
        endIndex: i + chunkWords.length,
        detectionMethod: 'optimized_chunking',
        confidence: 0.4
      });
    }
  }
  
  return chapters;
}

// Utility functions (same as in extract-pdf-text)
async function generateCacheKey(text: string, bookTitle: string): Promise<string> {
  const data = `${text.substring(0, 1000)}:${bookTitle}:${text.length}`;
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

async function checkCache(cacheKey: string, cacheType: string): Promise<DetectionResult | null> {
  try {
    const { data } = await supabase.rpc('get_cached_result', {
      p_cache_key: cacheKey,
      p_cache_type: cacheType
    });
    
    return data ? data as DetectionResult : null;
  } catch (error) {
    console.warn('[DETECT-CHAPTERS] Cache lookup failed:', error);
    return null;
  }
}

async function storeInCache(cacheKey: string, cacheType: string, result: DetectionResult, processingTime: number): Promise<void> {
  try {
    const inputHash = await hashText(JSON.stringify({ cacheKey, processingTime }));
    
    await supabase.rpc('store_cached_result', {
      p_cache_key: cacheKey,
      p_cache_type: cacheType,
      p_input_hash: inputHash,
      p_output_data: result,
      p_processing_time_seconds: processingTime
    });
  } catch (error) {
    console.warn('[DETECT-CHAPTERS] Cache storage failed:', error);
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
      p_current_step: isError ? 'ERROR' : 'detecting',
      p_message: message
    });
  } catch (error) {
    console.warn('[DETECT-CHAPTERS] Progress update failed:', error);
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
    
    console.log(`[DETECT-CHAPTERS] Enqueued ${jobType} job for book ${bookId}`);
  } catch (error) {
    console.error('[DETECT-CHAPTERS] Failed to enqueue next job:', error);
  }
}