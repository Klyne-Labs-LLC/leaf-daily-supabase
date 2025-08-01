# Microservice Architecture Implementation Plan
## Edge Functions Workflow Optimization

### Executive Summary

This document outlines the technical implementation plan for converting the monolithic PDF processing system into a scalable microservice architecture using Supabase Edge Functions. The new architecture provides better error handling, caching, progress tracking, and horizontal scalability.

### Current State Analysis

**Existing Functions:**
- `process-pdf` (494 lines) - Monolithic processing
- `process-pdf-orchestrator` (333 lines) - Workflow coordination

**Database Schema:**
- ✅ `processing_jobs` - Job queue management
- ✅ `processing_cache` - Result caching  
- ✅ `processing_progress` - Real-time progress tracking
- ✅ Supporting functions: `enqueue_job`, `update_processing_progress`, etc.

## Microservice Architecture Design

### 1. Function Decomposition

#### A. extract-pdf-text
**Purpose:** PDF text extraction with caching
**Input:** `{ bookId, workflowId, priority }`
**Output:** `{ text, metadata: { extractionMethod, fileSize, characterCount, extractedAt, processingTimeMs } }`

**Key Features:**
- PDF download from Supabase Storage
- Memory-optimized text extraction using `unpdf`
- Intelligent caching based on file hash
- Progress tracking (10% → 15% overall)
- Error handling and retry support

**Cache Key:** `text_extraction_v2:${userId}:${fileName}:${fileSize}`

#### B. detect-chapters  
**Purpose:** Intelligent chapter detection with multiple strategies
**Input:** `{ bookId, workflowId, extracted_text, priority }`
**Output:** `{ chapters[], metadata: { totalChapters, detectionMethod, avgConfidence } }`

**Detection Strategies:**
1. **Advanced Pattern Matching** (Confidence: 0.9)
   - Chapter/CHAPTER + numbers/roman numerals
   - Part/PART patterns
   - Numbered sections (1., 2., etc.)

2. **Content Analysis** (Confidence: 0.7)
   - Sentence-based splitting
   - 3000 words target per chapter
   - Smart boundary detection

3. **Optimized Chunking** (Confidence: 0.5)
   - Fixed 2500-word chunks
   - Fallback method

**Progress Tracking:** 20% → 30% overall

#### C. store-chapters
**Purpose:** Database storage with batch processing
**Input:** `{ bookId, workflowId, detected_chapters, priority }`
**Output:** `{ success, chaptersStored, totalWordCount, totalReadingTime, enhancementQueued }`

**Features:**
- Batch insertion (50 chapters per batch)
- Existing chapter cleanup
- Book metadata updates
- AI enhancement job queuing
- Progress tracking (40% → 50% overall)

#### D. enhance-chapters-async
**Purpose:** AI-powered chapter enhancement
**Input:** `{ bookId, workflowId, chapter_count, enhancement_type }`
**Output:** `{ success, enhanced, skipped, processingTime }`

**AI Enhancement:**
- OpenAI GPT-4o-mini integration
- Batch processing (3 chapters at a time)
- Rate limiting and error handling
- Individual chapter failure handling
- Progress tracking (60% → 95% overall)

**Enhancement Features:**
- Improved chapter titles
- Content formatting and cleanup
- 100-200 word summaries
- 3-5 key quotes extraction

#### E. get-processing-status
**Purpose:** Real-time status monitoring
**Input:** `{ bookIds[] }`
**Output:** `{ bookId, currentStage, stageProgress, overallProgress, message, estimatedCompletion }`

### 2. API Contracts & Data Flow

```typescript
// Workflow Pipeline
orchestrator → extract-pdf-text → detect-chapters → store-chapters → enhance-chapters-async
     ↓              ↓                   ↓               ↓                ↓
  progress      progress           progress       progress         progress
   (5%)         (15%)              (30%)          (50%)            (95%)
```

### 3. Database Enhancements

#### New Migration: `20250801170000_microservice_enhancements.sql`

**New Functions:**
- `get_next_job()` - Job queue processing
- `get_processing_status()` - Status monitoring  
- `cleanup_old_cache()` - Cache maintenance
- `retry_failed_job()` - Error recovery
- `estimate_processing_time()` - Time estimation

**Schema Extensions:**
```sql
-- Enhanced book tracking
ALTER TABLE books ADD COLUMN workflow_version TEXT DEFAULT 'v2_optimized';
ALTER TABLE books ADD COLUMN enhancement_status TEXT DEFAULT 'pending';

-- Chapter enhancement tracking  
ALTER TABLE chapters ADD COLUMN enhancement_status TEXT DEFAULT 'pending';
ALTER TABLE chapters ADD COLUMN ai_model_used TEXT;

-- Job dependencies
ALTER TABLE processing_jobs ADD COLUMN depends_on_job UUID;
ALTER TABLE processing_jobs ADD COLUMN retry_count INTEGER DEFAULT 0;
```

**Performance Indexes:**
- `idx_processing_jobs_status_priority` - Job queue optimization
- `idx_processing_cache_type_key` - Cache lookups
- `idx_chapters_book_enhancement` - Enhancement tracking

### 4. Caching Strategy

#### Cache Types & Keys
1. **Text Extraction:** `text_extraction_v2:${hash}`
2. **Chapter Detection:** `chapter_detection_v2:${textHash}:${bookTitle}`  
3. **Full Workflow:** `workflow_v2:${userId}:${fileName}:${fileSize}:${title}`

#### Cache Policies
- **Hit Tracking:** Increment hit count on access
- **Cleanup:** Remove entries older than 30 days with <2 hits
- **Size Limits:** Cache large results (>1MB) with compression
- **Invalidation:** Hash-based content verification

### 5. Job Queue Mechanism

#### Queue Processing
```sql
-- Get next job with priority and FIFO ordering
SELECT * FROM processing_jobs 
WHERE status = 'pending' 
ORDER BY priority ASC, created_at ASC 
FOR UPDATE SKIP LOCKED;
```

#### Job States
- `pending` → `running` → `completed`/`failed`
- Automatic retry up to 3 times
- Job dependencies for workflow ordering
- Priority levels (1=highest, 10=lowest)

#### Error Handling
- Individual job failure isolation
- Workflow-level error propagation
- Detailed error logging with context
- Automatic retry with exponential backoff

### 6. Monitoring & Observability

#### Progress Tracking
- **Stage-level:** Individual function progress (0-100%)
- **Overall:** Workflow completion percentage (0-100%)
- **Real-time:** WebSocket or polling updates
- **Estimation:** Historical data-based completion times

#### Metrics Collection
- Processing times per function
- Cache hit rates by type
- Error rates and failure patterns
- Resource usage patterns

#### Logging Standards
```typescript
console.log(`[FUNCTION-NAME] Message with ${bookId}`);
console.error(`[FUNCTION-NAME] Error:`, error);
console.warn(`[FUNCTION-NAME] Warning:`, warning);
```

### 7. Deployment Strategy

#### Function Dependencies
```yaml
# supabase/config.toml
[functions.extract-pdf-text]
verify_jwt = false

[functions.detect-chapters]  
verify_jwt = false

[functions.store-chapters]
verify_jwt = false

[functions.enhance-chapters-async]
verify_jwt = false

[functions.get-processing-status]
verify_jwt = false
```

#### Environment Variables
- `SUPABASE_URL` - Project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Admin access
- `OPENAI_API_KEY` - AI enhancement (optional)

#### Deployment Commands
```bash
# Deploy all functions
supabase functions deploy

# Deploy individual function
supabase functions deploy extract-pdf-text

# Run database migrations  
supabase db push
```

### 8. Performance Optimizations

#### Memory Management
- Stream processing for large files
- Batch operations for bulk inserts
- Connection pooling for database access
- Garbage collection optimization

#### Concurrency
- Parallel job processing
- Non-blocking I/O operations
- Rate limiting for external APIs
- Resource contention management

#### Scalability
- Horizontal function scaling
- Database connection management
- Cache distribution
- Load balancing strategies

### 9. Testing Strategy

#### Unit Tests
- Individual function logic
- Error handling scenarios
- Cache behavior verification
- Data transformation accuracy

#### Integration Tests
- End-to-end workflow testing
- Database interaction validation
- External API integration
- Performance benchmarking

#### Load Testing
- Concurrent job processing
- Large file handling
- Cache performance under load
- Database scaling limits

### 10. Migration Path

#### Phase 1: Infrastructure (Complete)
- ✅ Database schema enhancements
- ✅ Job queue functions
- ✅ Progress tracking system

#### Phase 2: Core Functions (In Progress)
- ⚠️ extract-pdf-text implementation
- ⚠️ detect-chapters implementation  
- ⚠️ store-chapters implementation

#### Phase 3: Enhancement (Pending)
- ⏳ enhance-chapters-async implementation
- ⏳ get-processing-status implementation
- ⏳ Monitoring dashboard

#### Phase 4: Optimization (Future)
- ⏳ Performance tuning
- ⏳ Advanced caching strategies
- ⏳ ML-based chapter detection

### Implementation Status

| Component | Status | Notes |
|-----------|--------|-------|
| Database Schema | ✅ Complete | All tables and functions ready |
| extract-pdf-text | ⚠️ Partial | Basic structure exists, needs refinement |
| detect-chapters | ⚠️ In Progress | Core logic implemented |
| store-chapters | ⚠️ In Progress | Batch processing ready |
| enhance-chapters-async | ⏳ Planned | OpenAI integration design complete |
| get-processing-status | ⏳ Planned | Database functions ready |
| Orchestrator Updates | ⚠️ Partial | Existing orchestrator needs integration |

### Next Steps

1. **Complete Function Implementation** - Finish all microservice functions
2. **Update Orchestrator** - Integrate with new microservice workflow  
3. **Frontend Integration** - Update progress monitoring UI
4. **Testing & Validation** - Comprehensive testing suite
5. **Performance Optimization** - Fine-tune for production load
6. **Documentation** - API documentation and deployment guides

### Benefits Achieved

- **Scalability:** Individual function scaling based on load
- **Reliability:** Isolated failure handling and recovery
- **Maintainability:** Smaller, focused codebases
- **Observability:** Detailed progress tracking and metrics
- **Performance:** Intelligent caching and optimization
- **Cost Efficiency:** Pay-per-execution model with optimization

---

**File Locations:**
- Functions: `/supabase/functions/`
- Migrations: `/supabase/migrations/20250801170000_microservice_enhancements.sql`
- Documentation: This file (`MICROSERVICE_IMPLEMENTATION_PLAN.md`)