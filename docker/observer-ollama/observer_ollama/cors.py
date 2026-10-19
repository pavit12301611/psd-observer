# ollama_proxy/cors.py
import logging

logger = logging.getLogger('ollama-proxy.cors')

class CorsMixin:
    """A mixin to handle CORS headers for the proxy."""
    def send_cors_headers(self):
        """Send the appropriate CORS headers."""
        origin = self.headers.get('Origin', '')
        # In a real-world scenario, you might want to make this configurable.
        allowed_origins = ['http://localhost:3000', 'http://localhost:3001', 'https://localhost:3000']

        # Allow any origin in dev mode
        if self.server.dev_mode:
            self.send_header("Access-Control-Allow-Origin", origin or "*")
            logger.debug(f"Dev mode: Allowing origin {origin or '*'}")
        elif origin in allowed_origins:
            self.send_header("Access-Control-Allow-Origin", origin)
            logger.debug(f"Allowed specific origin: {origin}")
        else:
            # Fallback for other cases - you could be more restrictive here
            self.send_header("Access-Control-Allow-Origin", "*")
            
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, User-Agent")
        self.send_header("Access-Control-Allow-Credentials", "true")
        self.send_header("Access-Control-Max-Age", "86400") # 24 hours
