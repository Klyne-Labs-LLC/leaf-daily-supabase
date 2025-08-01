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