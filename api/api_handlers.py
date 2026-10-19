#!/usr/bin/env python3
import os
import json
from datetime import datetime
from pathlib import Path
import logging

logger = logging.getLogger("api_handlers")
# Logging is configured once in api.py via logging_config.setup_logging()

# Global registry for API handlers
API_HANDLERS = {}

# Shared HTTP client - one connection pool for the process lifetime. Owned by
# http_client; re-exported here because the handlers import it from this module.
import http_client
from http_client import get_http_client

async def startup_handlers():
    """Initialize shared resources. Called from FastAPI lifespan on startup."""
    await http_client.startup()

async def shutdown_handlers():
    """Close shared resources. Called from FastAPI lifespan on shutdown."""
    await http_client.shutdown()

class HandlerError(Exception):
    """Custom exception for handler-specific errors."""
    def __init__(self, message, status_code=500):
        super().__init__(message)
        self.status_code = status_code

class ConfigError(HandlerError):
    """Error for configuration issues like missing API keys."""
    def __init__(self, message):
        super().__init__(message, status_code=500) # Internal server error as config is wrong

class BackendAPIError(HandlerError):
    """Error originating from the downstream AI API."""
    def __init__(self, message, status_code=502): # Bad Gateway by default
        super().__init__(message, status_code)


class BaseAPIHandler:
    """Base class for asynchronous API handlers."""
    def __init__(self, name):
        self.name = name
        self.models = []  # List of supported models { "name": "model-id", "parameters": "optional", ... }
        API_HANDLERS[name] = self
        logger.info("Registered API handler: '%s'", name)
        # Optional: Create a shared httpx client if needed across handlers (managing lifecycle is key)
        # self.http_client = httpx.AsyncClient(timeout=90.0) # Example

    def get_models(self):
        """Return the list of models supported by this handler."""
        return self.models

    async def handle_request(self, request_data: dict) -> dict:
        """
        Process the request asynchronously.
        Subclasses MUST override this method.

        Args:
            request_data: The parsed JSON request data (dictionary).

        Returns:
            A dictionary representing the successful JSON response payload.

        Raises:
            ConfigError: If configuration (like API key) is missing.
            BackendAPIError: If the downstream API call fails.
            ValueError: If the request_data is invalid.
            NotImplementedError: If the subclass doesn't implement this.
            Exception: For other unexpected errors.
        """
        raise NotImplementedError(f"Handler '{self.name}' must implement handle_request")

    # NOTE: log_conversation() method removed - now handled centrally in compute.py
    # This eliminates disk I/O during requests and ensures consistent logging across all handlers


# --- Import and Instantiate REWRITTEN Handlers ---
# Ensure these files contain the rewritten async versions below
from gemini_handler import GeminiAPIHandler
from openrouter_handler import OpenRouterAPIHandler

# Instantiate and register the handlers.
# The __init__ method in BaseAPIHandler adds them to API_HANDLERS
gemini_handler = GeminiAPIHandler()
openrouter_handler = OpenRouterAPIHandler()

logger.info("Initialized API Handlers. Available: %s", list(API_HANDLERS.keys()))

# Pre-built model-name → handler lookup (avoids O(handlers × models) search per request)
MODEL_TO_HANDLER = {
    m["name"]: handler
    for handler in API_HANDLERS.values()
    for m in handler.get_models()
}
logger.info("Model-to-handler index built. Models: %s", list(MODEL_TO_HANDLER.keys()))
# --- End Handler Instantiation ---
