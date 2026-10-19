// src/components/FeedbackDialog.tsx

import React, { useState } from 'react';
import { ThumbsUp, ThumbsDown, Send, X, AlertCircle } from 'lucide-react';
import { sendEmail } from '../utils/handlers/utils';

interface FeedbackDialogProps {
  isOpen: boolean;
  onClose: () => void;
  getToken: () => Promise<string | undefined>;
  isAuthenticated: boolean;
}

const FEEDBACK_CATEGORIES = [
  { value: 'bug', label: 'Bug Report' },
  { value: 'feature', label: 'Feature Request' },
  { value: 'general', label: 'General Feedback' },
  { value: 'other', label: 'Other' },
];

const FeedbackDialog: React.FC<FeedbackDialogProps> = ({
  isOpen,
  onClose,
  getToken,
  isAuthenticated,
}) => {
  const [category, setCategory] = useState('general');
  const [sentiment, setSentiment] = useState<'like' | 'dislike' | null>(null);
  const [comment, setComment] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submissionStatus, setSubmissionStatus] = useState<'idle' | 'success' | 'error'>('idle');

  const formatFeedbackEmail = (
    comment: string,
    category: string,
    sentiment: 'like' | 'dislike' | null
  ): string => {
    const timestamp = new Date().toISOString();
    const userAgent = navigator.userAgent;
    const screenSize = `${window.screen.width}x${window.screen.height}`;
    const viewportSize = `${window.innerWidth}x${window.innerHeight}`;
    const currentRoute = window.location.pathname + window.location.search;

    // Simple markdown-formatted email
    return `# General Feedback

## User Feedback
**Category:** ${FEEDBACK_CATEGORIES.find(c => c.value === category)?.label || category}
${sentiment ? `**Sentiment:** ${sentiment === 'like' ? '👍 Positive' : '👎 Negative'}` : ''}

**Message:**
${comment}

---

## Metadata
- **Timestamp:** ${timestamp}
- **Current Route:** ${currentRoute}
- **User Agent:** ${userAgent}
- **Screen Size:** ${screenSize}
- **Viewport Size:** ${viewportSize}
`;
  };

  const handleSubmit = async () => {
    if (!comment.trim() || !isAuthenticated) return;

    setIsSubmitting(true);
    setSubmissionStatus('idle');

    try {
      const token = await getToken();
      if (!token) {
        throw new Error('Authentication failed. Could not retrieve token.');
      }

      const emailContent = formatFeedbackEmail(comment, category, sentiment);
      await sendEmail(emailContent, 'roymedina@me.com', token);

      setSubmissionStatus('success');
      setTimeout(() => {
        onClose();
        // Reset form
        setCategory('general');
        setSentiment(null);
        setComment('');
        setSubmissionStatus('idle');
      }, 2000);
    } catch (error) {
      console.error('Failed to send feedback email:', error);
      setSubmissionStatus('error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    if (!isSubmitting) {
      onClose();
      // Reset form after animation
      setTimeout(() => {
        setCategory('general');
        setSentiment(null);
        setComment('');
        setSubmissionStatus('idle');
      }, 300);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 bg-black/50 z-[70] flex items-center justify-center p-4"
      onClick={handleClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        {submissionStatus === 'idle' && (
          <>
            <div className="flex justify-between items-center p-6 border-b border-gray-200">
              <h2 className="text-xl font-semibold text-gray-800">Send Feedback</h2>
              <button
                onClick={handleClose}
                className="p-1 rounded-full text-gray-400 hover:bg-gray-100 transition"
                disabled={isSubmitting}
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              {/* Category Dropdown */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Category
                </label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full p-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
                  disabled={isSubmitting}
                >
                  {FEEDBACK_CATEGORIES.map((cat) => (
                    <option key={cat.value} value={cat.value}>
                      {cat.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Sentiment Buttons */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  How do you feel? (optional)
                </label>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setSentiment(sentiment === 'like' ? null : 'like')}
                    className={`flex-1 p-3 rounded-lg border-2 transition-all ${
                      sentiment === 'like'
                        ? 'bg-green-50 border-green-500 text-green-700'
                        : 'border-gray-300 text-gray-500 hover:border-green-300 hover:bg-green-50'
                    }`}
                    disabled={isSubmitting}
                  >
                    <ThumbsUp className="w-5 h-5 mx-auto" />
                  </button>
                  <button
                    onClick={() => setSentiment(sentiment === 'dislike' ? null : 'dislike')}
                    className={`flex-1 p-3 rounded-lg border-2 transition-all ${
                      sentiment === 'dislike'
                        ? 'bg-red-50 border-red-500 text-red-700'
                        : 'border-gray-300 text-gray-500 hover:border-red-300 hover:bg-red-50'
                    }`}
                    disabled={isSubmitting}
                  >
                    <ThumbsDown className="w-5 h-5 mx-auto" />
                  </button>
                </div>
              </div>

              {/* Comment Textarea */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Your Feedback <span className="text-red-500">*</span>
                </label>
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Share your thoughts, report a bug, or suggest a feature..."
                  className="w-full p-3 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition resize-none"
                  rows={4}
                  disabled={isSubmitting}
                />
              </div>

              {/* Privacy Note */}
              <p className="text-xs text-gray-500">
                If you have an issue i'll fix it :) But please be nice I am a human :P Please don't include sensitive information.
              </p>

              {/* Submit Button */}
              <button
                onClick={handleSubmit}
                disabled={!comment.trim() || isSubmitting || !isAuthenticated}
                className="w-full px-4 py-3 bg-blue-600 text-white rounded-lg font-semibold text-sm flex items-center justify-center gap-2 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition"
              >
                {isSubmitting ? 'Sending...' : 'Send Feedback'}
                <Send className="w-4 h-4" />
              </button>

              {!isAuthenticated && (
                <p className="text-xs text-red-600 text-center flex items-center justify-center gap-1.5">
                  <AlertCircle className="w-4 h-4" />
                  Please sign in to send feedback.
                </p>
              )}
            </div>
          </>
        )}

        {submissionStatus === 'success' && (
          <div className="p-8 text-center">
            <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg
                className="w-8 h-8 text-green-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>
            <p className="text-lg font-semibold text-gray-800">Thank you!</p>
            <p className="text-sm text-gray-600 mt-1">Your feedback has been sent.</p>
          </div>
        )}

        {submissionStatus === 'error' && (
          <div className="p-8 text-center">
            <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <AlertCircle className="w-8 h-8 text-red-600" />
            </div>
            <p className="text-lg font-semibold text-gray-800">Oops!</p>
            <p className="text-sm text-gray-600 mt-1">Something went wrong. Please try again.</p>
            <button
              onClick={() => setSubmissionStatus('idle')}
              className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition"
            >
              Try Again
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default FeedbackDialog;
