// Memory management utilities for PDF processing
// Provides memory monitoring, optimization, and garbage collection helpers

export interface MemoryStats {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
  usagePercentage: number;
  recommendedAction: 'continue' | 'optimize' | 'pause' | 'abort';
}

export interface MemoryConfig {
  maxUsagePercentage: number;
  warningThreshold: number;
  criticalThreshold: number;
  gcInterval: number;
  enableAgressiveGC: boolean;
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  maxUsagePercentage: 85,     // 85% max memory usage
  warningThreshold: 70,       // 70% warning threshold
  criticalThreshold: 90,      // 90% critical threshold
  gcInterval: 10000,          // GC every 10 seconds
  enableAgressiveGC: true     // Enable aggressive garbage collection
};

export class MemoryManager {
  private config: MemoryConfig;
  private lastGCTime: number = 0;
  private memoryHistory: number[] = [];
  private maxHistoryLength = 20;

  constructor(config: MemoryConfig = DEFAULT_MEMORY_CONFIG) {
    this.config = config;
  }

  /**
   * Gets current memory statistics
   */
  getMemoryStats(): MemoryStats {
    const performance = (globalThis as any).performance;
    const memory = performance?.memory;

    if (!memory) {
      // Fallback for environments without memory API
      return {
        usedJSHeapSize: 0,
        totalJSHeapSize: 0,
        jsHeapSizeLimit: 0,
        usagePercentage: 0,
        recommendedAction: 'continue'
      };
    }

    const usedJSHeapSize = memory.usedJSHeapSize || 0;
    const totalJSHeapSize = memory.totalJSHeapSize || 0;
    const jsHeapSizeLimit = memory.jsHeapSizeLimit || 0;
    
    const usagePercentage = jsHeapSizeLimit > 0 
      ? (usedJSHeapSize / jsHeapSizeLimit) * 100 
      : 0;

    let recommendedAction: MemoryStats['recommendedAction'] = 'continue';
    
    if (usagePercentage >= this.config.criticalThreshold) {
      recommendedAction = 'abort';
    } else if (usagePercentage >= this.config.maxUsagePercentage) {
      recommendedAction = 'pause';
    } else if (usagePercentage >= this.config.warningThreshold) {
      recommendedAction = 'optimize';
    }

    // Track memory history
    this.memoryHistory.push(usagePercentage);
    if (this.memoryHistory.length > this.maxHistoryLength) {
      this.memoryHistory.shift();
    }

    return {
      usedJSHeapSize,
      totalJSHeapSize,
      jsHeapSizeLimit,
      usagePercentage,
      recommendedAction
    };
  }

  /**
   * Checks if memory usage is within safe limits
   */
  isMemorySafe(): boolean {
    const stats = this.getMemoryStats();
    return stats.usagePercentage < this.config.maxUsagePercentage;
  }

  /**
   * Forces garbage collection if available and needed
   */
  async forceGC(): Promise<boolean> {
    const now = Date.now();
    
    // Rate limit GC calls
    if (now - this.lastGCTime < this.config.gcInterval) {
      return false;
    }

    const gc = (globalThis as any).gc;
    if (typeof gc === 'function') {
      try {
        gc();
        this.lastGCTime = now;
        console.log('[MEMORY] Forced garbage collection');
        return true;
      } catch (error) {
        console.warn('[MEMORY] Failed to force GC:', error);
      }
    }

    return false;
  }

  /**
   * Optimizes memory by clearing large variables and forcing GC
   */
  async optimizeMemory(variables: any[] = []): Promise<void> {
    // Clear provided variables
    for (let i = 0; i < variables.length; i++) {
      variables[i] = null;
    }

    // Force garbage collection
    await this.forceGC();

    // Small delay to allow GC to complete
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  /**
   * Monitors memory during operation and takes action if needed
   */
  async monitorOperation<T>(
    operation: () => Promise<T>,
    operationName: string = 'operation'
  ): Promise<T> {
    const initialStats = this.getMemoryStats();
    console.log(`[MEMORY] Starting ${operationName}, initial usage: ${initialStats.usagePercentage.toFixed(1)}%`);

    try {
      const result = await operation();
      
      const finalStats = this.getMemoryStats();
      const memoryIncrease = finalStats.usagePercentage - initialStats.usagePercentage;
      
      console.log(`[MEMORY] Completed ${operationName}, final usage: ${finalStats.usagePercentage.toFixed(1)}% (Δ${memoryIncrease.toFixed(1)}%)`);
      
      // Force GC if memory usage increased significantly
      if (memoryIncrease > 10 || finalStats.recommendedAction === 'optimize') {
        await this.forceGC();
      }

      return result;
    } catch (error) {
      console.error(`[MEMORY] Error during ${operationName}:`, error);
      await this.forceGC(); // Clean up on error
      throw error;
    }
  }

  /**
   * Creates a memory-aware processing function that pauses when memory is high
   */
  createMemoryAwareProcessor<T>(
    processFunction: () => Promise<T>,
    options: {
      pauseThreshold?: number;
      pauseDuration?: number;
      maxRetries?: number;
    } = {}
  ): () => Promise<T> {
    const {
      pauseThreshold = this.config.warningThreshold,
      pauseDuration = 1000,
      maxRetries = 3
    } = options;

    return async (): Promise<T> => {
      let retries = 0;
      
      while (retries < maxRetries) {
        const stats = this.getMemoryStats();
        
        if (stats.usagePercentage >= this.config.criticalThreshold) {
          throw new Error(`Memory usage critical (${stats.usagePercentage.toFixed(1)}%), aborting operation`);
        }
        
        if (stats.usagePercentage >= pauseThreshold) {
          console.warn(`[MEMORY] High memory usage (${stats.usagePercentage.toFixed(1)}%), pausing for ${pauseDuration}ms`);
          await this.optimizeMemory();
          await new Promise(resolve => setTimeout(resolve, pauseDuration));
          retries++;
          continue;
        }
        
        // Memory is safe, proceed with operation
        return await processFunction();
      }
      
      throw new Error(`Max retries (${maxRetries}) exceeded due to high memory usage`);
    };
  }

  /**
   * Gets memory trend analysis
   */
  getMemoryTrend(): {
    trend: 'increasing' | 'decreasing' | 'stable';
    averageUsage: number;
    peakUsage: number;
  } {
    if (this.memoryHistory.length < 5) {
      return {
        trend: 'stable',
        averageUsage: this.memoryHistory[this.memoryHistory.length - 1] || 0,
        peakUsage: Math.max(...this.memoryHistory)
      };
    }

    const recent = this.memoryHistory.slice(-5);
    const older = this.memoryHistory.slice(-10, -5);
    
    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const olderAvg = older.length > 0 ? older.reduce((a, b) => a + b, 0) / older.length : recentAvg;
    
    const difference = recentAvg - olderAvg;
    
    let trend: 'increasing' | 'decreasing' | 'stable' = 'stable';
    if (difference > 5) {
      trend = 'increasing';
    } else if (difference < -5) {
      trend = 'decreasing';
    }

    return {
      trend,
      averageUsage: recentAvg,
      peakUsage: Math.max(...this.memoryHistory)
    };
  }

  /**
   * Estimates if there's enough memory for an operation
   */
  estimateMemoryCapacity(estimatedUsage: number): {
    canProceed: boolean;
    confidence: 'high' | 'medium' | 'low';
    recommendedAction: string;
  } {
    const currentStats = this.getMemoryStats();
    const projectedUsage = currentStats.usagePercentage + estimatedUsage;
    
    if (projectedUsage < this.config.warningThreshold) {
      return {
        canProceed: true,
        confidence: 'high',
        recommendedAction: 'proceed_normally'
      };
    }
    
    if (projectedUsage < this.config.maxUsagePercentage) {
      return {
        canProceed: true,
        confidence: 'medium',
        recommendedAction: 'proceed_with_monitoring'
      };
    }
    
    if (projectedUsage < this.config.criticalThreshold) {
      return {
        canProceed: true,
        confidence: 'low',
        recommendedAction: 'optimize_before_proceeding'
      };
    }
    
    return {
      canProceed: false,
      confidence: 'low',
      recommendedAction: 'abort_or_use_alternative_approach'
    };
  }
}

/**
 * Global memory manager instance
 */
export const memoryManager = new MemoryManager();

/**
 * Decorator for memory-safe functions
 */
export function memorySafe<T extends (...args: any[]) => Promise<any>>(
  target: T,
  operationName?: string
): T {
  return (async (...args: any[]) => {
    return await memoryManager.monitorOperation(
      () => target(...args),
      operationName || target.name || 'unknown_operation'
    );
  }) as T;
}

/**
 * Utility for chunked processing with memory management
 */
export async function processInMemorySafeChunks<T, R>(
  items: T[],
  processor: (chunk: T[]) => Promise<R>,
  options: {
    chunkSize?: number;
    memoryThreshold?: number;
    maxConcurrent?: number;
  } = {}
): Promise<R[]> {
  const {
    chunkSize = 10,
    memoryThreshold = DEFAULT_MEMORY_CONFIG.warningThreshold,
    maxConcurrent = 2
  } = options;

  const results: R[] = [];
  const chunks: T[][] = [];
  
  // Split into chunks
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }

  console.log(`[MEMORY] Processing ${items.length} items in ${chunks.length} chunks`);

  // Process chunks with memory monitoring
  for (let i = 0; i < chunks.length; i += maxConcurrent) {
    const batchChunks = chunks.slice(i, i + maxConcurrent);
    
    // Check memory before processing batch
    const stats = memoryManager.getMemoryStats();
    if (stats.usagePercentage > memoryThreshold) {
      console.warn(`[MEMORY] High usage (${stats.usagePercentage.toFixed(1)}%) before batch ${i + 1}, optimizing...`);
      await memoryManager.optimizeMemory();
    }
    
    // Process batch concurrently
    const batchPromises = batchChunks.map(chunk => 
      memoryManager.monitorOperation(
        () => processor(chunk),
        `chunk_${chunks.indexOf(chunk) + 1}`
      )
    );
    
    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
    
    // Small delay between batches to allow GC
    if (i + maxConcurrent < chunks.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  return results;
}

/**
 * Creates a memory pressure monitor that can trigger alerts
 */
export class MemoryPressureMonitor {
  private interval: number | null = null;
  private callbacks: Array<(stats: MemoryStats) => void> = [];

  start(intervalMs: number = 5000): void {
    if (this.interval !== null) {
      this.stop();
    }

    this.interval = setInterval(() => {
      const stats = memoryManager.getMemoryStats();
      
      if (stats.recommendedAction !== 'continue') {
        this.callbacks.forEach(callback => {
          try {
            callback(stats);
          } catch (error) {
            console.error('[MEMORY] Pressure monitor callback error:', error);
          }
        });
      }
    }, intervalMs) as any;

    console.log('[MEMORY] Pressure monitor started');
  }

  stop(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
      console.log('[MEMORY] Pressure monitor stopped');
    }
  }

  onPressure(callback: (stats: MemoryStats) => void): void {
    this.callbacks.push(callback);
  }

  removeCallback(callback: (stats: MemoryStats) => void): void {
    const index = this.callbacks.indexOf(callback);
    if (index > -1) {
      this.callbacks.splice(index, 1);
    }
  }
}

export const memoryPressureMonitor = new MemoryPressureMonitor();