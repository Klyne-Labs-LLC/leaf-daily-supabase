import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, Circle, Clock, Loader2, XCircle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

interface ProcessingProgressProps {
  bookId: string;
  onComplete?: () => void;
}

interface StageStatus {
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: number;
  duration?: number;
  message?: string;
}

interface ProcessingStatus {
  bookId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  currentStage: string;
  overallProgress: number;
  stageProgress: number;
  message: string;
  estimatedCompletionTime?: string;
  stages: StageStatus[];
  metrics?: {
    totalWordCount?: number;
    totalChapters?: number;
    totalReadingTime?: number;
    processingTime?: number;
    cacheHits?: number;
  };
  error?: string;
}

const stageDisplayNames: Record<string, string> = {
  'uploading': 'Uploading',
  'extracting_text': 'Extracting Text',
  'detecting_chapters': 'Detecting Chapters',
  'storing_chapters': 'Storing Chapters',
  'enhancing_chapters': 'AI Enhancement',
  'completed': 'Completed',
  'failed': 'Failed'
};

export const ProcessingProgress = ({ bookId, onComplete }: ProcessingProgressProps) => {
  const [status, setStatus] = useState<ProcessingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!bookId) return;

    const fetchStatus = async () => {
      try {
        // Get current session for auth
        const { data: { session } } = await supabase.auth.getSession();
        const authToken = session?.access_token || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVtZHJhbnBqb3BseGJneGtob2l4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTQwNjA1NTAsImV4cCI6MjA2OTYzNjU1MH0.QHXRsTsxZex2whi0V0rO4yeIoKAzLjuBJBsNe2bMmMo';
        
        // Use fetch directly for GET request with query parameters
        const response = await fetch(`https://umdranpjoplxbgxkhoix.supabase.co/functions/v1/get-processing-status?bookId=${encodeURIComponent(bookId)}&detailed=true`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${authToken}`,
            'Content-Type': 'application/json',
          },
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        const data = await response.json();
        
        if (data.error) {
          throw new Error(data.error);
        }
        
        setStatus(data);
        setError(null); // Clear any previous errors
        
        if (data.status === 'completed' && onComplete) {
          onComplete();
        }
      } catch (err: any) {
        console.error('Error fetching status:', err);
        setError(err.message || 'Failed to fetch processing status');
      }
    };

    // Initial fetch
    fetchStatus();

    // Poll for updates every 2 seconds
    const interval = setInterval(fetchStatus, 2000);

    return () => clearInterval(interval);
  }, [bookId, onComplete]);

  if (error) {
    return (
      <Card className="shadow-card-custom bg-gradient-card border-0">
        <CardContent className="p-6">
          <div className="flex items-center space-x-2 text-destructive">
            <XCircle className="h-5 w-5" />
            <span>Error loading progress: {error}</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!status) {
    return (
      <Card className="shadow-card-custom bg-gradient-card border-0">
        <CardContent className="p-6">
          <div className="flex items-center justify-center space-x-2">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>Loading progress...</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  const getStageIcon = (stage: StageStatus) => {
    switch (stage.status) {
      case 'completed':
        return <CheckCircle2 className="h-5 w-5 text-green-500" />;
      case 'running':
        return <Loader2 className="h-5 w-5 text-primary animate-spin" />;
      case 'failed':
        return <XCircle className="h-5 w-5 text-destructive" />;
      default:
        return <Circle className="h-5 w-5 text-muted-foreground" />;
    }
  };

  const getStatusBadge = () => {
    switch (status.status) {
      case 'completed':
        return <Badge className="bg-green-500">Completed</Badge>;
      case 'processing':
        return <Badge className="bg-primary">Processing</Badge>;
      case 'failed':
        return <Badge variant="destructive">Failed</Badge>;
      default:
        return <Badge variant="secondary">Pending</Badge>;
    }
  };

  const formatTime = (seconds?: number) => {
    if (!seconds) return '';
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  };

  const estimatedTimeRemaining = () => {
    if (!status.estimatedCompletionTime) return null;
    const now = new Date();
    const estimated = new Date(status.estimatedCompletionTime);
    const diffMs = estimated.getTime() - now.getTime();
    if (diffMs <= 0) return 'Almost done...';
    const diffMinutes = Math.floor(diffMs / 60000);
    const diffSeconds = Math.floor((diffMs % 60000) / 1000);
    if (diffMinutes > 0) {
      return `${diffMinutes} min ${diffSeconds} sec remaining`;
    }
    return `${diffSeconds} sec remaining`;
  };

  return (
    <Card className="shadow-card-custom bg-gradient-card border-0">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">Processing Progress</CardTitle>
          {getStatusBadge()}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Overall Progress */}
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="font-medium">{status.message}</span>
            <span>{status.overallProgress}%</span>
          </div>
          <Progress value={status.overallProgress} className="h-3" />
          {status.estimatedCompletionTime && (
            <div className="flex items-center space-x-1 text-sm text-muted-foreground">
              <Clock className="h-3 w-3" />
              <span>{estimatedTimeRemaining()}</span>
            </div>
          )}
        </div>

        {/* Stage Progress */}
        <div className="space-y-3">
          {status.stages.map((stage, index) => (
            <div key={stage.name} className="space-y-1">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  {getStageIcon(stage)}
                  <span className="text-sm font-medium">
                    {stageDisplayNames[stage.name] || stage.name}
                  </span>
                </div>
                <div className="text-sm text-muted-foreground">
                  {stage.status === 'completed' && stage.duration && (
                    <span>{formatTime(stage.duration)}</span>
                  )}
                  {stage.status === 'running' && (
                    <span>{stage.progress}%</span>
                  )}
                </div>
              </div>
              {stage.status === 'running' && (
                <Progress value={stage.progress} className="h-1" />
              )}
              {stage.message && (
                <p className="text-xs text-muted-foreground pl-7">{stage.message}</p>
              )}
            </div>
          ))}
        </div>

        {/* Metrics */}
        {status.metrics && status.status === 'completed' && (
          <div className="pt-3 border-t space-y-2">
            <h4 className="text-sm font-medium">Processing Results</h4>
            <div className="grid grid-cols-2 gap-2 text-sm">
              {status.metrics.totalChapters && (
                <div>
                  <span className="text-muted-foreground">Chapters:</span>{' '}
                  <span className="font-medium">{status.metrics.totalChapters}</span>
                </div>
              )}
              {status.metrics.totalWordCount && (
                <div>
                  <span className="text-muted-foreground">Words:</span>{' '}
                  <span className="font-medium">{status.metrics.totalWordCount.toLocaleString()}</span>
                </div>
              )}
              {status.metrics.totalReadingTime && (
                <div>
                  <span className="text-muted-foreground">Reading Time:</span>{' '}
                  <span className="font-medium">{status.metrics.totalReadingTime} min</span>
                </div>
              )}
              {status.metrics.processingTime && (
                <div>
                  <span className="text-muted-foreground">Processed in:</span>{' '}
                  <span className="font-medium">{formatTime(status.metrics.processingTime)}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Error Message */}
        {status.error && (
          <div className="p-3 bg-destructive/10 text-destructive rounded-md text-sm">
            {status.error}
          </div>
        )}
      </CardContent>
    </Card>
  );
};