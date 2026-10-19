// src/components/FeedbackBubble.tsx

import React, { useState, useRef, useEffect } from 'react';
import { ThumbsUp, ThumbsDown, Send, FileText, X, AlertCircle } from 'lucide-react';
import { generateFeedbackReportMarkdown } from '../utils/feedbackReporter';
import { sendEmail } from '../utils/handlers/utils';
import { IterationData } from '../utils/IterationStore';
import { useIterations, useHistoricalSessions } from '../hooks/useIterations';

// The component's contract: it requires the real authentication state and a function to get the token.
interface FeedbackBubbleProps {
  agentId: string;
  getToken: () => Promise<string | undefined>;
  isAuthenticated: boolean;
}

const FeedbackBubble: React.FC<FeedbackBubbleProps> = ({ agentId, getToken, isAuthenticated }) => {
  const [sentiment, setSentiment] = useState<'like' | 'dislike' | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [comment, setComment] = useState('');
  const [includeConfig, setIncludeConfig] = useState(true);
  const [includeLogs, setIncludeLogs] = useState(true);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [previewData, setPreviewData] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submissionStatus, setSubmissionStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const bubbleRef = useRef<HTMLDivElement>(null);

  // Use polling hooks for iteration data
  const currentIterations = useIterations(agentId, 1000); // Poll every 1s (feedback isn't time-critical)
  const historicalSessions = useHistoricalSessions(agentId);

  // Derive latest iteration from current or historical data
  const latestIteration: IterationData | null = (() => {
    if (currentIterations.length > 0) {
      return currentIterations[currentIterations.length - 1];
    }
    if (historicalSessions.length > 0) {
      const mostRecentSession = historicalSessions[0];
      if (mostRecentSession.iterations.length > 0) {
        return mostRecentSession.iterations[mostRecentSession.iterations.length - 1];
      }
    }
    return null;
  })();


  const handleSentimentClick = (newSentiment: 'like' | 'dislike') => {
    setSentiment(newSentiment);
    setIsExpanded(true);
  };

  const handleClose = () => {
    setIsExpanded(false);
    // Delay resetting sentiment to allow for the closing animation.
    setTimeout(() => {
      if (!isExpanded) setSentiment(null);
    }, 300);
  };

  const handlePreview = async () => {
    const markdownReport = await generateFeedbackReportMarkdown(
      { 
        agentId, 
        includeAgentConfig: includeConfig, 
        includeLogs: includeLogs,
        latestIteration: latestIteration || undefined
      },
      { sentiment: sentiment || 'like', comment }
    );
    setPreviewData(markdownReport);
    setIsPreviewing(true);
  };

  const handleSubmit = async () => {
    // Guard clause now uses the reliable `isAuthenticated` prop.
    if (!sentiment || !isAuthenticated) return;

    setIsSubmitting(true);
    setSubmissionStatus('idle');

    try {
      // 1. Get the JWT token using the provided function.
      const token = await getToken();
      if (!token) {
        throw new Error("Authentication failed. Could not retrieve token.");
      }

      // 2. Generate the feedback report.
      const markdownReport = await generateFeedbackReportMarkdown(
        { 
          agentId, 
          includeAgentConfig: includeConfig, 
          includeLogs: includeLogs,
          latestIteration: latestIteration || undefined
        },
        { sentiment, comment }
      );

      // 3. Call the `sendEmail` utility with the required token.
      await sendEmail(markdownReport, 'roymedina@me.com', token);

      setSubmissionStatus('success');
      setTimeout(() => {
        setIsExpanded(false);
        setSubmissionStatus('idle');
        setSentiment(null);
      }, 2000);

    } catch (error) {
      console.error("Failed to send feedback email:", error);
      setSubmissionStatus('error');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Effect to close the bubble when clicking outside of it.
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (bubbleRef.current && !bubbleRef.current.contains(event.target as Node)) {
        handleClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div className="relative" ref={bubbleRef}>
      <div className="flex items-center justify-between p-2 bg-white rounded-lg shadow border border-gray-200">
        <span className="text-sm font-medium text-gray-700 mr-4">How did this agent run go?</span>
        <div className="flex items-center gap-2">
          <button onClick={() => handleSentimentClick('like')} className={`p-2 rounded-full transition-colors ${sentiment === 'like' ? 'bg-green-100 text-green-600 ring-2 ring-green-500' : 'bg-gray-100 text-gray-500 hover:bg-green-50'}`} aria-label="Good run"><ThumbsUp className="w-5 h-5" /></button>
          <button onClick={() => handleSentimentClick('dislike')} className={`p-2 rounded-full transition-colors ${sentiment === 'dislike' ? 'bg-red-100 text-red-600 ring-2 ring-red-500' : 'bg-gray-100 text-gray-500 hover:bg-red-50'}`} aria-label="Bad run"><ThumbsDown className="w-5 h-5" /></button>
        </div>
      </div>

      {isExpanded && (
        <div className="absolute top-full right-0 mt-2 w-80 bg-white rounded-xl shadow-2xl border border-gray-200 z-20 p-5 animate-fade-in">
           {submissionStatus === 'idle' && (
            <>
                <div className="flex justify-between items-center mb-4">
                    <h3 className="text-lg font-semibold text-gray-800">Share Feedback</h3>
                    <button onClick={handleClose} className="p-1 rounded-full text-gray-400 hover:bg-gray-100"><X className="w-5 h-5"/></button>
                </div>
                
                <textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add a comment... (optional)" className="w-full p-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition" rows={3}/>

                <div className="mt-4 pt-4 border-t border-gray-200">
                  <p className="text-xs text-gray-700 mb-2 font-medium">
                    How was it? Help me improve by sending feedback. I'm a human so please be nice and i'll fix it!
                    <br />
                    <span className="text-gray-500">
                      For your privacy, please Preview Data and ensure you're not sharing sensitive information, especially from OCR.
                    </span>
                  </p>
                    <label className="flex items-center text-sm text-gray-700 cursor-pointer mb-2"><input type="checkbox" checked={includeConfig} onChange={e => setIncludeConfig(e.target.checked)} className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" /><span className="ml-2">Agent Configuration</span></label>
                    <label className="flex items-center text-sm text-gray-700 cursor-pointer"><input type="checkbox" checked={includeLogs} onChange={e => setIncludeLogs(e.target.checked)} className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" /><span className="ml-2">Prompt/Response Logs</span></label>
                </div>
                
                <div className="mt-4">
                    <button onClick={handleSubmit} disabled={!sentiment || isSubmitting || !isAuthenticated} className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg font-semibold text-sm flex items-center justify-center gap-2 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition">
                        {isSubmitting ? 'Sending...' : 'Send Feedback'} <Send className="w-4 h-4" />
                    </button>
                    {!isAuthenticated && (
                        <p className="text-xs text-red-600 mt-2 text-center flex items-center justify-center gap-1.5"><AlertCircle className="w-4 h-4" /> Please sign in to send feedback.</p>
                    )}
                </div>

                <div className="mt-3 text-center">
                     <button onClick={handlePreview} className="text-xs text-blue-600 hover:underline flex items-center gap-1 mx-auto"><FileText className="w-3 h-3" /> Preview Data</button>
                </div>
            </>
           )}
           {submissionStatus === 'success' && (<div className="text-center py-4"><p className="font-semibold text-green-600">Thank you for your feedback!</p></div>)}
           {submissionStatus === 'error' && (<div className="text-center py-4"><p className="font-semibold text-red-600">Something went wrong. Please try again.</p></div>)}
        </div>
      )}

      {isPreviewing && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setIsPreviewing(false)}>
            <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
                <div className="p-4 border-b flex justify-between items-center"><h3 className="text-lg font-semibold">Data Preview</h3><button onClick={() => setIsPreviewing(false)} className="p-1 rounded-full text-gray-400 hover:bg-gray-100"><X className="w-5 h-5"/></button></div>
                <pre className="p-4 text-xs bg-gray-50 overflow-auto flex-1 whitespace-pre-wrap">{previewData}</pre>
            </div>
        </div>
      )}
    </div>
  );
};

export default FeedbackBubble;
