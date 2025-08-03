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

interface ProcessingStatus {
  bookId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  currentStage: string;
  overallProgress: number;
  stageProgress: number;
  message: string;
  estimatedCompletionTime?: string;
  startedAt?: string;
  completedAt?: string;
  stages: StageStatus[];
  metrics: ProcessingMetrics;
  performance?: PerformanceMetrics;
  workflow?: WorkflowInfo;
  error?: string;
}

interface StageStatus {
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: number;
  duration?: number;
  startTime?: string;
  endTime?: string;
  message?: string;
}

interface ProcessingMetrics {
  totalWordCount?: number;
  totalChapters?: number;
  totalReadingTime?: number;
  processingTime?: number;
  cacheHits: number;
  enhancementStatus?: string;
  chaptersEnhanced?: number;
  chaptersFailed?: number;
}

interface PerformanceMetrics {
  memoryUsagePeakMB?: number;
  cacheHitRate?: number;
  qualityScore?: number;
  optimizationLevel: string;
  apiCallsCount?: number;
}

interface WorkflowInfo {
  strategy: string;
  version: string;
  optimizationLevel: string;
  retryCount: number;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const bookId = url.searchParams.get('bookId');
    const bookIds = url.searchParams.get('bookIds')?.split(',') || [];
    const detailed = url.searchParams.get('detailed') === 'true';
    const includePerformance = url.searchParams.get('includePerformance') === 'true';
    
    if (!bookId && bookIds.length === 0) {
      return new Response(
        JSON.stringify({ error: 'bookId or bookIds parameter is required' }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      );
    }

    const targetBookIds = bookId ? [bookId] : bookIds;
    console.log(`[STATUS] Getting processing status for books: ${targetBookIds.join(', ')}`);

    if (targetBookIds.length === 1) {
      const status = await getProcessingStatus(targetBookIds[0], detailed, includePerformance);
      return new Response(
        JSON.stringify(status),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    } else {
      const statuses = await getBatchProcessingStatus(targetBookIds, includePerformance);
      return new Response(
        JSON.stringify(statuses),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

  } catch (error: any) {
    console.error('[STATUS] Error:', error);
    
    // Provide more detailed error information
    const errorResponse = {
      error: error.message || 'Unknown error occurred',
      details: error.details || null,
      hint: error.hint || null,
      code: error.code || null
    };
    
    return new Response(
      JSON.stringify(errorResponse),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
});

async function getProcessingStatus(bookId: string, detailed: boolean): Promise<ProcessingStatus> {
  // Get book information
  const { data: book, error: bookError } = await supabase
    .from('books')
    .select('*')
    .eq('id', bookId)
    .single();

  if (bookError) {
    console.error('[STATUS] Database error fetching book:', bookError);
    throw new Error(`Database error: ${bookError.message}`);
  }
  
  if (!book) {
    throw new Error('Book not found');
  }

  // Get progress information
  let progressData: any[] = [];
  try {
    const { data, error: progressError } = await supabase
      .from('processing_progress')
      .select('*')
      .eq('book_id', bookId)
      .order('updated_at', { ascending: false })
      .limit(10);

    if (progressError) {
      console.warn('[STATUS] Failed to get progress data:', progressError);
    } else {
      progressData = data || [];
    }
  } catch (error) {
    console.warn('[STATUS] Processing progress table might not exist:', error);
  }

  // Get job queue information (if detailed)
  let jobData: any[] = [];
  if (detailed) {
    try {
      const { data, error } = await supabase
        .from('processing_jobs')
        .select('*')
        .eq('book_id', bookId)
        .order('created_at', { ascending: false })
        .limit(20);
      
      if (!error && data) {
        jobData = data;
      } else if (error) {
        console.warn('[STATUS] Failed to get job data:', error);
      }
    } catch (error) {
      console.warn('[STATUS] Processing jobs table might not exist:', error);
    }
  }

  // Get chapter information for metrics
  const { data: chapterData, error: chapterError } = await supabase
    .from('chapters')
    .select('id, word_count')
    .eq('book_id', bookId);
  
  if (chapterError) {
    console.warn('[STATUS] Failed to get chapter data:', chapterError);
  }

  // Build comprehensive status
  try {
    const status = buildProcessingStatus(book, progressData || [], jobData, chapterData || [], detailed);
    return status;
  } catch (error) {
    console.error('[STATUS] Error building status:', error);
    
    // Return a basic fallback status
    return {
      bookId: book.id,
      status: book.processing_status || 'pending',
      currentStage: 'unknown',
      overallProgress: 0,
      stageProgress: 0,
      message: 'Status information temporarily unavailable',
      stages: [],
      metrics: { cacheHits: 0 },
      error: 'Unable to build detailed status'
    };
  }
}

function buildProcessingStatus(
  book: any, 
  progressData: any[], 
  jobData: any[], 
  chapterData: any[], 
  detailed: boolean
): ProcessingStatus {
  
  // Determine current stage and overall progress
  const latestProgress = progressData[0];
  const currentStage = latestProgress?.stage || 'pending';
  const overallProgress = latestProgress?.overall_progress || 0;
  const stageProgress = latestProgress?.stage_progress || 0;
  const message = latestProgress?.message || getDefaultMessage(book.processing_status);

  // Build stage statuses
  const stages = buildStageStatuses(progressData, jobData, book);

  // Calculate metrics
  const metrics = calculateMetrics(book, chapterData, jobData);

  // Estimate completion time if still processing
  let estimatedCompletionTime: string | undefined;
  if (book.processing_status === 'processing') {
    estimatedCompletionTime = estimateCompletionTime(book, progressData, overallProgress);
  }

  // Determine if there's an error
  const errorMessage = book.processing_status === 'failed' 
    ? (latestProgress?.message || 'Processing failed')
    : undefined;

  const status: ProcessingStatus = {
    bookId: book.id,
    status: book.processing_status,
    currentStage,
    overallProgress,
    stageProgress,
    message,
    estimatedCompletionTime,
    startedAt: book.processing_started_at,
    completedAt: book.processing_completed_at,
    stages,
    metrics,
    error: errorMessage
  };

  return status;
}

function buildStageStatuses(progressData: any[], jobData: any[], book: any): StageStatus[] {
  const stageOrder = [
    'uploading',
    'extracting_text', 
    'detecting_chapters',
    'storing_chapters',
    'enhancing_chapters'
  ];

  const stages: StageStatus[] = [];

  for (const stageName of stageOrder) {
    const stageProgress = progressData.find(p => p.stage === stageName);
    const stageJobs = jobData.filter(j => getJobStage(j.job_type) === stageName);
    
    let status: 'pending' | 'running' | 'completed' | 'failed' = 'pending';
    let progress = 0;
    let duration: number | undefined;
    let startTime: string | undefined;
    let endTime: string | undefined;
    let message: string | undefined;

    if (stageProgress) {
      progress = stageProgress.stage_progress || 0;
      message = stageProgress.message;
      
      if (progress >= 100) {
        status = 'completed';
      } else if (progress > 0) {
        status = 'running';
      }
    }

    // Check job data for more precise timing
    const completedJobs = stageJobs.filter(j => j.status === 'completed');
    const runningJobs = stageJobs.filter(j => j.status === 'running');
    const failedJobs = stageJobs.filter(j => j.status === 'failed');

    if (failedJobs.length > 0) {
      status = 'failed';
      message = failedJobs[0].error_message || 'Stage failed';
    } else if (completedJobs.length > 0) {
      status = 'completed';
      progress = 100;
      startTime = completedJobs[0].started_at;
      endTime = completedJobs[0].completed_at;
      if (startTime && endTime) {
        duration = Math.round((new Date(endTime).getTime() - new Date(startTime).getTime()) / 1000);
      }
    } else if (runningJobs.length > 0) {
      status = 'running';
      startTime = runningJobs[0].started_at;
    }

    // Special handling for enhancement stage
    if (stageName === 'enhancing_chapters' && book.enhancement_status) {
      if (book.enhancement_status === 'completed') {
        status = 'completed';
        progress = 100;
      } else if (book.enhancement_status === 'processing') {
        status = 'running';
      } else if (book.enhancement_status === 'failed') {
        status = 'failed';
      }
    }

    stages.push({
      name: stageName,
      status,
      progress,
      duration,
      startTime,
      endTime,
      message
    });
  }

  return stages;
}

function getJobStage(jobType: string): string {
  const jobStageMap: Record<string, string> = {
    'extract_text': 'extracting_text',
    'detect_chapters': 'detecting_chapters',
    'store_chapters': 'storing_chapters',
    'enhance_chapters': 'enhancing_chapters'
  };
  
  return jobStageMap[jobType] || jobType;
}

function calculateMetrics(book: any, chapterData: any[], jobData: any[]): ProcessingMetrics {
  const metrics: ProcessingMetrics = {
    cacheHits: 0
  };

  // Basic book metrics
  if (book.total_word_count) metrics.totalWordCount = book.total_word_count;
  if (book.estimated_total_reading_time) metrics.totalReadingTime = book.estimated_total_reading_time;
  if (book.enhancement_status) metrics.enhancementStatus = book.enhancement_status;

  // Chapter metrics
  if (chapterData.length > 0) {
    metrics.totalChapters = chapterData.length;
    
    // If book doesn't have word count, calculate from chapters
    if (!metrics.totalWordCount) {
      metrics.totalWordCount = chapterData.reduce((sum, ch) => sum + (ch.word_count || 0), 0);
    }
  }

  // Processing time metrics
  if (book.processing_started_at && book.processing_completed_at) {
    const startTime = new Date(book.processing_started_at).getTime();
    const endTime = new Date(book.processing_completed_at).getTime();
    metrics.processingTime = Math.round((endTime - startTime) / 1000);
  }

  // Cache hit metrics from job data
  for (const job of jobData) {
    if (job.output_data && job.output_data.cached) {
      metrics.cacheHits++;
    }
  }

  return metrics;
}

function estimateCompletionTime(book: any, progressData: any[], currentProgress: number): string {
  try {
    const startTime = book.processing_started_at ? new Date(book.processing_started_at).getTime() : Date.now();
    const elapsedMinutes = (Date.now() - startTime) / (1000 * 60);
    
    if (currentProgress <= 0) {
      // Default estimation if no progress yet
      return new Date(Date.now() + 10 * 60 * 1000).toISOString();
    }

    // Calculate remaining time based on current progress rate
    const progressRate = currentProgress / elapsedMinutes; // progress per minute
    const remainingProgress = 100 - currentProgress;
    const estimatedRemainingMinutes = remainingProgress / Math.max(progressRate, 0.1);

    // Cap the estimation between 1 minute and 30 minutes
    const cappedMinutes = Math.min(Math.max(estimatedRemainingMinutes, 1), 30);
    
    return new Date(Date.now() + cappedMinutes * 60 * 1000).toISOString();

  } catch (error) {
    console.warn('[STATUS] Failed to estimate completion time:', error);
    return new Date(Date.now() + 5 * 60 * 1000).toISOString();
  }
}

function getDefaultMessage(status: string): string {
  const messages: Record<string, string> = {
    'pending': 'Waiting to start processing...',
    'processing': 'Processing your document...',
    'completed': 'Processing completed successfully!',
    'failed': 'Processing failed. Please try again.'
  };
  
  return messages[status] || 'Unknown status';
}