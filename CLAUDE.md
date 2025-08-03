# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
# Install dependencies
npm install

# Run development server (Vite at http://localhost:8080)
npm run dev

# Build for production
npm run build

# Build for development mode
npm run build:dev

# Run ESLint
npm run lint

# Preview production build
npm run preview
```

## Architecture Overview

This is a **Leaf Daily** application - a PDF book reader with chapter extraction and reading progress tracking, built with:

- **Frontend**: React 18 + TypeScript + Vite
- **UI**: shadcn/ui components + Tailwind CSS
- **Backend**: Supabase (PostgreSQL + Auth + Storage + Edge Functions)
- **State Management**: TanStack Query (React Query)
- **Routing**: React Router v6

### Key Architectural Patterns

1. **Component Structure**:
   - Pages in `/src/pages/` (Auth, Index, NotFound)
   - Business components in `/src/components/` (BookLibrary, BookReader, PDFUploader)
   - UI components in `/src/components/ui/` (shadcn/ui library)

2. **Authentication Flow**:
   - Managed via `useAuth` hook (`/src/hooks/useAuth.tsx`)
   - Supabase Auth with email/password
   - Protected routes redirect to `/auth` when unauthenticated

3. **PDF Processing**:
   - Upload handled by `PDFUploader` component
   - Processing via Supabase Edge Function (`/supabase/functions/process-pdf/`)
   - Uses `unpdf` library for text extraction
   - Intelligent chapter detection with multiple strategies

4. **Data Flow**:
   - Supabase client configured in `/src/integrations/supabase/client.ts`
   - Types auto-generated in `/src/integrations/supabase/types.ts`
   - React Query for data fetching and caching

### Database Schema

Key tables:
- `books`: Stores uploaded books with metadata and processing status
- `chapters`: Extracted chapters with content, summaries, and reading metadata
- Auth tables managed by Supabase

### Development Notes

- Path alias `@/` maps to `/src/`
- Lovable Tagger plugin active in development mode
- Supabase URL and keys are in the client configuration
- Edge Functions use Deno runtime

## Supabase Edge Functions Deep Dive

### Overview
The project uses Supabase Edge Functions (Deno Deploy) for server-side PDF processing. Edge functions are configured in `/supabase/config.toml` and located in `/supabase/functions/`.

### process-pdf Function (`/supabase/functions/process-pdf/index.ts`)

This is the core edge function that handles PDF text extraction and intelligent chapter detection.

#### Configuration
- **JWT Verification**: Disabled (`verify_jwt = false` in config.toml)
- **CORS**: Enabled with wildcard origin for development
- **Environment Variables Required**:
  - `SUPABASE_URL`: Supabase project URL
  - `SUPABASE_SERVICE_ROLE_KEY`: Service role key for admin operations
  - `OPENAI_API_KEY`: Optional, for AI-enhanced chapter processing

#### Processing Pipeline

1. **PDF Download**:
   - Downloads PDF from Supabase Storage bucket `book-pdfs`
   - Sanitizes filenames (removes special chars, replaces spaces with underscores)
   - Path format: `{user_id}/{sanitized_filename}`

2. **Text Extraction**:
   - Uses `unpdf` library (v1.1.0) for memory-efficient extraction
   - Converts PDF to text with options:
     - `mergePages: true` - Reduces memory usage
     - `disableCombineTextItems: false` - Better text flow

3. **Chapter Detection** (Multi-Strategy Approach):
   
   **Strategy 1: Advanced Pattern Matching**
   - Detects common chapter patterns:
     - `Chapter 1`, `CHAPTER 1`, `Chapter One`
     - `Ch. 1`, `CH. 1`
     - `Part 1`, `PART 1`
     - Numbered sections: `1. Title`, `1) Title`
     - Roman numerals: `I - Title`, `XV. Title`
   - Confidence: 0.9
   
   **Strategy 2: Content-Based Analysis**
   - Triggered when pattern matching finds < 2 chapters
   - Splits text into sentences
   - Creates chapters of ~3000 words (min 1500 words)
   - Uses first sentence or generic title
   - Confidence: 0.7
   
   **Strategy 3: Optimized Chunking (Fallback)**
   - Creates fixed-size chunks of 2500 words
   - Used when other methods fail
   - Confidence: 0.5

4. **Text Cleanup**:
   - Removes page numbers and headers/footers
   - Normalizes whitespace
   - Removes form feeds and excessive line breaks

5. **Database Storage**:
   - Creates chapter records with:
     - Content and word count
     - Reading time (200 words/min)
     - Detection metadata (method, confidence)
     - Placeholder for AI summaries
   - Updates book with total word count and reading time

#### AI Enhancement (Optional)
- Uses OpenAI GPT-4o-mini when API key is available
- Enhances each chapter with:
  - Improved title (max 80 chars)
  - Reformatted content with proper paragraphs
  - 100-200 word summary
  - 3-5 key quotes
- Fallback to original content if AI fails

#### Error Handling
- Updates book status to 'failed' on errors
- Returns detailed error messages
- Logs progress at each stage

#### Performance Considerations
- Memory-efficient PDF processing
- Processes chapters sequentially to avoid timeouts
- AI enhancement commented out by default (timeout risk)
- Typical processing: 50-500 chapters per book

### Local Development with Edge Functions

```bash
# Install Supabase CLI
npm install -g supabase

# Start local Supabase (includes edge functions)
supabase start

# Deploy edge function to local instance
supabase functions serve process-pdf --env-file ./supabase/.env.local

# Deploy to production
supabase functions deploy process-pdf
```

### Debugging Edge Functions
- Check function logs: `supabase functions logs process-pdf`
- Test locally with curl or Postman
- Monitor Supabase dashboard for execution metrics

## Supabase Edge Functions - Deep Dive

The application uses a sophisticated microservice architecture built on Supabase Edge Functions (Deno runtime). Each function is highly specialized for specific parts of the PDF processing pipeline.

### 1. process-pdf-orchestrator (`/supabase/functions/process-pdf-orchestrator/index.ts`)

**Primary Role**: Workflow coordination, caching strategy, and job queue management

#### Core Responsibilities
- **Workflow Initialization**: Sets up the entire processing pipeline with version tracking
- **Full Workflow Caching**: Checks for complete cached results to avoid reprocessing
- **Job Queue Management**: Enqueues jobs with priority levels and dependencies
- **Progress Coordination**: Manages overall progress tracking across all stages
- **Error Recovery**: Handles workflow-level failures and rollback

#### Key Interfaces
```typescript
interface WorkflowConfig {
  enableCaching: boolean;
  enableAsyncEnhancement: boolean; 
  priorityLevel: number;
  maxRetries: number;
  timeoutSeconds: number;
}
```

#### Processing Flow
1. **Input Validation**: Validates bookId and optional config parameters
2. **Workflow Initialization**: Updates book status to 'processing' with version 'v2_optimized'
3. **Cache Lookup**: Checks for full workflow cache using content-based keys
4. **Cache Restoration**: If found, restores chapters and updates book status instantly
5. **Job Enqueueing**: If not cached, enqueues first job (extract_text) with priority
6. **Time Estimation**: Calculates completion time based on file size and config

#### Caching Strategy
- **Cache Key**: `workflow_v2:${userId}:${fileName}:${fileSize}:${title}` (SHA-256 hash)
- **Full Restoration**: Restores complete chapters with metadata, summaries, and quotes
- **Performance**: Instant completion for previously processed identical files

#### Configuration Options
- **Priority Levels**: 1-10 (1=highest priority, affects processing speed)
- **Timeout Management**: Default 15-minute workflow timeout
- **Enhancement Control**: Toggle AI enhancement for cost/speed optimization
- **Retry Logic**: Up to 2 retries with exponential backoff

#### Error Handling
- Updates book status to 'failed' on any critical error
- Provides detailed error messages in progress tracking
- Implements cleanup for failed workflows

### 2. extract-pdf-text (`/supabase/functions/extract-pdf-text/index.ts`)

**Primary Role**: Memory-optimized PDF text extraction with intelligent caching

#### Core Responsibilities
- **PDF Download**: Securely downloads PDFs from Supabase Storage
- **Text Extraction**: Uses `unpdf` library with memory optimization
- **Content Cleaning**: Removes headers, footers, and formatting artifacts
- **Progress Tracking**: Provides granular progress updates (5% → 15% overall)
- **Caching**: Stores extraction results for identical files

#### Technical Implementation
```typescript
interface ExtractionResult {
  text: string;
  metadata: {
    totalPages: number;
    totalCharacters: number;
    totalWords: number;
    extractionMethod: string;
    processingTime: number;
    fileSize: number;
    textHash: string;
  };
}
```

#### PDF Processing Pipeline
1. **File Download**: Downloads from `book-pdfs/{user_id}/{sanitized_filename}`
2. **Memory Management**: Converts to ArrayBuffer then Uint8Array for efficient processing
3. **Text Extraction**: Uses unpdf with `mergePages: true` and progress callbacks
4. **Content Cleaning**: Removes page numbers, headers, excessive whitespace
5. **Metadata Generation**: Calculates word count, estimates pages, generates content hash
6. **Database Updates**: Updates book with total pages and word count

#### Optimization Features
- **Streaming Support**: Progress callbacks for large files
- **Memory Efficiency**: Uses mergePages to reduce memory footprint
- **File Sanitization**: Handles special characters in filenames
- **Error Recovery**: Graceful handling of corrupted or unsupported PDFs

#### Caching Mechanism
- **Cache Key**: SHA-256 hash of `${userId}:${fileName}:${fileSize}`
- **Storage**: Complete extraction result with metadata
- **Validation**: Content hash verification for integrity
- **Performance**: Instant results for previously processed files

### 3. detect-chapters (`/supabase/functions/detect-chapters/index.ts`)

**Primary Role**: Intelligent chapter detection using multiple AI strategies

#### Core Responsibilities
- **Multi-Strategy Detection**: Runs 4 parallel detection algorithms
- **Pattern Recognition**: Advanced regex patterns for chapter markers
- **Semantic Analysis**: Content-based boundary detection
- **Adaptive Processing**: Document type-aware strategy selection
- **Boundary Optimization**: Ensures natural reading breaks

#### Detection Strategies

**1. Pattern-Based Detection (Confidence: 0.95)**
```typescript
// Advanced patterns with multiple formats
- /^(?:Chapter|CHAPTER)\s+(\d+|[IVXLCDM]+|One|Two...)(?:\s*[:\.\-]\s*(.*))?$/gim
- /^(?:Part|PART)\s+(\d+|[IVXLCDM]+)(?:\s*[:\.\-]\s*(.*))?$/gim  
- /^(\d+)[\.\)]\s+(.{10,80})$/gm
- /^[A-Z\s]{3,50}$/gm // All caps headers
```

**2. Structural Detection (Confidence: 0.7)**
- Analyzes document structure (page breaks, line breaks, formatting)
- Identifies major structural breaks using triple line breaks
- Calculates break strength based on context
- Creates chapters from significant structural boundaries

**3. Semantic Detection (Confidence: 0.6-0.8)**
- Analyzes sentence-level semantic shifts
- Detects topic changes, character introductions, scene changes
- Optimizes chapter length (1200-4000 words)
- Uses content analysis for natural boundaries

**4. Adaptive Detection (Confidence: 0.8)**
- Document type detection (short_form, academic, narrative, etc.)
- Strategy selection based on content characteristics
- Word count-based optimization
- Genre-aware processing

#### Chapter Optimization
- **Boundary Refinement**: Ensures chapters end at sentence boundaries
- **Size Balancing**: Maintains optimal reading lengths
- **Content Validation**: Minimum content thresholds
- **Title Generation**: Intelligent title extraction or generation

#### Selection Algorithm
Scores each detection result based on:
- Base confidence score (40%)
- Chapter count reasonableness (30%)
- Content consistency (20%)
- Method preference (10%)

### 4. store-chapters (`/supabase/functions/store-chapters/index.ts`)

**Primary Role**: Optimized database storage with batch processing

#### Core Responsibilities
- **Chapter Validation**: Ensures data quality and completeness
- **Batch Processing**: Optimized database insertions (10 chapters per batch)
- **Metadata Generation**: Calculates reading times and extracts quotes
- **Book Statistics**: Updates aggregated book metrics
- **Enhancement Queuing**: Enqueues AI enhancement jobs

#### Data Processing Pipeline
1. **Validation**: Checks title, content, word count minimums
2. **Sanitization**: Ensures proper field lengths and formats
3. **Metadata Enhancement**: Calculates reading time (200 words/min)
4. **Quote Extraction**: Identifies potential highlight quotes
5. **Batch Insertion**: Groups chapters for efficient database writes
6. **Statistics Calculation**: Updates book-level aggregated data
7. **Enhancement Scheduling**: Enqueues async AI processing jobs

#### Batch Processing Optimization
```typescript
// Optimized batch size for Supabase performance
const batchSize = 10;

// Fallback to individual inserts on batch failure
// Progress tracking per batch
// 100ms delay between batches to prevent overload
```

#### Quote Extraction Heuristics
- Quoted text patterns: `"([^"]{20,200})"`
- Important phrase detection: "The key is", "Remember that", etc.
- Sentence analysis for meaningful content
- Maximum 5 quotes per chapter

#### Enhancement Job Scheduling
- Batches chapters into groups of 5 for AI processing
- Staggered priority levels (5, 6, 7...) for fair processing
- Includes chapter metadata for context

### 5. enhance-chapters-async (`/supabase/functions/enhance-chapters-async/index.ts`)

**Primary Role**: AI-powered chapter summarization with rate limiting

#### Core Responsibilities
- **OpenAI Integration**: GPT-4o-mini for chapter summarization
- **Rate Limiting**: Sophisticated throttling to prevent API overuse
- **Batch Processing**: Processes multiple chapters concurrently
- **Error Recovery**: Individual chapter failure handling
- **Progress Tracking**: Granular progress updates (50% → 95% overall)

#### AI Processing Pipeline
1. **Batch Coordination**: Handles batches of 5 chapters from store-chapters
2. **Database Sync**: Fetches actual chapter IDs and content
3. **Rate Limit Management**: Enforces API limits and concurrent request caps
4. **Summary Generation**: Creates 100-300 word chapter summaries
5. **Database Updates**: Stores summaries with enhancement metadata
6. **Status Tracking**: Updates book-level enhancement status

#### Rate Limiting Configuration
```typescript
const RATE_LIMIT = {
  requestsPerMinute: 20,
  requestsPerHour: 300, 
  maxConcurrentRequests: 5,
  baseDelay: 500,
  backoffMultiplier: 2,
  maxRetries: 3
};
```

#### OpenAI Integration
- **Model**: GPT-4o-mini for cost-effective summarization
- **Prompt Optimization**: Truncated content (4000 chars) for faster processing
- **JSON Response**: Structured output with validation
- **Temperature**: 0.1 for consistent, focused summaries
- **Token Limit**: 400 tokens for 100-300 word summaries

#### Error Handling Strategy
- **Individual Failures**: Continue processing other chapters
- **Retry Logic**: Exponential backoff for temporary failures
- **Fallback Summaries**: Basic summaries when AI fails
- **Status Tracking**: Mark failed chapters in database

#### Concurrent Processing
- Processes 3 chapters simultaneously within rate limits
- Batch-by-batch processing to prevent timeouts
- Progress updates per chapter for real-time feedback

### 6. get-processing-status (`/supabase/functions/get-processing-status/index.ts`)

**Primary Role**: Real-time processing status monitoring and reporting

#### Core Responsibilities
- **Status Aggregation**: Combines data from books, progress, jobs, and chapters
- **Stage Tracking**: Detailed progress for each processing stage
- **Time Estimation**: Calculates remaining processing time
- **Metrics Collection**: Gathers performance and cache statistics
- **Error Reporting**: Provides detailed error information

#### Status Interface
```typescript
interface ProcessingStatus {
  bookId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  currentStage: string;
  overallProgress: number;
  stageProgress: number;
  message: string;
  estimatedCompletionTime?: string;
  stages: StageStatus[];
  metrics: ProcessingMetrics;
}
```

#### Stage Monitoring
Tracks 5 main stages:
1. **Uploading** (0-5%): File upload and validation
2. **Extracting Text** (5-15%): PDF text extraction
3. **Detecting Chapters** (15-30%): Chapter boundary detection  
4. **Storing Chapters** (30-50%): Database storage
5. **Enhancing Chapters** (50-95%): AI summarization

#### Data Sources
- **Books Table**: Overall status, timestamps, metadata
- **Processing Progress**: Real-time stage updates
- **Processing Jobs**: Queue status and timing
- **Chapters**: Enhancement status and metrics

#### Time Estimation Algorithm
```typescript
// Progress rate calculation
const progressRate = currentProgress / elapsedMinutes;
const remainingProgress = 100 - currentProgress;
const estimatedMinutes = remainingProgress / Math.max(progressRate, 0.1);

// Capped between 1-30 minutes
const cappedMinutes = Math.min(Math.max(estimatedMinutes, 1), 30);
```

#### Metrics Collection
- **Performance**: Processing times, cache hit rates
- **Quality**: Chapter counts, word counts, enhancement status
- **Efficiency**: Cache utilization, job queue performance

### 7. Legacy process-pdf (`/supabase/functions/process-pdf/index.ts`)

**Primary Role**: Monolithic PDF processing (being phased out)

#### Current Status
- **Legacy Function**: Original monolithic implementation  
- **Still Active**: Handles some processing until migration complete
- **Single Responsibility**: All-in-one PDF to chapters conversion
- **No Enhancement**: Skips AI processing to avoid timeouts

#### Key Differences from Microservices
- **Monolithic**: All processing in single function call
- **Limited Caching**: Basic text extraction caching only
- **No Job Queue**: Synchronous processing
- **Simplified Enhancement**: Placeholder for AI summaries
- **Timeout Risk**: Long processing times for large documents

#### Migration Strategy
- **Parallel Operation**: Both systems run during transition
- **Feature Parity**: Microservices provide same functionality
- **Performance**: Microservices offer better scalability
- **Future**: Will be deprecated once microservices proven stable

### Microservice Architecture Benefits

#### Scalability
- **Independent Scaling**: Each function scales based on demand
- **Resource Optimization**: CPU/memory allocated per function needs
- **Parallel Processing**: Multiple stages can run simultaneously

#### Reliability
- **Fault Isolation**: Function failures don't affect entire pipeline
- **Retry Logic**: Individual stage retries with exponential backoff
- **Graceful Degradation**: Partial processing completion possible

#### Performance
- **Intelligent Caching**: Multi-level caching (text, chapters, full workflow)
- **Job Prioritization**: High-priority jobs processed first
- **Concurrent Processing**: Parallel chapter processing within limits

#### Observability
- **Granular Progress**: Stage-by-stage progress tracking
- **Detailed Metrics**: Processing times, cache hits, error rates
- **Real-time Monitoring**: Live status updates via get-processing-status

#### Cost Optimization
- **Pay-per-execution**: Only pay for actual processing time
- **Cache Efficiency**: Avoid reprocessing identical content
- **Resource Right-sizing**: Each function optimized for its task

### Database Schema Integration

#### Core Tables
- **`books`**: Enhanced with `workflow_version`, `enhancement_status`, processing timestamps
- **`chapters`**: Includes `enhancement_status`, `ai_model_used`, processing metadata
- **`processing_jobs`**: Job queue with priorities, dependencies, retry counts
- **`processing_cache`**: Multi-level caching with hit tracking and cleanup
- **`processing_progress`**: Real-time stage and overall progress tracking

#### Key Database Functions
- **`enqueue_job()`**: Adds jobs to priority queue with dependencies
- **`get_next_job()`**: Retrieves highest priority pending job
- **`update_processing_progress()`**: Updates progress with stage details
- **`get_cached_result()`** / **`store_cached_result()`**: Cache management
- **`cleanup_old_cache()`**: Maintenance for cache optimization

### Edge Function Development and Testing

#### Local Development
```bash
# Start local Supabase with all functions
supabase start

# Serve specific function locally
supabase functions serve process-pdf-orchestrator --env-file ./supabase/.env.local

# Deploy single function
supabase functions deploy extract-pdf-text

# Deploy all functions
supabase functions deploy
```

#### Function Testing
```bash
# Check function logs
supabase functions logs process-pdf-orchestrator --follow

# Test function with curl
curl -X POST 'http://localhost:54321/functions/v1/extract-pdf-text' \
  -H 'Authorization: Bearer YOUR_ANON_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"bookId":"test-book-id"}'
```

#### Edge Function Environment Variables
```bash
# Required for all functions
SUPABASE_URL=your_project_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# Optional for AI enhancement
OPENAI_API_KEY=your_openai_key
```

#### Testing and Quality Assurance

#### Running Tests
```bash
# No specific test framework configured
# Check for test files in the project
find . -name "*.test.*" -o -name "*.spec.*"
```

#### Code Quality
```bash
# Type checking (if TypeScript)
npx tsc --noEmit

# Linting
npm run lint

# Check for unused dependencies
npx depcheck
```

### Deployment

#### Frontend Deployment
- Built with Vite for optimized production builds
- Hosted via Lovable platform (auto-deployment on git push)
- Manual deployment: `npm run build` then serve `dist/` folder

#### Supabase Deployment
```bash
# Deploy all edge functions
supabase functions deploy

# Deploy specific function
supabase functions deploy process-pdf-orchestrator

# Apply database migrations
supabase db push

# Check deployment status
supabase status

# View function logs in production
supabase functions logs process-pdf-orchestrator
```

#### Production Monitoring
```bash
# Monitor function performance
supabase functions logs --follow

# Check database performance
supabase db inspect

# Monitor cache hit rates via get-processing-status
curl 'https://your-project.supabase.co/functions/v1/get-processing-status?bookId=xyz&detailed=true'
```