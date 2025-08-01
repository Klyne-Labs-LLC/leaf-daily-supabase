import { useState } from 'react';
import { PDFUploader } from '@/components/PDFUploader';
import { BookLibrary } from '@/components/BookLibrary';
import { BookReader } from '@/components/BookReader';

type ViewState = 'library' | 'upload' | 'reader';

const Index = () => {
  const [currentView, setCurrentView] = useState<ViewState>('library');
  const [selectedBookId, setSelectedBookId] = useState<string>('');

  const handleSelectBook = (bookId: string) => {
    setSelectedBookId(bookId);
    setCurrentView('reader');
  };

  const handleUploadComplete = (bookId: string) => {
    setCurrentView('library');
  };

  const handleBackToLibrary = () => {
    setCurrentView('library');
    setSelectedBookId('');
  };

  const handleUploadNew = () => {
    setCurrentView('upload');
  };

  return (
    <div className="min-h-screen bg-gradient-reader">
      <div className="container mx-auto px-4 py-8">
        {currentView === 'library' && (
          <BookLibrary 
            onSelectBook={handleSelectBook}
            onUploadNew={handleUploadNew}
          />
        )}
        
        {currentView === 'upload' && (
          <PDFUploader onUploadComplete={handleUploadComplete} />
        )}
        
        {currentView === 'reader' && selectedBookId && (
          <BookReader 
            bookId={selectedBookId}
            onBack={handleBackToLibrary}
          />
        )}
      </div>
    </div>
  );
};

export default Index;
