import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/components/ui/use-toast';
import { 
  ArrowLeft, 
  ArrowRight, 
  BookOpen, 
  Clock, 
  Quote,
  ChevronLeft,
  Menu,
  Bookmark
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

interface Chapter {
  id: string;
  book_id: string;
  chapter_number: number;
  part_number: number;
  title: string;
  content: string;
  summary: string | null;
  word_count: number;
  reading_time_minutes: number;
  highlight_quotes: string[];
}

interface Book {
  id: string;
  title: string;
  author: string | null;
  genre: string | null;
  total_word_count: number | null;
  estimated_total_reading_time: number | null;
}

interface BookReaderProps {
  bookId: string;
  onBack: () => void;
}

export const BookReader = ({ bookId, onBack }: BookReaderProps) => {
  const [book, setBook] = useState<Book | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [currentChapterIndex, setCurrentChapterIndex] = useState(0);
  const [showSidebar, setShowSidebar] = useState(false);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  useEffect(() => {
    fetchBookData();
  }, [bookId]);

  const fetchBookData = async () => {
    try {
      setLoading(true);

      // Fetch book details
      const { data: bookData, error: bookError } = await supabase
        .from('books')
        .select('*')
        .eq('id', bookId)
        .single();

      if (bookError) throw bookError;
      setBook(bookData);

      // Fetch chapters
      const { data: chaptersData, error: chaptersError } = await supabase
        .from('chapters')
        .select('*')
        .eq('book_id', bookId)
        .order('chapter_number', { ascending: true })
        .order('part_number', { ascending: true });

      if (chaptersError) throw chaptersError;
      setChapters(chaptersData || []);

    } catch (error: any) {
      console.error('Error fetching book data:', error);
      toast({
        title: "Error loading book",
        description: error.message || "Please try again",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const currentChapter = chapters[currentChapterIndex];
  const totalChapters = chapters.length;
  const readingProgress = totalChapters > 0 ? ((currentChapterIndex + 1) / totalChapters) * 100 : 0;

  const nextChapter = () => {
    if (currentChapterIndex < totalChapters - 1) {
      setCurrentChapterIndex(currentChapterIndex + 1);
    }
  };

  const previousChapter = () => {
    if (currentChapterIndex > 0) {
      setCurrentChapterIndex(currentChapterIndex - 1);
    }
  };

  const goToChapter = (index: number) => {
    setCurrentChapterIndex(index);
    setShowSidebar(false);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center space-y-4">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto"></div>
          <p className="text-muted-foreground">Loading your book...</p>
        </div>
      </div>
    );
  }

  if (!book || !currentChapter) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center space-y-4">
          <BookOpen className="h-12 w-12 text-muted-foreground mx-auto" />
          <p className="text-muted-foreground">Book not found or no chapters available</p>
          <Button onClick={onBack} variant="outline">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Library
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-reader">
      {/* Header */}
      <div className="sticky top-0 z-50 bg-background/80 backdrop-blur-sm border-b">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={onBack}>
              <ChevronLeft className="h-5 w-5" />
            </Button>
            <Button 
              variant="ghost" 
              size="icon" 
              onClick={() => setShowSidebar(!showSidebar)}
              className="md:hidden"
            >
              <Menu className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="font-semibold text-lg truncate max-w-xs">{book.title}</h1>
              {book.author && (
                <p className="text-sm text-muted-foreground">by {book.author}</p>
              )}
            </div>
          </div>
          
          <div className="flex items-center gap-4">
            <div className="hidden md:flex items-center gap-2 text-sm text-muted-foreground">
              <Clock className="h-4 w-4" />
              {currentChapter.reading_time_minutes}m read
            </div>
            <Badge variant="outline" className="hidden md:inline-flex">
              {currentChapterIndex + 1} / {totalChapters}
            </Badge>
          </div>
        </div>
        
        {/* Progress Bar */}
        <Progress value={readingProgress} className="h-1 border-none" />
      </div>

      <div className="flex">
        {/* Sidebar - Chapter Navigation */}
        <div className={`fixed md:relative inset-y-0 left-0 z-40 w-80 bg-background border-r transform transition-transform duration-300 ${
          showSidebar ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        } ${showSidebar ? 'md:block' : 'hidden md:block'}`}>
          <div className="p-4 h-full overflow-y-auto">
            <h3 className="font-semibold mb-4 flex items-center gap-2">
              <BookOpen className="h-5 w-5" />
              Chapters
            </h3>
            <div className="space-y-2">
              {chapters.map((chapter, index) => (
                <button
                  key={chapter.id}
                  onClick={() => goToChapter(index)}
                  className={`w-full text-left p-3 rounded-lg transition-colors ${
                    index === currentChapterIndex 
                      ? 'bg-chapter-highlight border border-primary/20' 
                      : 'hover:bg-muted'
                  }`}
                >
                  <div className="font-medium text-sm line-clamp-2">{chapter.title}</div>
                  <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {chapter.reading_time_minutes}m
                    <span>•</span>
                    {chapter.word_count} words
                  </div>
                  {chapter.summary && (
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                      {chapter.summary}
                    </p>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Overlay for mobile */}
        {showSidebar && (
          <div 
            className="fixed inset-0 bg-black/50 z-30 md:hidden"
            onClick={() => setShowSidebar(false)}
          />
        )}

        {/* Main Content */}
        <div className="flex-1 min-w-0">
          <div className="max-w-3xl mx-auto px-4 py-8">
            {/* Chapter Header */}
            <div className="mb-8">
              <Badge variant="outline" className="mb-3">
                Chapter {currentChapter.chapter_number}
                {currentChapter.part_number > 1 && ` - Part ${currentChapter.part_number}`}
              </Badge>
              <h2 className="text-3xl font-bold mb-4">{currentChapter.title}</h2>
              
              {currentChapter.summary && (
                <Card className="mb-6 bg-chapter-highlight border-primary/20">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-lg flex items-center gap-2">
                      <Bookmark className="h-5 w-5" />
                      Chapter Summary
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-muted-foreground leading-relaxed">
                      {currentChapter.summary}
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>

            {/* Chapter Content */}
            <div className="prose prose-lg max-w-none">
              <div className="reader-text leading-relaxed text-reader-text">
                {currentChapter.content.split('\n\n').map((paragraph, index) => (
                  <p key={index} className="mb-6 text-justify">
                    {paragraph}
                  </p>
                ))}
              </div>
            </div>

            {/* Highlights */}
            {currentChapter.highlight_quotes && currentChapter.highlight_quotes.length > 0 && (
              <Card className="mt-8 bg-gradient-card border-primary/20">
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Quote className="h-5 w-5" />
                    Chapter Highlights
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    {currentChapter.highlight_quotes.map((quote, index) => (
                      <blockquote key={index} className="border-l-4 border-primary pl-4 italic text-muted-foreground">
                        "{quote}"
                      </blockquote>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Navigation */}
            <div className="flex justify-between items-center mt-12 pt-8 border-t">
              <Button 
                variant="outline" 
                onClick={previousChapter}
                disabled={currentChapterIndex === 0}
                className="flex items-center gap-2"
              >
                <ArrowLeft className="h-4 w-4" />
                Previous
              </Button>

              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span>{currentChapterIndex + 1} of {totalChapters}</span>
              </div>

              <Button 
                onClick={nextChapter}
                disabled={currentChapterIndex === totalChapters - 1}
                className="flex items-center gap-2 bg-gradient-primary"
              >
                Next
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};