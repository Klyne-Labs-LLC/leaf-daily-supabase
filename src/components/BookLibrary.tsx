import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { useToast } from '@/components/ui/use-toast';
import { 
  BookOpen, 
  Clock, 
  FileText, 
  Loader2, 
  Play, 
  RotateCcw,
  Trash2,
  AlertCircle
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

interface Book {
  id: string;
  title: string;
  author: string | null;
  genre: string | null;
  processing_status: string;
  total_word_count: number | null;
  estimated_total_reading_time: number | null;
  upload_date: string;
  processing_completed_at: string | null;
}

interface BookLibraryProps {
  onSelectBook: (bookId: string) => void;
  onUploadNew: () => void;
}

export const BookLibrary = ({ onSelectBook, onUploadNew }: BookLibraryProps) => {
  const [books, setBooks] = useState<Book[]>([]);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  useEffect(() => {
    fetchBooks();
    
    // Set up real-time subscription for book updates
    const subscription = supabase
      .channel('book_changes')
      .on('postgres_changes', 
        { event: '*', schema: 'public', table: 'books' },
        () => {
          fetchBooks();
        }
      )
      .subscribe();

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const fetchBooks = async () => {
    try {
      const { data: { user }, error: userError } = await supabase.auth.getUser();
      if (userError || !user) {
        toast({
          title: "Authentication required",
          description: "Please sign in to view your books",
          variant: "destructive",
        });
        return;
      }

      const { data, error } = await supabase
        .from('books')
        .select('*')
        .eq('user_id', user.id)
        .order('upload_date', { ascending: false });

      if (error) throw error;
      setBooks(data || []);
    } catch (error: any) {
      console.error('Error fetching books:', error);
      toast({
        title: "Error loading books",
        description: error.message || "Please try again",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const deleteBook = async (bookId: string, bookTitle: string) => {
    if (!confirm(`Are you sure you want to delete "${bookTitle}"? This action cannot be undone.`)) {
      return;
    }

    try {
      const { error } = await supabase
        .from('books')
        .delete()
        .eq('id', bookId);

      if (error) throw error;

      toast({
        title: "Book deleted",
        description: `"${bookTitle}" has been removed from your library`,
      });
      
      fetchBooks();
    } catch (error: any) {
      console.error('Error deleting book:', error);
      toast({
        title: "Error deleting book",
        description: error.message || "Please try again",
        variant: "destructive",
      });
    }
  };

  const retryProcessing = async (bookId: string) => {
    try {
      const { error } = await supabase.functions.invoke('process-pdf', {
        body: { bookId }
      });

      if (error) throw error;

      toast({
        title: "Processing restarted",
        description: "Your book is being processed again",
      });
    } catch (error: any) {
      console.error('Error retrying processing:', error);
      toast({
        title: "Error restarting processing",
        description: error.message || "Please try again",
        variant: "destructive",
      });
    }
  };

  const getStatusBadge = (status: Book['processing_status']) => {
    switch (status) {
      case 'pending':
        return <Badge variant="secondary" className="gap-1"><Clock className="h-3 w-3" />Pending</Badge>;
      case 'processing':
        return <Badge variant="secondary" className="gap-1"><Loader2 className="h-3 w-3 animate-spin" />Processing</Badge>;
      case 'completed':
        return <Badge className="gap-1 bg-green-100 text-green-800 hover:bg-green-100"><FileText className="h-3 w-3" />Ready</Badge>;
      case 'failed':
        return <Badge variant="destructive" className="gap-1"><AlertCircle className="h-3 w-3" />Failed</Badge>;
      default:
        return <Badge variant="outline">Unknown</Badge>;
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (books.length === 0) {
    return (
      <div className="text-center py-12">
        <div className="flex justify-center mb-4">
          <div className="p-4 bg-muted rounded-full">
            <BookOpen className="h-12 w-12 text-muted-foreground" />
          </div>
        </div>
        <h3 className="text-xl font-semibold mb-2">No books yet</h3>
        <p className="text-muted-foreground mb-6">
          Upload your first PDF to get started with intelligent reading
        </p>
        <Button onClick={onUploadNew} className="bg-gradient-primary">
          <BookOpen className="h-4 w-4 mr-2" />
          Upload Your First Book
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold">Your Library</h2>
          <p className="text-muted-foreground">
            {books.length} book{books.length !== 1 ? 's' : ''} in your collection
          </p>
        </div>
        <Button onClick={onUploadNew} className="bg-gradient-primary">
          <BookOpen className="h-4 w-4 mr-2" />
          Add New Book
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {books.map((book) => (
          <Card key={book.id} className="shadow-card-custom hover:shadow-book transition-all duration-300 group">
            <CardHeader className="pb-3">
              <div className="flex justify-between items-start gap-2">
                <CardTitle className="text-lg line-clamp-2 group-hover:text-primary transition-colors">
                  {book.title}
                </CardTitle>
                {getStatusBadge(book.processing_status)}
              </div>
              {book.author && (
                <p className="text-sm text-muted-foreground">by {book.author}</p>
              )}
              {book.genre && (
                <Badge variant="outline" className="w-fit text-xs capitalize">
                  {book.genre}
                </Badge>
              )}
            </CardHeader>
            
            <CardContent className="space-y-4">
              {/* Book Stats */}
              {book.processing_status === 'completed' && (
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div className="text-center p-2 bg-muted/50 rounded">
                    <p className="font-medium">{book.total_word_count?.toLocaleString() || 0}</p>
                    <p className="text-muted-foreground">Words</p>
                  </div>
                  <div className="text-center p-2 bg-muted/50 rounded">
                    <p className="font-medium">{book.estimated_total_reading_time || 0}m</p>
                    <p className="text-muted-foreground">Reading</p>
                  </div>
                </div>
              )}

              {/* Processing Status */}
              {book.processing_status === 'processing' && (
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span>Processing chapters...</span>
                    <span>⏳</span>
                  </div>
                  <Progress value={65} className="h-2" />
                </div>
              )}

              {/* Upload Date */}
              <p className="text-xs text-muted-foreground">
                Uploaded {new Date(book.upload_date).toLocaleDateString()}
              </p>

              {/* Action Buttons */}
              <div className="flex gap-2">
                {book.processing_status === 'completed' && (
                  <Button 
                    onClick={() => onSelectBook(book.id)}
                    className="flex-1 bg-gradient-primary"
                  >
                    <Play className="h-4 w-4 mr-2" />
                    Read
                  </Button>
                )}
                
                {book.processing_status === 'failed' && (
                  <Button 
                    onClick={() => retryProcessing(book.id)}
                    variant="outline"
                    className="flex-1"
                  >
                    <RotateCcw className="h-4 w-4 mr-2" />
                    Retry
                  </Button>
                )}

                {book.processing_status === 'pending' && (
                  <Button variant="outline" className="flex-1" disabled>
                    <Clock className="h-4 w-4 mr-2" />
                    Waiting
                  </Button>
                )}

                {book.processing_status === 'processing' && (
                  <Button variant="outline" className="flex-1" disabled>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Processing
                  </Button>
                )}

                <Button 
                  onClick={() => deleteBook(book.id, book.title)}
                  variant="outline"
                  size="icon"
                  className="text-destructive hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
};