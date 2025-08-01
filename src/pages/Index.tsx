import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { LogOut, User } from 'lucide-react';
import { PDFUploader } from '@/components/PDFUploader';
import { BookLibrary } from '@/components/BookLibrary';
import { BookReader } from '@/components/BookReader';
import { useAuth } from '@/hooks/useAuth';

type ViewState = 'library' | 'upload' | 'reader';

const Index = () => {
  const [currentView, setCurrentView] = useState<ViewState>('library');
  const [selectedBookId, setSelectedBookId] = useState<string>('');
  const { user, loading, signOut } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && !user) {
      navigate('/auth');
    }
  }, [user, loading, navigate]);

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

  const handleSignOut = async () => {
    await signOut();
    navigate('/auth');
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-reader flex items-center justify-center">
        <div className="text-center space-y-4">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto"></div>
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return null; // Will redirect to auth page
  }

  return (
    <div className="min-h-screen bg-gradient-reader">
      <div className="container mx-auto px-4 py-8">
        {/* Header with user info and sign out */}
        <div className="flex justify-between items-center mb-8">
          <div className="flex items-center space-x-3">
            <div className="p-2 bg-gradient-primary rounded-full">
              <User className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Welcome back</p>
              <p className="font-medium">{user.email}</p>
            </div>
          </div>
          <Button
            variant="outline"
            onClick={handleSignOut}
            className="flex items-center space-x-2"
          >
            <LogOut className="h-4 w-4" />
            <span>Sign Out</span>
          </Button>
        </div>
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
