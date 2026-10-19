import React from 'react';

interface ErrorDisplayProps {
  message: string;
}

const ErrorDisplay: React.FC<ErrorDisplayProps> = ({ message }) => {
  return (
    <div className="mb-4 p-4 bg-red-100 text-red-700 rounded-md">
      {message}
    </div>
  );
};

export default ErrorDisplay;
