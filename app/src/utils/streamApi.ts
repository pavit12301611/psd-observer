// src/utils/streamApi.ts

/**
 * Stream a prompt to the Gemini API and receive chunks of the response
 * @param apiKey Your Gemini API key
 * @param modelName Name of the model to use (e.g., "gemini-2.0-flash", "gemma-4-26b-a4b-it")
 * @param prompt The prompt text to send
 * @param onChunk Callback function that receives each chunk of text as it arrives
 * @param onComplete Optional callback function that is called when streaming completes
 * @param onError Optional callback function that is called if an error occurs
 * @returns A function that can be called to abort the stream
 */
export function streamPrompt(
  apiKey: string,
  modelName: string,
  prompt: string,
  onChunk: (text: string) => void,
  onComplete?: () => void,
  onError?: (error: Error) => void
): () => void {
  // Create an AbortController to allow canceling the stream
  const abortController = new AbortController();
  const signal = abortController.signal;
  
  // Start the streaming process
  (async () => {
    try {
      // Construct the URL for the Gemini API streaming endpoint
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?alt=sse&key=${apiKey}`;
      
      // Prepare the request body
      const requestBody = JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: prompt
              }
            ]
          }
        ]
      });
      
      // Make the API request
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: requestBody,
        signal
      });
      
      if (!response.ok) {
        throw new Error(`Gemini API error: ${response.status} ${response.statusText}`);
      }
      
      if (!response.body) {
        throw new Error('Response body is null');
      }
      
      // Process the stream using the ReadableStream API
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        // Decode the chunk
        const chunk = decoder.decode(value, { stream: true });
        
        // Parse Server-Sent Events (SSE)
        // Format is: "data: {json}\n\n"
        const lines = chunk.split('\n\n');
        
        for (const line of lines) {
          // Skip empty lines
          if (!line.trim()) continue;
          
          // Process data lines
          if (line.startsWith('data: ')) {
            try {
              // Remove 'data: ' prefix
              const jsonStr = line.substring(6);
              
              // Skip end markers
              if (jsonStr === '[DONE]') continue;
              
              // Parse the JSON response
              const parsed = JSON.parse(jsonStr);
              
              // Extract text from the response structure
              if (parsed.candidates && 
                  parsed.candidates[0] && 
                  parsed.candidates[0].content && 
                  parsed.candidates[0].content.parts && 
                  parsed.candidates[0].content.parts[0] &&
                  parsed.candidates[0].content.parts[0].text) {
                onChunk(parsed.candidates[0].content.parts[0].text);
              }
            } catch (e) {
              // If parsing fails, just continue
              console.error('Error parsing SSE data:', e);
              continue;
            }
          }
        }
      }
      
      // Call onComplete when done
      if (onComplete) {
        onComplete();
      }
    } catch (error) {
      // Don't report errors if the stream was intentionally aborted
      if (signal.aborted) {
        return;
      }
      
      // Handle errors
      if (onError) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  })();
  
  // Return an abort function
  return () => {
    abortController.abort();
  };
}
