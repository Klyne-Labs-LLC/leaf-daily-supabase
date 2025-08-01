-- Create books table to store uploaded PDF information
CREATE TABLE public.books (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  title TEXT NOT NULL,
  author TEXT,
  file_name TEXT NOT NULL,
  file_size INTEGER,
  total_pages INTEGER,
  processing_status TEXT NOT NULL DEFAULT 'pending' CHECK (processing_status IN ('pending', 'processing', 'completed', 'failed')),
  genre TEXT,
  total_word_count INTEGER,
  estimated_total_reading_time INTEGER,
  upload_date TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  processing_completed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create chapters table to store book sections and summaries
CREATE TABLE public.chapters (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  book_id UUID NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  chapter_number INTEGER NOT NULL,
  part_number INTEGER DEFAULT 1,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  summary TEXT,
  word_count INTEGER NOT NULL,
  reading_time_minutes INTEGER NOT NULL,
  highlight_quotes TEXT[],
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(book_id, chapter_number, part_number)
);

-- Enable Row Level Security
ALTER TABLE public.books ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chapters ENABLE ROW LEVEL SECURITY;

-- Create policies for books table
CREATE POLICY "Users can view their own books" 
ON public.books 
FOR SELECT 
USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own books" 
ON public.books 
FOR INSERT 
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own books" 
ON public.books 
FOR UPDATE 
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own books" 
ON public.books 
FOR DELETE 
USING (auth.uid() = user_id);

-- Create policies for chapters table
CREATE POLICY "Users can view chapters of their own books" 
ON public.chapters 
FOR SELECT 
USING (
  EXISTS (
    SELECT 1 FROM public.books 
    WHERE books.id = chapters.book_id 
    AND books.user_id = auth.uid()
  )
);

CREATE POLICY "Users can create chapters for their own books" 
ON public.chapters 
FOR INSERT 
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.books 
    WHERE books.id = chapters.book_id 
    AND books.user_id = auth.uid()
  )
);

CREATE POLICY "Users can update chapters of their own books" 
ON public.chapters 
FOR UPDATE 
USING (
  EXISTS (
    SELECT 1 FROM public.books 
    WHERE books.id = chapters.book_id 
    AND books.user_id = auth.uid()
  )
);

CREATE POLICY "Users can delete chapters of their own books" 
ON public.chapters 
FOR DELETE 
USING (
  EXISTS (
    SELECT 1 FROM public.books 
    WHERE books.id = chapters.book_id 
    AND books.user_id = auth.uid()
  )
);

-- Create function to update timestamps
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers for automatic timestamp updates
CREATE TRIGGER update_books_updated_at
BEFORE UPDATE ON public.books
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_chapters_updated_at
BEFORE UPDATE ON public.chapters
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Create indexes for better performance
CREATE INDEX idx_books_user_id ON public.books(user_id);
CREATE INDEX idx_books_processing_status ON public.books(processing_status);
CREATE INDEX idx_chapters_book_id ON public.chapters(book_id);
CREATE INDEX idx_chapters_book_chapter ON public.chapters(book_id, chapter_number, part_number);

-- Create storage bucket for PDF files
INSERT INTO storage.buckets (id, name, public) VALUES ('book-pdfs', 'book-pdfs', false);

-- Create storage policies for PDF uploads
CREATE POLICY "Users can upload their own PDFs" 
ON storage.objects 
FOR INSERT 
WITH CHECK (bucket_id = 'book-pdfs' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can view their own PDFs" 
ON storage.objects 
FOR SELECT 
USING (bucket_id = 'book-pdfs' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can update their own PDFs" 
ON storage.objects 
FOR UPDATE 
USING (bucket_id = 'book-pdfs' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can delete their own PDFs" 
ON storage.objects 
FOR DELETE 
USING (bucket_id = 'book-pdfs' AND auth.uid()::text = (storage.foldername(name))[1]);