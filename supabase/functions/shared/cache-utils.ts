// Shared caching utilities for the PDF processing workflow
// This file provides optimized caching strategies for different stages of processing

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseKey);

// Cache Configuration
export const CACHE_CONFIG = {
  // Cache TTL (Time To Live) in seconds
  TTL: {
    text_extraction: 30 * 24 * 60 * 60,    // 30 days
    chapter_detection: 7 * 24 * 60 * 60,   // 7 days
    ai_enhancement: 14 * 24 * 60 * 60,     // 14 days
    full_workflow: 30 * 24 * 60 * 60       // 30 days
  },
  
  // Maximum cache entry sizes (in bytes)
  MAX_SIZES: {
    text_extraction: 10 * 1024 * 1024,     // 10MB
    chapter_detection: 5 * 1024 * 1024,    // 5MB
    ai_enhancement: 2 * 1024 * 1024,       // 2MB
    full_workflow: 15 * 1024 * 1024        // 15MB
  },
  
  // Cache cleanup thresholds
  CLEANUP: {
    maxEntries: 10000,              // Maximum cache entries
    cleanupBatchSize: 1000,         // Entries to clean at once
    lowAccessThreshold: 2,          // Minimum access count to keep
    oldEntryThreshold: 90           // Days old to consider for cleanup
  }
};

export interface CacheEntry {
  cacheKey: string;
  cacheType: string;
  data: any;
  metadata?: {
    fileSize?: number;
    processingTime?: number;
    quality?: number;
    version?: string;
  };
}

export interface CacheStats {
  hitRate: number;
  totalEntries: number;
  totalSize: number;
  typeBreakdown: Record<string, number>;
}

/**
 * Generates optimized cache keys for different processing stages
 */
export class CacheKeyGenerator {
  static async textExtraction(userId: string, fileName: string, fileSize: number): Promise<string> {
    const data = `text_v2:${userId}:${fileName}:${fileSize}`;
    return await this.hash(data);
  }

  static async chapterDetection(textHash: string, bookTitle: string, algorithm: string): Promise<string> {
    const data = `chapters_v2:${textHash}:${bookTitle}:${algorithm}`;
    return await this.hash(data);
  }

  static async aiEnhancement(contentHash: string, model: string, bookTitle: string): Promise<string> {
    const data = `ai_v2:${contentHash}:${model}:${bookTitle}`;
    return await this.hash(data);
  }

  static async fullWorkflow(userId: string, fileName: string, fileSize: number, bookTitle: string): Promise<string> {
    const data = `workflow_v2:${userId}:${fileName}:${fileSize}:${bookTitle}`;
    return await this.hash(data);
  }

  private static async hash(data: string): Promise<string> {
    const encoder = new TextEncoder();
    const hash = await crypto.subtle.digest('SHA-256', encoder.encode(data));
    return Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
}

/**
 * Smart cache manager with optimization strategies
 */
export class CacheManager {
  /**
   * Stores data in cache with intelligent compression and metadata
   */
  static async store(entry: CacheEntry): Promise<boolean> {
    try {
      // Check size limits
      const dataSize = JSON.stringify(entry.data).length;
      const maxSize = CACHE_CONFIG.MAX_SIZES[entry.cacheType as keyof typeof CACHE_CONFIG.MAX_SIZES];
      
      if (dataSize > maxSize) {
        console.warn(`[CACHE] Entry too large for ${entry.cacheType}: ${dataSize} > ${maxSize}`);
        return false;
      }

      // Compress data for storage efficiency
      const compressedData = await this.compressData(entry.data);
      
      // Generate input hash for deduplication
      const inputHash = await this.generateInputHash(entry);

      // Store in cache
      await supabase.rpc('store_cached_result', {
        p_cache_key: entry.cacheKey,
        p_cache_type: entry.cacheType,
        p_input_hash: inputHash,
        p_output_data: compressedData,
        p_file_size: entry.metadata?.fileSize || null,
        p_processing_time_seconds: entry.metadata?.processingTime || null
      });

      console.log(`[CACHE] Stored ${entry.cacheType} cache entry: ${entry.cacheKey}`);
      return true;

    } catch (error) {
      console.error('[CACHE] Failed to store cache entry:', error);
      return false;
    }
  }

  /**
   * Retrieves data from cache with automatic decompression
   */
  static async retrieve(cacheKey: string, cacheType: string): Promise<any | null> {
    try {
      const { data } = await supabase.rpc('get_cached_result', {
        p_cache_key: cacheKey,
        p_cache_type: cacheType
      });

      if (!data) {
        return null;
      }

      // Decompress data
      const decompressedData = await this.decompressData(data);
      
      console.log(`[CACHE] Retrieved ${cacheType} cache entry: ${cacheKey}`);
      return decompressedData;

    } catch (error) {
      console.warn('[CACHE] Failed to retrieve cache entry:', error);
      return null;
    }
  }

  /**
   * Checks if cache entry exists without retrieving full data
   */
  static async exists(cacheKey: string, cacheType: string): Promise<boolean> {
    try {
      const { data, error } = await supabase
        .from('processing_cache')
        .select('id')
        .eq('cache_key', cacheKey)
        .eq('cache_type', cacheType)
        .single();

      return !error && !!data;
    } catch {
      return false;
    }
  }

  /**
   * Invalidates cache entries matching patterns
   */
  static async invalidate(pattern: string): Promise<number> {
    try {
      const { count } = await supabase
        .from('processing_cache')
        .delete()
        .like('cache_key', pattern)
        .select('*', { count: 'exact', head: true });

      console.log(`[CACHE] Invalidated ${count || 0} cache entries matching: ${pattern}`);
      return count || 0;
    } catch (error) {
      console.error('[CACHE] Failed to invalidate cache entries:', error);
      return 0;
    }
  }

  /**
   * Gets cache statistics and performance metrics
   */
  static async getStats(): Promise<CacheStats> {
    try {
      const { data } = await supabase
        .from('processing_cache')
        .select('cache_type, hit_count, file_size')
        .order('created_at', { ascending: false })
        .limit(1000);

      if (!data) {
        return { hitRate: 0, totalEntries: 0, totalSize: 0, typeBreakdown: {} };
      }

      const totalEntries = data.length;
      const totalHits = data.reduce((sum, entry) => sum + (entry.hit_count || 0), 0);
      const totalSize = data.reduce((sum, entry) => sum + (entry.file_size || 0), 0);

      const typeBreakdown = data.reduce((acc: Record<string, number>, entry) => {
        acc[entry.cache_type] = (acc[entry.cache_type] || 0) + 1;
        return acc;
      }, {});

      return {
        hitRate: totalEntries > 0 ? totalHits / totalEntries : 0,
        totalEntries,
        totalSize,
        typeBreakdown
      };
    } catch (error) {
      console.error('[CACHE] Failed to get cache stats:', error);
      return { hitRate: 0, totalEntries: 0, totalSize: 0, typeBreakdown: {} };
    }
  }

  /**
   * Performs cache cleanup based on access patterns and age
   */
  static async cleanup(): Promise<{ deleted: number; freed: number }> {
    try {
      console.log('[CACHE] Starting cache cleanup...');
      
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - CACHE_CONFIG.CLEANUP.oldEntryThreshold);

      // Delete old, rarely accessed entries
      const { data: deletedEntries } = await supabase
        .from('processing_cache')
        .delete()
        .or(`hit_count.lt.${CACHE_CONFIG.CLEANUP.lowAccessThreshold},created_at.lt.${cutoffDate.toISOString()}`)
        .select('file_size')
        .limit(CACHE_CONFIG.CLEANUP.cleanupBatchSize);

      const deleted = deletedEntries?.length || 0;
      const freed = deletedEntries?.reduce((sum, entry) => sum + (entry.file_size || 0), 0) || 0;

      console.log(`[CACHE] Cleanup completed: deleted ${deleted} entries, freed ${freed} bytes`);
      return { deleted, freed };

    } catch (error) {
      console.error('[CACHE] Cache cleanup failed:', error);
      return { deleted: 0, freed: 0 };
    }
  }

  /**
   * Optimizes cache by consolidating similar entries
   */
  static async optimize(): Promise<{ optimized: number; saved: number }> {
    try {
      console.log('[CACHE] Starting cache optimization...');
      
      // Find duplicate entries (same input hash, different cache keys)
      const { data: duplicates } = await supabase
        .from('processing_cache')
        .select('input_hash, cache_key, file_size, hit_count')
        .order('hit_count', { ascending: false });

      if (!duplicates) return { optimized: 0, saved: 0 };

      const hashGroups = duplicates.reduce((acc: Record<string, any[]>, entry) => {
        if (!acc[entry.input_hash]) acc[entry.input_hash] = [];
        acc[entry.input_hash].push(entry);
        return acc;
      }, {});

      let optimized = 0;
      let saved = 0;

      // For each group with duplicates, keep the most accessed one
      for (const [hash, entries] of Object.entries(hashGroups)) {
        if (entries.length > 1) {
          entries.sort((a, b) => b.hit_count - a.hit_count);
          const toDelete = entries.slice(1); // Keep the first (highest hit count)
          
          for (const entry of toDelete) {
            await supabase
              .from('processing_cache')
              .delete()
              .eq('cache_key', entry.cache_key);
            
            optimized++;
            saved += entry.file_size || 0;
          }
        }
      }

      console.log(`[CACHE] Optimization completed: removed ${optimized} duplicates, saved ${saved} bytes`);
      return { optimized, saved };

    } catch (error) {
      console.error('[CACHE] Cache optimization failed:', error);
      return { optimized: 0, saved: 0 };
    }
  }

  private static async compressData(data: any): Promise<any> {
    // For now, return data as-is. In production, you might want to use compression
    // like gzip for large text content or use Supabase's built-in compression
    return data;
  }

  private static async decompressData(data: any): Promise<any> {
    // Corresponding decompression logic
    return data;
  }

  private static async generateInputHash(entry: CacheEntry): Promise<string> {
    const inputData = {
      cacheType: entry.cacheType,
      metadata: entry.metadata,
      timestamp: Math.floor(Date.now() / (1000 * 60 * 60)) // Hour-level granularity
    };
    
    const encoder = new TextEncoder();
    const hash = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(inputData)));
    return Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
}

/**
 * Cache warming utilities for predictive caching
 */
export class CacheWarmer {
  /**
   * Pre-warms cache based on user patterns
   */
  static async warmUserCache(userId: string): Promise<void> {
    try {
      // Get user's recent books for pattern analysis
      const { data: recentBooks } = await supabase
        .from('books')
        .select('file_name, file_size, genre, author')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(10);

      if (!recentBooks || recentBooks.length === 0) return;

      // Analyze patterns (similar file sizes, genres, authors)
      const patterns = this.analyzeUserPatterns(recentBooks);
      
      console.log(`[CACHE] Warming cache for user ${userId} based on ${patterns.length} patterns`);
      
      // Pre-load similar processing results
      for (const pattern of patterns) {
        await this.preloadSimilarResults(pattern);
      }

    } catch (error) {
      console.error('[CACHE] Cache warming failed:', error);
    }
  }

  private static analyzeUserPatterns(books: any[]): any[] {
    // Simple pattern analysis - in production, this could be more sophisticated
    const patterns: any[] = [];
    
    // Group by genre
    const genreGroups = books.reduce((acc: any, book) => {
      const genre = book.genre || 'unknown';
      if (!acc[genre]) acc[genre] = [];
      acc[genre].push(book);
      return acc;
    }, {});

    // Create patterns for each genre with sufficient examples
    for (const [genre, genreBooks] of Object.entries(genreGroups)) {
      if ((genreBooks as any[]).length >= 2) {
        patterns.push({
          type: 'genre',
          value: genre,
          count: (genreBooks as any[]).length
        });
      }
    }

    return patterns;
  }

  private static async preloadSimilarResults(pattern: any): Promise<void> {
    // In a production system, this would pre-load cache entries
    // for similar content based on the pattern
    console.log(`[CACHE] Pre-loading cache for pattern:`, pattern);
  }
}

// Export all utilities
export { supabase as cacheSupabase };