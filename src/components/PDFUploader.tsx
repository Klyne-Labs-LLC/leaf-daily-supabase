import { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/use-toast';
import { Progress } from '@/components/ui/progress';
import { BookOpen, Upload, FileText, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

interface PDFUploaderProps {
  onUploadComplete: (bookId: string) => void;
}

export const PDFUploader = ({ onUploadComplete }: PDFUploaderProps) => {
  const [uploading, setUploading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [bookDetails, setBookDetails] = useState({
    title: '',
    author: '',
    genre: 'fiction'
  });
  const { toast } = useToast();

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    const file = acceptedFiles[0];
    if (!file) return;

    if (file.type !== 'application/pdf') {
      toast({
        title: "Invalid file type",
        description: "Please upload a PDF file",
        variant: "destructive",
      });
      return;
    }

    if (file.size > 50 * 1024 * 1024) { // 50MB limit
      toast({
        title: "File too large",
        description: "Please upload a PDF smaller than 50MB",
        variant: "destructive",
      });
      return;
    }

    // Auto-detect title from filename if not provided
    if (!bookDetails.title) {
      setBookDetails(prev => ({
        ...prev,
        title: file.name.replace('.pdf', '').replace(/[-_]/g, ' ')
      }));
    }

    await handleUpload(file);
  }, [bookDetails, toast]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'application/pdf': ['.pdf']
    },
    multiple: false
  });

  const handleUpload = async (file: File) => {
    if (!bookDetails.title.trim()) {
      toast({
        title: "Missing information",
        description: "Please provide a book title",
        variant: "destructive",
      });
      return;
    }

    setUploading(true);
    setUploadProgress(0);

    try {
      // Get current user
      const { data: { user }, error: userError } = await supabase.auth.getUser();
      if (userError || !user) {
        throw new Error('Please sign in to upload books');
      }

      // Create book record
      const { data: book, error: bookError } = await supabase
        .from('books')
        .insert({
          user_id: user.id,
          title: bookDetails.title.trim(),
          author: bookDetails.author.trim() || null,
          genre: bookDetails.genre,
          file_name: file.name,
          file_size: file.size,
          processing_status: 'pending'
        })
        .select()
        .single();

      if (bookError) throw bookError;

      setUploadProgress(30);

      // Upload file to storage - sanitize filename for storage
      const sanitizedFileName = file.name
        .replace(/[^\w\s.-]/g, '') // Remove special characters except dots, hyphens, and spaces
        .replace(/\s+/g, '_') // Replace spaces with underscores
        .replace(/_{2,}/g, '_'); // Replace multiple underscores with single
      
      const filePath = `${user.id}/${sanitizedFileName}`;
      const { error: uploadError } = await supabase.storage
        .from('book-pdfs')
        .upload(filePath, file);

      if (uploadError) throw uploadError;

      setUploadProgress(70);
      setUploading(false);
      setProcessing(true);

      // Trigger PDF processing with new orchestrator
      const { data: orchestratorResult, error: processError } = await supabase.functions.invoke('process-pdf-orchestrator', {
        body: { 
          bookId: book.id,
          config: {
            enableCaching: true,
            enableAsyncEnhancement: true,
            priorityLevel: 5
          }
        }
      });

      if (processError) throw processError;

      setUploadProgress(100);

      toast({
        title: "Upload successful!",
        description: "Your book is being processed. You'll be notified when it's ready.",
      });

      onUploadComplete(book.id);

    } catch (error: any) {
      console.error('Upload error:', error);
      toast({
        title: "Upload failed",
        description: error.message || "Please try again",
        variant: "destructive",
      });
    } finally {
      setUploading(false);
      setProcessing(false);
      setUploadProgress(0);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="text-center space-y-2">
        <div className="flex justify-center">
          <div className="p-3 bg-gradient-primary rounded-full shadow-book">
            <BookOpen className="h-8 w-8 text-primary-foreground" />
          </div>
        </div>
        <h2 className="text-3xl font-bold bg-gradient-primary bg-clip-text text-transparent">
          Upload Your Book
        </h2>
        <p className="text-muted-foreground">
          Transform your PDF into an intelligent reading experience
        </p>
      </div>

      <Card className="shadow-card-custom bg-gradient-card border-0">
        <CardContent className="p-6 space-y-6">
          {/* Book Details Form */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="title">Book Title *</Label>
              <Input
                id="title"
                value={bookDetails.title}
                onChange={(e) => setBookDetails(prev => ({ ...prev, title: e.target.value }))}
                placeholder="Enter book title"
                className="transition-smooth"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="author">Author</Label>
              <Input
                id="author"
                value={bookDetails.author}
                onChange={(e) => setBookDetails(prev => ({ ...prev, author: e.target.value }))}
                placeholder="Author name"
                className="transition-smooth"
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="genre">Genre</Label>
              <select
                id="genre"
                value={bookDetails.genre}
                onChange={(e) => setBookDetails(prev => ({ ...prev, genre: e.target.value }))}
                className="w-full h-10 px-3 py-2 text-sm bg-background border border-input rounded-md transition-smooth focus:ring-2 focus:ring-ring focus:border-transparent"
              >
                <option value="fiction">Fiction</option>
                <option value="non-fiction">Non-Fiction</option>
                <option value="mystery">Mystery</option>
                <option value="romance">Romance</option>
                <option value="sci-fi">Science Fiction</option>
                <option value="fantasy">Fantasy</option>
                <option value="biography">Biography</option>
                <option value="history">History</option>
                <option value="self-help">Self Help</option>
                <option value="business">Business</option>
              </select>
            </div>
          </div>

          {/* File Upload Area */}
          <div
            {...getRootProps()}
            className={`border-2 border-dashed rounded-lg p-8 text-center transition-all cursor-pointer
              ${isDragActive 
                ? 'border-primary bg-chapter-highlight' 
                : 'border-border hover:border-primary hover:bg-muted/50'
              }`}
          >
            <input {...getInputProps()} />
            <div className="space-y-4">
              <div className="flex justify-center">
                {uploading || processing ? (
                  <Loader2 className="h-12 w-12 text-primary animate-spin" />
                ) : (
                  <div className="p-3 bg-muted rounded-full">
                    {isDragActive ? (
                      <Upload className="h-8 w-8 text-primary" />
                    ) : (
                      <FileText className="h-8 w-8 text-muted-foreground" />
                    )}
                  </div>
                )}
              </div>
              <div>
                <p className="text-lg font-medium">
                  {uploading ? 'Uploading...' : 
                   processing ? 'Processing your book...' :
                   isDragActive ? 'Drop your PDF here' : 'Drag & drop your PDF here'}
                </p>
                <p className="text-sm text-muted-foreground">
                  {!uploading && !processing && 'or click to browse files (PDF only, max 50MB)'}
                </p>
              </div>
            </div>
          </div>

          {/* Progress Bar */}
          {(uploading || processing) && (
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span>{uploading ? 'Uploading' : 'Processing'}</span>
                <span>{uploadProgress}%</span>
              </div>
              <Progress value={uploadProgress} className="h-2" />
            </div>
          )}

          {/* Upload Button */}
          {!uploading && !processing && (
            <Button
              className="w-full bg-gradient-primary hover:opacity-90 transition-smooth"
              disabled={!bookDetails.title.trim()}
              onClick={() => (document.querySelector('input[type="file"]') as HTMLInputElement)?.click()}
            >
              <Upload className="h-4 w-4 mr-2" />
              Choose PDF File
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
};