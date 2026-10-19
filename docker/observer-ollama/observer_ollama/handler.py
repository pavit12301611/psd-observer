# observer_ollama/handler.py
import http.server
import json
import logging
from urllib.parse import urlparse, parse_qs 
from .cors import CorsMixin
from . import translator
from . import ollama_client

logger = logging.getLogger('ollama-proxy.handler')

class OllamaProxyHandler(CorsMixin, http.server.BaseHTTPRequestHandler):
    """
    The main request handler.
    - Uses do_GET and do_POST to route requests to the correct handler method.
    """
    
    # Your original, working log_message method
    def log_message(self, format, *args):
        if '404' in args[1]:
             logger.warning("%s - %s", self.address_string(), format % args)
        elif args[1][0] in ['4', '5']:
            logger.error("%s - %s", self.address_string(), format % args)
        else:
            logger.debug("%s - %s", self.address_string(), format % args)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

    def do_GET(self):
        """Routes GET requests."""
        if self.path == '/favicon.ico':
            self._handle_favicon_request()
        elif self.path == '/commands-stream':
            self._handle_commands_stream_stub()
        else:
            # All other GETs use the simple, modern proxy
            self._handle_modern_proxy('GET')

    def do_POST(self):
        """Routes POST requests."""
        is_legacy_candidate = (self.path == '/v1/chat/completions')

        if is_legacy_candidate and self.server.enable_legacy_translation:
            # If it's a candidate AND the flag is on, use the special translation handler
            self._handle_legacy_translation()
        else:
            # All other POSTs use the simple, modern proxy
            self._handle_modern_proxy('POST')

    # --- New Private Handler Methods ---

    def _handle_modern_proxy(self, method):
        """A pure, simple proxy that streams requests and responses directly."""
        logger.debug(f"Modern proxy for {method} {self.path}")
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length) if content_length > 0 else None

        status, headers, response_iterator = ollama_client.forward_to_ollama(
            method, self.path, self.headers, body
        )

        self.send_response(status)
        for key, val in headers:
            if key.lower() not in ['transfer-encoding', 'connection', 'content-length']:
                self.send_header(key, val)
        self.send_cors_headers()
        self.end_headers()
        
        try:
            for chunk in response_iterator:
                self.wfile.write(chunk)
        except BrokenPipeError:
            logger.warning(f"Client disconnected during modern proxy stream for {self.path}.")

    def _handle_legacy_translation(self):
        """
        Handles the full request/response translation cycle.
        This contains the exact logic from your original _proxy_request method.
        """
        logger.debug("Legacy translation path for /v1/chat/completions")
        method = 'POST' # This handler is only ever called for POST requests
        
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length) if content_length > 0 else None
        
        path = self.path
        
        # This logic is copied directly from your original _proxy_request
        is_chat_completions = (method == 'POST' and path == '/v1/chat/completions')
        if is_chat_completions:
            original_model = 'unknown'
            is_streaming = False
            try:
                request_data = json.loads(body)
                original_model = request_data.get('model', 'unknown')
                is_streaming = request_data.get('stream', False)
            except (json.JSONDecodeError, AttributeError):
                pass
            path, body = translator.translate_request_to_ollama(body)

        status, headers, response_iterator = ollama_client.forward_to_ollama(
            method, path, self.headers, body
        )
        
        self.send_response(status)
        for key, val in headers:
            if key.lower() not in ['transfer-encoding', 'connection', 'content-length']:
                self.send_header(key, val)
        self.send_cors_headers()

        if is_chat_completions and not is_streaming:
            full_response_body = b''.join(response_iterator)
            final_body = translator.translate_response_to_openai(full_response_body, original_model)
            self.send_header('Content-Length', str(len(final_body)))
            self.end_headers()
            self.wfile.write(final_body)
        else:
            self.end_headers()
            try:
                for chunk in response_iterator:
                    self.wfile.write(chunk)
            except BrokenPipeError:
                logger.warning("Client disconnected during legacy stream.")

    # --- Your Original Helper Methods (Unchanged) ---

    def _handle_favicon_request(self):
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()
        logger.debug("Responded 204 No Content for /favicon.ico")

    def _handle_commands_stream_stub(self):
        """Stub handler for /commands-stream SSE endpoint (not needed in headless mode)."""
        logger.debug("Responding to /commands-stream with stub SSE stream")
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection', 'keep-alive')
        self.send_cors_headers()
        self.end_headers()

        # Send a single comment to keep connection valid, then close
        self.wfile.write(b': stub SSE stream\n\n')
