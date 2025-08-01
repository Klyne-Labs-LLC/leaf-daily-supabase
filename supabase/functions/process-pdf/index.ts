import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Initialize Supabase client
const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseKey);

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

    // Download PDF from storage
    const { data: fileData, error: downloadError } = await supabase.storage
      .from('book-pdfs')
      .download(`${book.user_id}/${book.file_name}`);

    if (downloadError || !fileData) {
      throw new Error('Failed to download PDF file');
    }

    // Convert file to base64 for PDF processing (safely handle large files)
    const arrayBuffer = await fileData.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    
    // Convert to base64 without spreading the array (prevents stack overflow)
    let base64Data = '';
    const chunkSize = 8192;
    for (let i = 0; i < uint8Array.length; i += chunkSize) {
      const chunk = uint8Array.slice(i, i + chunkSize);
      base64Data += btoa(String.fromCharCode.apply(null, Array.from(chunk)));
    }
    
    console.log(`PDF file size: ${arrayBuffer.byteLength} bytes`);

    // Simulate PDF text extraction (in production, use a proper PDF parser)
    const extractedText = await extractTextFromPDF(base64Data);
    
    // Split text into chapters using AI
    const chapters = await splitIntoChapters(extractedText, book.title);
    
    // Generate summaries for each chapter
    const processedChapters = await Promise.all(
      chapters.map(async (chapter, index) => {
        const summary = await generateSummary(chapter.content, book.genre);
        const highlights = await extractHighlights(chapter.content);
        
        return {
          book_id: bookId,
          chapter_number: index + 1,
          part_number: 1,
          title: chapter.title,
          content: chapter.content,
          summary: summary,
          word_count: chapter.wordCount,
          reading_time_minutes: Math.ceil(chapter.wordCount / 200), // 200 words per minute
          highlight_quotes: highlights,
          metadata: {
            genre: book.genre,
            extraction_method: 'ai_split',
            processed_at: new Date().toISOString()
          }
        };
      })
    );

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
        totalReadingTime
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );

  } catch (error) {
    console.error('Error processing PDF:', error);
    
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});

async function extractTextFromPDF(base64Data: string): Promise<string> {
  // Simulated PDF text extraction - in production, integrate with a PDF parsing service
  // For now, return sample text that simulates a book
  return `Chapter 1: The Beginning

This is the opening chapter of our story, where we meet the main characters and establish the setting. The narrative begins in a small coastal town where mysteries unfold and adventures await.

Our protagonist, Sarah, discovers an old letter hidden in the attic of her grandmother's house. The letter speaks of treasures and secrets that have been kept for generations.

Chapter 2: The Discovery

Sarah decides to investigate the clues mentioned in the letter. She embarks on a journey that will change her life forever. The path leads her through ancient forests and forgotten ruins.

Along the way, she meets Thomas, a local historian who becomes her guide and companion. Together, they uncover the first piece of the puzzle that will lead them to an extraordinary discovery.

Chapter 3: The Quest

The adventure intensifies as Sarah and Thomas follow the trail of clues. They encounter challenges that test not only their resolve but also their growing friendship.

Each revelation brings them closer to the truth, but also deeper into danger. The stakes rise as they realize they're not the only ones searching for the treasure.

Chapter 4: The Revelation

In this climactic chapter, all the mysteries are revealed. Sarah discovers her true heritage and the reason why the treasure was hidden in the first place.

The final confrontation brings resolution to the story, but also opens new possibilities for future adventures. The characters have grown and changed through their journey.`;
}

async function splitIntoChapters(text: string, bookTitle: string): Promise<Array<{title: string, content: string, wordCount: number}>> {
  const openAIApiKey = Deno.env.get('OPENAI_API_KEY');
  
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
          content: `You are an expert book editor. Analyze the provided text and split it into logical chapters. Each chapter should be 1000-2000 words. If a chapter is longer, split it into parts. Return a JSON array where each object has: title, content, wordCount. Ensure chapters flow naturally and maintain narrative cohesion.`
        },
        {
          role: 'user',
          content: `Split this text from "${bookTitle}" into chapters:\n\n${text}`
        }
      ],
      temperature: 0.3,
    }),
  });

  const data = await response.json();
  
  if (!response.ok) {
    throw new Error(`OpenAI API error: ${data.error?.message || 'Unknown error'}`);
  }

  try {
    const chapters = JSON.parse(data.choices[0].message.content);
    return Array.isArray(chapters) ? chapters : [];
  } catch {
    // Fallback: simple chapter splitting
    const paragraphs = text.split('\n\n').filter(p => p.trim());
    const chapters = [];
    let currentChapter = { title: 'Chapter 1', content: '', wordCount: 0 };
    let chapterNum = 1;
    
    for (const paragraph of paragraphs) {
      if (paragraph.toLowerCase().includes('chapter') && currentChapter.content) {
        currentChapter.wordCount = currentChapter.content.split(' ').length;
        chapters.push(currentChapter);
        chapterNum++;
        currentChapter = { title: `Chapter ${chapterNum}`, content: paragraph, wordCount: 0 };
      } else {
        currentChapter.content += (currentChapter.content ? '\n\n' : '') + paragraph;
      }
    }
    
    if (currentChapter.content) {
      currentChapter.wordCount = currentChapter.content.split(' ').length;
      chapters.push(currentChapter);
    }
    
    return chapters;
  }
}

async function generateSummary(content: string, genre?: string): Promise<string> {
  const openAIApiKey = Deno.env.get('OPENAI_API_KEY');
  
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
          content: `Create a concise 100-200 word summary that captures the key events, character development, and narrative progression. ${genre ? `Adapt your tone for ${genre} genre.` : ''} Focus on plot advancement and emotional beats.`
        },
        {
          role: 'user',
          content: `Summarize this chapter:\n\n${content}`
        }
      ],
      temperature: 0.5,
      max_tokens: 300,
    }),
  });

  const data = await response.json();
  
  if (!response.ok) {
    throw new Error(`Summary generation failed: ${data.error?.message || 'Unknown error'}`);
  }

  return data.choices[0].message.content.trim();
}

async function extractHighlights(content: string): Promise<string[]> {
  const openAIApiKey = Deno.env.get('OPENAI_API_KEY');
  
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
          content: 'Extract 2-4 meaningful, memorable quotes or passages that capture the essence of this chapter. Return as a JSON array of strings. Focus on impactful dialogue, beautiful descriptions, or key plot moments.'
        },
        {
          role: 'user',
          content: `Extract highlights from:\n\n${content}`
        }
      ],
      temperature: 0.3,
      max_tokens: 400,
    }),
  });

  const data = await response.json();
  
  if (!response.ok) {
    return []; // Return empty array if highlights extraction fails
  }

  try {
    const highlights = JSON.parse(data.choices[0].message.content);
    return Array.isArray(highlights) ? highlights : [];
  } catch {
    return [];
  }
}