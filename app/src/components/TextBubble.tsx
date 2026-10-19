import React, { useState, useEffect } from 'react';
import { HelpCircle } from 'lucide-react';

interface TextBubbleProps {
  message: string;
  duration?: number; // in milliseconds, 0 for permanent
}

const TextBubble: React.FC<TextBubbleProps> = ({
  message,
  duration = 0
}) => {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (duration > 0) {
      const timer = setTimeout(() => {
        setVisible(false);
      }, duration);
      
      return () => clearTimeout(timer);
    }
  }, [duration]);

  if (!visible) return null;

  return (
    <div className="relative">
      {/* Speech bubble tail pointing up */}
      <div className="absolute -top-2 right-12 w-4 h-4 bg-blue-50 transform rotate-45" style={{ boxShadow: '-1px -1px 1px rgba(0,0,0,0.05)' }}></div>
      
      {/* Main bubble */}
      <div className="flex items-center p-3 bg-blue-50 text-blue-700 rounded-md shadow-md z-10 relative">
        <HelpCircle className="h-5 w-5 mr-2 flex-shrink-0 text-blue-500" />
        <span className="text-sm">{message}</span>
      </div>
    </div>
  );
};

export default TextBubble;
