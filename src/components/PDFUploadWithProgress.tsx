import { useState } from 'react';
import { PDFUploader } from './PDFUploader';
import { ProcessingProgress } from './ProcessingProgress';
import { Button } from '@/components/ui/button';
import { ArrowLeft, BookOpen } from 'lucide-react';

interface PDFUploadWithProgressProps {
  onComplete: () => void;
  onCancel: () => void;
}

export const PDFUploadWithProgress = ({ onComplete, onCancel }: PDFUploadWithProgressProps) => {
  const [processingBookId, setProcessingBookId] = useState<string | null>(null);
  const [isProcessingComplete, setIsProcessingComplete] = useState(false);

  const handleUploadComplete = (bookId: string) => {
    setProcessingBookId(bookId);
  };

  const handleProcessingComplete = () => {
    setIsProcessingComplete(true);
  };

  const handleBackToLibrary = () => {
    onComplete();
  };

  if (processingBookId && !isProcessingComplete) {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="text-center space-y-2">
          <div className="flex justify-center">
            <div className="p-3 bg-gradient-primary rounded-full shadow-book">
              <BookOpen className="h-8 w-8 text-primary-foreground" />
            </div>
          </div>
          <h2 className="text-3xl font-bold bg-gradient-primary bg-clip-text text-transparent">
            Processing Your Book
          </h2>
          <p className="text-muted-foreground">
            We're extracting chapters and preparing your reading experience
          </p>
        </div>

        <ProcessingProgress 
          bookId={processingBookId} 
          onComplete={handleProcessingComplete}
        />

        <div className="flex justify-center">
          <Button
            variant="outline"
            onClick={onCancel}
            className="gap-2"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Library
          </Button>
        </div>
      </div>
    );
  }

  if (isProcessingComplete) {
    return (
      <div className="max-w-2xl mx-auto space-y-6 text-center">
        <div className="space-y-2">
          <div className="flex justify-center">
            <div className="p-3 bg-green-500 rounded-full shadow-book">
              <BookOpen className="h-8 w-8 text-white" />
            </div>
          </div>
          <h2 className="text-3xl font-bold">Success!</h2>
          <p className="text-muted-foreground">
            Your book has been processed and is ready to read
          </p>
        </div>

        <div className="flex justify-center gap-4">
          <Button
            onClick={handleBackToLibrary}
            className="bg-gradient-primary"
          >
            <BookOpen className="h-4 w-4 mr-2" />
            Go to Library
          </Button>
        </div>
      </div>
    );
  }

  return <PDFUploader onUploadComplete={handleUploadComplete} />;
};